# Global Fintech Control Tower

A conference demo of an **event-driven cross-border payments platform**: visitors watch a payment travel
from "initiated" through screening, risk, FX, routing, settlement, ledger and reconciliation, with the
reason for every decision visible on screen.

> **Simulation · synthetic data · runs offline.** No real customers, banks, providers or money. Provider
> names (Orion, Lyra, Vega), rails and corridors are fictional.

This repository is at **Milestone M1 - walking skeleton**: the full pipeline exists end to end, every step
is a simple deterministic stub, and one basic screen shows payments move from start to settled. The
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
npm start            # builds the UI if needed, starts all 10 processes
```

Open **http://127.0.0.1:7072**, click **Send test payment**, and watch it go from *initiated* to *settled*.

In a second terminal, send seeded synthetic traffic:

```bash
npm run traffic -- --count 10 --seed 42 --rate 2
npm run traffic -- --count 3 --scenario force-hold     # payments the risk stub will hold
```

Stop everything with **Ctrl+C** (all child processes are stopped, none are left behind).

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Launcher: builds the UI if `apps/web/dist` is missing, checks ports, starts broker → payment-api + 7 stages → gateway, waits for each to be healthy, prints the URL. `npm start -- --help` lists options. |
| `npm run start:reset` | Same, but deletes the data directory (event log) first. |
| `npm run traffic -- [opts]` | Posts seeded synthetic payments to `POST /payments` (`--count`, `--seed`, `--rate`, `--scenario`, `--url`, `--start`). Same seed = same payments = same Idempotency-Keys, so re-running is idempotent. Prints accepted / duplicates / errors. |
| `npm run typecheck` | `tsc` over all packages, services, apps, tools and tests. |
| `npm test` | Unit tests (vitest), excluding e2e. |
| `npm run test:e2e` | End-to-end: launches the whole system on temp ports with zero delays and drives a payment to settled. |
| `npm run build:web` | Builds the React UI into `apps/web/dist` (served by the gateway). |
| `npm run ci` | typecheck + test + build:web + test:e2e, as CI does. |

Launcher options: `--reset`, `--no-build`, `--quiet`, `--host`, `--broker-port`, `--api-port`,
`--gateway-port`, `--data-dir`, `--stage-delay`, `--settlement-delay`, `--timeout`.

## Ports and environment

All defaults live in [`packages/contracts/src/config.ts`](packages/contracts/src/config.ts). Everything binds to
`127.0.0.1` so the demo works with Wi-Fi off.

| Variable | Default | Used by | Meaning |
| --- | --- | --- | --- |
| `HOST` | `127.0.0.1` | all | Bind address |
| `BROKER_PORT` | `7070` | broker | Local event broker (WebSocket + `GET /health`) |
| `PAYMENT_API_PORT` | `7071` | payment-api | `POST /payments`, `POST /payments/sample`, `GET /health` |
| `GATEWAY_PORT` | `7072` | gateway | UI, API for the browser, live updates, `GET /health` |
| (vite dev) | `5173` | apps/web | `npm run dev -w @ct/web`, proxies `/api` and `/ws` to the gateway |
| `BUS` | `local` | all | `local` (built-in broker), `memory` (single-process tests), `kafka` (Redpanda/Kafka) |
| `BROKER_URL` | `ws://HOST:BROKER_PORT` | clients of the bus | Where the local broker is |
| `KAFKA_BROKERS` | `127.0.0.1:9092` | `BUS=kafka` | Comma-separated Kafka bootstrap servers |
| `PAYMENT_API_URL` | `http://HOST:PAYMENT_API_PORT` | gateway, traffic | Where the Payment API is |
| `GATEWAY_URL` | `http://HOST:GATEWAY_PORT` | tools | Where the gateway is |
| `DATA_DIR` | `.data` | broker | Event-log directory (delete it, or use `--reset`, to start clean) |
| `STAGE_DELAY_MS` | `400` | stages | Artificial delay per stage so people can watch (0 in tests) |
| `SETTLEMENT_DELAY_MS` | `900` | settlement | Extra delay before settlement |
| `WEB_DIST` | `apps/web/dist` | gateway | Built UI to serve |

## Repository layout

```
packages/contracts/   event envelope + payload types, state machine, money, ids, corridors, config (shared by all)
packages/event-bus/   bus interface + local-broker, in-memory and Kafka adapters
services/broker/      built-in event broker: one topic, append-only log in DATA_DIR
services/payment-api/ validates requests, de-duplicates by Idempotency-Key, publishes payment.initiated
services/stages/      screening, risk, fx, routing, settlement, ledger, reconciliation (one process each, stubs in M1)
services/gateway/     serves the UI, projects events into payment views, pushes live updates
apps/web/             React UI (first basic screen)
tools/launcher/       `npm start`: process supervisor (ordering, health, logs, clean shutdown)
tools/traffic/        `npm run traffic`: seeded synthetic payment generator
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
docker compose -f deploy/docker-compose.yml up --build      # http://127.0.0.1:7072
docker compose -f deploy/docker-compose.yml down -v         # stop and remove the event-log volume
```

One image (`deploy/Dockerfile`) runs every service; Compose starts broker, payment-api, each stage and the
gateway with health checks and a volume for the broker's data. The `redpanda` profile adds a single-node
Redpanda and switches the services to the Kafka adapter:

```bash
BUS=kafka docker compose -f deploy/docker-compose.yml --profile redpanda up --build
```

> The Kafka/Redpanda path was verified 2026-10-22 with Docker 29.9 / Redpanda: payments reach reconciled, 10 concurrent, no duplicate events after a full restart. The local broker stays the default for the laptop demo.

## Tests

```bash
npm test                 # unit tests: contracts, bus, broker, services, launcher, traffic generator
npm run build:web
npm run test:e2e         # whole system on temp ports + temp data dir, zero delays
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, UI build and e2e on Node 22 and 24, and validates the
Compose file with `docker compose config`.

## Troubleshooting

- **"Cannot start: port(s) busy."** Another copy is probably still running. Stop it, or find the process:
  Windows `netstat -ano | findstr :7072` then `taskkill /PID <pid> /F`; macOS/Linux `lsof -i :7072`. Or use
  other ports: `npm start -- --broker-port 7170 --api-port 7171 --gateway-port 7172`.
- **Odd state or old payments on screen.** `npm run start:reset` deletes `.data/` and starts clean.
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

## What comes in M2 - Money core

- Double-entry ledger (debits = credits, enforced)
- FX service with simulated rates and spreads
- Routing over the 3 fictional providers
- Settlement simulator with ISO 20022-style messages
- Synthetic traffic at scale across 3 corridors
- Done when: 10,000 payments with debits = credits and no duplicates on retry
