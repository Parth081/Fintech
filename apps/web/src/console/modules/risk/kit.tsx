// Local UI kit for the Risk, Treasury and Config modules: thin React wrappers over the console design system
// (theme.css ct-* classes + kit.css ctm-* additions). Kept local so these modules build independently of the
// shell's ui/ primitives; the API mirrors them (PageHeader, Card, MetricCard, Badge, Button, Tabs, Modal,
// Drawer, Timeline, KeyValueList, EmptyState, Skeleton, toasts) so swapping later is mechanical.
import { useEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Money as MoneyT, Permission } from '@ct/contracts/browser';
import { Icon, type IconName } from '../../ui/Icon';
import { formatDateTime, formatMoney, formatRelative } from '../../lib/format';
import { statusStyle, type StatusKind, type Tone } from '../../lib/status';
import { opsApi, type ConsoleApiError } from '../../api';
import { useToast } from '../../ui/overlays';
import { links } from '../../route';
import './kit.css';

export type { Tone };

// ---------------------------------------------------------------------------------------------- gates

export interface Gate {
  allowed: boolean;
  /** Tooltip when not allowed: the missing permission or the workflow rule. */
  reason?: string;
}

export const OK: Gate = { allowed: true };

export function permGate(can: (p: Permission) => boolean, p: Permission): Gate {
  return can(p) ? OK : { allowed: false, reason: `Requires permission ${p}` };
}

// ---------------------------------------------------------------------------------------------- badges

