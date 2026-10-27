// App shell: sidebar (grouped, permission-filtered), top bar (global search, notifications, theme, user menu),
// and the routed module page.
import { Component, createContext, Suspense, useContext, useEffect, type ErrorInfo, type ReactNode } from 'react';
import type { Permission } from '@ct/contracts/browser';
import { MODULES, type ConsoleModule } from '../modules';
import { allowed, navSections, resolveEntry } from '../lib/nav';
import { consoleHref, links, useConsoleRoute } from '../route';
import { useSession } from '../session';
import type { ThemeChoice } from '../ConsoleApp';
import { Avatar, Badge, Button, EmptyState, Icon, Page, PageHeader, Popover, Skeleton, type IconName } from '../ui';
import { GlobalSearch } from './GlobalSearch';
import { Notifications } from './Notifications';
import { ROLE_LABEL } from './SignInPage';
import { useAttention, type Attention } from './useAttention';

const AttentionContext = createContext<Attention | null>(null);

/** Overview counters and notices polled by the shell (pages may reuse instead of polling again). */
export function useShellAttention(): Attention | null {
  return useContext(AttentionContext);
}

function navCount(m: ConsoleModule, a: Attention): number | null {
  const o = a.overview;
  if (!o) return null;
  if (m.id === 'cases') return o.cases.open || null;
  if (m.id === 'alerts') return (o.alerts.bySeverity.critical ?? 0) + (o.alerts.bySeverity.high ?? 0) || null;
  if (m.id === 'treasury') return o.recon.openBreaks || null;
  if (m.id === 'changes') return o.changes.pending || null;
  return null;
}

