// Table logic (pure): client-side sort, column visibility, saved views.

export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

export type SortValue = string | number | boolean | null | undefined;

function cmp(a: SortValue, b: SortValue): number {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an && bn) return 0;
  if (an) return 1; // blanks last
  if (bn) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
}

/** Stable sort by a value accessor; blanks always last. */
export function sortRows<T>(rows: readonly T[], value: (row: T) => SortValue, dir: SortDir): T[] {
  return rows
    .map((row, i) => ({ row, i, v: value(row) }))
    .sort((x, y) => {
      const blankX = x.v === null || x.v === undefined || x.v === '';
      const blankY = y.v === null || y.v === undefined || y.v === '';
      if (blankX !== blankY) return blankX ? 1 : -1;
      const c = cmp(x.v, y.v);
      return c !== 0 ? (dir === 'asc' ? c : -c) : x.i - y.i;
    })
    .map((x) => x.row);
}

/** Header click: new column -> its default direction; same column -> flip. */
export function nextSort(cur: SortState | null, key: string, defaultDir: SortDir = 'asc'): SortState {
  if (!cur || cur.key !== key) return { key, dir: defaultDir };
  return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
}

/** Visible column ids: those not hidden, keeping `required` ones always visible. */
export function visibleColumns(all: readonly { id: string; required?: boolean }[], hidden: readonly string[]): string[] {
  const h = new Set(hidden);
  return all.filter((c) => c.required || !h.has(c.id)).map((c) => c.id);
}

export function toggleHidden(hidden: readonly string[], id: string): string[] {
  return hidden.includes(id) ? hidden.filter((x) => x !== id) : [...hidden, id];
}

// ---------------------------------------------------------------------------------------------- saved views

export interface SavedView<F> {
  id: string;
  name: string;
  filters: F;
  createdAt: string;
}

/** Add or replace (by case-insensitive name) a saved view; newest first; capped. */
export function upsertView<F>(views: readonly SavedView<F>[], name: string, filters: F, now: Date = new Date(), max = 20): SavedView<F>[] {
  const clean = name.trim().slice(0, 60);
  if (!clean) return [...views];
  const rest = views.filter((v) => v.name.toLowerCase() !== clean.toLowerCase());
  const taken = new Set(views.map((v) => v.id));
  let n = 0;
  while (taken.has(`v-${now.getTime().toString(36)}-${n}`)) n += 1;
  const id = `v-${now.getTime().toString(36)}-${n}`;
  return [{ id, name: clean, filters, createdAt: now.toISOString() }, ...rest].slice(0, max);
}

export function removeView<F>(views: readonly SavedView<F>[], id: string): SavedView<F>[] {
  return views.filter((v) => v.id !== id);
}
