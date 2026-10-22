# ADR 0001: Event-driven pipeline on a single `payments` topic

- **Status:** Accepted (M1)
- **Date:** 2026-10-22

## Context

The demo has to show a cross-border payment moving through screening, risk, FX, routing, settlement,
ledger and reconciliation, live, and later survive scenarios such as a provider outage, retries and
replays. Visitors should be able to see *why* each step happened. Stages are built by different people
and must be replaceable independently (a stub in M1, a real simulator later).

## Decision

- Every pipeline step is its own process that **subscribes to events and publishes events**; no stage
  calls another directly. The Payment API only validates and publishes `payment.initiated`.
- All lifecycle events go to **one topic, `payments`, keyed by `paymentId`** (`PAYMENTS_TOPIC` in
  `packages/contracts/src/events.ts`). Per-key ordering gives each payment a total order of events.
- Events use one versioned envelope (`EventEnvelope`: `eventId`, `type`, `schemaVersion`, `paymentId`,
  `correlationId`, `causationId`, `producer`, `payload`, `trace`).
- The current state of a payment is derived from its events by the shared **state machine**
  (`state-machine.ts`); the gateway builds UI views by projecting the same log.

## Consequences

- + The log is the single source of truth: the UI, replays, audits and tests all read the same history.
- + Adding or replacing a stage means subscribing to one event type and emitting another.
- + `causationId` links make the whole chain traceable on screen.
- - Each stage sees every event type and filters for the one it handles; fine at demo volume, and
  per-type topics can be introduced later without changing the envelope.
- - Eventual consistency: the UI shows state as events arrive, not synchronously.
