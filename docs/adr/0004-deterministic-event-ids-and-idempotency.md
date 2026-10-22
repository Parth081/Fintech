# ADR 0004: Deterministic event IDs and idempotency

- **Status:** Accepted (M1)
- **Date:** 2026-10-22

## Context

Event-driven systems deliver *at least once*: a stage may see the same trigger twice after a restart or
reconnect, and a client may retry `POST /payments` after a timeout. In a payments demo, a duplicate
settlement or ledger posting is the worst possible bug to show on stage. M2's exit criterion is "10,000
payments, no duplicates on retry".

## Decision

- **Stages derive the `eventId` of the event they emit** from its cause:
  `deterministicId(causationEventId, stage, type)` (`packages/contracts/src/ids.ts`). Handling the same
  trigger twice produces the same event id.
- **The state machine drops duplicates** (an `eventId` already applied) and events that are not a legal
  transition from the current status.
- **The Payment API de-duplicates on `Idempotency-Key`** (header, 1-128 printable ASCII). A repeated key
  returns the original `paymentId` with `200` and `duplicate: true` instead of `202`. The key index is
  rebuilt from the event log on startup.
- Stub outcomes are deterministic (`unitHash` of stable inputs), and the traffic tool derives its
  Idempotency-Keys from `seed + index`, so re-running the same seed is a no-op.

## Consequences

- + Retries and redeliveries are safe end to end; demos and tests are reproducible.
- + Duplicate detection needs no coordination between stages.
- - Event ids are not random; they must never be used as secrets.
- - Anything that should produce a *new* event for the same cause (e.g. a retry attempt) must include a
  distinguishing part (attempt number) in the id inputs.