function Sidebar({ path, attention }: { path: string; attention: Attention }) {
  const { can } = useSession();
  const sections = navSections(MODULES, can);
  const active = resolveEntry(MODULES.filter((m) => !m.hidden), path);
  return (
    <aside className="ct-sidebar" aria-label="Console navigation">
      <a className="ct-brand" href={links.home()}>
        <span className="ct-brand-mark">CT</span>
        <span>
          Control Tower
          <span className="ct-brand-sub">Operations Console</span>
        </span>
      </a>
      <nav className="ct-nav">
        {sections.map((s) => (
          <div key={s.group} className="ct-nav-group">
            <div className="ct-nav-group-label">{s.group}</div>
            {s.items.map((m) => {
              const count = navCount(m, attention);
              return (
                <a key={m.id} className="ct-nav-item" href={consoleHref(m.path)} aria-current={active?.id === m.id ? 'page' : undefined}>
                  <Icon name={m.icon} />
                  <span>{m.label}</span>
                  {count !== null && <span className="ct-nav-count">{count > 99 ? '99+' : count}</span>}
                </a>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="ct-sidebar-foot">
        <div className="ct-row">
          <span className="ct-dot" style={{ color: 'var(--ct-ok)' }} aria-hidden="true" />
          Sandbox region · synthetic data
        </div>
        <a href="#/stage" className="ct-small">
          Booth mode (audience screens) →
        </a>
      </div>
    </aside>
  );
}

const THEME_NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON: Record<ThemeChoice, IconName> = { system: 'monitor', light: 'sun', dark: 'moon' };

function UserMenu() {
  const { user, session, signOut } = useSession();
  if (!user) return null;
  return (
    <Popover
      width={280}
      trigger={({ open, toggle }) => (
        <button type="button" className="ct-user-btn" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          <Avatar initials={user.initials} />
          <span className="ct-ellipsis" style={{ maxWidth: 160 }}>
            {user.name}
            <small>{ROLE_LABEL[user.role] ?? user.role}</small>
          </span>
          <Icon name="chevronDown" size={14} />
        </button>
      )}
    >
      {(close) => (
        <div role="menu">
          <div className="ct-popover-head" style={{ justifyContent: 'flex-start' }}>
            <Avatar initials={user.initials} large />
            <div style={{ minWidth: 0 }}>
              <div>{user.name}</div>
              <div className="ct-small ct-muted" style={{ fontWeight: 400 }}>
                {user.title}
              </div>
              <div style={{ marginTop: 4 }}>
                <Badge tone="accent">{ROLE_LABEL[user.role] ?? user.role}</Badge>
              </div>
            </div>
          </div>
          <div className="ct-popover-section">{session?.permissions.length ?? 0} permissions</div>
          <a className="ct-menu-item" role="menuitem" href={links.users()} onClick={close}>
            <Icon name="users" /> Roles & permissions
          </a>
          <button
            type="button"
            className="ct-menu-item"
            role="menuitem"
            onClick={() => {
              close();
              signOut();
            }}
          >
            <Icon name="users" /> Switch user
          </button>
          <a className="ct-menu-item" role="menuitem" href="#/stage" onClick={close}>
            <Icon name="monitor" /> Booth mode
            <small style={{ marginLeft: 'auto' }}>#/stage</small>
          </a>
          <div className="ct-menu-sep" />
          <button
            type="button"
            className="ct-menu-item"
            role="menuitem"
            onClick={() => {
              close();
              signOut();
            }}
          >
            <Icon name="logout" /> Sign out
          </button>
        </div>
      )}
    </Popover>
  );
}

function TopBar({ theme, setTheme, attention }: { theme: ThemeChoice; setTheme(t: ThemeChoice): void; attention: Attention }) {
  return (
    <header className="ct-topbar">
      <GlobalSearch />
      <div className="ct-spacer" />
      <span className="ct-env" title="All data in this environment is synthetic; nothing leaves this machine.">
        <Icon name="shield" size={13} /> Sandbox · synthetic data
      </span>
      <Notifications attention={attention} />
      <button type="button" className="ct-icon-btn" onClick={() => setTheme(THEME_NEXT[theme])} aria-label={`Theme: ${theme}. Switch to ${THEME_NEXT[theme]}`} title={`Theme: ${theme}`}>
        <Icon name={THEME_ICON[theme]} />
      </button>
      <UserMenu />
    </header>
  );
}

export function PageSkeleton() {
  return (
    <Page>
      <Skeleton width={240} height={26} />
      <Skeleton width={360} style={{ marginTop: 10, marginBottom: 24 }} />
      <div className="ct-grid ct-grid-4" style={{ marginBottom: 16 }}>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="ct-card ct-metric">
            <Skeleton width="50%" />
            <Skeleton width="70%" height={28} style={{ marginTop: 8 }} />
          </div>
        ))}
      </div>
      <div className="ct-card ct-card-body">
        <Skeleton lines={8} />
      </div>
    </Page>
  );
}

function Forbidden({ permission }: { permission: ConsoleModule['permission'] }) {
  const perms = permission === null ? [] : typeof permission === 'string' ? [permission] : [...permission];
  return (
    <Page>
      <div className="ct-card">
        <EmptyState icon="shield" title="You don't have access to this workspace" actions={<a className="ct-btn" href={links.home()}>Back to overview</a>}>
          Requires {perms.map((p: Permission, i) => <span key={p}>{i > 0 && ' or '}<code>{p}</code></span>)}. Ask an administrator, or switch to a user with that role.
        </EmptyState>
      </div>
    </Page>
  );
}

function NotFound() {
  return (
    <Page>
      <div className="ct-card">
        <EmptyState icon="search" title="Page not found" actions={<a className="ct-btn" href={links.home()}>Back to overview</a>}>
          This console address does not exist.
        </EmptyState>
      </div>
    </Page>
  );
}

/** Keeps one broken module from taking down the shell. Resets when the route changes. */
class ModuleBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null; key: string }> {
  override state = { error: null as Error | null, key: this.props.resetKey };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: Error | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[console] module crashed', error, info.componentStack);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <Page>
        <PageHeader title="Something went wrong" />
        <div className="ct-card">
          <EmptyState icon="alert" title="This page failed to render" actions={<Button icon="refresh" onClick={() => this.setState({ error: null })}>Try again</Button>}>
            {this.state.error.message}
          </EmptyState>
        </div>
      </Page>
    );
  }
}

export function Shell({ theme, setTheme }: { theme: ThemeChoice; setTheme(t: ThemeChoice): void }) {
  const { path } = useConsoleRoute();
  const { can } = useSession();
  const attention = useAttention();
  const entry = resolveEntry(MODULES, path);
  // Scroll to top on page change (not on query changes).
  const base = path.split('/').slice(0, 2).join('/');
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [base]);
  let content: ReactNode;
  if (!entry) content = <NotFound />;
  else if (!allowed(entry, can)) content = <Forbidden permission={entry.permission} />;
  else {
    const C = entry.component;
    content = <C />;
  }
  return (
    <AttentionContext.Provider value={attention}>
      <div className="ct-shell">
        <Sidebar path={path} attention={attention} />
        <div className="ct-main">
          <TopBar theme={theme} setTheme={setTheme} attention={attention} />
          <main className="ct-content" id="ct-main">
            <ModuleBoundary resetKey={path}>
              <Suspense fallback={<PageSkeleton />}>{content}</Suspense>
            </ModuleBoundary>
          </main>
        </div>
      </div>
    </AttentionContext.Provider>
  );
}
