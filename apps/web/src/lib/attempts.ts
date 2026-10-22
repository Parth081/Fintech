// Routing attempts timeline for the drawer: each routing decision with its scoring table and the
// provider's outcome (sent, settled, or rejected with its ISO 20022 reason code).
import type { AnyEvent, Money, ProviderScore } from '@ct/contracts/browser';

export interface ScoringRow extends ProviderScore {
  chosen: boolean;
}

export type AttemptOutcome = 'routed' | 'sent' | 'settled' | 'rejected';

export interface AttemptView {
  attempt: number;
  routedAt: string;
  providerId: string;
  rail: string;
  estimatedFee: Money;
  excludedProviders: string[];
  /** Chosen first, then eligible by score (desc), ineligible last. */
  scoring: ScoringRow[];
  /** True when the routing event carried a full scoring table (M2); false for M1 alternatives only. */
  fullScoring: boolean;
  outcome: AttemptOutcome;
  outcomeAt?: string;
  messageId?: string;
  reasonCode?: string;
  reason?: string;
  settlementRef?: string;
}

export interface AttemptsSummary {
  attempts: AttemptView[];
  failed?: { reason: string; attempts?: number; at: string };
}

function sortRows(rows: ScoringRow[]): ScoringRow[] {
  return [...rows].sort((a, b) => {
    if (a.chosen !== b.chosen) return a.chosen ? -1 : 1;
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.score - a.score;
  });
}

export function attemptsFrom(events: AnyEvent[]): AttemptsSummary {
  const attempts: AttemptView[] = [];
  let failed: AttemptsSummary['failed'];
  for (const e of events) {
    const current = attempts.at(-1);
    switch (e.type) {
      case 'payment.routed': {
        const p = e.payload;
        const rows: ScoringRow[] = p.scoring?.length
          ? p.scoring.map((s) => ({ ...s, chosen: s.providerId === p.providerId }))
          : [
              { providerId: p.providerId, eligible: true, fee: p.estimatedFee, successRate: NaN, latencyMs: NaN, score: NaN, chosen: true },
              ...p.alternatives.map((a) => ({
                providerId: a.providerId,
                eligible: true,
                fee: { amountMinor: NaN, currency: p.estimatedFee.currency },
                successRate: NaN,
                latencyMs: NaN,
                score: a.score,
                chosen: false,
              })),
            ];
        attempts.push({
          attempt: p.attempt ?? attempts.length + 1,
          routedAt: e.occurredAt,
          providerId: p.providerId,
          rail: p.rail,
          estimatedFee: p.estimatedFee,
          excludedProviders: p.excludedProviders ?? [],
          scoring: sortRows(rows),
          fullScoring: Boolean(p.scoring?.length),
          outcome: 'routed',
        });
        break;
      }
      case 'payment.sent':
        if (current) Object.assign(current, { outcome: 'sent', outcomeAt: e.occurredAt, messageId: e.payload.messageId });
        break;
      case 'payment.send_failed':
        if (current) {
          Object.assign(current, { outcome: 'rejected', outcomeAt: e.occurredAt, reasonCode: e.payload.reasonCode, reason: e.payload.reason });
        }
        break;
      case 'payment.settled':
        if (current) Object.assign(current, { outcome: 'settled', outcomeAt: e.occurredAt, settlementRef: e.payload.settlementRef });
        break;
      case 'payment.failed':
        failed = { reason: e.payload.reason, at: e.occurredAt };
        if (e.payload.attempts !== undefined) failed.attempts = e.payload.attempts;
        break;
      default:
        break;
    }
  }
  return failed ? { attempts, failed } : { attempts };
}
