// Demo sign-in: pick a fictional user; POST /api/ops/auth/login. No passwords in the demo environment.
import { useState } from 'react';
import type { DemoUser, Role } from '@ct/contracts/browser';
import { ROLE_PERMISSIONS } from '@ct/contracts/browser';
import { opsApi } from '../api';
import { useSession } from '../session';
import { Avatar, Badge, Banner, ErrorState, Icon, Skeleton, errorMessage, useApi } from '../ui';

export const ROLE_LABEL: Record<Role, string> = {
  ops_analyst: 'Payment operations',
  compliance_analyst: 'Compliance analyst',
  compliance_manager: 'Compliance manager',
  treasury: 'Treasury',
  admin: 'Administrator',
  auditor: 'Auditor (read-only)',
};

export function SignInPage() {
  const { signIn, expired } = useSession();
  const users = useApi((signal) => opsApi.demoUsers(signal), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = async (u: DemoUser) => {
    setBusy(u.id);
    setError(null);
    try {
      await signIn(u.id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(null);
    }
  };

  return (
    <div className="ct-signin">
      <aside className="ct-signin-hero">
        <div className="ct-row" style={{ gap: 10 }}>
          <span className="ct-brand-mark">CT</span>
          <strong style={{ color: '#fff' }}>Control Tower</strong>
        </div>
        <div>
          <h1>Operations Console</h1>
          <p>The back office for cross-border payments: investigate, act with four-eyes control, and keep an immutable audit trail.</p>
          <ul>
            <li><Icon name="payments" /> Payment search, detail and operator actions</li>
            <li><Icon name="shield" /> Sanctions, fraud and AML case management</li>
            <li><Icon name="bank" /> Treasury positions and reconciliation breaks</li>
            <li><Icon name="audit" /> Maker-checker changes and a complete audit log</li>
          </ul>
        </div>
        <div className="ct-small" style={{ color: '#c7c9ff' }}>
          Demo environment · synthetic data · all names and accounts are fictional
        </div>
      </aside>
      <main className="ct-signin-panel">
        <div className="ct-row" style={{ marginBottom: 6 }}>
          <span className="ct-env">
            <Icon name="info" size={13} /> Demo environment · synthetic data
          </span>
        </div>
        <h2 style={{ fontSize: 22, margin: '8px 0 4px' }}>Sign in</h2>
        <p className="ct-muted" style={{ margin: '0 0 20px' }}>
          Choose a demo user. Each role sees different workspaces and actions.
        </p>
        {expired && (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="warn">Your session ended. Sign in again to continue.</Banner>
          </div>
        )}
        {error && (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="bad">{error}</Banner>
          </div>
        )}
        {users.loading ? (
          <div className="ct-user-cards">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="ct-user-card">
                <Skeleton width={44} height={44} style={{ borderRadius: '50%' }} />
                <div style={{ flex: 1 }}>
                  <Skeleton width="70%" />
                  <Skeleton width="50%" style={{ marginTop: 8 }} />
                </div>
              </div>
            ))}
          </div>
        ) : users.error ? (
          <div className="ct-card">
            <ErrorState error={`The operations service is not reachable (${users.error}). Start the platform and try again.`} onRetry={users.refresh} />
          </div>
        ) : (
          <div className="ct-user-cards">
            {(users.data ?? []).map((u) => (
              <button key={u.id} type="button" className="ct-user-card" disabled={busy !== null} onClick={() => void choose(u)}>
                <Avatar initials={u.initials} large />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="ct-user-card-name">{u.name}</div>
                  <div className="ct-user-card-title">{u.title}</div>
                  <div className="ct-row" style={{ marginTop: 8 }}>
                    <Badge tone="accent">{ROLE_LABEL[u.role] ?? u.role}</Badge>
                    <span className="ct-small ct-muted">{ROLE_PERMISSIONS[u.role]?.length ?? 0} permissions</span>
                  </div>
                </div>
                {busy === u.id && <span className="ct-spinner" aria-label="Signing in" />}
              </button>
            ))}
          </div>
        )}
        <p className="ct-small ct-muted" style={{ marginTop: 24 }}>
          Looking for the audience screens? <a href="#/stage">Open booth mode</a>
        </p>
      </main>
    </div>
  );
}
