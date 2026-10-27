// Console design-system primitives over theme.css (ct-* classes). Every console page builds from these.
import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import type { Money as MoneyValue } from '@ct/contracts/browser';
import { formatDateTime, formatMoney, formatRelative } from '../lib/format';
import { statusStyle, type StatusKind, type Tone } from '../lib/status';
import { Icon, type IconName } from './Icon';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');
export { cx };

// ---------------------------------------------------------------------------------------------- layout

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('ct-page', className)}>{children}</div>;
}

export interface Crumb {
  label: string;
  href?: string;
}

export function PageHeader({
  title,
  subtitle,
  breadcrumbs,
  actions,
  badge,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumbs?: Crumb[];
  actions?: ReactNode;
  /** Shown next to the title (e.g. a StatusBadge). */
  badge?: ReactNode;
}) {
  return (
    <header className="ct-page-header">
      <div className="ct-page-header-main">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav className="ct-breadcrumb" aria-label="Breadcrumb">
            {breadcrumbs.map((c, i) => (
              <span key={i}>
                {i > 0 && <span aria-hidden="true"> / </span>}
                {c.href ? <a href={c.href}>{c.label}</a> : <span>{c.label}</span>}
              </span>
            ))}
          </nav>
        )}
        <div className="ct-page-title-row">
          <h1 className="ct-page-title">{title}</h1>
          {badge}
        </div>
        {subtitle && <p className="ct-page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="ct-page-actions">{actions}</div>}
    </header>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  footer,
  flush,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** No body padding (tables). */
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={cx('ct-card', className)}>
      {(title || actions) && (
        <div className="ct-card-header">
          <div>
            {title && <h2 className="ct-card-title">{title}</h2>}
            {subtitle && <p className="ct-card-sub">{subtitle}</p>}
          </div>
          {actions && <div className="ct-row">{actions}</div>}
        </div>
      )}
      {flush ? children : <div className="ct-card-body">{children}</div>}
      {footer && <div className="ct-card-footer">{footer}</div>}
    </section>
  );
}

export function MetricCard({
  label,
  value,
  hint,
  tone,
  href,
  loading,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
  href?: string;
  loading?: boolean;
}) {
  const body = (
    <div className="ct-metric">
      <div className="ct-metric-label">{label}</div>
      {loading ? (
        <Skeleton height={30} width="60%" style={{ marginTop: 6 }} />
      ) : (
        <div className={cx('ct-metric-value', tone && `ct-tone-${tone}`)}>{value}</div>
      )}
      {hint && <div className="ct-metric-delta">{hint}</div>}
    </div>
  );
  return href ? (
    <a className="ct-card ct-metric-link" href={href}>
      {body}
    </a>
  ) : (
    <div className="ct-card">{body}</div>
  );
}

// ---------------------------------------------------------------------------------------------- badges

