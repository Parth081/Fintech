// Notifications bell: urgent cases, approvals waiting for my role, reconciliation breaks.
import { useMemo } from 'react';
import { unseenCount } from '../lib/notifications';
import { useSession } from '../session';
import { DateTime, EmptyState, Icon, Popover, useLocalStorage } from '../ui';
import type { Attention } from './useAttention';

export function Notifications({ attention }: { attention: Attention }) {
  const { user } = useSession();
  const [seen, setSeen] = useLocalStorage<string[]>(`ct.console.seen.${user?.id ?? 'anon'}`, []);
  const notices = attention.notices;
  const unseen = unseenCount(notices, seen);
  const groups = useMemo(() => {
    const m = new Map<string, typeof notices>();
    for (const n of notices) m.set(n.group, [...(m.get(n.group) ?? []), n]);
    return [...m.entries()];
  }, [notices]);
  return (
    <Popover
      width={380}
      trigger={({ open, toggle }) => (
        <button type="button" className="ct-icon-btn" aria-label={`Notifications${unseen ? ` (${unseen} new)` : ''}`} aria-expanded={open} onClick={toggle}>
          <Icon name="bell" />
          {unseen > 0 && <span className="ct-icon-btn-badge">{unseen > 9 ? '9+' : unseen}</span>}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="ct-popover-head">
            <span>Notifications</span>
            {notices.length > 0 && (
              <button type="button" className="ct-link-btn ct-small" onClick={() => setSeen(notices.map((n) => n.id).slice(-200))}>
                Mark all as read
              </button>
            )}
          </div>
          <div className="ct-menu-scroll">
            {notices.length === 0 ? (
              <EmptyState icon="check" title="You're all caught up">
                No urgent cases, approvals or breaks need you right now.
              </EmptyState>
            ) : (
              groups.map(([g, list]) => (
                <div key={g}>
                  <div className="ct-popover-section">{g}</div>
                  {list.map((n) => (
                    <a
                      key={n.id}
                      className="ct-menu-item"
                      href={n.href}
                      onClick={() => {
                        setSeen((s) => (s.includes(n.id) ? s : [...s, n.id].slice(-200)));
                        close();
                      }}
                    >
                      <span className="ct-dot" style={{ color: `var(--ct-${n.tone === 'accent' ? 'accent' : n.tone === 'neutral' ? 'text-3' : n.tone})`, opacity: seen.includes(n.id) ? 0.3 : 1 }} aria-hidden="true" />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: seen.includes(n.id) ? 400 : 600 }}>{n.title}</span>
                        <small className="ct-ellipsis">{n.body}</small>
                      </span>
                      <small>
                        <DateTime value={n.at || null} relative />
                      </small>
                    </a>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}
