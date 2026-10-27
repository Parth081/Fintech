// Kiosk visit flow as a pure reducer. One visit: welcome -> choose a corridor and amount -> follow the payment
// live -> value moment ("Delivered · Ledger balanced") -> optional lead form -> thanks -> welcome.
// The lead form can only be reached AFTER the value moment; personal data never leaves React state.
import { CORRIDORS } from '@ct/contracts/browser';
import { amountChips } from './payment';

export type KioskMode = 'send' | 'fail';
export type Screen = 'welcome' | 'choose' | 'tracking' | 'done' | 'lead' | 'thanks';
export type Outcome = 'delivered' | 'failed' | 'held' | 'rejected' | 'unknown';

export interface FlowState {
  screen: Screen;
  /** Increments on every reset so components keyed on it lose their local state (form inputs etc.). */
  visit: number;
  mode: KioskMode;
  corridorId: string;
  amountMajor: number;
  sending: boolean;
  error: string | null;
  paymentId: string | null;
  outcome: Outcome | null;
  /** Step whose "Ask why" panel is open (null = closed). */
  askStepId: string | null;
  leadSubmitted: boolean;
  /** Demos completed this visit, e.g. ['send'] (offers the other one next). */
  completed: KioskMode[];
}

export type FlowAction =
  | { type: 'start'; mode: KioskMode }
  | { type: 'pickCorridor'; corridorId: string }
  | { type: 'pickAmount'; amountMajor: number }
  | { type: 'sendStarted' }
  | { type: 'sent'; paymentId: string }
  | { type: 'sendFailed'; error: string }
  | { type: 'finished'; outcome: Outcome }
  | { type: 'askOpen'; stepId: string }
  | { type: 'askClose' }
  | { type: 'openLead' }
  | { type: 'skipLead' }
  | { type: 'leadSubmitted' }
  | { type: 'again'; mode: KioskMode }
  | { type: 'reset' };

const DEFAULT_CORRIDOR = CORRIDORS[0]?.id ?? 'US-IN';

function defaultAmount(corridorId: string): number {
  const chips = amountChips(corridorId);
  return chips[1] ?? chips[0] ?? 100;
}

export function initialFlow(visit = 0): FlowState {
  return {
    screen: 'welcome',
    visit,
    mode: 'send',
    corridorId: DEFAULT_CORRIDOR,
    amountMajor: defaultAmount(DEFAULT_CORRIDOR),
    sending: false,
    error: null,
    paymentId: null,
    outcome: null,
    askStepId: null,
    leadSubmitted: false,
    completed: [],
  };
}

/** The visit is "active" (idle timer armed, analytics session open) on every screen but welcome. */
export const visitActive = (s: FlowState): boolean => s.screen !== 'welcome';

export function flowReducer(s: FlowState, a: FlowAction): FlowState {
  switch (a.type) {
    case 'start':
      if (s.screen !== 'welcome') return s;
      return { ...s, screen: 'choose', mode: a.mode, error: null };
    case 'pickCorridor':
      if (s.screen !== 'choose' || s.sending || !CORRIDORS.some((c) => c.id === a.corridorId)) return s;
      return { ...s, corridorId: a.corridorId, amountMajor: defaultAmount(a.corridorId), error: null };
    case 'pickAmount':
      if (s.screen !== 'choose' || s.sending || !amountChips(s.corridorId).includes(a.amountMajor)) return s;
      return { ...s, amountMajor: a.amountMajor, error: null };
    case 'sendStarted':
      if (s.screen !== 'choose' || s.sending) return s;
      return { ...s, sending: true, error: null };
    case 'sent':
      if (s.screen !== 'choose' || !s.sending) return s;
      return { ...s, screen: 'tracking', sending: false, paymentId: a.paymentId, outcome: null, askStepId: null };
    case 'sendFailed':
      if (s.screen !== 'choose') return s;
      return { ...s, sending: false, error: a.error };
    case 'finished':
      if (s.screen !== 'tracking') return s;
      return { ...s, screen: 'done', outcome: a.outcome, completed: s.completed.includes(s.mode) ? s.completed : [...s.completed, s.mode] };
    case 'askOpen':
      if ((s.screen !== 'tracking' && s.screen !== 'done') || !s.paymentId) return s;
      return { ...s, askStepId: a.stepId };
    case 'askClose':
      return s.askStepId === null ? s : { ...s, askStepId: null };
    case 'openLead':
      // Only after the value moment, and only once per visit.
      if (s.screen !== 'done' || s.leadSubmitted) return s;
      return { ...s, screen: 'lead', askStepId: null };
    case 'skipLead':
      if (s.screen !== 'lead' && s.screen !== 'done') return s;
      return { ...s, screen: 'thanks', askStepId: null };
    case 'leadSubmitted':
      if (s.screen !== 'lead') return s;
      return { ...s, screen: 'thanks', leadSubmitted: true };
    case 'again':
      if (s.screen !== 'done' && s.screen !== 'thanks') return s;
      return { ...s, screen: 'choose', mode: a.mode, paymentId: null, outcome: null, askStepId: null, error: null, sending: false };
    case 'reset':
      return initialFlow(s.visit + 1);
    default:
      return s;
  }
}
