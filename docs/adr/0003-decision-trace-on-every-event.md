# ADR 0003: A decision trace on every event

- **Status:** Accepted (M1)
- **Date:** 2026-10-22

## Context

The point of the demo is explainability: visitors (and later an AI explainer) should be able to ask
"why was this payment held / routed to this provider / quoted at this rate?". Regulators expect the
same of real payment systems. If reasons are reconstructed after the fact from logs, they drift from
what actually happened.

## Decision

Every event produced by a stage (and the Payment API) carries a `trace: DecisionTrace`:

- `stage` - who decided
- `decision` - what was decided (e.g. `clear`, `approve`, `hold`, `provider:orion`)
- `reasonCodes` - machine-readable reasons (e.g. `SANCTIONS_CLEAR`, `SCENARIO_FORCE_HOLD`)
- `inputs` - the inputs the decision used
- `ruleVersion` - which rules/stub version produced it
- `latencyMs` - how long the decision took

The trace is written at the moment of the decision, in the same event that records the outcome.

## Consequences

- + The UI can show the "why" next to every step with no extra lookups; the AI explainer (M5) reads the
  same data.
- + Replays and audits see exactly the reasons that were used at the time.
- - Slightly larger events; `inputs` must stay small and contain only synthetic data.
- - Every new stage must fill the trace; tests should assert that stage-produced events carry one.
