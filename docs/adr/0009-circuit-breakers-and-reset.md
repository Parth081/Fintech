# ADR 0009: Circuit breaker semantics and the 10-second reset

- **Status:** Accepted (M3)
- **Date:** 2026-10-23

## Context

The M3 story: Orion goes down, the platform notices, moves traffic to Lyra and Vega, tests Orion
carefully when it comes back, and the ledger still balances. Retries (ADR 0007) already save each
payment, but without a breaker every new payment would first try Orion, fail, and retry. That wastes an
attempt and adds latency for every customer during the outage. The demo also has to be repeatable on
stage: after a run, the presenter needs a clean system again in seconds, not a minute of restarts.

## Decision 1: circuit breakers

The breaker is part of the routing contract. The exact thresholds belong to `@ct/market`
(`packages/market/src/breaker.ts`, `DEFAULT_BREAKER_OPTIONS`) and its engineer's notes; this ADR fixes
the semantics that screens, routing and verification rely on.

- **Derived, not stored.** A provider's breaker is a pure function of attempt outcomes
  (`payment.settled` / `payment.send_failed`) that occurred before a given time:
  `breakerStates(states, atMs)`. No process holds breaker state of its own, so every process (routing,
  gateway, verify) and every replay computes the same breaker for the same time.
- **States.** `closed` → `open` when enough recent attempts failed (a count and a failure share within a
  sliding window). `open` → `half-open` after a fixed open period. `half-open` → `closed` on a
  successful probe; `half-open` → `open` when probes keep failing (the exact count is a breaker option;
  currently two failed probes re-open it). Outcomes of attempts sent before a trip do not
  count afterwards.
- **Routing honours it at the trigger's time.** Routing evaluates the breaker as of the trigger's
  `occurredAt` minus a small lag (the same cut-off as provider health), records it in the decision trace
  (`breakerAsOf`, `breakers`), and:
  - `open`: the provider is excluded with `excludedReason: 'CIRCUIT_OPEN'` (reason code
    `CIRCUIT_OPEN_REROUTED` when it would have been chosen);
  - `half-open`: a deterministic share of payments (hash of paymentId + provider) are probes and go to
    it (`CIRCUIT_HALF_OPEN_PROBE`); the others see `excludedReason: 'CIRCUIT_HALF_OPEN'`;
  - if every eligible provider is blocked, the least-bad class is re-admitted
    (`ALL_CIRCUITS_OPEN_FALLBACK`): a breaker never fails a payment by itself.
- **Retries still apply.** A breaker reduces first attempts to a sick provider. It does not replace ADR
  0007. Payments already in flight when the breaker opens still fail over by retry.
- **Displayed as `BreakerView`** (`orchestrator-api.ts`): state, since, failure rate, attempts and a
  plain-English reason, from `GET /api/control/state`.

**Verified by `verify:m3`, per run:** (b) the provider's breaker is seen open (`CIRCUIT_OPEN` in a routing
decision) within 10 s of the outage starting. (c) From then until the first half-open sign, no
first-attempt payment is routed to the provider, and none at a time when the breaker, recomputed from
the final log with `breakerFor`, was open. (d) After the outage, the provider settles normal (non-probe)
traffic again.

## Decision 2: the 10-second reset

- **The launcher owns reset.** Only the process that started the services can restart them. `npm start`
  serves a small control API on `127.0.0.1:7079` (`--control-port`, env `LAUNCHER_CONTROL_PORT`):
  `GET /status` and `POST /reset`. The gateway proxies `POST /api/control/reset` there when
  `LAUNCHER_CONTROL_URL` is set; otherwise (Docker, or `--no-control`) it answers 503.
- **Reset = stop, wipe, start.** Kill every service tree in parallel (no graceful drain: the data is about
  to go). Delete the data dir with the same safety checks as `--reset` (never the repo root, a parent of
  it or a filesystem root; brief retries for Windows file handles). Start everything again without
  rebuilding the UI, and respond once every service, gateway included, is ready:
  `{ ok, durationMs, phases: { stopMs, wipeMs, startMs }, ready: { service: ms } }`.
  A wiped log means a new story: offsets restart at 0, ambient traffic resumes at the launch rate.
- **One at a time.** A second reset while one runs, or a reset before the first start finished, gets 409.
  `POST /reset?wait=0` answers 202 at once and resets in the background. Callers that are themselves
  restarted by the reset (the gateway proxy) should use it.
- **Fast start.** The critical path is: broker and ledger together (the ledger opens PGlite before it
  touches the bus); once the broker is up, payment API, the 6 stages and the gateway in parallel (bus
  clients retry their first connection); once the payment API is up, the orchestrator. Health is polled
  every 40 ms.
- **No orphans, even mid-reset.** Every child still has the launcher's stdin pipe (lifecycle.ts), so a
  hard-killed launcher takes its services with it. `stop()` during a reset (Ctrl+C) kills every live
  child of any generation, and the reset spawns nothing more once stopping. A failed reset stops
  everything and exits like a crash, so the demo never runs half-reset.

Measured on the demo laptop (Windows 11, Node 24, 11 processes): reset in about 5 s. Stopping takes about
0.65 s (taskkill per tree), the wipe about 0.2 s, and the start about 4 s. During the start, most services
are ready after about 1.5 s; the ledger's fresh PGlite database (initdb + migrations) is the long pole at
about 4 s. Opening an existing PGlite directory takes about 0.15 s, so copying a pre-initialised empty
ledger template into place could cut the reset to about 2.5 s. We did not do this because the time is
inside the target and it would couple the launcher to the ledger's storage layout.

## Consequences

- + The breaker is explainable and replay-stable. Its state at any moment can be recomputed from the
  log, which is what the screens show and what Gate 2 checks.
- + The presenter can run the scenario, press Reset, and run it again: Gate 2 does exactly that 10 times.
- - Breaker transitions happen only on outcomes or time. Routing sees them only when a payment arrives,
  so with no traffic the display can show "open" past the open period until the next decision. The
  view is computed at request time, so it stays correct.
- - Reset is not available in Docker, where there is no launcher. Use `down -v` / `up` there.
- - A synchronous `POST /reset` through the gateway cannot get its answer, because the gateway is
  restarted mid-request. The UI should use `?wait=0` and wait for the live feed to reconnect.
