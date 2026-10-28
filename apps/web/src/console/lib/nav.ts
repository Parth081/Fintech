// Navigation logic (pure): which modules a user sees, grouped for the sidebar, and which one owns a path.
import type { Permission } from '@ct/contracts/browser';
import { isUnder } from './routing';

export type NavGroup = 'Operate' | 'Risk & Compliance' | 'Treasury' | 'Platform';
export const NAV_GROUPS: readonly NavGroup[] = ['Operate', 'Risk & Compliance', 'Treasury', 'Platform'];

export interface NavEntry {
  id: string;
  label: string;
  /** Base path inside the console ("" = home). The entry owns this path and everything below it. */
  path: string;
  group: NavGroup;
  /** Required permission; an array means any one of them. null = every signed-in user. */
  permission: Permission | readonly Permission[] | null;
  /** Not shown in the sidebar (still routable). */
  hidden?: boolean;
}

export function allowed(entry: Pick<NavEntry, 'permission'>, can: (p: Permission) => boolean): boolean {
  const p = entry.permission;
  if (p === null) return true;
  if (typeof p === 'string') return can(p);
  return p.some((x) => can(x));
}

/** Sidebar sections: groups in fixed order, entries in registry order, empty groups dropped. */
export function navSections<T extends NavEntry>(entries: readonly T[], can: (p: Permission) => boolean): { group: NavGroup; items: T[] }[] {
  return NAV_GROUPS.map((group) => ({
    group,
    items: entries.filter((e) => e.group === group && !e.hidden && allowed(e, can)),
  })).filter((s) => s.items.length > 0);
}

/** The entry that owns `path`: the longest base path that `path` is under. Home ("") only matches "" exactly. */
export function resolveEntry<T extends NavEntry>(entries: readonly T[], path: string): T | null {
  let best: T | null = null;
  for (const e of entries) {
    if (!isUnder(path, e.path)) continue;
    if (!best || e.path.length > best.path.length) best = e;
  }
  return best;
}
