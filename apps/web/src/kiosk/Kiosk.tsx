// Visitor kiosk (touch screen). Route #/kiosk is wired by the app shell; this module only exports <Kiosk />.
// Personal data (lead form) lives only in React state and is cleared on reset; nothing goes to browser storage.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AnalyticsBatcher } from './analytics';
import { createPayment, sendAnalytics, serviceUp } from './api';
import { AskPanel } from './AskPanel';
import { ChooseScreen } from './ChooseScreen';
import { flowReducer, initialFlow, visitActive, type KioskMode, type Outcome } from './flow';
import { IdleTimer, type IdleStatus } from './idle';
import { LeadScreen } from './LeadScreen';
import { buildPaymentRequest } from './payment';
import { Tracker } from './Tracker';
import type { KioskStep } from './explain';
import './kiosk.css';

const SCENARIO_ID: Record<KioskMode, string> = { send: 'send-payment', fail: 'provider-fails' };
const THANKS_RETURN_MS = 15_000;
const HEALTH_EVERY_MS = 30_000;
const FLUSH_EVERY_MS = 5_000;

function useServiceHealth(prefix: '/api/assistant' | '/api/booth'): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    let alive = true;
    const check = () => void serviceUp(prefix).then((ok) => alive && setUp(ok));
    check();
    const t = setInterval(check, HEALTH_EVERY_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [prefix]);
  return up;
}

