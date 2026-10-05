import { VERSION, saveConfig } from './config.js';

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

function baseRoot(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

function errorMessage(text, status) {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : null);
    if (m) return m;
  } catch {}
  return (text || `HTTP ${status}`).slice(0, 500);
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(Object.assign(new Error('Przerwano'), { name: 'AbortError' }));
    }, { once: true });
  });

const STREAM_IDLE_MS = 180000;

// Czyta strumień Server-Sent Events i zwraca kolejne obiekty JSON.
async function* sse(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const parse = function* (raw) {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') return;
    try {
      yield JSON.parse(data);
    } catch {}
  };
  while (true) {
    // jeśli bramka przestanie wysyłać dane, nie czekamy w nieskończoność
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reader.cancel().catch(() => {});
        reject(new ApiError(`Brak danych z API od ${STREAM_IDLE_MS / 1000}s — połączenie zerwane. Spróbuj ponownie.`));
      }, STREAM_IDLE_MS);
    });
    let chunk;
    try {
      chunk = await Promise.race([reader.read(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    const { value, done } = chunk;
    if (done) break;
    buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      yield* parse(raw);
    }
  }
  if (buf.trim()) yield* parse(buf);
}

// ---------- konwersja historii (wewnętrznie trzymamy format Anthropic) ----------

function blockText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  return String(content ?? '');
}

function toOpenAIMessages(system, messages) {
  const outMsgs = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      outMsgs.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'user') {
      const texts = [];
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          outMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id, content: blockText(b.content) || '(brak wyniku)' });
        } else if (b.type === 'text') {
          texts.push(b.text);
        }
      }
      if (texts.length) outMsgs.push({ role: 'user', content: texts.join('\n\n') });
    } else {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      outMsgs.push(msg);
    }
  }
  return outMsgs;
}

// Chwilowy błąd bramki przy liczeniu tokenów — mija po kilku sekundach.
const isTransient = (e) => /liczenia token|poprzedniego żądania/i.test(e?.message || e?.msg || '');

const isClaude = (model) => /^claude/i.test(String(model || ''));

export const EFFORTS = ['auto', 'low', 'medium', 'high', 'max'];

