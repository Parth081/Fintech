# ADR 0010: Operator actions are events on the payment log

- **Status:** Accepted (M4)
- **Date:** 2026-10-27

## Context

M4 adds people to the payment flow. Compliance releases or rejects held payments, operations retries a
failed payment or refunds a completed one, and admins change configuration. A payment platform has to
answer two questions about every one of these actions, years later: what happened to the money, and
who decided it. The pipeline is already event-sourced (ADR 0001): every stage reacts to events on one
ordered log, and the ledger, the gateway and verification rebuild everything from that log.

## Decision

- **A human decision that changes a payment is an event, not a database update.** The ops service
  (`services/ops`) publishes `payment.released`, `payment.rejected` (with `atStage: 'ops'`),
  `payment.retry_requested` and `payment.refund_requested`, all with `producer: 'ops'` and
  `payload.actor` (plus `approvedBy` when a second person approved). The pipeline reacts to them like
  any other trigger. A release resumes at FX quoting, a retry gives routing a new budget of attempts
  (ADR 0007), and a refund makes the ledger post a mirror reversal journal (`payment.refunded`).
- **The state machine owns the rules.** `held → released → scored`, `failed → retrying`,
  `reconciled → refund_requested → refunded` are transitions in `@ct/contracts` state-machine.ts. An
  action on a payment that is not in that state is refused by ops (409), and it would also be refused by
  every projection.
- **Deterministic event ids.** Ops derives each event id from the action and the state it acts on (for
  example the failure being retried, the refund request id or the change request id). A double-click,
  a client retry or an ops restart publishes the same id, and consumers drop the duplicate (ADR 0004).
- **Configuration changes are control events.** An approved change is published as
  `control.config.updated` (key, value, version, change request id, actor, approver) on the same log
  (ADR 0008). Stages read the configuration as of the trigger's log position, so a replay makes the same
  decision as the live run, and a change applies to every service at the same point.
- **The audit trail links to the log.** Every mutating ops call writes an audit row (actor, action,
  target, details). When the action produced an event, the row also has its `eventId`. The audit table
  is append-only: a database trigger rejects UPDATE, DELETE and TRUNCATE, and the API has no route that
  changes a row.

## Consequences

- + "Who released this payment?" is answered by the log itself. It is replayable and it is the same in
  the console, the gateway and verification.
- + Operator actions get exactly-once effects, deterministic replays and the ledger's balance
  guarantees for free.
- - Ops is a producer on the payment log and has to respect the same contracts as the stages (schema
  version, state machine, deterministic ids).
- - An action is asynchronous. The API answers 202 with the `eventId`, and the console watches the
  payment until the pipeline has reacted.

**Verified by `verify:m4`:** (c)-(g) drive each action through the API and find the event on the log
with the right actor; (i) checks that every mutating call has an audit row whose `eventId`, when present,
points to that event; (j) checks that every payment history is still a valid state-machine walk.