export function Kiosk() {
  const [flow, dispatch] = useReducer(flowReducer, undefined, () => initialFlow());
  const assistantUp = useServiceHealth('/api/assistant');
  const boothUp = useServiceHealth('/api/booth');
  const analytics = useRef<AnalyticsBatcher | null>(null);
  analytics.current ??= new AnalyticsBatcher({ send: sendAnalytics });
  const idle = useRef(new IdleTimer(Date.now()));
  const [idleStatus, setIdleStatus] = useState<IdleStatus>(() => idle.current.status(Date.now()));
  const [steps, setSteps] = useState<KioskStep[]>([]);
  const active = visitActive(flow);

  useEffect(() => {
    if (analytics.current) analytics.current.enabled = boothUp;
  }, [boothUp]);

  const endVisit = useCallback((reason: 'idle' | 'finished') => {
    void analytics.current?.endVisit(reason);
    setSteps([]);
    dispatch({ type: 'reset' });
  }, []);

  // Idle: any touch counts; after 60 s untouched the visit ends and the kiosk starts over.
  useEffect(() => {
    const touch = () => idle.current.touch(Date.now());
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true, capture: true });
    return () => {
      for (const e of events) window.removeEventListener(e, touch, { capture: true });
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    idle.current.touch(Date.now());
    const t = setInterval(() => {
      const st = idle.current.status(Date.now());
      setIdleStatus(st);
      if (st.phase === 'expired') endVisit('idle');
    }, 250);
    return () => clearInterval(t);
  }, [active, endVisit]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void analytics.current?.flush(), FLUSH_EVERY_MS);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => {
    if (flow.screen !== 'thanks') return;
    const t = setTimeout(() => endVisit('finished'), THANKS_RETURN_MS);
    return () => clearTimeout(t);
  }, [flow.screen, endVisit]);

  // Value moment reached: the follow-up offer becomes visible (only when the booth service is up).
  useEffect(() => {
    if (flow.screen === 'done' && boothUp && !flow.leadSubmitted) analytics.current?.track('cta.shown', { cta: 'lead-form' });
  }, [flow.screen, boothUp, flow.leadSubmitted]);

  // Booth service went away while the form was open: never collect data we cannot store; move on.
  useEffect(() => {
    if (flow.screen === 'lead' && !boothUp) dispatch({ type: 'skipLead' });
  }, [flow.screen, boothUp]);

  const start = (mode: KioskMode) => {
    analytics.current?.startVisit();
    analytics.current?.track('scenario.viewed', { scenarioId: SCENARIO_ID[mode] });
    dispatch({ type: 'start', mode });
  };

  const again = (mode: KioskMode) => {
    analytics.current?.track('scenario.viewed', { scenarioId: SCENARIO_ID[mode] });
    setSteps([]);
    dispatch({ type: 'again', mode });
  };

  const send = async () => {
    if (flow.sending) return;
    dispatch({ type: 'sendStarted' });
    try {
      const id = await createPayment(buildPaymentRequest(flow.corridorId, flow.amountMajor, flow.mode));
      analytics.current?.track('payment.sent', { corridor: flow.corridorId, amount: flow.amountMajor, mode: flow.mode });
      dispatch({ type: 'sent', paymentId: id });
    } catch {
      dispatch({ type: 'sendFailed', error: 'The payment system is not answering right now. Please try again in a moment.' });
    }
  };

  const finished = useCallback((outcome: Outcome) => dispatch({ type: 'finished', outcome }), []);
  const askStep = steps.find((s) => s.id === flow.askStepId);

  return (
    <div className={`kiosk-root kiosk-${flow.screen}`}>
      <header className="kiosk-head">
        <div className="kiosk-brand">
          <span className="kiosk-logo" aria-hidden="true" />
          Global Fintech Control Tower
        </div>
        <span className="kiosk-sim">SIMULATION · fictional data</span>
        {active && flow.screen !== 'thanks' && (
          <button type="button" className="kiosk-ghost" onClick={() => endVisit('finished')}>
            Start over
          </button>
        )}
      </header>

      <main className="kiosk-main" key={flow.visit}>
        {flow.screen === 'welcome' && <Welcome onStart={start} />}
        {flow.screen === 'choose' && (
          <ChooseScreen
            mode={flow.mode}
            corridorId={flow.corridorId}
            amountMajor={flow.amountMajor}
            sending={flow.sending}
            error={flow.error}
            onCorridor={(id) => dispatch({ type: 'pickCorridor', corridorId: id })}
            onAmount={(a) => dispatch({ type: 'pickAmount', amountMajor: a })}
            onSend={() => void send()}
          />
        )}
        {(flow.screen === 'tracking' || flow.screen === 'done') && flow.paymentId && (
          <Tracker
            key={flow.paymentId}
            paymentId={flow.paymentId}
            mode={flow.mode}
            done={flow.screen === 'done'}
            outcome={flow.outcome}
            canAsk={assistantUp}
            canFollowUp={boothUp && !flow.leadSubmitted}
            completed={flow.completed}
            onSteps={setSteps}
            onFinished={finished}
            onAsk={(stepId) => dispatch({ type: 'askOpen', stepId })}
            onLead={() => dispatch({ type: 'openLead' })}
            onAgain={again}
            onFinish={() => dispatch({ type: 'skipLead' })}
          />
        )}
        {flow.screen === 'lead' && boothUp && (
          <LeadScreen
            sessionId={analytics.current?.sessionId}
            onSubmitted={() => {
              analytics.current?.track('lead.submitted');
              dispatch({ type: 'leadSubmitted' });
            }}
            onSkip={() => dispatch({ type: 'skipLead' })}
          />
        )}
        {flow.screen === 'thanks' && <ThankYou lead={flow.leadSubmitted} onDone={() => endVisit('finished')} onAgain={again} completed={flow.completed} />}
      </main>

      {assistantUp && flow.askStepId && flow.paymentId && (
        <AskPanel
          paymentId={flow.paymentId}
          step={askStep}
          onClose={() => dispatch({ type: 'askClose' })}
          onAsked={(data) => analytics.current?.track('question.asked', data)}
        />
      )}

      {active && idleStatus.phase === 'warning' && (
        <div className="kiosk-idle" role="alertdialog" aria-live="polite" aria-label="Are you still there?">
          <div className="kiosk-idle-card">
            <div className="kiosk-idle-ring" style={{ ['--p' as string]: String(idleStatus.remainingMs / idle.current.warnMs) }}>
              {idleStatus.secondsLeft}
            </div>
            <h2>Still there?</h2>
            <p>We'll start over for the next visitor in {idleStatus.secondsLeft} seconds. Anything you typed will be cleared.</p>
            <button type="button" className="kiosk-primary" onClick={() => setIdleStatus(idle.current.status(Date.now()))}>
              I'm still here
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Welcome({ onStart }: { onStart: (mode: KioskMode) => void }) {
  return (
    <section className="kiosk-welcome">
      <h1>
        Move money across the world.
        <br />
        <span>See every decision it takes.</span>
      </h1>
      <p className="kiosk-lede">Tap one to begin. It takes about two minutes.</p>
      <div className="kiosk-welcome-grid">
        <button type="button" className="kiosk-hero-btn" onClick={() => onStart('send')}>
          <span className="kiosk-hero-icon" aria-hidden="true">
            <svg viewBox="0 0 64 64">
              <circle cx="14" cy="44" r="6" />
              <circle cx="50" cy="20" r="6" />
              <path d="M18 40 Q 30 8 46 22" fill="none" strokeWidth="3" strokeDasharray="4 5" />
            </svg>
          </span>
          <strong>Send a payment across the world</strong>
          <small>Pick a corridor and an amount, then follow it live: checks, exchange rate, routing, delivery and the ledger.</small>
        </button>
        <button type="button" className="kiosk-hero-btn kiosk-hero-warn" onClick={() => onStart('fail')}>
          <span className="kiosk-hero-icon" aria-hidden="true">
            <svg viewBox="0 0 64 64">
              <circle cx="14" cy="44" r="6" />
              <circle cx="50" cy="20" r="6" />
              <path d="M18 40 L30 26" fill="none" strokeWidth="3" />
              <path d="M34 20 l8 8 M42 20 l-8 8" fill="none" strokeWidth="3" />
              <path d="M18 46 Q 40 56 50 26" fill="none" strokeWidth="3" strokeDasharray="4 5" />
            </svg>
          </span>
          <strong>Watch what happens when a provider fails</strong>
          <small>Your payment's first provider refuses it. Watch the system re-route it, with nothing lost.</small>
        </button>
      </div>
    </section>
  );
}

function ThankYou({ lead, onDone, onAgain, completed }: { lead: boolean; onDone: () => void; onAgain: (m: KioskMode) => void; completed: KioskMode[] }) {
  const next: KioskMode | null = !completed.includes('fail') ? 'fail' : !completed.includes('send') ? 'send' : null;
  return (
    <section className="kiosk-thanks">
      <div className="kiosk-check" aria-hidden="true">✓</div>
      <h1>{lead ? 'Thank you! We’ll be in touch.' : 'Thanks for stopping by!'}</h1>
      <p className="kiosk-lede">
        {lead
          ? 'Your details stay on this booth laptop and are deleted after the event. Ask anyone on the team if you want them removed sooner.'
          : 'Our team is right here if you want to talk about payments, routing or the ledger.'}
      </p>
      <div className="kiosk-actions">
        {next && (
          <button type="button" className="kiosk-secondary" onClick={() => onAgain(next)}>
            {next === 'fail' ? 'Now watch a provider fail' : 'Send a payment yourself'}
          </button>
        )}
        <button type="button" className="kiosk-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </section>
  );
}
