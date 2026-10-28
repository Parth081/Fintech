# @ct/ledger: double-entry ledger

The ledger is the system's source of truth for money. It runs as one process that does two things:

- runs the **ledger pipeline stage**: on `payment.settled` it posts a journal and emits `ledger.posted`.
- serves the **read API** from `@ct/contracts` `ledger-api.ts` on `LEDGER_PORT` (default 7073).

```
npx tsx services/ledger/src/index.ts        # prints "[ledger] ready on http://127.0.0.1:7073 ..."
```

The storage driver depends on the environment:

| Env | Driver |
|---|---|
| `DATABASE_URL` unset (default) | embedded PGlite (real Postgres compiled to WASM, works offline), stored in `${DATA_DIR}/ledger` |
| `DATABASE_URL=postgres://...` | node-postgres (pool of 10) |

Both drivers run the same SQL. Migrations are versioned in `src/migrations.ts` and recorded in
`schema_migrations`. Each migration runs in its own transaction, under an advisory lock.

## Chart of accounts

Each account holds exactly one currency, and its id ends with `:<CCY>`. An account is created the
first time it is used. Its type comes from its prefix, as listed in `src/chart.ts`. An id that matches
no prefix is rejected.

| Pattern | Type | Meaning |
|---|---|---|
| `customer:<debtorAccountId>:<CCY>` | asset | Funds collected from (receivable from) the paying customer |
| `fx-position:<CCY>` | asset | Treasury currency position: source currency sold (credit), target currency bought (debit) |
| `provider:<providerId>:payable:<CCY>` | liability | Owed to the payout provider for what it delivered |
| `fee-revenue:<CCY>` | revenue | Transfer fees earned |
| `fx-revenue:<CCY>` | revenue | Reserved: realised FX spread (M3+) |
| `suspense:<reason>:<CCY>` | liability | Reserved: unmatched amounts / reconciliation breaks |
| `expense:<name>:<CCY>` | expense | Reserved |
| `equity:<name>:<CCY>` | equity | Reserved |

Customer and provider ids carry the currency because one customer id or provider can move several
currencies. For example, `orion` pays out in INR, BRL and PHP.

Account balances follow the API definition: `balance = debits - credits`. A positive balance is
normal for asset and expense accounts. A negative balance is normal for liability, revenue and
equity accounts.

## Posting rule: settlement (`ledger-v1`)

The rule reads these facts from the payment state:

- source and target amounts from `payment.quoted`
- the provider from `payment.settled`
- the fee from `payment.routed.estimatedFee`, which must be in the source currency

```
Dr customer:<debtor>:<SRC>         amount + fee
  Cr fx-position:<SRC>             amount
  Cr fee-revenue:<SRC>             fee          (line omitted when the fee is 0)
Dr fx-position:<TGT>               target
  Cr provider:<id>:payable:<TGT>   target
```

Example: a USD 1,250.00 payment to INR at 83.00 with a USD 1.88 fee, paid out via orion (amounts in
minor units):

| Account | Debit | Credit |
|---|---:|---:|
| customer:ACC-US-0001:USD | 125,188 | |
| fx-position:USD | | 125,000 |
| fee-revenue:USD | | 188 |
| fx-position:INR | 10,375,000 | |
| provider:orion:payable:INR | | 10,375,000 |

Amounts are integer minor units, stored as `BIGINT`. They are read back as text and converted only
when the value is a safe integer. Invariant sums use `BigInt`.

## Posting rule: refund (M4, `ledger-v1`)

On `payment.refund_requested` (an operator refund approved in the ops console) the ledger stage posts a
journal of kind `refund` and emits `payment.refunded { journalId, entries }`. The refund journal is the
settlement journal mirrored line for line: same accounts, same amounts, every direction swapped. The
example above refunds as:

