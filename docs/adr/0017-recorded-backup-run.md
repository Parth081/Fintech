# ADR 0017: Recorded backup run ("safe mode")

- **Status:** Accepted (M6)
- **Date:** 2026-11-05

## Context

If the live pipeline misbehaves at a booth, the big screen must keep telling the story without a visible
failure. The cheapest honest fallback is a recording of a good live run, played back through the same read
side (broker log, gateway projection, every screen) so nothing in the UI needs a second code path.

## Decision

1. **Recording.** `npm run booth:record` captures a window of the running system's broker log
   (`GET /events`) into `DATA_DIR/recordings/<name>.jsonl` (one BusEvent per line, log order) plus
   `<name>.meta.json` (`RecordingMeta`). Only control events and payments initiated inside the window (with
   everything they produced, up to a grace period) are kept. Scenarios, outages and shocks still open at the
   end are closed with deterministic synthetic control events so every loop ends with clean control state.
2. **Replay.** `tools/booth/replay.ts` publishes the events into a fresh bus with their original relative
   timing (`--speed` scales it). Every ISO date-time in an event is mapped to `loopStart + (t - first)/speed`
   (plain dates are kept) so the first event is "now". All ids are re-keyed per (publisher start, loop):
   UUIDs by a deterministic hash, other ids by a suffix, applied to the whole event text so causation,
   correlation and ids inside payloads and XML stay consistent. Each loop is therefore a set of new payments
   (totals keep climbing like a live system, nothing is rejected as a duplicate) and the bus' eventId
   idempotency only absorbs genuine re-publishes. Loops are separated by a short gap.
3. **Mode.** The launcher starts broker + gateway (+ assistant, booth) with `SYSTEM_MODE=safe` and
   `RECORDING_NAME`; the ledger, orchestrator and stages are not running. The gateway reports
   `{mode, recording}` on `/health` and in the control view (also pushed over the WebSocket), and answers
   `POST /api/payments*` with `503 {error:'demo paused', mode:'safe'}`.
4. **UI.** A calm "RECORDED RUN · not live" ribbon on the stage, the presenter console and the booth views
   (the SIMULATION label is never hidden); the kiosk replaces the send flow by "The live demo is taking a
   short break. Watch the big screen!" (visitors mid-visit finish; the lead form keeps working). The presenter
   console shows per-service health and a confirmed switch that reuses the reset reconnect handling.

## Consequences

- The backup is only as good as the recording: record one per scenario before the event and keep it.
- In safe mode ledger-backed panels are empty (the ledger is not running); this is stated, not faked.
- The recorded run is labelled everywhere; it is never presented as live.
