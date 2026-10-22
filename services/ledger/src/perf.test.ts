// M2 done-criterion: 10,000 payments, debits = credits, no duplicates on retry.
// Slower test (~tens of seconds on PGlite). Skip with LEDGER_SKIP_PERF=1.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CORRIDOR_CASES, settledPayment, type SettledFixture } from './fixtures';
import { createInMemoryLedger, type LedgerStore } from './store';

const N = Number(process.env.LEDGER_PERF_N ?? 10_000);

describe.skipIf(process.env.LEDGER_SKIP_PERF === '1')(`ledger at scale (${N} payments)`, () => {
  let store: LedgerStore;
  beforeAll(async () => {
    store = await createInMemoryLedger();
  });
  afterAll(async () => {
    await store?.close();
  });

  it(
    `posts ${N} settlements, keeps debits = credits and creates no duplicates on retry`,
    async () => {
      const fixtures: SettledFixture[] = [];
      for (let i = 0; i < N; i++) {
        const tc = CORRIDOR_CASES[i % CORRIDOR_CASES.length]!;
        const scale = 1 + (i % 97);
        fixtures.push(
          settledPayment({
            ...tc,
            debtorAccountId: `ACC-${tc.corridor.slice(0, 2)}-${String(i % 250).padStart(4, '0')}`,
            providerId: ['orion', 'lyra', 'vega'][i % 3]!,
            source: { ...tc.source, amountMinor: tc.source.amountMinor * scale + i },
            target: { ...tc.target, amountMinor: tc.target.amountMinor * scale + 7 * i },
            fee: { ...tc.fee, amountMinor: i % 10 === 0 ? 0 : tc.fee.amountMinor + (i % 13) },
          }),
        );
      }
      const post = (f: SettledFixture) => store.postSettlement({ paymentId: f.state.paymentId, causationEventId: f.settledEventId, state: f.state });

      const t0 = performance.now();
      const concurrency = 16;
      let next = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < fixtures.length) await post(fixtures[next++]!);
        }),
      );
      const seconds = (performance.now() - t0) / 1000;
      const rate = Math.round(N / seconds);
      console.log(`[ledger perf] ${N} journals in ${seconds.toFixed(1)}s = ${rate} journals/s (PGlite in-memory)`);

      // Retry storm: every 10th payment re-posted 3 times concurrently.
      const retries = fixtures.filter((_, i) => i % 10 === 0).flatMap((f) => [f, f, f]);
      const replayed = await Promise.all(retries.map(post));
      expect(replayed.every((r) => !r.created)).toBe(true);

      const tb = await store.trialBalance();
      expect(tb.journals).toBe(N);
      expect(tb.balanced).toBe(true);
      for (const row of tb.byCurrency) expect(row.debits).toBe(row.credits);
      const dup = await store.driver.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM (SELECT payment_id FROM journals GROUP BY payment_id HAVING count(*) > 1) d`,
      );
      expect(dup[0]?.n).toBe(0);
      const t1 = performance.now();
      const inv = await store.invariants();
      console.log(`[ledger perf] invariants over ${tb.entries} entries in ${Math.round(performance.now() - t1)}ms`);
      expect(inv).toEqual({ ok: true, violations: [] });
    },
    300_000,
  );
});
