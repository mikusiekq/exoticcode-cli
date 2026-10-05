---
name: security-review
description: Security review of the pending changes or a given part of the codebase — injection, auth, secrets, unsafe input handling, dependency risks. Use when the user asks for a security review/audit, "is this safe", "check for vulnerabilities", or before shipping code that handles user input, auth, files or payments.
---

# Security review

Find vulnerabilities an attacker could actually exploit. Prefer a few confirmed issues over a long list of theoretical ones.

## 1. Scope
- Default: uncommitted changes and the current branch vs. main (`git diff`, `git diff main...HEAD`).
- Identify the trust boundaries: where does untrusted data enter (HTTP params, headers, files, env, CLI args, messages, webhooks, LLM output)?

## 2. Checklist
- **Injection:** SQL/NoSQL built with string concatenation; shell commands built from input (`exec`, `spawn` with `shell: true`, `os.system`); template injection; `eval`/`Function`/`pickle`/`yaml.load` on input.
- **Path traversal:** user input joined into file paths without normalising and checking it stays inside the allowed directory.
- **XSS:** untrusted data rendered as HTML (`innerHTML`, `dangerouslySetInnerHTML`, unescaped templates).
- **AuthN/AuthZ:** endpoints missing auth, checks done on the client only, IDOR (object accessed by id without ownership check), privilege escalation.
- **Secrets:** API keys, tokens or passwords in code, logs, error messages or committed config. Tokens stored without restrictive permissions.
- **Crypto & sessions:** weak hashing for passwords (md5/sha1 without salt), predictable tokens (`Math.random`), missing expiry, JWT without verification.
- **SSRF:** server fetching URLs supplied by the user without an allow-list.
- **Deserialization & uploads:** unvalidated file types/sizes, files stored in a web-served folder.
- **Dependencies:** obviously outdated or abandoned packages handling security-sensitive work (check the lockfile; run `npm audit` / `pip-audit` if available).
- **Error handling:** stack traces or internal details returned to clients.

## 3. Verify
For each candidate, trace the data flow from the entry point to the sink. Keep it only if you can describe the exploit: attacker input → what happens.

## 4. Report
```
[critical|high|medium|low] path:LINE — vulnerability
  Exploit: how an attacker triggers it
  Fix: concrete remediation
```
Finish with the overall risk in one sentence. Do not change code unless asked.
