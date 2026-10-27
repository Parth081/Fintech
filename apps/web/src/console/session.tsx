// Console session: who is signed in and what they may do.
//   <SessionProvider> wraps the console; useSession() -> { session, user, can(permission), signIn, signOut }.
// The token lives in sessionStorage (per tab). Any 401 from the API signs the user out (back to sign-in).
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Permission, Session } from '@ct/contracts/browser';
import { loadStoredSession, opsApi, storeSession, UNAUTHORIZED_EVENT } from './api';

export interface SessionContextValue {
  session: Session | null;
  user: Session['user'] | null;
  /** True when the signed-in user holds the permission. */
  can(permission: Permission | null | undefined): boolean;
  signIn(userId: string): Promise<Session>;
  signOut(opts?: { expired?: boolean }): void;
  /** Set when the last sign-out was caused by an expired/invalid session (sign-in page shows a note). */
  expired: boolean;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(() => loadStoredSession());
  const [expired, setExpired] = useState(false);

  const signOut = useCallback((opts?: { expired?: boolean }) => {
    const had = loadStoredSession();
    storeSession(null);
    setSession(null);
    setExpired(!!opts?.expired);
    if (had && !opts?.expired) {
      // best effort; the token is already forgotten locally
      void fetch('/api/ops/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${had.token}` } }).catch(() => undefined);
    }
  }, []);

  const signIn = useCallback(async (userId: string) => {
    const s = await opsApi.login(userId);
    storeSession(s);
    setSession(s);
    setExpired(false);
    return s;
  }, []);

  // 401 anywhere -> back to sign-in.
  useEffect(() => {
    const on = () => {
      if (loadStoredSession()) signOut({ expired: true });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, on);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, on);
  }, [signOut]);

  // Refresh the session (permissions may have changed; detects a restarted ops service).
  useEffect(() => {
    if (!session) return;
    const ctrl = new AbortController();
    opsApi
      .me(ctrl.signal)
      .then((fresh) => {
        if (!fresh || typeof fresh !== 'object' || !fresh.user) return;
        const merged: Session = { ...fresh, token: fresh.token || session.token };
        storeSession(merged);
        setSession((cur) => (cur && cur.token === session.token ? merged : cur));
      })
      .catch(() => undefined); // 401 handled by the event; network errors keep the cached session
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.token]);

  const value = useMemo<SessionContextValue>(() => {
    const perms = new Set(session?.permissions ?? []);
    return {
      session,
      user: session?.user ?? null,
      can: (p) => (p ? perms.has(p) : session !== null),
      signIn,
      signOut,
      expired,
    };
  }, [session, signIn, signOut, expired]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession() outside <SessionProvider>');
  return ctx;
}
