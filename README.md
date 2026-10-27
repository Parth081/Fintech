# Global Fintech Control Tower

A conference demo of an **event-driven cross-border payments platform**: visitors watch a payment travel
from "initiated" through screening, risk, FX, routing, settlement, ledger and reconciliation, with the
reason for every decision visible on screen.

> **Simulation · synthetic data · runs offline.** No real customers, banks, providers or money. Provider
> names (Orion, Lyra, Vega), rails and corridors are fictional.

This repository is at **Milestone M3 - first scenario live**: a scripted provider outage, circuit breakers
with automatic failover, a world map and pipeline view, a presenter console, and a 10-second reset
(see [M3 - First scenario live](#m3---first-scenario-live)). Below it, **M2 - money core** (a real
double-entry ledger, simulated FX, routing with retries over three fictional providers, ISO 20022 settlement,
reconciliation, the 10,000-payment proof) and M1 (walking skeleton) are described as before. The
end-to-end picture and the roadmap are in [`fintech-control-tower.drawio`](fintech-control-tower.drawio)
(open with [diagrams.net](https://app.diagrams.net) or the VS Code Draw.io extension).

## Architecture (M1)

```
 browser ──HTTP/WS──► gateway ──► payment-api ──payment.initiated──┐
    ▲                    ▲                                         ▼
    │                    └──────── reads all events ◄──── broker: one "payments" topic (append-only log, .data/)
    │                                                     ▲   │
    └── live timeline + decision trace                    │   ▼  each stage = its own process
                                         screening → risk → fx → routing → settlement → ledger → reconciliation
```

- **Event-driven services.** Each pipeline step is a separate process that subscribes to the event log,
  reacts to one event type and publishes the next (`payment.screened`, `payment.scored`, `payment.quoted`,
  …). Nobody calls a stage directly. See [ADR 0001](docs/adr/0001-event-driven-single-topic.md).
- **One event log.** A single `payments` topic keyed by `paymentId`, served by a small built-in broker
  (WebSocket + append-only file log) so the demo runs on one laptop without Docker. A Kafka/Redpanda adapter
  sits behind the same bus interface. See [ADR 0002](docs/adr/0002-typescript-and-local-broker-with-kafka-adapter.md).
- **Payment state machine.** `packages/contracts/src/state-machine.ts` defines the legal transitions
  (`initiated → screened → scored → quoted → routed → sent → settled → reconciled`, plus `held` / `rejected`);
  invalid or duplicate events are dropped.
- **Decision trace on every event.** Every stage-produced event carries a `trace` (stage, decision, reason
  codes, inputs, rule version, latency). See [ADR 0003](docs/adr/0003-decision-trace-on-every-event.md).
- **Deterministic IDs and idempotency.** Stages derive the id of the event they emit from its cause, and
  the Payment API de-duplicates on `Idempotency-Key`. See [ADR 0004](docs/adr/0004-deterministic-event-ids-and-idempotency.md).
- **Money** is always integer minor units plus an ISO 4217 code - never floats.

## Quick start

Requires Node.js 22+ (`.nvmrc` pins 24). No Docker, database or internet needed at runtime.

```bash
npm install          # once (needs network); afterwards everything runs offline
npm start            # builds the UI if needed, starts all 11 processes (broker, api, 6 stages, ledger, orchestrator, gateway)
```

Open **http://127.0.0.1:7072**, click **Send test payment**, and watch it go from *initiated* to *settled*.
Ambient traffic (3 payments/s, `--ambient 0` to turn it off) keeps the screens alive; the presenter console
is at **http://127.0.0.1:7072/#/presenter** (start the outage scenario, change the pace, **Reset**).

In a second terminal, send seeded synthetic traffic:

```bash
npm run traffic -- --count 10 --seed 42 --rate 2
npm run traffic -- --count 3 --scenario force-hold     # payments the risk stub will hold
```

Stop everything with **Ctrl+C** (all child processes are stopped, none are left behind).

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Launcher: builds the UI if `apps/web/dist` is missing, checks ports, starts broker + ledger → payment-api, 6 stages, gateway → orchestrator (in parallel where possible), waits for each to be healthy, serves the launcher control API (reset) on 7079, prints the URL. `npm start -- --help` lists options. |
| `npm run start:reset` | Same, but deletes the data directory (event log) first. |
| `npm run traffic -- [opts]` | Posts seeded synthetic payments to `POST /payments` (`--count`, `--seed`, `--rate`, `--scenario`, `--mix`, `--concurrency`, `--url`, `--start`, `--quiet`). Same seed = same payments = same Idempotency-Keys, so re-running is idempotent. Prints accepted / duplicates / errors. |
| `npm run verify:m2 -- [opts]` | M2 proof at scale: launches everything, sends 10,000 payments, checks ledger balance, journals, duplicates, state machine, stuck payments; JSON report in `.data/reports`. See [M2](#m2---money-core). |
| `npm run verify:m2:quick` | Same with 500 payments (~30 s). |
| `npm run verify:m3 -- [opts]` | M3 Gate 2: runs the provider-outage scenario 10 times in a row (offline), checks breaker, failover, recovery, ledger and a < 10 s reset after each run; JSON report. See [M3](#m3---first-scenario-live). |
| `npm run verify:m3:quick` | Same with 2 runs (~3 min, what CI runs). |
| `npm run verify:m5 -- [opts]` | M5: AI explainer + booth. Runs every scripted scenario offline (`ASSISTANT_LLM=off`), asks ≥ 100 questions per scenario through the gateway and re-derives every cited fact from the event log; booth privacy checks; JSON report. See [M5](#m5---ai-explainer-and-booth-mode). |
| `npm run verify:m5:quick` | Same, one scenario (provider-degraded). |
| `npm run booth:clear-leads` | Deletes the visitor leads and booth analytics (`DATA_DIR/booth`) after typing `DELETE` (`--yes` to skip). A reset never does. |
| `npm run bench:broker` | Broker benchmark: publish / catch-up throughput, reload time, memory for 120k events. |
| `npm run typecheck` | `tsc` over all packages, services, apps, tools and tests. |
| `npm test` | Unit tests (vitest), excluding e2e. |
| `npm run test:e2e` | End-to-end: launches the whole system on temp ports with zero delays and drives a payment to settled. |
| `npm run build:web` | Builds the React UI into `apps/web/dist` (served by the gateway). |
| `npm run ci` | typecheck + test + build:web + test:e2e, as CI does. |

Launcher options: `--reset`, `--no-build`, `--quiet`, `--host`, `--broker-port`, `--api-port`,
`--gateway-port`, `--ledger-port`, `--orchestrator-port`, `--assistant-port`, `--booth-port`, `--llm auto|off`,
`--control-port`, `--no-control`, `--ambient`,
`--data-dir`, `--stage-delay`, `--settlement-delay`, `--timeout`.

## Ports and environment

All defaults live in [`packages/contracts/src/config.ts`](packages/contracts/src/config.ts). Everything binds to
`127.0.0.1` so the demo works with Wi-Fi off.

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `HOST` | `127.0.0.1` | all | Bind address |
| `BROKER_PORT` | `7070` | broker | Local event broker (WebSocket + `GET /health`, `/events`, `/stats`) |
| `PAYMENT_API_PORT` | `7071` | payment-api | `POST /payments`, `POST /payments/sample`, `GET /health` |
| `GATEWAY_PORT` | `7072` | gateway | UI, API for the browser, live updates, `GET /health` |
| `LEDGER_PORT` | `7073` | ledger | `GET /health`, `/ledger/trial-balance`, `/ledger/accounts`, `/ledger/journals?paymentId=`, `/ledger/invariants` |
| `ORCHESTRATOR_PORT` | `7074` | orchestrator | Scenarios, ambient traffic, pace (`packages/contracts/src/orchestrator-api.ts`) |
| `ASSISTANT_PORT` | `7076` | assistant | AI explainer (`packages/contracts/src/assistant-api.ts`; browser: `/api/assistant/*`) |
| `BOOTH_PORT` | `7077` | booth | Leads + anonymous analytics (`packages/contracts/src/booth-api.ts`; browser: `/api/booth/*`) |
| `ASSISTANT_LLM` | `auto` (launch for tests/verify: `off`; Docker: `off`) | assistant | `auto` = Claude phrases answers when credentials work, else grounded; `off` = grounded only, never uses the network |
| `ANTHROPIC_API_KEY` | (empty) | assistant | Credentials for `ASSISTANT_LLM=auto` (read from the environment only; never stored or logged) |
| `BOOTH_STAFF_PIN` | `2468` | booth | PIN for staff routes (header `X-Booth-Staff`); change it per event |
| `ASSISTANT_URL` / `BOOTH_URL` | `http://HOST:7076` / `:7077` | gateway | Where the gateway proxies `/api/assistant/*` and `/api/booth/*` (502 JSON when down) |
| `LAUNCHER_CONTROL_PORT` | `7079` | launcher | `GET /status`, `POST /reset` (only when started by `npm start`; `--control-port`) |
| (vite dev) | `5173` | apps/web | `npm run dev -w @ct/web`, proxies `/api` and `/ws` to the gateway |
| `BUS` | `local` | all | `local` (built-in broker), `memory` (single-process tests), `kafka` (Redpanda/Kafka) |
| `BROKER_URL` | `ws://HOST:BROKER_PORT` | clients of the bus | Where the local broker is |
| `KAFKA_BROKERS` | `127.0.0.1:9092` | `BUS=kafka` | Comma-separated Kafka bootstrap servers |
| `PAYMENT_API_URL` | `http://HOST:PAYMENT_API_PORT` | gateway, traffic | Where the Payment API is |
| `GATEWAY_URL` | `http://HOST:GATEWAY_PORT` | tools | Where the gateway is |
| `LEDGER_URL` | `http://HOST:LEDGER_PORT` | gateway, tools | Where the ledger is |
| `ORCHESTRATOR_URL` | `http://HOST:ORCHESTRATOR_PORT` | gateway | Where the orchestrator is (proxied under `/api/control/orchestrator/*`) |
| `LAUNCHER_CONTROL_URL` | (empty) | gateway | Set by the launcher; empty (e.g. Docker) = reset unavailable, `POST /api/control/reset` answers 503 |
| `AMBIENT_RATE` | `0` (`npm start`: 3) | orchestrator | Ambient payments per second while no scenario runs (`npm start -- --ambient <n>`) |
| `DATABASE_URL` | (empty) | ledger | Postgres URL; empty = embedded PGlite in `DATA_DIR/ledger` (offline default, ADR 0005) |
| `SIM_SEED` | `control-tower` | fx, routing, settlement | Seed for simulated rates and provider behaviour |
| `PROVIDER_FAILURE_SCALE` | `1` | settlement | Scales provider reject rates; `0` disables failures |
| `DATA_DIR` | `.data` | broker, ledger, verify | Event log, PGlite ledger, verify reports (delete it, or use `--reset`, to start clean) |
| `STAGE_DELAY_MS` | `400` | stages | Artificial delay per stage so people can watch (0 in tests) |
| `SETTLEMENT_DELAY_MS` | `900` | settlement | Extra delay before settlement |
| `WEB_DIST` | `apps/web/dist` | gateway | Built UI to serve |

## Repository layout

```
packages/contracts/   event envelope + payload types, state machine, money, ids, corridors, config (shared by all)
packages/event-bus/   bus interface + local-broker, in-memory and Kafka adapters
services/broker/      built-in event broker: one topic, append-only log in DATA_DIR
services/payment-api/ validates requests, de-duplicates by Idempotency-Key, publishes payment.initiated
services/stages/      screening, risk, fx, routing, settlement, reconciliation (one process each)
services/ledger/      double-entry ledger service (PGlite offline / Postgres in Docker), HTTP API on 7073
services/orchestrator/ scenarios (provider outage), ambient traffic, pacing; control events on the log; API on 7074
packages/market/      simulated FX rates, spreads, provider catalogue and routing scores
packages/iso20022/    pacs.008 / pacs.002 / camt.053 builders and validation
services/gateway/     serves the UI, projects events into payment views, pushes live updates
apps/web/             React UI (first basic screen)
tools/launcher/       `npm start`: process supervisor (ordering, health, logs, clean shutdown, control API + reset)
tools/traffic/        `npm run traffic`: seeded synthetic payment generator (v2: population, corridor mix, log-normal amounts)
tools/verify/         `npm run verify:m2`: 10k-payment proof; `npm run verify:m3`: Gate 2 (outage scenario x10)
tools/bench/          `npm run bench:broker`: broker performance benchmark
tests/e2e/            end-to-end test (launches everything)
deploy/               Dockerfile + docker-compose.yml (optional)
docs/adr/             architecture decision records
```

## Offline operation

After `npm install`, nothing needs the network: services bind to `127.0.0.1`, the UI is built locally and
served by the gateway (no CDN or external assets), and data is a local file log in `.data/`. To
rehearse, turn Wi-Fi off and run `npm start`.

## Docker (optional)

Docker is not needed for the demo. For a containerised run (from the repo root):

```bash
docker compose -f deploy/docker-compose.yml up -d --build --wait   # http://127.0.0.1:7072
npm run verify:m2 -- --url http://127.0.0.1:7072 --count 500        # optional proof against the containers
docker compose -f deploy/docker-compose.yml down -v                # stop and remove the volumes
```

One image (`deploy/Dockerfile`) runs every service; Compose starts broker, payment-api, each stage, the
ledger, the orchestrator (7074, `AMBIENT_RATE` default 3), **Postgres 17** (`postgres:17-alpine`, volume `ledger-pg`, `pg_isready` health check) and the
gateway, with health checks and a volume for the broker's data. In Docker the ledger uses Postgres via
`DATABASE_URL`; with `npm start` it uses embedded PGlite, no server needed (ADR 0005). Broker, API,
gateway and ledger ports are published on `127.0.0.1` only. The `redpanda` profile adds a single-node
Redpanda and switches the services to the Kafka adapter:

```bash
BUS=kafka docker compose -f deploy/docker-compose.yml --profile redpanda up -d --build --wait
BUS=kafka docker compose -f deploy/docker-compose.yml --profile redpanda down -v   # include the profile, or the redpanda volume stays
```

**Reset is not available in Docker**: there is no launcher to stop and restart the containers, so
`LAUNCHER_CONTROL_URL` is empty and the presenter console's Reset (`POST /api/control/reset`) answers 503.
Start clean with `down -v` and `up` again. Scenarios, pace and ambient traffic work as with `npm start`;
`npm run verify:m3 -- --url http://127.0.0.1:7072 --orchestrator-url http://127.0.0.1:7074 --runs 1` runs the
scenario checks against the containers (no reset, so check h is skipped).

In Kafka mode the local broker container idles, so `verify:m2 --url` (which reads the broker's `/events`)
does not apply; Kafka-side duplicate protection is described in ADR 0006.

> The Kafka/Redpanda path was verified 2026-10-22 with Docker 29.9 / Redpanda: payments reach reconciled, 10 concurrent, no duplicate events after a full restart. The local broker stays the default for the laptop demo.

## Tests

```bash
npm test                 # unit tests: contracts, bus, broker, services, launcher, traffic generator
npm run build:web
npm run test:e2e         # whole system on temp ports + temp data dir, zero delays
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, UI build and e2e on Node 22 and 24, `verify:m2`
(500 payments, plus a chaos run), `verify:m3 --runs 2`, and validates the Compose file with `docker compose config`.

## Troubleshooting

- **"Cannot start: port(s) busy."** Another copy is probably still running. Stop it, or find the process:
  Windows `netstat -ano | findstr :7072` then `taskkill /PID <pid> /F`; macOS/Linux `lsof -i :7072`. Or use
  other ports: `npm start -- --broker-port 7170 --api-port 7171 --gateway-port 7172`.
- **Odd state or old payments on screen.** Press **Reset** in the presenter console (or
  `curl -X POST http://127.0.0.1:7079/reset`): everything restarts clean in about 5 s. Or stop and run
  `npm run start:reset`.
- **"did not become ready within … ms".** The launcher names the service and prints its last log lines.
  Raise the limit with `npm start -- --timeout 60000` if the machine is slow.
- **Blank page at :7072.** The UI was not built: run `npm run build:web` (the launcher does this
  automatically unless `--no-build`).
- **A service crashed.** The launcher stops everything and shows that service's last log lines, so the
  demo never runs half-broken.
- **Terminal closed or launcher killed.** Every service watches a pipe from the launcher and shuts itself
  down within a few seconds when the launcher disappears, so no services are left holding the ports.

## M1 definition of done

- [x] Repo with npm workspaces, shared contracts, CI workflow and Docker Compose file
- [x] Event backbone running (local broker; Kafka adapter behind the same interface)
- [x] Payment state machine
- [x] Every pipeline step as a simple stub, one process each
- [x] First basic screen
- [x] Shown live: one payment travels start → settled on screen
- [x] Runs on one laptop with no network dependency: every service binds 127.0.0.1, the UI bundle loads no external
  assets, and the e2e test runs the real processes locally. Still worth one physical rehearsal: Wi-Fi off,
  `npm run start:reset`, send a test payment.

## M2 - Money core

**Done when: 10,000 payments, debits = credits, no duplicates on retry.** Proven by `npm run verify:m2`.

What's new:

- **Double-entry ledger service** (`services/ledger`, port 7073) replaces the M1 ledger stage. Posts one
  balanced journal per settled payment, exposes trial balance, accounts, journals and a full invariant
  re-check. Embedded PGlite offline, Postgres 17 in Docker ([ADR 0005](docs/adr/0005-ledger-storage-pglite-offline-postgres-in-docker.md)).
- **FX** with simulated mid rates and spreads, **routing** over Orion / Lyra / Vega with scored, explained
  choices, and a **settlement simulator** that emits ISO 20022 pacs.008 / pacs.002 and camt.053 statement
  entries; **reconciliation** matches statements to journals and reports breaks.
- **Retries and failures** ([ADR 0007](docs/adr/0007-retry-and-failure-semantics.md)): `send_failed →
  retrying → re-route`, max 3 attempts, then `failed` (terminal); the ledger posts only on settlement.
  New statuses `retrying` and `failed`; scenarios `force-hold`, `provider-reject`, `recon-break`.
- **Event backbone guarantees** ([ADR 0006](docs/adr/0006-idempotent-append-and-head-catch-up.md)):
  idempotent append by `eventId` in the broker (also for concurrent duplicates), `head()` so a restarted
  stage catches up fully before acting, batched catch-up delivery (~4x faster restarts at 120k events).
- **Traffic v2**: seeded population of fictional customers per corridor, weighted corridor mix
  (US-IN 50%, GB-PH 30%, DE-BR 20%), log-normal amounts per corridor, optional scenario mix, rate control
  with bounded concurrency.
- **Launcher**: starts the ledger service (`--ledger-port`, default gateway + 1), passes `LEDGER_*`,
  `DATABASE_URL`, `SIM_SEED`, `PROVIDER_FAILURE_SCALE`; the `launch()` handle gains `kill(name)` /
  `restart(name)` for chaos tests.

### Proving it: `npm run verify:m2`

```bash
npm run verify:m2                          # 10,000 payments, launches its own system (ports 27070-27073)
npm run verify:m2 -- --count 500           # quick (what CI runs; also: npm run verify:m2:quick)
npm run verify:m2 -- --chaos               # also kill -9 / restart random stages and the ledger during the run
npm run verify:m2 -- --url http://127.0.0.1:7072 --count 500   # against an already-running system
npm run verify:m2 -- --help
```

By default it launches the whole system itself on non-default ports with a temp data dir and zero delays,
sends the payments with traffic v2 (default mix: 2% `provider-reject`, 1% `recon-break`, 300/s, 32 in
flight), waits until every payment is terminal (progress every 2 s, timeout), then checks:

| | check |
| --- | --- |
| a | `/ledger/trial-balance` balanced for every currency, `/ledger/invariants` ok |
| b | exactly one journal (and one `ledger.posted`) per reconciled payment, none for held / rejected / failed |
| c | zero duplicate eventIds in the broker log (read via `/events` in pages), every payment history is a valid state-machine walk, at most 3 routing attempts |
| d | no payment stuck non-terminal; every request accepted |
| e | gateway `/api/stats` `rejectedEvents = 0` |
| f | report: counts per corridor / status / provider / scenario, retries, recon breaks, latency, throughput |

It writes `DATA_DIR/reports/verify-m2-<time>.json` and exits non-zero if any check fails.

### M2 ports

| Service | Port | Notes |
| --- | --- | --- |
| broker | 7070 | WebSocket bus + `/health`, `/events`, `/stats` |
| payment-api | 7071 | `POST /payments` |
| gateway | 7072 | UI + browser API |
| ledger | 7073 | ledger HTTP API (`packages/contracts/src/ledger-api.ts`) |
| postgres | (internal) | Docker only; offline the ledger uses PGlite in `DATA_DIR/ledger` |

## M3 - First scenario live

**Done when (Gate 2): the provider-outage scenario runs offline 10 times in a row, and the ledger balances.**
Proven by `npm run verify:m3`.

### The story (provider-outage, about 72 s)

1. **Normal day.** Ambient payments flow on the three corridors (US-IN, GB-PH, DE-BR), and most of them go
   through **Orion**, the fastest provider.
2. **Orion goes down** (+10 s). The orchestrator publishes `control.provider_outage.started` on the payment
   log ([ADR 0008](docs/adr/0008-control-events-on-the-payment-log.md)). Settlement rejects every Orion
   instruction from then on, and those payments retry on Lyra or Vega (ADR 0007).
3. **Breaker trips, traffic re-routes** (a few seconds later). Orion's **circuit breaker** opens. Routing stops sending
   first attempts to Orion (`CIRCUIT_OPEN`) and the world map shows the traffic moving.
4. **Orion comes back** (+35 s). The breaker goes **half-open** and lets a few probe payments through. One
   success closes it ([ADR 0009](docs/adr/0009-circuit-breakers-and-reset.md)).
5. **Back to normal, and the ledger proves it.** Traffic returns to Orion. Every payment is terminal and
   the trial balance is still balanced to the cent.

### Running it

```bash
npm start                                   # 11 processes + launcher control API; ambient traffic 3/s
```

- **Presenter console:** http://127.0.0.1:7072/#/presenter. Start the scenario, follow the narration for
  each step, change the pace (normal / slow / fast; delays only, never decisions), pause, adjust ambient
  traffic, **Reset**.
- **Reset in about 5 s** (target < 10 s): stops every service, deletes the data dir and starts everything
  again (no UI rebuild). From a terminal: `curl -X POST http://127.0.0.1:7079/reset`, which answers
  `{ ok, durationMs, phases, ready }`. `GET http://127.0.0.1:7079/status` lists the services. A second reset
  while one is running gets 409. Reset is not available in Docker (503); see [Docker](#docker-optional).
- Orchestrator API on **7074** (`packages/contracts/src/orchestrator-api.ts`), for example
  `curl -X POST http://127.0.0.1:7074/scenarios/provider-outage/start`.

### Proving it: `npm run verify:m3`

```bash
npm run verify:m3                    # 10 runs, launches its own system (ports 27170-27174, control 27179)
npm run verify:m3 -- --runs 2        # quick (what CI runs; also: npm run verify:m3:quick)
npm run verify:m3 -- --help
```

It launches the whole system on non-default ports with a temp data dir, the PGlite ledger, ambient traffic
at 3/s and the normal stage delays, all on 127.0.0.1 with no internet. Then, for each run: it starts the
scenario, reads the broker's `/events` until `control.scenario.ended`, waits until Orion carries normal
traffic again, stops ambient traffic, lets in-flight payments finish, checks, and finally `POST /reset`
(timed):

| | check |
| --- | --- |
| a | the run's control events are in order (started → steps → outage started → outage ended → ended); no outage left open |
| b | Orion's breaker opened during the outage: a routing decision excluded it with `CIRCUIT_OPEN` within **10 s** of the outage start (`--breaker-bound`) |
| c | from then until the first half-open sign, no first-attempt payment was routed to Orion; and none while the breaker, recomputed from the log (`@ct/market breakerFor` at the decision's `breakerAsOf`), was open |
| d | Orion got traffic again after recovery: first-attempt routes beyond the probes, and settlements |
| e | every payment terminal, zero duplicate eventIds, every history a valid state-machine walk, ≤ 3 attempts |
| f | ledger trial balance balanced, invariants ok, exactly one journal per reconciled payment |
| g | gateway `rejectedEvents = 0` |
| h | the reset took < 10 s (`--max-reset`), and the system came back empty and healthy |

It prints a table with one row per run, plus a summary, writes `<data dir>/reports/verify-m3-<time>.json`
(the temp dir is kept for the report; `--report-dir` to choose), and exits non-zero if any check fails.

### M3 ports

| Service | Port | Notes |
| --- | --- | --- |
| orchestrator | 7074 | scenarios, ambient traffic, pace (`ORCHESTRATOR_PORT`) |
| launcher control | 7079 | `GET /status`, `POST /reset` (`LAUNCHER_CONTROL_PORT`; only with `npm start`) |
| verify:m3 | 27170-27174, 27179 | its own system (`--base-port`) |

## M5 - AI explainer and booth mode

M5 turns the Control Tower into a trade-show booth: a big screen that runs itself, a touch kiosk where
visitors send a payment and ask "why?", and an AI explainer that answers **only from what the system
recorded**. Decisions (ADRs): [0013 grounded-first AI explainer](docs/adr/0013-grounded-first-ai-explainer.md),
[0014 booth privacy](docs/adr/0014-booth-privacy.md).

### Booth setup

```bash
npm start                         # 13 processes + launcher control API; explainer in auto mode
npm start -- --llm off            # fully offline explainer (grounded answers only)
BOOTH_STAFF_PIN=8131 npm start    # your own staff PIN for the event (default 2468)
```

| Screen | URL | What it is |
| --- | --- | --- |
| Big screen | http://127.0.0.1:7072/#/stage | the live map; when nobody touches anything it runs the **attract loop** (orchestrator `POST /attract {enabled}`; a touch, `POST /attract/touch`, hands control back) |
| Kiosk | http://127.0.0.1:7072/#/kiosk | visitor flow: pick a corridor, send a payment, watch it, ask the explainer, optional contact form with explicit consent; resets itself when idle |
| Presenter | http://127.0.0.1:7072/#/presenter | scenarios, pace, ambient traffic, reset, and (with the staff PIN) leads, CSV export and booth summary |

A **reset never deletes visitor leads**: the booth keeps running through it and `DATA_DIR/booth` is left in
place (also with `npm start -- --reset`). Export them from the presenter console (or
`curl -H "X-Booth-Staff: <PIN>" http://127.0.0.1:7072/api/booth/leads/export.csv`), then clear them on
purpose with `npm run booth:clear-leads` (stop the system first; asks you to type `DELETE`).

### AI explainer: grounded vs Claude

- **Grounded (default offline mode, `ASSISTANT_LLM=off`).** Answers are built deterministically from the
  event log: every number comes from a recorded field and is shown with a citation (event id + field). No
  network, no credentials; this is what `verify:m5` and CI prove.
- **Claude (`ASSISTANT_LLM=auto`, the `npm start` default).** When credentials work (environment only:
  `ANTHROPIC_API_KEY`, or the other credentials the Anthropic SDK reads), Claude phrases the answer from the
  same facts via read-only tools. Every number in its answer is verified against the citations; if that
  fails, or the model is unreachable, the grounded (or a cached verified) answer is served instead. Visitors
  never see an unverified answer.
- The explainer narrates; it never makes, changes or recommends a payment decision, declines off-topic
  questions, and ignores instructions embedded in questions.
- Docker: `ASSISTANT_LLM=off` by default; `ASSISTANT_LLM=auto ANTHROPIC_API_KEY=... docker compose -f deploy/docker-compose.yml up -d`
  to enable Claude.

### Lead privacy

Leads are stored only on this laptop (embedded PGlite under `DATA_DIR/booth`); the booth service makes no
outbound requests. A lead needs explicit consent (`consent: true` plus the exact consent sentence shown) and
a valid email, or it is rejected with 400. Listing, exporting, summarising and deleting leads (right to
erasure) need the staff PIN (`X-Booth-Staff`). Kiosk analytics are anonymous: a random per-visit session id,
and any event that looks like personal data (names, emails, phone numbers) is refused.

### Proving it: `npm run verify:m5`

```bash
npm run verify:m5                                   # every scripted scenario (ports 37070-37079)
npm run verify:m5 -- --scenario provider-outage     # one scenario (repeatable)
npm run verify:m5 -- --help
```

It launches the system with a temp data dir, `ASSISTANT_LLM=off` and **no credentials**, then:

| | check |
| --- | --- |
| static | `services/booth/src` contains no outbound HTTP/socket client and no non-local URL |
| booth | consent required (missing/false/invalid email → 400), staff routes refuse a missing or wrong PIN, PIN works (list, CSV, summary), analytics refuse personal data, leads survive every reset, staff can erase a lead |
| bank | per scenario, run with ambient traffic, then ambient stopped and drained: ≥ 100 questions from the assistant's `generateQuestionBank(scenarioId, log)` |
| answers | each asked through the gateway (`POST /api/assistant/ask`): `verified: true`, grounded mode; every number in the text matches a citation value (display rounding only); every citation equals the value at `eventId` + `field` on the broker `/events` log; every aggregate citation (`eventId: null`) re-derived from the log by independent code (`tools/verify/m5-aggregates.ts`); key facts for the intent cited (e.g. a why-held answer cites the hold/score event of that payment) |
| safety | off-topic questions declined; prompt-injection questions leak nothing (keys, instructions), repeat no injected claim, and cause no events or orchestrator change |

Per-scenario table, `<data dir>/reports/verify-m5-<time>.json` (`--report-dir`), non-zero exit on any failure.

### M5 ports

| Service | Port | Notes |
| --- | --- | --- |
| assistant | 7076 | AI explainer (`ASSISTANT_PORT`); browser via `/api/assistant/*` |
| booth | 7077 | leads + analytics (`BOOTH_PORT`); browser via `/api/booth/*` |
| verify:m5 | 37070-37074, 37076, 37077, 37079 | its own system (`--base-port`) |
