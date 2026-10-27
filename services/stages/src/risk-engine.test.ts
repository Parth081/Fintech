// M4 risk & compliance engine: matching quality, fraud model, AML typologies, decision policy, calibration.
import { describe, expect, it } from 'vitest';
import { applyEvent, CORRIDORS, DEFAULT_CONFIG, type AnyEvent, type PaymentState } from '@ct/contracts';
import { makeEvent, sampleInitiatedPayload } from '@ct/contracts/testing';
import { corridorPopulation, generatePayment, hash32 } from '../../../tools/traffic/generator';
import { SANCTIONS_NEAR_MATCHES } from '../../../tools/traffic/risk';
import { samplePayment } from '@ct/payment-api';
import {
  assessRisk,
  bestMatch,
  detectAml,
  FICTIONAL_SANCTIONS_LIST,
  historyBefore,
  jaroWinkler,
  nameSimilarity,
  normaliseName,
  recordOf,
  SANCTIONS_HIT_THRESHOLD,
  SANCTIONS_LIST_NAME,
  sanctionsAlert,
  scoreFraud,
  screenParties,
  simulateTraffic,
  toUsd,
  type PaymentRecord,
} from './risk';

const T0 = Date.parse('2026-10-26T15:00:00Z');
let seq = 0;
function rec(over: Partial<PaymentRecord> & { usd?: number }): PaymentRecord {
  const usd = over.usd ?? 500;
  seq += 1;
  return {
    paymentId: `h-${seq}`, atMs: T0 - 60_000, debtorAccount: 'D-1', creditorAccount: 'C-1', debtorName: 'Sender', creditorName: 'Receiver',
    corridor: 'US-IN', amount: { amountMinor: Math.round(usd * 100), currency: 'USD' }, major: usd, ...over, usd,
  };
}
function stateOf(id: string, over: Parameters<typeof sampleInitiatedPayload>[0] = {}, atMs = T0): PaymentState {
  return applyEvent(undefined, makeEvent('payment.initiated', id, sampleInitiatedPayload(over), { occurredAt: new Date(atMs).toISOString() }) as AnyEvent);
}

describe('sanctions list', () => {
  it('has ~60 fictional entries with unique ids, aliases and fictional jurisdictions', () => {
    expect(FICTIONAL_SANCTIONS_LIST.length).toBeGreaterThanOrEqual(60);
    expect(new Set(FICTIONAL_SANCTIONS_LIST.map((e) => e.id)).size).toBe(FICTIONAL_SANCTIONS_LIST.length);
    expect(FICTIONAL_SANCTIONS_LIST.some((e) => e.type === 'individual')).toBe(true);
    expect(FICTIONAL_SANCTIONS_LIST.some((e) => e.type === 'entity')).toBe(true);
    for (const e of FICTIONAL_SANCTIONS_LIST) for (const c of e.countries) expect(c).toMatch(/^X[A-Z]$/);
    expect(SANCTIONS_LIST_NAME).toBe('FICTIONAL CONSOLIDATED LIST');
  });
});

