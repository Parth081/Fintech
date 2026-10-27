// useConsoleRoute(): the console's hash router.
//   const { path, params, query, navigate } = useConsoleRoute('payments/:id');
//   navigate('payments/pay_1')  or  navigate(links.case(id))  (a full "#/console/..." href also works)
//   navigate('payments', { query: { status: 'failed' }, replace: true })
import { useCallback, useEffect, useState } from 'react';
import { consoleHref, matchPattern, parseConsoleHash, type ConsoleLocation } from './lib/routing';

export { links, consoleHref, matchPattern, targetHref, isUnder } from './lib/routing';

export interface NavigateOptions {
  query?: Record<string, string | number | null | undefined>;
  replace?: boolean;
}

export interface ConsoleRoute extends ConsoleLocation {
  /** Params of `pattern` (empty object when no pattern is given or it does not match). */
  params: Record<string, string>;
  /** Whether `pattern` matched the current path (true when no pattern is given). */
  matched: boolean;
  navigate(to: string, opts?: NavigateOptions): void;
  /** Replace query parameters on the current path (null/'' removes a key). */
  setQuery(patch: Record<string, string | number | null | undefined>, opts?: { replace?: boolean }): void;
}

function current(): ConsoleLocation {
  return parseConsoleHash(typeof window === 'undefined' ? '' : window.location.hash);
}

export function navigateTo(to: string, opts: NavigateOptions = {}): void {
  const href = to.startsWith('#') ? to : consoleHref(to, opts.query);
  if (opts.replace) {
    const url = `${window.location.pathname}${window.location.search}${href}`;
    window.history.replaceState(window.history.state, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (window.location.hash !== href) {
    window.location.hash = href;
  }
}

export function useConsoleRoute(pattern?: string): ConsoleRoute {
  const [loc, setLoc] = useState<ConsoleLocation>(current);
  useEffect(() => {
    const on = () => setLoc(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((to: string, opts?: NavigateOptions) => navigateTo(to, opts), []);
  const setQuery = useCallback((patch: Record<string, string | number | null | undefined>, opts?: { replace?: boolean }) => {
    const now = current();
    const q: Record<string, string | number | null | undefined> = { ...now.query, ...patch };
    navigateTo(consoleHref(now.path, q), { replace: opts?.replace ?? true });
  }, []);
  const params = pattern ? matchPattern(pattern, loc.path) : {};
  return { ...loc, params: params ?? {}, matched: params !== null, navigate, setQuery };
}
