# ADR 0007: Retry and failure semantics

- **Status:** Accepted (M2)
- **Date:** 2026-10-22

## Context

M2 routes payments over three fictional providers (Orion, Lyra, Vega) whose simulated behaviour includes
rejecting instructions (`PROVIDER_FAILURE_SCALE`, scenario `provider-reject`). We need defined behaviour
when a provider rejects: what the customer sees, whether money moves, and how many times we try, so that
"debits = credits" holds no matter what fails.

## Decision

- A provider rejection is an event, not an exception: settlement publishes **`payment.send_failed`**
  (`attempt`, ISO 20022 status reason code such as `AC04`/`AM04`, `pacs.002` RJCT message) and the
  payment moves `sent → retrying` (non-terminal).
- **Routing reacts to `send_failed`** by re-routing with the failed providers excluded
  (`excludedProviders`, `attempt + 1`, full `scoring` in the decision trace): `retrying → routed → sent`.
- **At most 3 attempts** per payment. When no eligible provider is left or the third attempt fails,
  routing publishes **`payment.failed`** (`attempts`, `atStage: 'routing'`): `retrying → failed`, a
  **terminal** status.
- **The ledger posts only on settlement.** `ledger.posted` is produced only from `payment.settled`;
  `send_failed`, `failed`, `held` and `rejected` payments have no journal. A failed send therefore never
  needs a reversal, and the trial balance stays balanced by construction.
- Terminal statuses: `reconciled`, `held`, `rejected`, `failed`. Reconciliation breaks (scenario
  `recon-break`) still end in `reconciled` with `matched: false` and `breaks`, so they are visible but the
  payment is not stuck.
- Every retry event id includes the attempt number (ADR 0004), so attempt N and N+1 are different events,
  while a redelivered trigger for attempt N still produces the same id (and is dropped, ADR 0006).

## Consequences

- + Customers see `retrying` instead of an error; most rejects end `reconciled` via another provider.
- + `npm run verify:m2` can check the rules mechanically: exactly one journal per reconciled payment, none
  for failed/held/rejected, at most 3 `payment.routed` per payment, every payment terminal.
- - A payment can take up to three settlement round trips; the UI shows the attempt count.
- - No partial settlement or reversal flows in M2 (future milestone).
