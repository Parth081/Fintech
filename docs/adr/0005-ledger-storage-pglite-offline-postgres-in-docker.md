# ADR 0005: Ledger storage - embedded PGlite offline, Postgres in Docker

- **Status:** Accepted (M2)
- **Date:** 2026-10-22

## Context

M2 replaces the M1 ledger stage with a real double-entry ledger (`services/ledger`, port 7073). The
ledger is the system of record for money: every journal must balance, a payment must never be posted
twice, and the trial balance must be checkable at any time. It needs real transactions and constraints
(SQL), but the conference demo must still start with `npm start` on a laptop with Wi-Fi off and no Docker.

## Decision

- **One SQL schema, two drivers**, chosen by `DATABASE_URL` (`packages/contracts/src/config.ts`):
  - empty (default for `npm start`, the e2e test and `verify:m2`): **embedded PGlite** (Postgres compiled to
    WASM, in-process) stored under `${DATA_DIR}/ledger`. No server, no network, deleted by `--reset`.
  - set (Docker Compose): **Postgres 17** (`postgres:17-alpine` service with a named volume and a
    `pg_isready` health check); the ledger container gets
    `DATABASE_URL=postgres://ct:ct-local-only@postgres:5432/ledger` and starts only once Postgres is healthy.
- Both run the same migrations and the same queries, so behaviour (constraints, `UNIQUE` journal per
  payment, balance checks) is identical; the ledger's store test suite runs against both.
- The ledger service replaces the stage process: the launcher starts `services/ledger/src/index.ts` with a
  `/health` probe instead of `services/stages/src/index.ts --stage ledger`.
- Exactly-once posting comes from the database, not the bus: a journal is keyed by payment (and its
  causation event), inserted in one transaction with its entries, and a redelivered `payment.settled`
  finds the existing journal. `ledger.posted` carries a deterministic eventId (ADR 0004), so even a
  re-publish after a crash is a broker-level no-op (ADR 0006).

## Consequences

- + Offline demo keeps working with zero infrastructure; Docker shows the "real" deployment shape.
- + `npm run verify:m2` proves the money invariants on the default (PGlite) path; the Docker path is
  verified with `verify:m2 --url` against the compose stack.
- - PGlite is single-process and slower than a Postgres server for large volumes; fine for 10k payments,
  not a production choice.
- - Two drivers mean the SQL must stay within what both support (plain Postgres SQL, no extensions).
- The Postgres password in compose is a local-only placeholder for synthetic data, not a secret.