function buildBody(format, p, stream) {
  const effort = p.effort && p.effort !== 'auto' ? p.effort : null;
  if (format === 'anthropic') {
    const body = {
      model: p.model,
      max_tokens: p.maxTokens,
      system: p.system,
      messages: p.messages,
      stream,
    };
    if (p.tools?.length) body.tools = p.tools;
    if (effort) body.output_config = { effort };
    return body;
  }
  const body = {
    model: p.model,
    messages: toOpenAIMessages(p.system, p.messages),
    max_tokens: p.maxTokens,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (effort) body.reasoning_effort = effort === 'max' ? 'high' : effort;
  if (p.tools?.length) {
    body.tools = p.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
  }
  return body;
}

// ---------- klient ----------

export class ApiClient {
  constructor(config) {
    this.config = config;
  }

  get root() {
    return baseRoot(this.config.baseUrl);
  }

  headers() {
    const token = this.config.token || '';
    return {
      'content-type': 'application/json',
      'x-api-key': token,
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'user-agent': `exoticcode/${VERSION}`,
    };
  }

  // Format dla danego modelu: wymuszony w configu albo zapamiętany z auto-wykrywania.
  formatFor(model) {
    if (this.config.format === 'anthropic' || this.config.format === 'openai') return this.config.format;
    return this.config.formats?.[model] || null;
  }

  async listModels() {
    const res = await fetch(`${this.root}/v1/models`, { headers: this.headers(), signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    if (!res.ok) throw new ApiError(errorMessage(text, res.status), res.status);
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError('Niepoprawna odpowiedź /v1/models');
    }
    const list = Array.isArray(json) ? json : json.data || json.models || [];
    return list.map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
  }

  async request(format, params, stream, signal, onRetry) {
    const url = format === 'anthropic' ? `${this.root}/v1/messages` : `${this.root}/v1/chat/completions`;
    const body = JSON.stringify(buildBody(format, params, stream));
    let lastErr;
    let serverErrors = 0;
    let networkErrors = 0;
    for (let attempt = 0; attempt < 25; attempt++) {
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers: this.headers(), body, signal });
      } catch (e) {
        if (e.name === 'AbortError' || signal?.aborted) throw e;
        lastErr = new ApiError(`Błąd sieci: ${e.cause?.message || e.message}`);
        if (++networkErrors > 4) throw lastErr;
        onRetry?.(`Problem z siecią — ponawiam (${networkErrors}/4)`);
        await sleep(1000 * 2 ** networkErrors, signal);
        continue;
      }
      if (res.ok) return res;
      const text = await res.text();
      lastErr = new ApiError(errorMessage(text, res.status), res.status);
      if (res.status === 429 || isTransient(lastErr)) {
        const retryAfter = Number(res.headers.get('retry-after'));
        let wait;
        let why;
        if (/poprzedniego żądania/i.test(lastErr.message)) {
          // bramka obsługuje jedno żądanie naraz — zwykle zwalnia się po chwili
          wait = 1500;
          why = 'Bramka kończy poprzednie żądanie — czekam';
        } else if (/liczenia token/i.test(lastErr.message)) {
          wait = Math.min(2000 + 1500 * attempt, 8000);
          why = 'Bramka chwilowo nie liczy tokenów — ponawiam';
        } else {
          wait = Math.min(2000 * (attempt + 1), 10000);
          why = 'Limit zapytań — ponawiam';
        }
        if (retryAfter > 0) wait = retryAfter * 1000;
        onRetry?.(`${why} za ${Math.ceil(wait / 1000)}s (próba ${attempt + 1})`);
        await sleep(wait, signal);
        continue;
      }
      if (res.status >= 500 && ++serverErrors < 3) {
        await sleep(1500 * serverErrors, signal);
        continue;
      }
      throw lastErr;
    }
    throw lastErr;
  }

  // Sprawdza, który format bramka przyjmuje dla danego modelu.
  async detectFormat(model) {
    // próbka z narzędziem — tak jak prawdziwe zapytania agenta
    const params = {
      model,
      maxTokens: 16,
      system: 'Reply with the single word: pong',
      messages: [{ role: 'user', content: 'ping' }],
      tools: [{ name: 'noop', description: 'Does nothing.', input_schema: { type: 'object', properties: {} } }],
    };
    const tryFormat = async (format) => {
      const url = format === 'anthropic' ? `${this.root}/v1/messages` : `${this.root}/v1/chat/completions`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(buildBody(format, params, false)),
          signal: AbortSignal.timeout(60000),
        });
        const text = await res.text();
        if (!res.ok) return { ok: false, status: res.status, msg: errorMessage(text, res.status) };
        // odrzuć odpowiedzi, które nie wyglądają na dany format
        const j = JSON.parse(text);
        if (format === 'anthropic' && !Array.isArray(j.content)) return { ok: false, status: res.status, msg: 'zły kształt odpowiedzi' };
        if (format === 'openai' && !Array.isArray(j.choices)) return { ok: false, status: res.status, msg: 'zły kształt odpowiedzi' };
        return { ok: true };
      } catch (e) {
        return { ok: false, status: 0, msg: e.message };
      }
    };
    // Claude: natywny endpoint Anthropic (z liczeniem tokenów), reszta: OpenAI
    const order = isClaude(model) ? ['anthropic', 'openai'] : ['openai', 'anthropic'];
    const results = {};
    for (const f of order) {
      let r = await tryFormat(f);
      for (let i = 0; (r.status === 429 || isTransient(r)) && i < 8; i++) {
        await sleep(Math.min(3000 * (i + 1), 10000));
        r = await tryFormat(f);
      }
      if (r.ok) return f;
      results[f] = r;
      if (r.status === 401 || r.status === 403) throw new ApiError(r.msg, r.status);
    }
    throw new ApiError(
      `Model "${model}" nie odpowiada w żadnym formacie.\n` +
        Object.entries(results).map(([f, r]) => `  ${f}: [${r.status}] ${r.msg}`).join('\n'),
    );
  }

  /**
   * Wysyła zapytanie i streamuje odpowiedź.
   * Zwraca { content: [bloki w formacie Anthropic], stopReason, usage: {input, output} }.
   */
  async stream(params, { signal, onText, onToolStart, onThinking, onRetry } = {}) {
    let format = this.formatFor(params.model) || (isClaude(params.model) ? 'anthropic' : 'openai');
    let res;
    try {
      res = await this.request(format, params, true, signal, onRetry);
    } catch (e) {
      // przy auto-wykrywaniu: jeśli ten format nie działa, spróbuj drugiego i zapamiętaj
      const fixed = this.config.format === 'anthropic' || this.config.format === 'openai';
      if (fixed || signal?.aborted || !(e instanceof ApiError) || [401, 403, 429].includes(e.status) || isTransient(e)) throw e;
      const other = format === 'openai' ? 'anthropic' : 'openai';
      try {
        res = await this.request(other, params, true, signal, onRetry);
      } catch {
        throw e;
      }
      format = other;
      this.config.formats = { ...this.config.formats, [params.model]: other };
      saveConfig(this.config);
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('event-stream')) {
      const json = await res.json();
      return format === 'anthropic' ? fromAnthropicJson(json, onText) : fromOpenAIJson(json, onText);
    }
    return format === 'anthropic' ? readAnthropic(res, onText, onToolStart, onThinking) : readOpenAI(res, onText, onToolStart, onThinking);
  }
}

// ---------- parsowanie odpowiedzi ----------

