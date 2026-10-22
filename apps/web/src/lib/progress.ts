import { PIPELINE } from '@ct/contracts/browser';
import type { PaymentSummary } from './types';

export type DotState = 'done' | 'current' | 'todo' | 'stopped' | 'skipped';

/**
 * One dot per PIPELINE stage.
 * - in flight: stages before the current one are done, current is "current", rest "todo"
 * - reconciled: all done
 * - held/rejected: reached stages done, the next one is "stopped" (where it was stopped), rest "skipped"
 */
export function progressDots(p: Pick<PaymentSummary, 'status' | 'stepIndex' | 'lastPipelineIndex'>): DotState[] {
  if (p.status === 'held' || p.status === 'rejected') {
    const reached = p.lastPipelineIndex;
    return PIPELINE.map((_, i) => (i <= reached ? 'done' : i === reached + 1 ? 'stopped' : 'skipped'));
  }
  if (p.status === 'reconciled') return PIPELINE.map(() => 'done');
  return PIPELINE.map((_, i) => (i < p.stepIndex ? 'done' : i === p.stepIndex ? 'current' : 'todo'));
}

/** 0..1 completion for a payment (held/rejected count what they reached). */
export function progressFraction(p: Pick<PaymentSummary, 'status' | 'stepIndex' | 'lastPipelineIndex'>): number {
  const last = PIPELINE.length - 1;
  const idx = p.stepIndex >= 0 ? p.stepIndex : p.lastPipelineIndex;
  return Math.max(0, Math.min(1, idx / last));
}