describe('fuzzy matching', () => {
  it('Jaro-Winkler matches the textbook values', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.9611, 3);
    expect(jaroWinkler('dwayne', 'duane')).toBeCloseTo(0.84, 2);
    expect(jaroWinkler('abc', 'abc')).toBe(1);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });

  it('normalises case, diacritics, punctuation, legal forms', () => {
    expect(normaliseName('  Société Générale-Trading, LTD. ')).toEqual(['societe', 'generale', 'trading']);
    expect(nameSimilarity('MORVANE, Dariusz Kael', 'Dariusz Kael Morvane')).toBe(1);
  });

  it('flags every scenario near-match against the intended entry', () => {
    const expected = ['FCL-0001', 'FCL-0002', 'FCL-0003', 'FCL-0004', 'FCL-0005'];
    SANCTIONS_NEAR_MATCHES.forEach((n, i) => {
      const m = bestMatch('creditor', n.name)!;
      expect(m.score).toBeGreaterThanOrEqual(SANCTIONS_HIT_THRESHOLD);
      expect(m.entry.id).toBe(expected[i]);
    });
  });

  it('catches transliteration, dropped words, reordering and aliases', () => {
    for (const name of ['Darius Morvane', 'Morvane Dariusz', 'Severin Malek', 'Zarevsk Industrialni Bank', 'Amberlock Exchange', 'Teodor Kasparyan', 'Golden Dune Bullion']) {
      expect(screenParties('Ordinary Sender', name).result).toBe('hit');
    }
    expect(bestMatch('debtor', 'Darek Morvane')).toMatchObject({ matchedAlias: true, entry: { id: 'FCL-0002' } });
  });

  it('does not flag ordinary customers (synthetic populations, test fixtures, scenario names)', () => {
    let worst = { score: 0, name: '' };
    for (const seed of [hash32('ambient:control-tower'), 42, 7]) {
      for (const c of CORRIDORS) {
        const pop = corridorPopulation(seed, c);
        for (const p of [...pop.senders, ...pop.recipients]) {
          const m = bestMatch('debtor', p.name)!;
          if (m.score > worst.score) worst = { score: m.score, name: p.name };
        }
      }
    }
    expect(worst.score).toBeLessThan(SANCTIONS_HIT_THRESHOLD);
    for (const name of ['Northwind Marketplace', 'Asha Textiles', 'Brightwater Textiles Ltd', 'Marigold Bullion Traders', 'Halden Crest Logistics LLC', 'Fictional Sender', 'Collector Account 2', 'Maria Santos']) {
      expect(bestMatch('debtor', name)!.score).toBeLessThan(SANCTIONS_HIT_THRESHOLD);
    }
  });

  it('is deterministic and builds a sanctions alert with entry, score, field and algorithm', () => {
    const a = screenParties('Brightwater Textiles Ltd', 'Volkhov Maritime Holding');
    expect(screenParties('Brightwater Textiles Ltd', 'Volkhov Maritime Holding')).toEqual(a);
    const alert = sanctionsAlert('p-1', a)!;
    expect(alert).toMatchObject({ kind: 'sanctions', rule: 'SANCTIONS_FUZZY_MATCH', severity: 'critical', alertId: expect.stringMatching(/^ALR-[0-9A-F]{12}$/) });
    expect(alert.evidence).toMatchObject({ listName: SANCTIONS_LIST_NAME, field: 'creditor', entry: { id: 'FCL-0001', name: 'VOLKOV MARITIME HOLDINGS' }, algorithm: expect.stringContaining('Jaro-Winkler') });
    expect(sanctionsAlert('p-1', a)).toEqual(alert);
  });
});

