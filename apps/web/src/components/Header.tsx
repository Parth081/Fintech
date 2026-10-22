import { hashFor, VIEW_LABELS, VIEWS, type View } from '../lib/route';
import type { ConnectionStatus } from '../lib/types';

const CONNECTION_TEXT: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  polling: 'Polling (WebSocket down)',
  offline: 'Offline',
};

export function Header({ connection, view }: { connection: ConnectionStatus; view: View }) {
  return (
    <header className="header">
      <div className="header-title">
        <h1>Global Fintech Control Tower</h1>
        <span className="milestone">M2 money core</span>
      </div>
      <nav className="nav" aria-label="Views">
        {VIEWS.map((v) => (
          <a key={v} href={hashFor(v)} className={`nav-link${v === view ? ' nav-active' : ''}`} aria-current={v === view ? 'page' : undefined}>
            {VIEW_LABELS[v]}
          </a>
        ))}
      </nav>
      <div className="header-right">
        <span className="sim-badge" title="Every payment, party, provider and rate on this screen is fictional">
          SIMULATION · SYNTHETIC DATA
        </span>
        <span className={`conn conn-${connection}`} role="status" aria-live="polite">
          <span className="conn-dot" aria-hidden="true" />
          {CONNECTION_TEXT[connection]}
        </span>
      </div>
    </header>
  );
}