export function Badge({ tone = 'neutral', children, dot, title }: { tone?: Tone; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span className={cx('ct-badge', tone !== 'neutral' && `ct-badge-${tone}`)} title={title}>
      {dot && <span className="ct-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Status pill for payment status / severity / case / change / break / refund / delivery values. */
export function StatusBadge({ kind, value, dot = true }: { kind: StatusKind; value: string; dot?: boolean }) {
  const s = statusStyle(kind, value);
  return (
    <Badge tone={s.tone} dot={dot}>
      {s.label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------------------------- controls

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  icon?: IconName;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, loading, children, className, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'ct-btn',
        variant !== 'default' && `ct-btn-${variant}`,
        size === 'sm' && 'ct-btn-sm',
        !children && icon && 'ct-btn-icon',
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="ct-spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
});

/** Anchor styled as a button (navigation). */
export function LinkButton({ href, children, variant = 'default', size = 'md', icon }: { href: string; children?: ReactNode; variant?: ButtonVariant; size?: 'md' | 'sm'; icon?: IconName }) {
  return (
    <a className={cx('ct-btn', variant !== 'default' && `ct-btn-${variant}`, size === 'sm' && 'ct-btn-sm')} href={href}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </a>
  );
}

/** Label + control + hint/error. Pass the control as children; `htmlFor` defaults to the generated id via render prop. */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  id,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode | ((id: string) => ReactNode);
  id?: string;
}) {
  const auto = useId();
  const fid = id ?? auto;
  return (
    <div className="ct-field">
      <label className="ct-label" htmlFor={fid}>
        {label}
        {required && (
          <span className="ct-required" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {typeof children === 'function' ? children(fid) : children}
      {error ? <span className="ct-field-error">{error}</span> : hint ? <span className="ct-field-hint">{hint}</span> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { compact?: boolean }>(function Input(
  { className, compact, ...rest },
  ref,
) {
  return <input ref={ref} className={cx('ct-input', compact && 'ct-input-sm', className)} {...rest} />;
});

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({
  options,
  className,
  compact,
  placeholder,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { options: readonly SelectOption[]; compact?: boolean; placeholder?: string }) {
  return (
    <select className={cx('ct-select', compact && 'ct-input-sm', className)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx('ct-textarea', className)} {...rest} />;
});

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className="ct-check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export interface TabItem {
  id: string;
  label: ReactNode;
  count?: number;
  hidden?: boolean;
}

export function Tabs({ tabs, active, onChange, label = 'Sections' }: { tabs: readonly TabItem[]; active: string; onChange(id: string): void; label?: string }) {
  const visible = tabs.filter((t) => !t.hidden);
  return (
    <div className="ct-tabs" role="tablist" aria-label={label}>
      {visible.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          className="ct-tab"
          aria-selected={t.id === active}
          tabIndex={t.id === active ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            const i = visible.findIndex((x) => x.id === t.id);
            const next = visible[(i + (e.key === 'ArrowRight' ? 1 : visible.length - 1)) % visible.length];
            if (next) onChange(next.id);
          }}
        >
          {t.label}
          {t.count !== undefined && <span className="ct-tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- display

export interface KeyValue {
  label: ReactNode;
  value: ReactNode;
  hidden?: boolean;
}

export function KeyValueList({ items, className }: { items: readonly KeyValue[]; className?: string }) {
  return (
    <dl className={cx('ct-kv', className)}>
      {items
        .filter((i) => !i.hidden)
        .map((i, idx) => (
          <div key={idx} style={{ display: 'contents' }}>
            <dt>{i.label}</dt>
            <dd>{i.value === null || i.value === undefined || i.value === '' ? <span className="ct-muted">—</span> : i.value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Formatted money, tabular numbers. Put it in a .ct-num cell for right alignment. */
export function Money({ value, className }: { value: MoneyValue | null | undefined; className?: string }) {
  return <span className={cx('ct-num', className)}>{formatMoney(value)}</span>;
}

/** Absolute local date-time with the relative age in the tooltip (or inline with `relative`). */
export function DateTime({ value, relative, now, seconds }: { value: string | number | null | undefined; relative?: boolean; now?: number; seconds?: boolean }) {
  if (value === null || value === undefined || value === '') return <span className="ct-muted">—</span>;
  const abs = formatDateTime(value, { seconds });
  const rel = formatRelative(value, now ?? Date.now());
  const iso = typeof value === 'number' ? new Date(value).toISOString() : value;
  return (
    <time dateTime={iso} title={relative ? abs : rel} style={{ whiteSpace: 'nowrap' }}>
      {relative ? rel : abs}
    </time>
  );
}

export function Skeleton({ width = '100%', height = 14, style, lines }: { width?: number | string; height?: number; style?: CSSProperties; lines?: number }) {
  if (lines && lines > 1) {
    return (
      <div className="ct-stack-sm" aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="ct-skeleton" style={{ width: i === lines - 1 ? '60%' : width, height }} />
        ))}
      </div>
    );
  }
  return <div className="ct-skeleton" aria-hidden="true" style={{ width, height, ...style }} />;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="ct-row ct-muted" role="status">
      <span className="ct-spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function EmptyState({ title, children, icon = 'info', actions }: { title: ReactNode; children?: ReactNode; icon?: IconName; actions?: ReactNode }) {
  return (
    <div className="ct-empty">
      <div className="ct-empty-icon">
        <Icon name={icon} size={20} />
      </div>
      <div className="ct-empty-title">{title}</div>
      {children && <div>{children}</div>}
      {actions && <div className="ct-empty-actions">{actions}</div>}
    </div>
  );
}

/** Error panel: 403 renders as a permission notice, everything else with a retry. */
export function ErrorState({ error, onRetry, forbidden }: { error: string; onRetry?: () => void; forbidden?: boolean }) {
  return (
    <EmptyState
      icon={forbidden ? 'shield' : 'alert'}
      title={forbidden ? 'Access restricted' : 'Could not load this data'}
      actions={onRetry && !forbidden ? <Button size="sm" icon="refresh" onClick={onRetry}>Try again</Button> : undefined}
    >
      {error}
    </EmptyState>
  );
}

export function Banner({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad' | 'neutral'; children: ReactNode }) {
  return (
    <div className={cx('ct-banner', tone !== 'neutral' && `ct-banner-${tone}`)} role={tone === 'bad' ? 'alert' : undefined}>
      {children}
    </div>
  );
}

export interface TimelineItem {
  id: string;
  title: ReactNode;
  meta?: ReactNode;
  body?: ReactNode;
  tone?: Tone;
}

export function Timeline({ items, empty = 'Nothing yet' }: { items: readonly TimelineItem[]; empty?: ReactNode }) {
  if (items.length === 0) return <div className="ct-muted">{empty}</div>;
  return (
    <ol className="ct-timeline">
      {items.map((i) => (
        <li key={i.id} className="ct-timeline-item">
          <span className={cx('ct-timeline-dot', i.tone && i.tone !== 'neutral' && `ct-tone-${i.tone}`)} aria-hidden="true" />
          <div className="ct-timeline-head">
            <span className="ct-timeline-title">{i.title}</span>
            {i.meta && <span className="ct-timeline-meta">{i.meta}</span>}
          </div>
          {i.body && <div className="ct-timeline-body">{i.body}</div>}
        </li>
      ))}
    </ol>
  );
}

export function Avatar({ initials, large }: { initials: string; large?: boolean }) {
  return (
    <span className={cx('ct-avatar', large && 'ct-avatar-lg')} aria-hidden="true">
      {initials}
    </span>
  );
}

/** Horizontal stacked proportion bar. */
export function StackedBar({ parts, label }: { parts: { value: number; tone: Tone; label: string }[]; label: string }) {
  const total = parts.reduce((a, p) => a + Math.max(0, p.value), 0);
  return (
    <div className="ct-bar" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}`}>
      {total > 0 && parts.map((p, i) => (p.value > 0 ? <span key={i} className={`ct-fill-${p.tone}`} style={{ width: `${(p.value / total) * 100}%` }} /> : null))}
    </div>
  );
}
