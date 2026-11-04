# ADR 0015: Self-healing launcher supervisor

- **Status:** Accepted (M6)
- **Date:** 2026-11-05

## Context

Gate 3 for M6 is "no hard failures in rehearsals". Until now the launcher treated any service that exited
after startup as fatal: it stopped everything and `npm start` exited non-zero. On a conference floor that
turns one flaky process into a dead booth. The system is already built to survive restarts (ADR 0006,
0007: durable log, idempotent append, consumer groups resume from their committed offset, bus clients
reconnect), so the launcher can simply start the process again.

## Decision

- **Restart on crash.** A service that exits unexpectedly after startup is restarted with the same
  environment and ports, after an exponential backoff (`SupervisorPolicy`: `backoffMs` doubling per
  failure up to `maxBackoffMs`). It counts as recovered only when its health URL / ready line says so.
  Stages, the ledger and the projections resume from the durable log; a restarted broker is reconnected by
  every client.
- **Give up loudly.** Crashes and failed restart attempts are counted per service inside `windowMs`. More
  than `maxRestarts` and the launcher stops everything and calls `onUnexpectedExit` (the CLI exits 1) with
  a message naming the service and its last log lines - the old behaviour, only later.
- **Not a crash:** `kill()`, `restart()`, `reset()`, mode changes and `stop()` are intentional; they are
  never restarted, never counted. An operator `restart()` cancels a pending supervisor restart.
- **Defaults.** `npm start` enables the supervisor (`--no-supervise` turns it off). `launch()` defaults to
  disabled so tests and `verify:*` keep stop-everything semantics unless they opt in with `supervisor`.
- **Visible.** `launch().health()` and `GET /status` list per service `running`, `restarts`,
  `lastRestartAt`, `lastExit`. The counters survive a demo reset (which is not a restart). The banner
  prints whether the supervisor is on.
- **No orphans.** Children keep their stdin pipe (`CT_SUPERVISED`), so a dying launcher still takes them
  with it; restart loops are cancelled (and awaited) by `stop()`, reset and mode changes before they can
  spawn anything.
- **Test hook.** `launch().crash(name)` kills a process tree without marking it intentional.

## Consequences

- A crash is visible as a log block and a restart counter, not as a stopped demo; the presenter console
  can show the counters.
- A crash loop is still fatal after `maxRestarts` (default 5 in 2 minutes), so a real defect is not
  hidden.
- In-flight work of the crashed process is retried by the at-least-once, idempotent pipeline; verified by
  `tests/e2e/m6-supervisor.test.ts` (no duplicate events, one journal per payment).
- Known gap: a crash of the surviving booth during a reset is reported as a startup failure of the reset.
