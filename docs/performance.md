# Measured performance

Every number on this page was measured by `npm run loadtest` (see
[ADR 0021](adr/0021-load-test-mode.md)) and is copied from its JSON reports. Nothing is estimated or rounded
up. Rates are shown to one decimal as the tool prints them.

## Read this first (caveats)

- **One laptop, everything on it.** The broker, Payment API, six stage services, ledger, orchestrator, ops,
  assistant, booth, gateway **and the load generator** all ran on the same machine, with other programs
  open (including other development tools). Results will differ on other hardware or under other load.
- **Synthetic traffic, simulated providers.** Payments come from the seeded generator; providers
  (Orion, Lyra, Vega), FX and sanctions lists are fictional simulations. No real network, bank or money.
- **Local components.** The event bus is the built-in local broker (an append-only file), the ledger is
  embedded PGlite. A production system would use different components; these numbers say nothing about them.
- **Not a production benchmark.** Use them to say "this demo, on this laptop, did X", not "the platform
  can do X". Short runs (15 s to 60 s per step); no long soak test was run.
- Latency is `payment.initiated` to first terminal event as recorded in the event log, for reconciled
  payments. It excludes the client-to-API request and any time before the API stamped the event.

## Machine and configuration

| | |
|---|---|
| CPU | 11th Gen Intel Core i7-1195G7 @ 2.90GHz, 8 logical CPUs |
| RAM | 15.8 GiB |
| OS / Node | Windows (win32 10.0.26200) / Node v24.19.0 |
| Run date | 2026-11-06 (UTC, 19:41 to 19:46) |
| Pipeline | `stageDelayMs=0`, `settlementDelayMs=0`, local broker, embedded PGlite ledger |
| Traffic | seed 7001, scenario mix provider-reject 2%, recon-break 1%, sender concurrency 128, request retries off |
| Commit | branch `m7-grow-on-demand` (working tree with the load-test tool added) |

## Run 1: stepped ramp, 15 s per step

Command: `npm run loadtest -- --ramp-start 20 --ramp-factor 1.5 --ramp-steps 8 --duration 15`
(planned 20, 30, 45, 68, 101, 152, 228, 342 per second; it stopped after the first saturated step).

| offered/s | accepted/s | completed/s | reconciled/s | backlog at end | backlog growth | p50 ms | p95 ms | p99 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 20.0 | 20.0 | 20.0 | 1 | 1 | 31 | 49 | 58 | 0 |
| 30 | 30.1 | 30.1 | 29.6 | 1 | 0 | 26 | 42 | 47 | 0 |
| 45 | 45.0 | 45.0 | 44.0 | 1 | 0 | 29 | 39 | 45 | 0 |
| 68 | 68.0 | 66.5 | 64.7 | 24 | 23 | 59 | 359 | 384 | 0 |
| 101 | 101.0 | 70.4 | 64.8 | 483 | 459 | 3994 | 6204 | 8507 | 0 |

"completed" counts every payment reaching a terminal status (reconciled, held, rejected, failed) per second
inside the step window; "reconciled" counts only those that reached reconciled.

The tool flagged the 101/s step as saturated (completed 70.4/s of 101.0/s accepted). Whole run: 3,960
payments accepted, 0 request errors, 3,960 terminal (3,823 reconciled, 128 held, 7 rejected, 2 failed).

## Run 2 and 3: fixed rate for 60 s

| offered/s | accepted/s | completed/s | reconciled/s | backlog at end | p50 ms | p95 ms | p99 ms | errors |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 60 | 60.0 | 58.2 | 56.3 | 109 | 577 | 1958 | 2117 | 0 |
| 68 | 68.0 | 65.8 | 63.3 | 132 | 2664 | 2993 | 3064 | 0 |

(`npm run loadtest -- --rate 60 --duration 60` and `--rate 68 --duration 60`.) The tool did **not** flag
either as saturated (its rule is completed below 90% of accepted), but the backlog grew all minute in both
and latency was far above the low-rate figures, so neither is a rate the pipeline kept up with cleanly.

## What the numbers support

- **Up to 45 payments/s offered (15 s steps)**: it kept up. Completed equalled accepted, backlog stayed
  at 0 or 1, p95 latency 39 to 49 ms, no errors.
- **Around 60 to 70 payments/s offered**: it falls behind gradually. In the 60 s runs, completed was 58.2/s
  at 60 offered and 65.8/s at 68 offered, with a growing backlog and p95 of 1.96 s and 2.99 s.
- **Highest completed rate seen in any step: 70.4 payments/s** (Run 1, step offered at 101/s). At that
  offered rate the backlog grew by 459 in 15 s and p95 latency was 6.2 s. Offered rates above about 70/s
  are not absorbed on this machine.
- The tool's saturation point for Run 1 is 101/s offered; its "highest sustained" step is 68/s by its
  90% rule, but see Runs 2 and 3: a longer window at that rate showed a backlog building up. A conservative
  reading is "clean up to 45/s, degrading from about 60/s, ceiling near 70/s completed on this laptop".
- The step that saturated was limited by the pipeline, not by request intake: the API accepted every
  offered request, with zero errors, in every run. This run did not identify which stage or component is
  the bottleneck.

## Integrity under load

All three runs passed every integrity check after draining (every payment reached a terminal status):

- Ledger trial balance debits = credits in every currency; ledger invariants re-checked from raw entries: ok.
- Exactly one ledger journal per reconciled payment (Run 1: 3,823 reconciled, 3,823 journals; none for
  held, rejected or failed payments).
- Zero duplicate event IDs in the log (Run 1: 35,551 events, 35,551 distinct), every payment history a
  valid state-machine walk, at most 3 routing attempts per payment, zero events rejected by the gateway.

## Reproduce

```
npm run loadtest -- --ramp-start 20 --ramp-factor 1.5 --ramp-steps 8 --duration 15 --report out/ramp.json
npm run loadtest -- --rate 60 --duration 60 --report out/60.json
npm run loadtest:quick     # 3 short steps, about 30 s
```

Reports are written as `<file>.json` and `<file>.md`. Close other programs before measuring and quote the
report's machine section with any number you use.