async function readAnthropic(res, onText, onToolStart, onThinking) {
  const blocks = [];
  let stopReason = null;
  const usage = { input: 0, output: 0 };
  for await (const ev of sse(res)) {
    switch (ev.type) {
      case 'message_start': {
        const u = ev.message?.usage || {};
        usage.input = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        usage.output = u.output_tokens || 0;
        break;
      }
      case 'content_block_start': {
        const b = ev.content_block || {};
        if (b.type === 'text') blocks[ev.index] = { type: 'text', text: b.text || '' };
        else if (b.type === 'tool_use') {
          blocks[ev.index] = { type: 'tool_use', id: b.id, name: b.name, input: {}, _json: '' };
          onToolStart?.(b.name);
        } else if (b.type === 'thinking') {
          blocks[ev.index] = { type: 'thinking', thinking: b.thinking || '', signature: b.signature || '' };
          onThinking?.();
        } else if (b.type === 'redacted_thinking') {
          blocks[ev.index] = { ...b };
        } else blocks[ev.index] = { type: '_skip' };
        break;
      }
      case 'content_block_delta': {
        const b = blocks[ev.index];
        const d = ev.delta || {};
        if (!b) break;
        if (d.type === 'text_delta') {
          b.text += d.text;
          onText?.(d.text);
        } else if (d.type === 'input_json_delta') {
          b._json += d.partial_json || '';
        } else if (d.type === 'thinking_delta') {
          b.thinking += d.thinking || '';
        } else if (d.type === 'signature_delta') {
          b.signature = (b.signature || '') + (d.signature || '');
        }
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index];
        if (b?.type === 'tool_use') finishToolBlock(b);
        break;
      }
      case 'message_delta':
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens;
        break;
      case 'error':
        throw new ApiError(ev.error?.message || 'Błąd strumienia');
    }
  }
  for (const b of blocks) if (b?.type === 'tool_use' && '_json' in b) finishToolBlock(b);
  return { content: cleanBlocks(blocks), stopReason, usage };
}

function finishToolBlock(b) {
  try {
    b.input = b._json ? JSON.parse(b._json) : {};
  } catch {
    b.input = {};
    b.parseError = true;
  }
  delete b._json;
}

function cleanBlocks(blocks) {
  return blocks.filter((b) => b && b.type !== '_skip' && !(b.type === 'text' && !b.text));
}

function fromAnthropicJson(json, onText) {
  const content = (json.content || [])
    .filter((b) => ['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(b.type))
    .map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} } : b));
  for (const b of content) if (b.type === 'text') onText?.(b.text);
  return {
    content: cleanBlocks(content),
    stopReason: json.stop_reason,
    usage: { input: json.usage?.input_tokens || 0, output: json.usage?.output_tokens || 0 },
  };
}

function openAIResult(text, calls, finish, usage) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const call of calls) {
    if (!call) continue;
    const b = { type: 'tool_use', id: call.id || `call_${Math.random().toString(36).slice(2, 12)}`, name: call.name, input: {} };
    try {
      b.input = call.args ? JSON.parse(call.args) : {};
    } catch {
      b.parseError = true;
    }
    content.push(b);
  }
  const stopReason = finish === 'length' ? 'max_tokens' : finish === 'tool_calls' ? 'tool_use' : 'end_turn';
  return { content, stopReason, usage };
}

async function readOpenAI(res, onText, onToolStart, onThinking) {
  let text = '';
  const calls = [];
  let finish = null;
  const usage = { input: 0, output: 0 };
  for await (const ev of sse(res)) {
    if (ev.error) throw new ApiError(ev.error.message || JSON.stringify(ev.error));
    if (ev.usage) {
      usage.input = ev.usage.prompt_tokens || usage.input;
      usage.output = ev.usage.completion_tokens || usage.output;
    }
    const ch = ev.choices?.[0];
    if (!ch) continue;
    const d = ch.delta || {};
    if (d.reasoning_content || d.reasoning) onThinking?.();
    if (d.content) {
      text += d.content;
      onText?.(d.content);
    }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      if (!calls[i]) {
        calls[i] = { id: '', name: '', args: '' };
        if (tc.function?.name) onToolStart?.(tc.function.name);
      }
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name && !calls[i].name) calls[i].name = tc.function.name;
      if (tc.function?.arguments) calls[i].args += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  return openAIResult(text, calls, finish, usage);
}

function fromOpenAIJson(json, onText) {
  const msg = json.choices?.[0]?.message || {};
  if (msg.content) onText?.(msg.content);
  const calls = (msg.tool_calls || []).map((t) => ({ id: t.id, name: t.function?.name, args: t.function?.arguments || '' }));
  return openAIResult(msg.content || '', calls, json.choices?.[0]?.finish_reason, {
    input: json.usage?.prompt_tokens || 0,
    output: json.usage?.completion_tokens || 0,
  });
}
