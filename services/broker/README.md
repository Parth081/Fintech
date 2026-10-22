# @ct/broker — local event broker

The default event backbone (`BUS=local`): a durable, single-topic, append-only log served over
WebSocket, so the whole demo runs offline on one laptop with no Docker. Services talk to it through
`LocalBrokerBus` (`packages/event-bus/src/local-broker-bus.ts`) via `createBus()`; nothing else
should speak the protocol directly.

## Run

```sh
npx tsx services/broker/src/index.ts          # ws://127.0.0.1:7070, data in .data/broker
BROKER_PORT=7170 DATA_DIR=/tmp/x npx tsx services/broker/src/index.ts
```

Env (via `serviceConfig()`): `HOST`, `BROKER_PORT`, `DATA_DIR`. SIGINT/SIGTERM shut down gracefully
(pending appends finish, offsets flushed). Programmatic: `startBroker({ host, port, dataDir })` from
`src/broker.ts` (port `0` picks a free port; the handle returns the real one).

HTTP on the same port:

- `GET /health` → `{"ok":true,"events":<count>}`
- `GET /events?from=0&limit=100` → `[{"offset":0,"event":{...}}, ...]` (limit ≤ 1000; debugging only)

## Storage

- `${DATA_DIR}/broker/payments.log` — JSONL; line N is the event at offset N. Appends are
  serialized and group-committed (one `write` + `datasync` per batch); a publish is acked only after
  its batch is on disk, so offsets are strictly sequential and acked ⇒ durable.
- `${DATA_DIR}/broker/offsets.json` — `{"groups":{"<group>":<next offset>}}`, written atomically
  (temp file + datasync + rename), coalesced so bursts of commits cause few writes.
- On start the log is reloaded. A truncated/corrupt **final** line (torn write) is dropped with a
  warning and the file truncated back to the last good line; corruption anywhere else refuses to start.

Delete `.data/broker` to reset.

## Protocol (v1)

One JSON object per WebSocket text frame. `reqId` is chosen by the client and echoed back.

Client → broker

| op | fields | meaning |
|---|---|---|
| `hello` | `clientId`, `protocol` | identify (informational) → `welcome` |
| `publish` | `reqId`, `event`, `retry?` | append an event (must have string `eventId`, `type`, `paymentId`) → `ack` or `error`. `retry:true` marks a resend after a lost connection: if an event with that `eventId` is already in the log, the broker acks with the existing offset (`duplicate:true`) instead of appending again |
| `subscribe` | `reqId`, `subId`, `group`, `from` (`earliest`/`latest`), `ephemeral`, `credit`, `position?` | start a subscription → `subscribed {start}`. Start = `position` if given (resubscribe after reconnect; for a non-ephemeral group it is also committed), else for ephemeral `from`, else the group's committed offset, else `from` |
| `credit` | `subId`, `n` | flow control: allow `n` more deliveries |
| `commit` | `subId`, `offset` | commit the group's *next* offset (ignored for ephemeral) |
| `unsubscribe` | `reqId`, `subId` | stop → `unsubscribed` |

Broker → client

| op | fields |
|---|---|
| `welcome` | `protocol`, `length` (events in log) |
| `ack` | `reqId`, `offset`, `duplicate?` |
| `subscribed` | `reqId`, `subId`, `start` |
| `unsubscribed` | `reqId`, `subId` |
| `deliver` | `subId`, `offset`, `event` |
| `error` | `reqId?`, `message` |

Non-publish messages from one connection are processed strictly in order (so a `commit` is applied
before the following `unsubscribed` is sent). The broker only delivers durable events, sends at most
`credit` deliveries ahead, and drops a connection's subscriptions when its socket closes.

## Client behaviour (LocalBrokerBus)

- Per subscription: bounded buffer (window, default 256; credit returned in half-window batches),
  handler calls strictly sequential, `commit` after the handler resolves, retry the same event with
  exponential backoff (20 ms → 1 s) if it throws.
- Reconnects automatically with backoff (100 ms → 2 s). On reconnect every subscription resubscribes
  with `position` = next offset it still has to process (duplicates of already-handled offsets are
  skipped); queued/in-flight publishes are resent with `retry:true`, and rejected after
  `publishTimeoutMs` (default 30 s) if the broker stays unreachable.
- `connect()` retries for `connectTimeoutMs` (default 10 s) so services may start before the broker.
- `close()` stops handlers, flushes final commits (unsubscribe round-trip), closes the socket.
