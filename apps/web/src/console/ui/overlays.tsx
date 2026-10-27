// Overlays: Drawer, Modal, ConfirmDialog (reason required for consequential actions), Toasts, Popover menu.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { errorMessage } from '../lib/http';
import { reasonError } from '../lib/reason';
import { useDismiss } from './hooks';
import { Icon } from './Icon';
import { Banner, Button, Field, Textarea, cx, type ButtonVariant } from './primitives';

/** Portal into the console root so overlays keep the console's theme tokens. */
function Portal({ children }: { children: ReactNode }) {
  const host = typeof document !== 'undefined' ? (document.querySelector('.ct-console') ?? document.body) : null;
  return host ? createPortal(children, host) : <>{children}</>;
}

function useEscape(active: boolean, onEscape: () => void) {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cb.current();
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  }, [active]);
}

/** Focus the first focusable element on open; restore focus on close. */
function useFocusOnOpen(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('textarea, input, select, button:not([data-close]), [tabindex="0"]');
    (first ?? el)?.focus();
    return () => prev?.focus?.();
  }, [ref]);
}

export function Drawer({ open, title, subtitle, onClose, children, actions, width }: { open: boolean; title: ReactNode; subtitle?: ReactNode; onClose(): void; children: ReactNode; actions?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <Portal>
      <div className="ct-drawer-backdrop" onClick={onClose} />
      <div ref={ref} className="ct-drawer" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} style={width ? { width: `min(${width}px, 94vw)` } : undefined}>
        <div className="ct-drawer-head">
          <div style={{ minWidth: 0 }}>
            <h2 className="ct-drawer-title">{title}</h2>
            {subtitle && <div className="ct-muted ct-small">{subtitle}</div>}
          </div>
          <div className="ct-row">
            {actions}
            <button type="button" className="ct-icon-btn" onClick={onClose} aria-label="Close" data-close>
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="ct-drawer-body">{children}</div>
      </div>
    </Portal>
  );
}

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: ReactNode; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return <ModalInner title={title} onClose={onClose} footer={footer} wide={wide}>{children}</ModalInner>;
}

function ModalInner({ title, onClose, children, footer, wide }: { title: ReactNode; onClose(): void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEscape(true, onClose);
  useFocusOnOpen(ref);
  return (
    <Portal>
      <div className="ct-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={ref} className={cx('ct-modal', wide && 'ct-modal-wide')} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
          <div className="ct-modal-head">
            <h2 id={titleId} className="ct-modal-title">
              {title}
            </h2>
          </div>
          <div className="ct-modal-body">{children}</div>
          {footer && <div className="ct-modal-foot">{footer}</div>}
        </div>
      </div>
    </Portal>
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  /** What will happen (shown above the reason field). */
  description?: ReactNode;
  confirmLabel?: string;
  variant?: ButtonVariant;
  /** Ask for a reason (written to the audit trail). Default true. */
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  /** Minimum reason length (default 5). */
  minReason?: number;
  onCancel(): void;
  /** Throw to show the error inside the dialog; resolve to close it. */
  onConfirm(reason: string): Promise<void> | void;
}

export { reasonError };

export function ConfirmDialog(props: ConfirmDialogProps) {
  if (!props.open) return null;
  return <ConfirmInner {...props} />;
}

function ConfirmInner({ title, description, confirmLabel = 'Confirm', variant = 'primary', requireReason = true, reasonLabel = 'Reason', reasonPlaceholder = 'Why are you doing this? This is recorded in the audit log.', minReason = 5, onCancel, onConfirm }: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalid = requireReason ? reasonError(reason, minReason) : null;
  const submit = async () => {
    setTouched(true);
    if (invalid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <ModalInner
      title={title}
      onClose={() => !busy && onCancel()}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant={variant} loading={busy} onClick={() => void submit()} disabled={touched && !!invalid}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description && <div className="ct-muted" style={{ color: 'var(--ct-text-2)' }}>{description}</div>}
      {requireReason && (
        <Field label={reasonLabel} required error={touched ? invalid : null} hint="Recorded in the audit log with your name and role.">
          {(id) => (
            <Textarea
              id={id}
              value={reason}
              maxLength={500}
              placeholder={reasonPlaceholder}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
              }}
            />
          )}
        </Field>
      )}
      {error && <Banner tone="bad">{error}</Banner>}
    </ModalInner>
  );
}

// ---------------------------------------------------------------------------------------------- toasts

export type ToastTone = 'info' | 'ok' | 'warn' | 'bad';
export interface ToastInput {
  title: string;
  body?: ReactNode;
  tone?: ToastTone;
  /** Optional link (e.g. "View audit entry"). */
  action?: { label: string; href: string };
  durationMs?: number;
}
interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  show(t: ToastInput): void;
  success(title: string, body?: ReactNode, action?: ToastInput['action']): void;
  error(title: string, err?: unknown): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.durationMs ?? (t.tone === 'bad' ? 8000 : 5000));
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, body, action) => show({ title, body, action, tone: 'ok' }),
      error: (title, err) => show({ title, body: err === undefined ? undefined : errorMessage(err), tone: 'bad' }),
    }),
    [show],
  );
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ct-toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={cx('ct-toast', t.tone && t.tone !== 'info' && `ct-toast-${t.tone}`)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="ct-toast-title">{t.title}</div>
              {t.body && <div className="ct-toast-body">{t.body}</div>}
              {t.action && (
                <a className="ct-small" href={t.action.href} onClick={() => dismiss(t.id)}>
                  {t.action.label} →
                </a>
              )}
            </div>
            <button type="button" className="ct-icon-btn" style={{ width: 24, height: 24 }} onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

const noopToast: ToastApi = { show: () => undefined, success: () => undefined, error: () => undefined };

export function useToast(): ToastApi {
  return useContext(ToastContext) ?? noopToast;
}

// ---------------------------------------------------------------------------------------------- popover

/** Button + popover panel that closes on outside click / Escape. */
export function Popover({ trigger, children, align = 'right', open, onOpenChange, width }: { trigger: (p: { open: boolean; toggle(): void }) => ReactNode; children: ReactNode | ((close: () => void) => ReactNode); align?: 'left' | 'right'; open?: boolean; onOpenChange?(open: boolean): void; width?: number }) {
  const [own, setOwn] = useState(false);
  const isOpen = open ?? own;
  const set = useCallback((v: boolean) => (onOpenChange ? onOpenChange(v) : setOwn(v)), [onOpenChange]);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, isOpen, () => set(false));
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      {trigger({ open: isOpen, toggle: () => set(!isOpen) })}
      {isOpen && (
        <div className={cx('ct-popover', align === 'right' && 'ct-popover-right')} style={width ? { width } : undefined}>
          {typeof children === 'function' ? children(() => set(false)) : children}
        </div>
      )}
    </div>
  );
}
