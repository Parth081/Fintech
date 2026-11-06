# ADR 0021: Load-test mode with measured, not claimed, throughput

- **Status:** Accepted (M7 stream B)
- **Date:** 2026-11-07

## Context

"How many payments per second can it do?" is the first question from technical visitors. Until now the
answer was a feeling. `verify:m2` sends 10,000 payments and prints a rate, but it offers one fixed rate, so
it cannot say where the system stops keeping up. We want a number we can repeat, with the conditions
stated, and a tool that refuses to let us quote a number it did not measure.

## Decision

`npm run loadtest -- --rate <pps|ramp> --duration <s> --report <file>` (`tools/loadtest`):

- Launches the real processes (or attaches to a running system with `--url`) with `stageDelayMs=0` and
  `settlementDelayMs=0`, so the pipeline is not slowed for the demo's benefit.
- Offers synthetic payments (the same seeded generator as `npm run traffic`) at **stepped rising rates**,
  open loop: payment i is due at a fixed time regardless of how earlier ones went, so a slow system
  shows up as backlog instead of silently lowering the offered rate. Request retries are off so errors
  are visible.
- Measures from the **event log**, not from the sender: per step, accepted/s, terminal and reconciled
  payments/s inside the step window, backlog (initiated but not terminal) at the window edges, errors,
  and p50/p95/p99 of `payment.initiated` to first terminal event (reconciled payments only, nearest-rank
  percentiles, same machine clock).
- Calls a step **saturated** when requests fail (at least 1%), when the API accepts less than 90% of the
  offered rate, or when payments finish at less than 90% of the rate they were accepted. The ramp stops
  after the first saturated step (`--no-stop` continues). Gradual degradation below those thresholds is
  not hidden: backlog growth and latency are reported for every step, and the reader should look at them.
- After draining, runs the `verify:m2` integrity checks (trial balance, ledger invariants, exactly one
  journal per reconciled payment, no duplicate eventIds, valid state-machine walks, nothing stuck, no
  events rejected by the gateway). A load test that corrupts the ledger fails, whatever its speed.
- Writes JSON and markdown with machine info (CPU, RAM, OS, Node) and the configuration.
- The maths (percentiles, step summaries, saturation) lives in `report.ts` with unit tests; nothing is
  rounded up or smoothed.

## Consequences

- + Any number we quote has a report behind it and a command to reproduce it.
- + Regressions in throughput or latency are visible between milestones.
- - It measures one laptop running every service plus the load generator, with simulated providers and an
  embedded ledger and local broker. It is not a production benchmark and says so in its output and in
  `docs/performance.md`. Results vary with background load and hardware.
- - Latency uses the services' own event timestamps, so it excludes client network time and the time a
  request waits to be accepted by the Payment API.
