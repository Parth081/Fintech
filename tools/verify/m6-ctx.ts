// Shared context of the verify:m6 phases.
import type { LaunchedSystem } from '../launcher/launch';
import type { Check } from './analyze';
import type { VerifyM6Args } from './m6-args';
import type { VisitContext } from './m6-visitors';
import type { VisitSummary } from './m6-analyze';

export interface Urls {
  gateway: string;
  brokerHttp: string;
  orchestrator: string;
  ledger: string;
  booth: string | null;
  control: string | null;
}

export interface Rehearsal {
  args: VerifyM6Args;
  /** Only when this tool launched the system. */
  system: LaunchedSystem | null;
  urls: Urls;
  dataDir: string;
  checks: Check[];
  details: Record<string, unknown>;
  visits: VisitSummary[];
  /** Leads acknowledged to visitors so far (id -> email); must all be stored. */
  leads: Map<string, string>;
  /** Set when a service died for good (the supervisor gave up) - everything is stopped. */
  crashed: () => Error | null;
  visitContext: (tolerant: () => boolean) => VisitContext;
  say: (msg: string) => void;
}

export function check(id: string, title: string, ok: boolean, detail: string, examples?: unknown[]): Check {
  return { id, title, ok, detail, ...(examples && examples.length ? { examples: examples.slice(0, 10) } : {}) };
}