describe('fraud model', () => {
  it('is deterministic; contributions add up to the logit; reasons are positive and sorted', () => {
    const p = rec({ usd: 9_850, major: 9_850, debtorAccount: 'NEW', creditorAccount: 'HUB', atMs: T0 });
    const input = { payment: p, debtorCountry: 'US', history: [], atMs: T0, manualReviewAboveUsd: 25_000 };
    const a = scoreFraud(input);
    expect(scoreFraud(input)).toEqual(a);
    const sum = a.features.reduce((s, f) => s + f.contribution, a.intercept);
    expect(a.logit).toBeCloseTo(sum, 3);
    expect(a.score).toBeCloseTo(1 / (1 + Math.exp(-a.logit)), 3);
    expect(a.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(['JUST_BELOW_THRESHOLD', 'FIRST_TIME_SENDER', 'NEW_BENEFICIARY', 'LARGE_AMOUNT']));
    for (let i = 1; i < a.reasons.length; i++) expect(a.reasons[i - 1]!.weight).toBeGreaterThanOrEqual(a.reasons[i]!.weight);
    expect(a.reasons.every((r) => r.weight > 0 && r.text.length > 10)).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(0.7); // a structured amount from a brand-new account
  });

  it('uses sender history: amount vs usual, velocity, known beneficiary', () => {
    const history = Array.from({ length: 6 }, (_, i) => rec({ usd: 200, atMs: T0 - 60_000 * (i + 1) }));
    const usual = scoreFraud({ payment: rec({ usd: 210, atMs: T0 }), debtorCountry: 'US', history, atMs: T0, manualReviewAboveUsd: 25_000 });
    const spike = scoreFraud({ payment: rec({ usd: 4_000, atMs: T0 }), debtorCountry: 'US', history, atMs: T0, manualReviewAboveUsd: 25_000 });
    const f = (r: typeof usual, c: string) => r.features.find((x) => x.code === c)!.value;
    expect(f(usual, 'AMOUNT_VS_HISTORY')).toBeLessThan(0.05);
    expect(f(spike, 'AMOUNT_VS_HISTORY')).toBe(1);
    expect(f(usual, 'VELOCITY')).toBeCloseTo(4 / 6, 3);
    expect(f(usual, 'NEW_BENEFICIARY')).toBe(0);
    expect(f(usual, 'FIRST_TIME_SENDER')).toBe(0);
    expect(spike.score).toBeGreaterThan(usual.score);
  });

  it('history only includes payments initiated at a lower log offset than the anchor', () => {
    const a = stateOf('a', { debtor: { name: 'A', country: 'US', accountId: 'X' } }, T0 - 5_000);
    const b = stateOf('b', { debtor: { name: 'B', country: 'US', accountId: 'X' } }, T0 - 4_000);
    const self = stateOf('self', {}, T0 - 3_000);
    const late = stateOf('late', {}, T0 - 6_000); // earlier timestamp but appended to the log after the anchor
    const offsets = new Map([[a.history[0]!.eventId, 1], [b.history[0]!.eventId, 2], [self.history[0]!.eventId, 3], [late.history[0]!.eventId, 9]]);
    const states = [a, b, self, late];
    const h = historyBefore(states, 'self', { atMs: T0, offset: 5 }, (id) => offsets.get(id));
    expect(h.map((x) => x.paymentId)).toEqual(['a', 'b']);
    // without offsets (hand-built contexts): createdAt before the anchor time
    expect(historyBefore(states, 'self', { atMs: T0 - 4_500 }).map((x) => x.paymentId)).toEqual(['late', 'a']);
  });
});