export function Badge({ tone = 'neutral', children, title, dot }: { tone?: Tone; children: ReactNode; title?: string; dot?: boolean }) {
  return (
    <span className={`ct-badge${tone === 'neutral' ? '' : ` ct-badge-${tone}`}`} title={title}>
      {dot && <span className="ct-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function StatusBadge({ kind, value, title }: { kind: StatusKind; value: string; title?: string }) {
  const s = statusStyle(kind, value);
  return (
    <Badge tone={s.tone} dot={kind === 'severity'} title={title}>
      {s.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------------------------- buttons

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  icon?: IconName;
  gate?: Gate;
  busy?: boolean;
};

/** Button that is disabled (with a tooltip naming the missing permission / rule) when `gate` is not allowed. */
export function Button({ variant = 'default', size = 'md', icon, gate, busy, disabled, children, className, title, type, ...rest }: BtnProps) {
  const blocked = gate !== undefined && !gate.allowed;
  const cls = ['ct-btn', variant !== 'default' ? `ct-btn-${variant}` : '', size === 'sm' ? 'ct-btn-sm' : '', className ?? ''].filter(Boolean).join(' ');
  const btn = (
    <button type={type ?? 'button'} className={cls} disabled={disabled || blocked || busy} aria-busy={busy || undefined} title={blocked ? undefined : title} {...rest}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {busy ? 'Working…' : children}
    </button>
  );
  // Disabled buttons swallow hover in some browsers: put the tooltip on a wrapper.
  return blocked ? (
    <span className="ctm-gate" title={gate.reason}>
      {btn}
    </span>
  ) : (
    btn
  );
}

// ---------------------------------------------------------------------------------------------- layout

export function PageHeader({ title, subtitle, breadcrumb, actions }: { title: ReactNode; subtitle?: ReactNode; breadcrumb?: { label: string; href?: string }[]; actions?: ReactNode }) {
  return (
    <div className="ct-page-header">
      <div className="ctm-grow">
        {breadcrumb && breadcrumb.length > 0 && (
          <nav className="ct-breadcrumb" aria-label="Breadcrumb">
            {breadcrumb.map((b, i) => (
              <span key={i}>
                {i > 0 && ' / '}
                {b.href ? <a href={b.href}>{b.label}</a> : b.label}
              </span>
            ))}
          </nav>
        )}
        <h1 className="ct-page-title">{title}</h1>
        {subtitle && <p className="ct-page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="ctm-row">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, flush, className, id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; id?: string }) {
  return (
    <section className={`ct-card${className ? ` ${className}` : ''}`} id={id}>
      {(title || actions) && (
        <header className="ct-card-header">
          <div>
            {title && <h2 className="ct-card-title">{title}</h2>}
            {subtitle && <div className="ct-muted ctm-small">{subtitle}</div>}
          </div>
          {actions && <div className="ctm-row">{actions}</div>}
        </header>
      )}
      {flush ? children : <div className="ct-card-body">{children}</div>}
    </section>
  );
}

export function MetricCard({ label, value, delta, tone, title }: { label: string; value: ReactNode; delta?: ReactNode; tone?: Tone; title?: string }) {
  const color = tone === 'bad' ? 'var(--ct-bad)' : tone === 'warn' ? 'var(--ct-warn)' : tone === 'ok' ? 'var(--ct-ok)' : undefined;
  return (
    <div className="ct-card ct-metric" title={title}>
      <div className="ct-metric-label">{label}</div>
      <div className="ct-metric-value" style={color ? { color } : undefined}>
        {value}
      </div>
      {delta && <div className="ct-metric-delta">{delta}</div>}
    </div>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: string;
  count?: number;
  hidden?: boolean;
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: readonly TabDef<T>[]; value: T; onChange(id: T): void; label?: string }) {
  return (
    <div className="ct-tabs" role="tablist" aria-label={label}>
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button key={t.id} type="button" role="tab" className="ct-tab" aria-selected={t.id === value} onClick={() => onChange(t.id)}>
            {t.label}
            {t.count !== undefined && <span className="ctm-chip-count"> {t.count}</span>}
          </button>
        ))}
    </div>
  );
}

export function KeyValueList({ items }: { items: readonly (readonly [string, ReactNode] | null | false)[] }) {
  return (
    <dl className="ctm-kv">
      {items
        .filter((x): x is readonly [string, ReactNode] => !!x)
        .map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <dt>{k}</dt>
            <dd>{v ?? '—'}</dd>
          </div>
        ))}
    </dl>
  );
}

export interface TimelineItem {
  at: string;
  title: ReactNode;
  detail?: ReactNode;
  actor?: string;
  tone?: Tone;
}

export function Timeline({ items, now }: { items: readonly TimelineItem[]; now?: number }) {
  if (!items.length) return <EmptyState title="No history yet" />;
  return (
    <ol className="ctm-timeline">
      {items.map((h, i) => (
        <li key={i}>
          <span className={`ctm-timeline-dot ctm-tone-${h.tone ?? 'neutral'}`} aria-hidden="true" />
          <div className="ctm-strong">{h.title}</div>
          <div className="ct-muted ctm-small">
            <DateTime iso={h.at} now={now} />
            {h.actor ? ` · ${h.actor}` : ''}
          </div>
          {h.detail && <div className="ctm-small" style={{ marginTop: 2, color: 'var(--ct-text-2)', overflowWrap: 'anywhere' }}>{h.detail}</div>}
        </li>
      ))}
    </ol>
  );
}

// ---------------------------------------------------------------------------------------------- values

export function Money({ value, className }: { value: MoneyT | null | undefined; className?: string }) {
  return <span className={`ct-num${className ? ` ${className}` : ''}`}>{formatMoney(value)}</span>;
}

/** Absolute time with the relative time as tooltip (or vice versa when `relative`). */
export function DateTime({ iso, now, relative }: { iso: string | null | undefined; now?: number; relative?: boolean }) {
  if (!iso) return <span className="ct-muted">—</span>;
  const abs = formatDateTime(iso);
  const rel = formatRelative(iso, now ?? Date.now());
  return (
    <time dateTime={iso} title={relative ? abs : rel}>
      {relative ? rel : abs}
    </time>
  );
}

export function Avatar({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]!.toUpperCase())
    .join('');
  return (
    <span className="ctm-avatar" aria-hidden="true">
      {initials || '?'}
    </span>
  );
}

// ---------------------------------------------------------------------------------------------- states

