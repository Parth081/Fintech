# ADR 0016: Safe mode - the recorded backup run

- **Status:** Accepted (M6)
- **Date:** 2026-11-05

## Context

Whatever goes wrong with the live pipeline (see ADR 0015), the booth must still show something true to
what the system does. A recorded run of a scenario (tools/booth/record.ts) is the backup; the launcher
owns the processes, so it owns the switch.

## Decision

- **Switch.** `POST /safe-mode {on, name?}` on the launcher control API (and `launch().setMode`). `on`
  stops the live pipeline, wipes the data directory (except `booth` and `recordings`), and starts the safe
  system on the same ports: broker (fresh log), gateway and, when enabled, the assistant, plus the
  untouched booth. `off` returns to a fresh live system. `--safe [--recording n]` starts that way.
- **Playback.** The launcher process opens a bus connection and runs `startReplayPublisher` (looped, the
  newest recording unless `name` is given) against the new broker once the gateway is ready. Timestamps
  are shifted by the replay library; the screens, assistant and projections work from events as usual.
- **Nothing live.** No payment API, stages, ledger, orchestrator or ops run, so nothing can change what
  the screens show; the gateway refuses to send payments in this mode.
- **Gateway contract.** The gateway process gets `SYSTEM_MODE=safe` and `RECORDING_NAME=<name>` (live:
  `SYSTEM_MODE=live`, `RECORDING_NAME` empty, always explicit) and reports `{mode, recording}` in
  `/health` and `/api/control/state`.
- **Safe by construction.** The recording is resolved (404) and the request validated before anything is
  stopped. 409 while a reset or mode change runs. Already in the requested mode is a no-op. A reset in
  safe mode restarts the safe run (it never silently goes live). Visitor leads and recordings are never
  wiped. The supervisor stays active in safe mode (broker or gateway crash: restarted, the recording keeps
  playing).
- **Speed.** About the same as a reset: the safe system is smaller than the live one.
- **`?wait=0`.** Like reset, the gateway calls it with `?wait=0` (202 after validation) because the switch
  restarts the gateway itself.

## Consequences

- A hard failure becomes one button: the presenter switches to the recorded run in seconds, then back.
- Safe mode needs the local broker (`BUS=kafka` is refused with 400).
- If the switch itself fails, the launcher behaves as for a failed reset: it stops everything.