describe('AML typologies', () => {
  const at = T0;
  it('fan-in: three senders, one beneficiary, within 15 minutes', () => {
    const history = [rec({ debtorAccount: 'S1', creditorAccount: 'HUB', usd: 5_000 }), rec({ debtorAccount: 'S2', creditorAccount: 'HUB', usd: 5_000 })];
    const hits = detectAml(rec({ debtorAccount: 'S3', creditorAccount: 'HUB', usd: 5_000, atMs: at }), history, at, 25_000);
    expect(hits.map((h) => h.rule)).toEqual(['AML_FAN_IN']);
    expect(hits[0]!.relatedPaymentIds).toEqual(history.map((h) => h.paymentId));
    expect(hits[0]!.evidence).toMatchObject({ distinctSenders: 3, beneficiaryAccount: 'HUB' });
    // small amounts or an old payment do not count
    expect(detectAml(rec({ debtorAccount: 'S3', creditorAccount: 'HUB', usd: 500, atMs: at }), history, at, 25_000)).toEqual([]);
    const old = [history[0]!, { ...history[1]!, atMs: at - 16 * 60_000 }];
    expect(detectAml(rec({ debtorAccount: 'S3', creditorAccount: 'HUB', usd: 5_000, atMs: at }), old, at, 25_000)).toEqual([]);
  });

  it('fan-out: one sender, three beneficiaries, within 10 minutes', () => {
    const history = [rec({ debtorAccount: 'COL', creditorAccount: 'R1', usd: 4_900 }), rec({ debtorAccount: 'COL', creditorAccount: 'R2', usd: 4_900 })];
    const hits = detectAml(rec({ debtorAccount: 'COL', creditorAccount: 'R3', usd: 4_900, atMs: at }), history, at, 25_000);
    expect(hits.map((h) => h.rule)).toEqual(['AML_FAN_OUT']);
    expect(hits[0]!.relatedPaymentIds).toHaveLength(2);
    expect(detectAml(rec({ debtorAccount: 'COL', creditorAccount: 'R2', usd: 4_900, atMs: at }), [history[1]!], at, 25_000)).toEqual([]);
  });

  it('structuring: repeated amounts just below the reporting line or the review threshold', () => {
    const history = [rec({ debtorAccount: 'M1', creditorAccount: 'HUB', usd: 9_900, major: 9_900, atMs: at - 3_600_000 })];
    const hits = detectAml(rec({ debtorAccount: 'M2', creditorAccount: 'HUB', usd: 9_850, major: 9_850, atMs: at }), history, at, 25_000);
    expect(hits.map((h) => h.rule)).toContain('AML_STRUCTURING');
    expect(hits.find((h) => h.rule === 'AML_STRUCTURING')!.relatedPaymentIds).toEqual([history[0]!.paymentId]);
    // just below the configured manual-review threshold (USD 25,000 -> band 22,500..25,000)
    const near = [rec({ debtorAccount: 'B', creditorAccount: 'Z1', usd: 24_000, major: 24_000, atMs: at - 7_200_000 })];
    expect(detectAml(rec({ debtorAccount: 'B', creditorAccount: 'Z2', usd: 23_500, major: 23_500, atMs: at }), near, at, 25_000).map((h) => h.rule)).toContain('AML_STRUCTURING');
    // a single just-below payment is not structuring
    expect(detectAml(rec({ debtorAccount: 'Q', creditorAccount: 'Q2', usd: 9_850, major: 9_850, atMs: at }), [], at, 25_000)).toEqual([]);
  });

  it('rapid in-out: received funds sent straight on', () => {
    const history = [rec({ debtorAccount: 'X', creditorAccount: 'PASS', usd: 6_000, atMs: at - 20 * 60_000 })];
    const hits = detectAml(rec({ debtorAccount: 'PASS', creditorAccount: 'Y', usd: 5_800, atMs: at }), history, at, 25_000);
    expect(hits.map((h) => h.rule)).toEqual(['AML_RAPID_IN_OUT']);
    expect(hits[0]!.evidence).toMatchObject({ account: 'PASS', receivedUsd: 6_000 });
    expect(detectAml(rec({ debtorAccount: 'PASS', creditorAccount: 'Y', usd: 1_000, atMs: at }), history, at, 25_000)).toEqual([]);
  });
});

describe('decision policy', () => {
  const config = { 'risk.thresholds': DEFAULT_CONFIG['risk.thresholds'], 'risk.manualReviewAboveUsd': DEFAULT_CONFIG['risk.manualReviewAboveUsd'] };
  it('approves an ordinary payment with the policy version and inputs in the plan', () => {
    const plan = assessRisk({ state: stateOf('ok'), history: [], atMs: T0, config });
    expect(plan.decision).toBe('approve');
    expect(plan.alerts).toEqual([]);
    expect(plan.inputs).toMatchObject({ policyVersion: 'risk-engine-v1', fraudModel: 'fraud-lr-v1', config });
  });

  it('a sanctions hit always holds, even when the fraud score would reject', () => {
    const state = stateOf('s', { amount: { amountMinor: 999_000, currency: 'USD' }, creditor: { name: 'Volkhov Maritime Holding', country: 'IN', accountId: 'Z' } });
    const plan = assessRisk({ state, history: [], atMs: T0, config: { ...config, 'risk.thresholds': { hold: 0.5, reject: 0.51 } } });
    expect(plan.decision).toBe('hold');
    expect(plan.alertIds[0]).toBe(sanctionsAlert('s', plan.screening)!.alertId);
    expect(plan.heldReason).toMatch(/Sanctions screening/);
  });

  it('thresholds and the review amount come from config', () => {
    const state = stateOf('t', { amount: { amountMinor: 980_000, currency: 'USD' }, debtor: { name: 'New Person', country: 'US', accountId: 'NEW-1' } });
    const base = assessRisk({ state, history: [], atMs: T0, config });
    expect(base.decision).toBe('hold');
    expect(base.alerts.map((a) => a.rule)).toContain('FRAUD_MODEL_HIGH');
    expect(assessRisk({ state, history: [], atMs: T0, config: { ...config, 'risk.thresholds': { hold: 0.99, reject: 0.995 } } }).decision).toBe('approve');
    expect(assessRisk({ state, history: [], atMs: T0, config: { ...config, 'risk.thresholds': { hold: 0.3, reject: 0.5 } } })).toMatchObject({ decision: 'reject', alerts: [expect.objectContaining({ rule: 'FRAUD_MODEL_REJECT', severity: 'critical' })] });
    const small = stateOf('u', { amount: { amountMinor: 200_000, currency: 'USD' } });
    expect(assessRisk({ state: small, history: [], atMs: T0, config }).decision).toBe('approve');
    const review = assessRisk({ state: small, history: [], atMs: T0, config: { ...config, 'risk.manualReviewAboveUsd': 1_000 } });
    expect(review.decision).toBe('hold');
    expect(review.alerts.map((a) => a.rule)).toContain('AML_LARGE_VALUE_REVIEW');
    expect(review.reasonCodes).toContain('MANUAL_REVIEW_AMOUNT');
  });

  it('force-hold scenario holds with a workable alert', () => {
    const plan = assessRisk({ state: stateOf('f', { scenario: 'force-hold' }), history: [], atMs: T0, config });
    expect(plan).toMatchObject({ decision: 'hold', heldReason: 'Manual review (scenario)', alerts: [expect.objectContaining({ rule: 'SCENARIO_FORCE_HOLD' })] });
  });

  it('USD equivalents use the reference rates', () => {
    expect(toUsd({ amountMinor: 100_000, currency: 'GBP' })).toBe(1_270);
    expect(recordOf(stateOf('r')).usd).toBe(1_250);
  });
});

