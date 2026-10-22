import type { ConnectionStatus } from '../lib/types';

const CONNECTION_TEXT: Record<ConnectionStatus, string> = {
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  polling: 'Polling (WebSocket down)',
  offline: 'Offline',
};

export function Header({ connection }: { connection: ConnectionStatus }) {
  return (
    <header className="header">
      <div className="header-title">
        <h1>Global Fintech Control Tower</h1>
        <span className="milestone">M1 walking skeleton</span>
      </div>
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
