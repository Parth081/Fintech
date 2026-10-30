# Global Fintech Control Tower: project overview

A working, end-to-end simulation of a cross-border payments platform. It is built to show banks, payment
companies, neobanks and marketplaces that we can design and engineer complex financial infrastructure, not just
draw it. Everything runs on one laptop, offline, on **synthetic data** (fictional customers, providers,
banks and sanctions lists).

> It is a demonstration and sales asset, **not** a production payment system and **not** certified for any
> regulation. Screens say "Simulation" on purpose.

---

## 1. What problem it solves

Fintech buyers have seen many slide decks and click-through demos. They trust what they can inspect. This
project lets a prospect watch a payment cross borders, see why every decision was made, break things on
purpose, and question the system, while engineers can open the architecture and see it is real.

| Who | What they get from it |
| --- | --- |
| **Business development and sales** | A live booth demo and a client-meeting walkthrough with real behaviour behind every screen. Lead capture with consent at conferences. |
| **Bank and payment-company architects** | A reference of how we build event-driven, auditable payment infrastructure: ledger, routing, resilience, risk, ISO 20022 messages. |
| **Compliance and operations leaders** | A working back office: alert queues, case management with four-eyes approval, an audit trail, configuration with approval. |
| **Our engineering team** | A reusable base (contracts, event log, ledger, simulator, verification tools) for client proofs of concept. |

---

## 2. What it can do today

### Payments engine (milestones 1 to 3)
- A payment moves through **screening, risk, FX quote, provider routing, settlement, ledger and reconciliation**.
  Each step is its own service and communicates only through one ordered **event log**.
- **Double-entry ledger** whose database refuses unbalanced, edited or duplicate postings (embedded Postgres
  offline, real Postgres in Docker).
- **Simulated FX market** with tiered spreads that widen when rates move, and **smart routing** across three
  fictional providers by reliability, cost and speed, with a recorded explanation for every choice.
- **ISO 20022 messages** (payment instruction, status report, daily statement) and provider rejections with
  real reason codes.
- **Resilience:** circuit breakers, automatic failover to another provider and recovery with test payments.
  A live **provider-outage scenario** shows Orion failing, traffic re-routing and nothing being lost.

### Operations console and risk (milestone 4)
- Demo sign-in with **six roles** (operations, compliance analyst, compliance manager, treasury, admin, auditor).
- **Risk and compliance:** fuzzy matching against a fictional sanctions list, an explainable fraud model and four
  money-laundering patterns. Suspicious payments are held and become **cases**.
- **Case management:** investigators see why each alert fired; high-risk decisions need a second person
  (**four-eyes**). Operators can retry failed payments and refund completed ones; both are recorded.
- **Treasury and reconciliation**, **routing and provider configuration** (changes need a second person's
  approval), an **append-only audit log**, users and roles, and a developer area (API keys, simulated webhooks).
- Extra scenarios: **fraud ring**, **currency spike**, **sanctions hit**.

### Booth and AI explainer (milestone 5)
- **AI explainer:** answers questions such as "why was this held?" or "why did it go through Lyra?" using only
  what the system recorded, with the cited facts shown. Works fully offline; Claude can optionally phrase the
  answers, but every number is checked against the record first.
- **Visitor kiosk:** a visitor sends a payment, follows each step in plain English, asks "why", then may leave
  their details through a form with explicit consent. Leads stay on the booth laptop and can be deleted.
- **Attract loop:** when nobody is at the booth, the big screen plays a 90-second story by itself (normal flow,
  an outage, automatic recovery, "ledger still balanced").
- **Presenter console** on a tablet: start scenarios, pause or slow down, reset the demo in about five seconds.

---

## 3. The four ways it is shown

| Screen | Address when running | Audience |
| --- | --- | --- |
| Operations console | `http://127.0.0.1:7072/#/console` | Client meetings, compliance and operations buyers |
| Big screen (world map) | `http://127.0.0.1:7072/#/stage` | Booth, passing visitors |
| Visitor kiosk | `http://127.0.0.1:7072/#/kiosk` | Touch screen at the booth |
| Presenter console | `http://127.0.0.1:7072/#/presenter` | The person running the demo |

---

## 4. How it is built

```
                       payment events and control events (one ordered log)
  Payment API  ->  screening -> risk -> fx -> routing -> settlement -> ledger -> reconciliation
        |                                                                    |
   Orchestrator (scenarios, traffic)      Gateway (REST + live feed) -> web apps
   Ops service (cases, audit, config)     AI explainer      Booth (leads, analytics)
```

