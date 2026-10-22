import type { PipelineStage, Step } from './common';
import { screeningSteps } from './screening';
import { riskSteps } from './risk';
import { fxSteps } from './fx';
import { routingSteps } from './routing';
import { settlementSteps } from './settlement';
import { ledgerSteps } from './ledger';
import { reconciliationSteps } from './reconciliation';

export * from './common';
export { SANCTIONS_LIST_VERSION } from './screening';
export { FX_SPREAD_BPS, QUOTE_TTL_MS } from './fx';
export { ROUTING_FEE_BPS, ROUTING_FEE_MIN_MINOR } from './routing';

export const STAGE_STEPS: Record<PipelineStage, Step[]> = {
  screening: screeningSteps,
  risk: riskSteps,
  fx: fxSteps,
  routing: routingSteps,
  settlement: settlementSteps,
  ledger: ledgerSteps,
  reconciliation: reconciliationSteps,
};
