# ADR 0008: Control events on the payment log

- **Status:** Accepted (M3)
- **Date:** 2026-10-23

## Context

M3 adds scripted scenarios: a presenter presses "Provider outage" and Orion stops accepting instructions
for a while. Several processes must agree on *when* that happened. Settlement has to reject Orion
instructions during the outage, routing has to see the breaker open, the gateway and the UI have to show
the outage, and the ledger proof has to hold afterwards.

If the outage were a side channel (an HTTP flag on each service, a shared file, a second topic), every
process would apply it at a slightly different moment relative to the payments flowing past. A payment
sent "at the same time" as the outage could be rejected by one process and accepted by another. Worse,
a restart or a replay would have no record of where the outage fell in the stream, so it would decide
differently the second time. That breaks the M2 guarantees: deterministic ids (ADR 0004), idempotent
append (ADR 0006) and "same log in, same decisions out".

## Decision

- Scenario and demo controls are **events on the same ordered log as payment events** (`payments` topic,
  `packages/contracts/src/control.ts`): `control.provider_outage.started|ended`,
  `control.scenario.started|step|ended`, `control.demo.speed`, `control.demo.paused`.
- They use the envelope of payment events with `paymentId = "__control__"` (`CONTROL_STREAM_ID`), so the
  broker and Kafka key them like everything else and keep their order. Producers are the orchestrator
  (scenarios, pace, ambient traffic) and the presenter; ids are deterministic (`runId` + step), so a
  retried publish is de-duplicated by the broker like any other event.
- The **control state is a pure fold** (`applyControl`) over control events in log order.
- **Decisions use `ControlTimeline.at(offset)`**: the state from control events strictly *before* the
  trigger's offset. A stage deciding on the payment.sent at offset 1200 sees an outage published at
  offset 1180 and never one published at 1210, even if it has already read it. A live run and a later
  replay therefore make the same decision for the same event. Settlement honours an outage only for
  instructions sent after it started.
- **Pacing never changes decisions.** `control.demo.speed` and `control.demo.paused` only change delays
  (they are read with `current()`, not `at(offset)`). Payment events keep the same ids and contents
  whatever the pace.
- Readers that only care about payments skip control events (`project()`, the gateway projection,
  `verify`'s `LogAnalyzer`), and they never count as rejected events.

## Consequences

- + One source of truth for "what happened when": the log. A restart, a new consumer or `verify:m3`
  can reconstruct the outage, the scenario steps and their position relative to every payment.
- + Deterministic: the same log gives the same routing and settlement decisions, so a replay of an
  outage run produces no duplicates and the same ledger.
- + The UI's timeline and the presenter console come for free: they fold the same events.
- - Every payment consumer receives control events (a few dozen per scenario) and must ignore them.
  A consumer written before M3 that assumes every event is a payment event would mis-handle them; the
  shared projection helpers already skip them.
- - Control state applies in log order, not wall-clock order. A control event delayed in publishing
  takes effect late, but at the same point for everyone, which is what matters for consistency.
- - Ending a scenario cleanly (no outage left open) is the orchestrator's job: on stop or shutdown it
  publishes `provider_outage.ended` and `scenario.ended`. `verify:m3` checks this after every run.