Design rules that make it credible:
1. **Event sourcing.** Every state change is an immutable event; the log is the source of truth.
2. **A decision trace on every decision** (inputs, rule version, reason codes), which also feeds the AI explainer.
3. **Money moves only as balanced ledger entries**, with idempotent retries so nothing is paid twice.
4. **Human actions are events too**, so the audit trail, the ledger and the screens cannot disagree.
5. **Deterministic simulation.** The same seed gives the same story, which makes rehearsals and tests reliable.
6. **Offline first.** Services bind to the local machine only; no external calls are needed.

**Stack:** TypeScript (Node 24), React 19 and Vite, embedded Postgres (PGlite) or Postgres, Docker Compose,
optional Kafka-compatible bus (Redpanda), optional Claude for answer phrasing.

---

## 5. Evidence that it works

These are repeatable commands, not claims:

| Proof | Command | Result when last run |
| --- | --- | --- |
| Whole test suite | `npm run ci` | 811 unit tests and 14 end-to-end tests pass |
| 10,000 payments: debits equal credits, no duplicates | `npm run verify:m2` | All checks pass, including with services killed mid-run |
| Provider outage, 10 times in a row, offline | `npm run verify:m3` | 10 of 10 pass; reset takes about 4 seconds |
| Enterprise workflow (cases, four-eyes, refunds, config, audit) | `npm run verify:m4` | 41 of 41 checks pass |
| AI explainer: 100+ questions per scenario, every number matched to the log | `npm run verify:m5` | Passes on all five scenarios |

---

## 6. Running it

```bash
npm install
npm start            # starts every service and the web apps
```

Then open the console address above and pick a demo user. To run a scenario, use the presenter console, or
`curl -X POST http://127.0.0.1:7074/scenarios/provider-outage/start`. Other useful commands:

```bash
npm run start:reset -- --ambient 3   # fresh data and steady background traffic
npm start -- --llm off               # fully offline explainer
npm run traffic -- --count 50        # send test payments
docker compose -f deploy/docker-compose.yml up -d --build   # same system in containers (with Postgres)
```

Ports: broker 7070, payment API 7071, gateway and web 7072, ledger 7073, orchestrator 7074, ops 7075,
explainer 7076, booth 7077, launcher control 7079.

---

## 7. Where things live

| Folder | Contents |
| --- | --- |
| `apps/web` | All screens: console, world map, kiosk, presenter |
| `packages/contracts` | Shared event and API definitions (the system's vocabulary) |
| `packages/event-bus`, `packages/market`, `packages/iso20022` | Event log client, FX and routing logic, bank-message builders |
| `services/*` | broker, payment-api, stages (the pipeline), ledger, gateway, orchestrator, ops, assistant, booth |
| `tools` | launcher and reset, traffic generator, the `verify:*` checks, benchmarks |
| `tests/e2e` | End-to-end tests against real running processes |
| `deploy` | Docker Compose (local broker and a Kafka-compatible option) |
| `docs/adr` | Fourteen short design decision records explaining why |
| `fintech-control-tower.drawio` | Architecture and milestone diagrams |

---

## 8. Honest limits

- **Synthetic only.** No real money, customers, banks or provider connections. Provider and sanctions-list
  names are fictional.
- **Not a compliance certification.** Screens and docs say "designed with patterns used for" regulated
  systems; never "compliant".
- **Claude-written answers are untested against the live API.** The offline explainer is fully verified;
  Claude mode only has tests with a fake client so far.
- **Not yet rehearsed physically.** The kiosk and big screen have been checked in a desktop browser, not on a
  touch screen with the booth hardware, and not with Wi-Fi switched off.
- **Docker and Kafka paths** were verified by hand; the GitHub CI run only validates the Docker files.
- **Duplicate-record edge case on the Kafka option:** a crash at exactly the wrong moment can write a duplicate
  event. Every service ignores it, so money is unaffected; the built-in log has no such gap.

---

## 9. Suggested next steps

1. Booth hardening: a rehearsal with Wi-Fi off, a staff lead-export routine, a hot-spare laptop and a recorded
   backup run.
2. Try the explainer in Claude mode with a real API key.
3. Tailor scenarios to the first target audience (for example PSP acceptance rates, or bank compliance cases).
4. Pair each module with an anonymised real client reference, so the demo is backed by delivered work.
5. Name a permanent owner and a small budget so the demo does not go stale between events.