export function EmptyState({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ct-empty">
      <div className="ctm-strong" style={{ color: 'var(--ct-text-2)' }}>
        {title}
      </div>
      {hint && <div className="ctm-small" style={{ marginTop: 4 }}>{hint}</div>}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry, forbidden }: { error: string; onRetry?: () => void; forbidden?: boolean }) {
  return (
    <div className={`ct-banner ${forbidden ? 'ct-banner-warn' : 'ct-banner-bad'}`} role="alert" style={{ margin: 12 }}>
      <div className="ctm-between">
        <span>{error}</span>
        {onRetry && !forbidden && (
          <Button size="sm" icon="refresh" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    </div>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { width?: number | string; height?: number }) {
  return <div className="ct-skeleton" style={{ width, height }} />;
}

export function LoadingRows({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <tbody aria-busy="true">
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <td key={c}>
              <Skeleton width={c === 0 ? 70 : '80%'} />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export function LoadingBlock({ lines = 4 }: { lines?: number }) {
  return (
    <div className="ctm-stack" aria-busy="true" style={{ gap: 10 }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={`${90 - i * 12}%`} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- overlays

function useEscape(onClose: () => void, active = true) {
  const cb = useRef(onClose);
  cb.current = onClose;
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [active]);
}

export function Modal({ title, children, footer, onClose, wide }: { title: ReactNode; children: ReactNode; footer?: ReactNode; onClose(): void; wide?: boolean }) {
  useEscape(onClose);
  return (
    <div className="ct-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`ct-modal${wide ? ' ctm-modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="ctm-modal-head ctm-between">
          <h2 className="ct-card-title" style={{ fontSize: 16 }}>
            {title}
          </h2>
          <Button variant="ghost" size="sm" icon="x" aria-label="Close" onClick={onClose} />
        </div>
        <div className="ctm-modal-body">{children}</div>
        {footer && <div className="ctm-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Confirmation with a free-text reason/comment. `minLength` 0 makes the text optional. `onConfirm` may throw:
 * the error is shown in the dialog and the dialog stays open.
 */
export function ReasonDialog({
  title,
  description,
  label = 'Reason',
  placeholder,
  confirmLabel,
  variant = 'primary',
  minLength = 10,
  children,
  onConfirm,
  onClose,
}: {
  title: string;
  description?: ReactNode;
  label?: string;
  placeholder?: string;
  confirmLabel: string;
  variant?: 'primary' | 'danger';
  minLength?: number;
  children?: ReactNode;
  onConfirm(text: string): Promise<void>;
  onClose(): void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const t = text.trim();
  const invalid = minLength > 0 ? (!t ? `${label} is required` : t.length < minLength ? `Please write at least ${minLength} characters` : null) : null;
  const submit = async () => {
    setTouched(true);
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(t);
      onClose();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant={variant} onClick={() => void submit()} busy={busy} disabled={touched && !!invalid}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <div style={{ color: 'var(--ct-text-2)' }}>{description}</div>}
      {children}
      <label className="ct-field">
        <span className="ct-label">
          {label}
          {minLength > 0 ? ' (required)' : ' (optional)'}
        </span>
        <textarea
          className="ct-textarea"
          value={text}
          autoFocus
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => setTouched(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
          }}
          aria-invalid={touched && !!invalid}
        />
        {touched && invalid && <span className="ctm-error-text">{invalid}</span>}
      </label>
      {error && (
        <div className="ct-banner ct-banner-bad" role="alert">
          {error}
        </div>
      )}
    </Modal>
  );
}

export function Drawer({ title, subtitle, onClose, children, actions }: { title: ReactNode; subtitle?: ReactNode; onClose(): void; children: ReactNode; actions?: ReactNode }) {
  useEscape(onClose);
  return (
    <>
      <div className="ctm-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="ct-drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="ctm-drawer-head">
          <div className="ctm-grow">
            <h2 className="ct-card-title" style={{ fontSize: 16 }}>
              {title}
            </h2>
            {subtitle && <div className="ct-muted ctm-small" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          {actions}
          <Button variant="ghost" size="sm" icon="x" aria-label="Close" onClick={onClose} />
        </div>
        <div className="ctm-drawer-body">{children}</div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- toasts

export interface ToastMsg {
  id: number;
  tone: 'ok' | 'bad' | 'warn' | 'info';
  title: string;
  detail?: string;
  ms?: number;
  href?: string;
  hrefLabel?: string;
}

// Toasts go through the console shell's ToastProvider (useToast). toast() can be called from anywhere (async
// handlers that finish after a dialog closed): messages queue here and the module's <ToastHost/> forwards them.
let pending: ToastMsg[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(t: Omit<ToastMsg, 'id'>, ms = 6000): void {
  pending = [...pending, { ...t, id: nextId++, ms }];
  emit();
}

/** Readable message for an API error; a four-eyes 403 (code FOUR_EYES) shows the rule, not "no permission". */
export function describeError(err: unknown): string {
  const body = typeof err === 'object' && err !== null ? (err as { body?: unknown }).body : undefined;
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    if (b.code === 'FOUR_EYES') return `Four-eyes rule: ${typeof b.error === 'string' ? b.error : typeof b.message === 'string' ? b.message : 'another person must review this'}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export function toastError(err: unknown, title = 'Action failed'): void {
  toast({ tone: 'bad', title, detail: describeError(err) }, 9000);
}

/** Render once per module root page: forwards queued toasts to the shell's toast stack. */
export function ToastHost() {
  const shell = useToast();
  const queued = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending,
    () => pending,
  );
  useEffect(() => {
    if (!queued.length) return;
    pending = [];
    for (const t of queued) shell.show({ title: t.title, body: t.detail, tone: t.tone, durationMs: t.ms, ...(t.href ? { action: { label: t.hrefLabel ?? 'Open', href: t.href } } : {}) });
  }, [queued, shell]);
  return null;
}

/**
 * Reference of the audit entry an action just wrote ("audit AUD-… · event …"), looked up after the mutation:
 * the audit log when the user may read it, else the payment's operator-activity feed. Best effort ('' on failure).
 */
export async function latestAuditRef(target: AuditTarget, can: (p: Permission) => boolean): Promise<string> {
  const entry = await latestAudit(target, can);
  return entry ? [`audit ${entry.id}`, entry.eventId ? `event ${entry.eventId}` : null].filter(Boolean).join(' · ') : '';
}

type AuditTarget = { type: string; id: string; paymentId?: string };

async function latestAudit(target: AuditTarget, can: (p: Permission) => boolean): Promise<{ id: string; eventId?: string } | undefined> {
  try {
    let entry: { id: string; eventId?: string; target: { type: string; id: string } } | undefined;
    if (can('audit.read')) {
      const page = await opsApi.audit({ targetType: target.type, targetId: target.id, limit: 1 });
      entry = page.items[0];
    }
    if (!entry && target.paymentId && can('payments.read')) {
      const list = await opsApi.activity(target.paymentId);
      entry = list.find((e) => e.target.type === target.type && e.target.id === target.id) ?? list[0];
    }
    return entry;
  } catch {
    return undefined;
  }
}

/** Success toast carrying the audit reference (and a link to the audit entry when the user may read the log). */
export async function toastDone(title: string, target: AuditTarget, can: (p: Permission) => boolean, detail?: string): Promise<void> {
  const entry = await latestAudit(target, can);
  const ref = entry ? [`audit ${entry.id}`, entry.eventId ? `event ${entry.eventId}` : null].filter(Boolean).join(' · ') : '';
  toast({
    tone: 'ok',
    title,
    detail: [detail, ref].filter(Boolean).join(' · ') || undefined,
    ...(entry && can('audit.read') ? { href: links.auditEntry(entry.id), hrefLabel: 'View audit entry' } : {}),
  });
}

export function isForbiddenError(err: unknown): err is ConsoleApiError {
  return typeof err === 'object' && err !== null && (err as { kind?: string }).kind === 'forbidden';
}
