# ADR 0006: Idempotent append by eventId and head() catch-up

- **Status:** Accepted (M2)
- **Date:** 2026-10-22

## Context

M2's exit criterion is "10,000 payments: debits = credits, no duplicates on retry", including when stage
processes or the ledger are killed and restarted mid-run (`npm run verify:m2 -- --chaos`).

In M1 duplicates were prevented by deterministic event ids (ADR 0004) and the state machine, but two
windows remained:

1. **Restart race.** A restarted stage rebuilt its projection with an ephemeral subscription and waited
   for a *quiet period* (no events for 100 ms) before acting. Under load the log is never quiet, and a
   stage could act on a trigger before its projection had seen that the step had already happened, and
   publish the same event again.
2. **Crash during publish.** The broker only de-duplicated publishes flagged `retry` (a resend over a new
   connection). A process killed after its publish reached the broker, restarted, and re-publishing the
   same deterministic eventId produced a second copy in the log.

## Decision

1. **`EventBus.head()`** returns the number of events in the log (the offset the next append gets).
   Stages and the ledger read `head()` once on start and do not act on any trigger until their projection
   has applied offset `head - 1`. Everything published before the call is then visible to the projection.
   - Local broker: protocol v2 op `head` → `{ op: 'head', length }`; durable events only (a publish is
     acked only after its batch is fsynced, so every acked publish is counted).
   - Kafka: `admin.fetchTopicOffsets(topic)` high watermark of the single partition.
   - The quiet-period heuristic stays only as a fallback for a bus that cannot answer `head()`.
2. **Idempotent append in the local broker.** Every publish is de-duplicated by `eventId`, not only
   retries: an in-memory `eventId → offset` index (rebuilt when the log is loaded) answers a duplicate
   with the original offset and `duplicate: true`, and an index of *in-flight* appends makes concurrent
   duplicates (two publishes of the same id in the same write batch) share one append.
3. **Kafka cannot do append-if-absent.** The adapter gives the best practical guarantee:
   - idempotent producer (`acks=all`, one request in flight): network retries never duplicate;
   - `publish()` is idempotent per bus instance (same eventId → first offset, no second send);
   - each subscription drops a delivery whose eventId it already handled (bounded window of 1M ids), so
     a duplicate record is never processed twice and offsets still advance;
   - `head()` catch-up + the state machine make a restarted stage see its own earlier event.
   The remaining window is a process killed after its send reached Kafka but before the ack, whose
   restarted instance re-publishes before that record is visible: the topic may then contain a duplicate
   *record*, which every consumer ignores. Kafka transactions with fencing would close it, but they
   introduce control records (non-dense offsets), which breaks `head() - 1` catch-up; not worth it for
   the demo. The local broker (default) has no such window.

### Performance (same change)

Measured with `npm run bench:broker` (120,000 events, 204 MB, 3 of 12 events per payment with a
2-4 KB ISO 20022 XML; 8 sequential publishers like stages; 10 ephemeral subscriber *processes*
replaying the whole log at once, like every service starting) on the dev laptop (Windows 11, NVMe):

| | before | after |
| --- | --- | --- |
| publish, 8 sequential publishers (fsync per group commit) | 4,510/s | 4,436/s (fsync-bound, unchanged) |
| re-publish of 1,000 existing eventIds | appended 1,000 duplicates | 0 appended, original offsets |
| catch-up, 10 subscribers x 120k events | 20.1 s (slowest 19.2 s) | 4.7-5.7 s (slowest 4.1-5.0 s) |
| aggregate delivery | 59,757 events/s | 210,000-253,000 events/s |
| broker reload of the 204 MB log (process start to /health) | 1.39 s | 0.88 s (log load 0.67 s) |
| broker RSS after reload | 623 MB | 364 MB |
| broker peak RSS during the 10-way catch-up | 438 MB | 683 MB (short-lived frame buffers; GC reclaims them) |

What changed: lines are kept as UTF-8 `Buffer` slices of the file / write batch (no per-line JS strings,
no `JSON.stringify(JSON.parse(line))` on load or after each append); deliveries splice stored bytes into
`deliver-batch` frames of up to 512 events / 1 MB (negotiated per subscription, v1 clients still get
single `deliver` frames); the client window grew from 256 to 1024; publish frames put `event` last so the
broker stores the client's JSON as-is; `/events` splices stored lines (pages up to 5000) instead of
parse + stringify. The broker also exposes `GET /stats` (events, bytes, load time, duplicates
suppressed, memory).

## Consequences

- + A restarted stage or ledger never re-acts on a step that already happened; a re-published event is a
  no-op; verified under chaos by `verify:m2 --chaos`.
- + Restart catch-up is ~4x faster, which matters because every stage replays the whole log on start.
- - The broker keeps the whole log and the id index in memory (~1.8x the log size at 120k events); fine
  for a demo, a segment/mmap store would be the next step beyond ~1M events.
- - Publish throughput is bounded by fsync latency per group commit; sequential publishers (stages) each
  see one fsync per event. Acceptable: the pipeline sustains ~100-200 payments/s end to end.
