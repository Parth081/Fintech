// M3 SKELETON from the integrator: circuit breakers. The resilience engineer implements it; the gateway
// and routing call breakerStates() — keep the signature.
import type { BreakerView, PaymentState } from '@ct/contracts';

export interface BreakerOptions {
  /** Failures within the window that open the breaker. */
  failureThreshold?: number;
  windowMs?: number;
  /** How long an open breaker stays open before letting probe traffic through (half-open). */
  openMs?: number;
}

/**
 * Breaker state for every provider at `atMs`, derived ONLY from attempt outcomes that occurred before
 * `atMs` (deterministic: the same inputs always give the same states).
 */
export function breakerStates(states: Iterable<PaymentState>, atMs: number, opts: BreakerOptions = {}): BreakerView[] {
  void states; void atMs; void opts;
  throw new Error('breakerStates not implemented yet (resilience agent)');
}
