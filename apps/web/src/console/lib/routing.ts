// Console hash routing (pure). The console lives at #/console/<path>?<query>, e.g. #/console/payments/pay_123.
// Modules match their own sub-paths with matchPattern('payments/:id', path).

export const CONSOLE_PREFIX = '#/console';

export interface ConsoleLocation {
  /** Path inside the console without leading/trailing slashes, e.g. "payments/pay_123" ("" = home). */
  path: string;
  segments: string[];
  query: Record<string, string>;
}

/** True when the hash belongs to the console (also the default for an empty hash). */
export function isConsoleHash(hash: string): boolean {
  const h = hash.replace(/^#?\/?/, '');
  return h === '' || h === 'console' || h.startsWith('console/') || h.startsWith('console?');
}

export function parseConsoleHash(hash: string): ConsoleLocation {
  let h = hash.replace(/^#?\/?/, '');
  if (h === 'console' || h.startsWith('console/') || h.startsWith('console?')) h = h.slice('console'.length);
  const qi = h.indexOf('?');
  const rawPath = qi >= 0 ? h.slice(0, qi) : h;
  const rawQuery = qi >= 0 ? h.slice(qi + 1) : '';
  const segments = rawPath
    .split('/')
    .filter((s) => s !== '')
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
  const query: Record<string, string> = {};
  if (rawQuery) {
    for (const [k, v] of new URLSearchParams(rawQuery)) query[k] = v;
  }
  return { path: segments.join('/'), segments, query };
}

/** Build a console hash: consoleHref('payments/' + id, { tab: 'messages' }) -> "#/console/payments/<id>?tab=messages". */
export function consoleHref(path: string, query?: Record<string, string | number | null | undefined>): string {
  const segs = path
    .split('/')
    .filter((s) => s !== '')
    .map((s) => encodeURIComponent(s));
  let out = `${CONSOLE_PREFIX}${segs.length ? '/' + segs.join('/') : ''}`;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) out += `?${s}`;
  }
  return out;
}

/**
 * Match "payments/:id" against "payments/pay_1" -> { id: "pay_1" }. A trailing "*" matches the rest:
 * "risk/*" matches "risk" and "risk/cases/1" (rest in params["*"]). Returns null when it does not match.
 */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    if (part === '*') {
      params['*'] = s.slice(i).join('/');
      return params;
    }
    const seg = s[i];
    if (seg === undefined) return null;
    if (part.startsWith(':')) params[part.slice(1)] = seg;
    else if (part !== seg) return null;
  }
  return s.length === p.length ? params : null;
}

/** True when `path` is `base` or below it ("payments" covers "payments/pay_1"). */
export function isUnder(path: string, base: string): boolean {
  if (base === '') return path === '';
  return path === base || path.startsWith(base + '/');
}

/**
 * Canonical deep links shared by every console module. Use these instead of building hashes by hand so
 * links between modules (payment <-> case <-> audit) stay consistent.
 */
export const links = {
  home: () => consoleHref(''),
  payments: (query?: Record<string, string>) => consoleHref('payments', query),
  payment: (paymentId: string, tab?: string) => consoleHref(`payments/${paymentId}`, tab ? { tab } : undefined),
  alerts: (query?: Record<string, string>) => consoleHref('risk/alerts', query),
  alert: (alertId: string) => consoleHref(`risk/alerts/${alertId}`),
  cases: (query?: Record<string, string>) => consoleHref('risk/cases', query),
  case: (caseId: string) => consoleHref(`risk/cases/${caseId}`),
  treasury: (query?: Record<string, string>) => consoleHref('treasury', query),
  breaks: (query?: Record<string, string>) => consoleHref('treasury/breaks', query),
  break: (breakId: string) => consoleHref(`treasury/breaks/${breakId}`),
  refunds: (query?: Record<string, string>) => consoleHref('payments/refunds', query),
  config: () => consoleHref('config'),
  changes: (query?: Record<string, string>) => consoleHref('config/changes', query),
  change: (changeId: string) => consoleHref(`config/changes/${changeId}`),
  audit: (query?: Record<string, string>) => consoleHref('audit', query),
  auditEntry: (id: string) => consoleHref('audit', { entry: id }),
  users: () => consoleHref('users'),
  developers: (tab?: string) => consoleHref('developers', tab ? { tab } : undefined),
  signIn: () => consoleHref('sign-in'),
} as const;

/** Where an audit target points to inside the console. */
export function targetHref(target: { type: string; id: string }): string | null {
  switch (target.type) {
    case 'payment':
      return links.payment(target.id);
    case 'case':
      return links.case(target.id);
    case 'alert':
      return links.alert(target.id);
    case 'config':
      return target.id.startsWith('CR-') ? links.change(target.id) : links.config();
    case 'break':
      return links.break(target.id);
    case 'user':
      return links.users();
    case 'apikey':
      return links.developers('keys');
    case 'webhook':
      return links.developers('webhooks');
    default:
      return null;
  }
}
