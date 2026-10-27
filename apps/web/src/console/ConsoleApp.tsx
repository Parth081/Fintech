// Operations Console root (#/console/...): session gate, theme, toasts, app shell.
import { useEffect } from 'react';
import './theme.css';
import { SessionProvider, useSession } from './session';
import { navigateTo, useConsoleRoute } from './route';
import { ToastProvider, useLocalStorage } from './ui';
import { Shell } from './shell/Shell';
import { SignInPage } from './shell/SignInPage';

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_KEY = 'ct.console.theme';

function Gate({ theme, setTheme }: { theme: ThemeChoice; setTheme(t: ThemeChoice): void }) {
  const { session } = useSession();
  const { path, query } = useConsoleRoute();
  // Signed in on the sign-in route -> go where the user was heading (or home).
  useEffect(() => {
    if (session && path === 'sign-in') navigateTo(query.next ? decodeURIComponent(query.next) : '', { replace: true });
  }, [session, path, query.next]);
  if (!session) return <SignInPage />;
  return <Shell theme={theme} setTheme={setTheme} />;
}

export default function ConsoleApp() {
  const [theme, setTheme] = useLocalStorage<ThemeChoice>(THEME_KEY, 'system');
  useEffect(() => {
    const prev = document.title;
    document.title = 'Control Tower · Operations Console';
    return () => {
      document.title = prev;
    };
  }, []);
  return (
    <div className="ct-console" data-theme={theme === 'system' ? undefined : theme}>
      <SessionProvider>
        <ToastProvider>
          <Gate theme={theme} setTheme={setTheme} />
        </ToastProvider>
      </SessionProvider>
    </div>
  );
}
