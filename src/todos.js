// Wspólny stan listy zadań (todo_write) — narzędzie go ustawia, dolny pasek pokazuje bieżący krok.

const listeners = new Set();
let list = [];

export const todos = {
  get list() {
    return list;
  },
  set(items) {
    list = items;
    for (const fn of listeners) fn();
  },
  clear() {
    this.set([]);
  },
  /** { index, total, done, item } bieżącego kroku albo null, gdy nie ma aktywnej listy. */
  current() {
    if (!list.length) return null;
    const done = list.filter((t) => t.status === 'completed').length;
    if (done === list.length) return null;
    const index = list.findIndex((t) => t.status === 'in_progress');
    const i = index === -1 ? list.findIndex((t) => t.status !== 'completed') : index;
    return { index: i, total: list.length, done, item: list[i] };
  },
  onChange(fn) {
    listeners.add(fn);
  },
};
