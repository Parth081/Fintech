// Follows one payment live: polls the gateway, reveals one plain-English step at a time, then shows the
// value moment ("Delivered · Ledger balanced ✓") and the next actions.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AnyEvent, PaymentStatus } from '@ct/contracts/browser';
import { fetchPayment } from './api';
import { explainEvents, isTerminal, ledgerBalanced, outcomeOf, revealNext, type KioskStep } from './explain';
import type { KioskMode, Outcome } from './flow';

const POLL_MS = 700;
const REVEAL_GAP_MS = 1100;
const SLOW_AFTER_MS = 45_000;

interface Props {
  paymentId: string;
  mode: KioskMode;
  done: boolean;
  outcome: Outcome | null;
  canAsk: boolean;
  canFollowUp: boolean;
  completed: KioskMode[];
  onSteps: (steps: KioskStep[]) => void;
  onFinished: (outcome: Outcome) => void;
  onAsk: (stepId: string) => void;
  onLead: () => void;
  onAgain: (mode: KioskMode) => void;
  onFinish: () => void;
}

export function Tracker(p: Props) {
  const { paymentId, onSteps, onFinished, done } = p;
  const [events, setEvents] = useState<AnyEvent[]>([]);
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [shown, setShown] = useState(0);
  const [slow, setSlow] = useState(false);
  const lastReveal = useRef(0);
  const startedAt = useRef(Date.now());

  const steps = useMemo(() => explainEvents(events), [events]);
  useEffect(() => onSteps(steps), [steps, onSteps]);

  const terminal = status !== null && isTerminal(status);

  // Poll until the payment reaches a final state.
  useEffect(() => {
    if (terminal) return;
    let alive = true;
    const ctrl = new AbortController();
    const tick = async () => {
      try {
        const d = await fetchPayment(paymentId, ctrl.signal);
        if (!alive) return;
        setEvents(d.events);
        setStatus(d.state.status);
      } catch {
        /* not projected yet, or a blip: keep polling */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(t);
    };
  }, [paymentId, terminal]);

  // Reveal steps at reading pace; report the outcome once everything is shown.
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setShown((s) => {
        const r = revealNext(steps.length, s, lastReveal.current, now, REVEAL_GAP_MS);
        lastReveal.current = r.lastRevealAt;
        return r.shown;
      });
      if (!terminal && now - startedAt.current > SLOW_AFTER_MS) setSlow(true);
    }, 200);
    return () => clearInterval(t);
  }, [steps.length, terminal]);

  const allShown = shown >= steps.length && steps.length > 0;
  useEffect(() => {
    if (done || !terminal || !allShown || !status) return;
    const t = setTimeout(() => onFinished(outcomeOf(status)), 900);
    return () => clearTimeout(t);
  }, [done, terminal, allShown, status, onFinished]);

  // Keep the newest step in view.
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current?.lastElementChild;
    if (el && 'scrollIntoView' in el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [shown]);

  const visible = steps.slice(0, shown);
  const balanced = ledgerBalanced(events);

  return (
    <section className={`kiosk-track${done ? ' is-done' : ''}`}>
      <div className="kiosk-track-steps">
        <h1>{done ? 'What just happened' : p.mode === 'fail' ? 'Watch closely: the first provider will refuse it' : 'Your payment is on its way'}</h1>
        <ol className="kiosk-steps" ref={listRef} aria-live="polite">
          {visible.map((s, i) => (
            <li key={s.id} className={`kiosk-step tone-${s.tone}`}>
              <span className="kiosk-step-n" aria-hidden="true">
                {s.tone === 'warn' ? '!' : s.tone === 'bad' ? '×' : i + 1}
              </span>
              <div className="kiosk-step-text">
                <strong>{s.title}</strong>
                <p>{s.body}</p>
              </div>
              {p.canAsk && (
                <button type="button" className="kiosk-ask-btn" onClick={() => p.onAsk(s.id)}>
                  Ask why
                </button>
              )}
            </li>
          ))}
          {!done && (
            <li className="kiosk-step kiosk-step-pending" aria-hidden="true">
              <span className="kiosk-dots">
                <i />
                <i />
                <i />
              </span>
              {steps.length === 0 ? 'Sending your payment…' : 'Next step…'}
            </li>
          )}
        </ol>
        {slow && !done && (
          <div className="kiosk-note">
            This is taking longer than usual.{' '}
            <button type="button" className="kiosk-link" onClick={() => onFinished(status ? outcomeOf(status) : 'unknown')}>
              Continue anyway
            </button>
          </div>
        )}
      </div>

      {done && (
        <aside className="kiosk-value">
          <ValueMoment outcome={p.outcome} balanced={balanced} rerouted={steps.some((s) => s.type === 'payment.send_failed')} />
          <div className="kiosk-next">
            {p.canFollowUp && (
              <button type="button" className="kiosk-primary" onClick={p.onLead}>
                Email me this demo
              </button>
            )}
            {!p.completed.includes('fail') && (
              <button type="button" className="kiosk-secondary" onClick={() => p.onAgain('fail')}>
                Now watch a provider fail
              </button>
            )}
            {p.completed.includes('fail') && !p.completed.includes('send') && (
              <button type="button" className="kiosk-secondary" onClick={() => p.onAgain('send')}>
                Send a normal payment
              </button>
            )}
            <button type="button" className="kiosk-ghost" onClick={p.onFinish}>
              {p.canFollowUp ? 'No thanks, I’m done' : 'I’m done'}
            </button>
          </div>
        </aside>
      )}
    </section>
  );
}

function ValueMoment({ outcome, balanced, rerouted }: { outcome: Outcome | null; balanced: boolean; rerouted: boolean }) {
  if (outcome === 'delivered') {
    return (
      <div className="kiosk-moment tone-ok">
        <div className="kiosk-check" aria-hidden="true">✓</div>
        <h2>
          Delivered{balanced ? <> · Ledger balanced ✓</> : null}
        </h2>
        <p>
          {rerouted
            ? 'A provider refused it, and the system re-routed it on its own. The money arrived, and every cent is accounted for.'
            : 'Checked, converted, routed and delivered in seconds, and every cent is accounted for.'}
        </p>
      </div>
    );
  }
  if (outcome === 'failed') {
    return (
      <div className="kiosk-moment tone-warn">
        <h2>Stopped safely</h2>
        <p>Every eligible provider refused it, so the payment stopped. Nothing was posted to the ledger: no money is lost.</p>
      </div>
    );
  }
  if (outcome === 'held' || outcome === 'rejected') {
    return (
      <div className="kiosk-moment tone-warn">
        <h2>{outcome === 'held' ? 'Held for review' : 'Rejected'}</h2>
        <p>A compliance check stopped it before any money moved. A person reviews it next.</p>
      </div>
    );
  }
  return (
    <div className="kiosk-moment tone-info">
      <h2>Still in progress</h2>
      <p>The payment is still moving through the system. You can watch it on the big screen.</p>
    </div>
  );
}