describe('calibration on synthetic traffic', () => {
  const ambient = (label: string, n: number) => Array.from({ length: n }, (_, i) => generatePayment(hash32(`ambient:${label}`), i).body);

  it.each([
    ['control-tower', 4, '2026-10-26T15:00:00Z'],
    ['control-tower', 4, '2026-10-26T07:00:00Z'],
    ['control-tower', 1, '2026-10-26T15:00:00Z'],
    ['other', 2, '2026-10-26T18:00:00Z'],
  ] as const)('ambient seed %s at %s/s from %s: ~2-5%% held, few rejects', (seed, rate, start) => {
    const { summary } = simulateTraffic(ambient(seed, 3000), { startMs: Date.parse(start), ratePerSec: rate, config: DEFAULT_CONFIG });
    expect(summary.holdRate).toBeGreaterThanOrEqual(0.012);
    expect(summary.holdRate).toBeLessThanOrEqual(0.05);
    expect(summary.rejectRate).toBeLessThanOrEqual(0.005);
  });

  it('the payment API sample ("send test payment") is never held, at any hour, for a brand-new sender', () => {
    for (const hourUtc of [3, 7, 15]) {
      for (let i = 0; i < 400; i++) {
        const body = samplePayment();
        const state = stateOf(`sample-${hourUtc}-${i}`, body, Date.parse(`2026-10-26T${String(hourUtc).padStart(2, '0')}:00:00Z`));
        const plan = assessRisk({ state, history: [], atMs: Date.parse(state.createdAt) + 400, config: DEFAULT_CONFIG });
        expect(plan.decision, `${JSON.stringify(body)} -> ${plan.fraud.score}`).toBe('approve');
      }
    }
  });

  it('crafted risky traffic (tools/traffic risk mix) is always held', () => {
    const risky = Array.from({ length: 3000 }, (_, i) => generatePayment(99, i, { riskMix: { sanctions: 0.01, fraud: 0.02 } }));
    const r = simulateTraffic(risky.map((p) => p.body), { startMs: T0, ratePerSec: 4, config: DEFAULT_CONFIG });
    const kinds = risky.map((p) => p.idempotencyKey.split('-risk-')[1]);
    const flagged = r.decisions.filter((d, i) => kinds[i] && d !== 'hold');
    expect(kinds.filter(Boolean).length).toBeGreaterThan(50);
    expect(flagged).toEqual([]);
    r.plans.forEach((p, i) => {
      if (kinds[i] === 'sanctions') expect(p.screening.result).toBe('hit');
    });
  });
});