| Account | Debit | Credit |
|---|---:|---:|
| customer:ACC-US-0001:USD | | 125,188 |
| fx-position:USD | 125,000 | |
| fee-revenue:USD | 188 | |
| fx-position:INR | | 10,375,000 |
| provider:orion:payable:INR | 10,375,000 | |

Fee policy: a refund is a full reversal, so the customer also gets the transfer fee back. FX is unwound at
the original quoted rate. No new FX exposure is booked, so a market move since settlement is a treasury
matter, not the customer's. The provider payable is reversed, which means the payout is recalled from the
provider.

Rules:

- At most one refund journal per payment. A unique partial index enforces it, and a repeat request (any
  causation) returns the existing journal (`created: false`).
- A refund journal can only exist after the payment's settlement journal. Code checks this, and so does a
  `BEFORE INSERT` trigger (migration 2).
- `invariants()` also reports refunds without a settlement journal, more than one refund per payment, and
  any refund that does not exactly reverse its settlement per account and currency.

## Guarantees and how they are enforced

| Guarantee | In code | In the database |
|---|---|---|
| Debits = credits per currency, ≥ 2 entries | `assertPostable` (uses `isBalanced` from contracts) | Deferred constraint triggers on `journals` and `entries`, checked at COMMIT. No path can commit an unbalanced journal, including raw SQL. |
| Entry currency = account currency | Checked against the chart | Composite FK `(account_id, currency) → accounts` |
| Amounts > 0 | `isBalanced` | `CHECK (amount_minor > 0)` |
| Posted in one transaction | One transaction: accounts + one `WITH j AS (INSERT journal) INSERT entries` statement | Entries may only be added in the transaction that created their journal (`xmin` check) |
| Immutable | n/a | `BEFORE UPDATE/DELETE/TRUNCATE` triggers on accounts, journals and entries raise errors. Corrections must be new journals. |
| Idempotent on causation | Deterministic journal id from the causation id. `ON CONFLICT DO NOTHING`, then the existing journal is returned. | `causation_event_id UNIQUE`, plus a partial unique index allowing one `settlement` journal per payment |

Concurrent duplicates are handled as follows:

- **PGlite** runs transactions one at a time.
- **Postgres**: a second inserter waits on the unique index until the first commits. Its insert then
  becomes a no-op, and it reads back the committed journal.

Tests cover 50 concurrent duplicate posts on both drivers.

## HTTP API (GET only)

```
/health                       { ok, journals, driver }
/ledger/trial-balance         TrialBalance
/ledger/accounts              AccountBalance[]
/ledger/accounts/:accountId   AccountBalance & { recent: JournalView[] }   (URL-encoded id; 404 if unknown)
/ledger/journals?paymentId=x  JournalView[]   (no paymentId: latest 50, ?limit= up to 500)
/ledger/invariants            { ok, violations[] }
```

`/ledger/invariants` re-reads every raw journal, entry and account and recomputes in JS with BigInt.
It checks that:

- every journal balances per currency and has at least 2 entries
- no two journals share a causation id
- no payment has two settlement journals
- every entry's currency matches its account's currency
- every account's type matches the chart
- the trial balance is balanced per currency
- the balances the API serves match the recomputation

## Library

```ts
import { openLedgerStore, createInMemoryLedger, startLedgerService, openConfiguredLedger } from '@ct/ledger';
const ledger = await createInMemoryLedger();              // StageServices.ledger + close()
const svc = await startLedgerService({ store: ledger, bus, port: 0 }); // { port, close() }
```

## Tests

```
npx vitest run services/ledger
```

- The 10,000-payment test is in `perf.test.ts`. Set `LEDGER_SKIP_PERF=1` to skip it, or
  `LEDGER_PERF_N` to change its size.
- `postgres.test.ts` runs the same suite against `postgres:17-alpine` in docker. It is skipped when
  docker is unavailable, or when `LEDGER_SKIP_DOCKER=1` is set. To use an existing throwaway database
  instead of docker, set `TEST_DATABASE_URL`.
