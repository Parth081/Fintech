// Synthetic, deterministic M4-shaped logs: the real event shapes of the risk & compliance engine
// (services/stages/src/risk/*.ts: risk.alert_raised with evidence and reasons, payment.held { alertIds },
// decision traces with combinedScore / amountUsd, operator release / reject with approvedBy, retry and refund
// events) and the treasury FX shock (control.fx_shock.* plus FX_SHOCK_ACTIVE quotes with spreadComponents),
// around scripted runs of fraud-ring, sanctions-hit and fx-spike. Used by tests and the evaluation.
// All names and accounts are fictional.
import {
  CORRIDORS,
  SCHEMA_VERSION,
  deterministicId,
  makeControlEvent,
  type Actor,
  type AnyEvent,
  type BusEvent,
  type ControlEvent,
  type DecisionTrace,
  type EventType,
  type LedgerEntry,
  type Money,
  type PayloadMap,
  type StageName,
} from '@ct/contracts';

export type SyntheticM4ScenarioId = 'fraud-ring' | 'sanctions-hit' | 'fx-spike';

export type M4PaymentKind =
  | 'normal'
  | 'held_fraud'
  | 'held_sanctions'
  | 'held_large'
  | 'released'
  | 'rejected_by_operator'
  | 'rejected_by_system'
  | 'failed_retried'
  | 'refunded'
  | 'shock_quote'
  | 'before_quote'
  | 'after_quote';

export interface SyntheticM4Log {
  events: BusEvent[];
  runId: string;
  scenarioId: SyntheticM4ScenarioId;
  kinds: Map<string, M4PaymentKind>;
  /** Ids of every payment by kind (several may share a kind). */
  byKind: (k: M4PaymentKind) => string[];
}

const ANALYST: Actor = { userId: 'u-analyst', name: 'Maya Okafor', role: 'analyst' };
const MANAGER: Actor = { userId: 'u-manager', name: 'Jonas Weber', role: 'manager' };

const iso = (ms: number) => new Date(ms).toISOString();
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

class Pay {
  readonly evs: AnyEvent[] = [];
  private seq = 0;
  private prev: string | null = null;
  constructor(
    readonly id: string,
    public t: number,
  ) {}
  push<T extends EventType>(type: T, payload: PayloadMap[T], producer: StageName, trace: Omit<DecisionTrace, 'stage'> | null, dt = 100): string {
    this.t += dt;
    const e = {
      eventId: deterministicId(this.id, type, String(this.seq++)),
      type,
      schemaVersion: SCHEMA_VERSION,
      paymentId: this.id,
      occurredAt: iso(this.t),
      correlationId: this.id,
      causationId: this.prev,
      producer,
      payload,
      ...(trace ? { trace: { stage: producer, ...trace } } : {}),
    } as AnyEvent;
    this.prev = e.eventId;
    this.evs.push(e);
    return e.eventId;
  }
}

interface Spec {
  corridor?: string;
  usd?: number;
  debtor?: string;
  creditor?: string;
  scenario?: string;
}

function initiate(p: Pay, i: number, spec: Spec = {}): Money {
  const c = CORRIDORS.find((x) => x.id === (spec.corridor ?? 'US-IN'))!;
  const major = spec.usd ?? 1_000 + i * 37;
  const amount: Money = { amountMinor: Math.round(major * 100), currency: c.sourceCurrency };
  p.push(
    'payment.initiated',
    {
      amount,
      targetCurrency: c.targetCurrency,
      corridor: c.id,
      debtor: { name: spec.debtor ?? `Sender ${i}`, country: c.sourceCountry, accountId: `SIM-${c.sourceCountry}-${1000 + i}` },
      creditor: { name: spec.creditor ?? `Recipient ${i}`, country: c.targetCountry, accountId: `SIM-${c.targetCountry}-${2000 + i}` },
      idempotencyKey: `m4-${p.id}`,
      ...(spec.scenario ? { scenario: spec.scenario } : {}),
    },
    'payment-api',
    null,
    0,
  );
  return amount;
}

const screenedClear = (p: Pay) =>
  p.push('payment.screened', { result: 'clear', listVersion: 'fictional-sanctions-2026.2' }, 'screening', { decision: 'clear', reasonCodes: ['NO_LIST_MATCH'], inputs: { listVersion: 'fictional-sanctions-2026.2' }, ruleVersion: 'screen-v1', latencyMs: 20 }, 100);

function approve(p: Pay, fraudScore: number) {
  p.push('payment.scored', { fraudScore, amlAlerts: [], decision: 'approve' }, 'risk', { decision: 'approve', reasonCodes: ['SCORE_BELOW_THRESHOLD'], inputs: { fraudScore, combinedScore: fraudScore }, ruleVersion: 'risk-engine-v1', latencyMs: 30 }, 100);
}

interface HoldSpec {
  reason: string;
  fraudScore: number;
  combined: number;
  usd: number;
  codes: string[];
  alerts: PayloadMap['risk.alert_raised'][];
  atStage?: StageName;
}

function hold(p: Pay, h: HoldSpec) {
  for (const a of h.alerts) p.push('risk.alert_raised', a, h.atStage === 'screening' ? 'screening' : 'risk', null, 20);
  p.push(
    'payment.held',
    { reason: h.reason, atStage: h.atStage ?? 'risk', alertIds: h.alerts.map((a) => a.alertId) },
    h.atStage === 'screening' ? 'screening' : 'risk',
    {
      decision: 'hold',
      reasonCodes: h.codes,
      inputs: { policyVersion: 'risk-engine-v1', amountUsd: h.usd, fraudScore: h.fraudScore, combinedScore: h.combined, alertIds: h.alerts.map((a) => a.alertId) },
      ruleVersion: 'risk-engine-v1',
      latencyMs: 20,
    },
    50,
  );
}

const fraudAlert = (id: string, score: number, usd: number, severity: 'medium' | 'high' = 'medium'): PayloadMap['risk.alert_raised'] => ({
  alertId: `ALR-${id}`,
  kind: 'fraud',
  severity,
  rule: 'FRAUD_MODEL_HIGH',
  score,
  summary: `Fraud model scored ${Math.round(score * 100)}%: amount kept just below the USD 10,000 reporting line; payment of about USD ${Math.round(usd).toLocaleString('en-US')}`,
  reasons: [
    { code: 'JUST_BELOW_THRESHOLD', text: 'Amount kept just below the USD 10,000 reporting line', weight: 1.4 },
    { code: 'NEW_ACCOUNT', text: 'Sender account has no history with us', weight: 0.9 },
  ],
  evidence: { model: 'fraud-lr-v1', logit: 1.3, intercept: -3, features: [], facts: { priorPayments: 0, recentPayments: 2, typicalUsd: 1_000, amountUsd: usd, localHour: 14 }, thresholds: { hold: 0.7, reject: 0.92 } },
});

function amlAlert(rule: 'AML_FAN_IN' | 'AML_FAN_OUT' | 'AML_STRUCTURING', id: string, related: string[], n: number, total: number): PayloadMap['risk.alert_raised'] {
  const base = { alertId: `ALR-${id}-${rule.slice(4, 8)}`, kind: 'aml' as const, severity: 'medium' as const, rule, score: Math.min(0.95, 0.75 + 0.04 * (n - 3)) };
  if (rule === 'AML_FAN_IN') {
    return {
      ...base,
      summary: `${n} different senders paid Marigold Bullion Traders USD ${Math.round(total).toLocaleString('en-US')} within 15 minutes (fan-in)`,
      reasons: [
        { code: 'MANY_SENDERS_ONE_BENEFICIARY', text: `${n} distinct sender accounts paid the same beneficiary account SIM-IN-9000` },
        { code: 'SHORT_WINDOW', text: 'All within 15 minutes, each at least USD 2,000' },
      ],
      evidence: { beneficiaryAccount: 'SIM-IN-9000', beneficiaryName: 'Marigold Bullion Traders', distinctSenders: n, senderAccounts: [], totalUsd: Math.round(total * 100) / 100, windowMinutes: 15, relatedPaymentIds: related, rulesVersion: 'aml-typologies-v1' },
    };
  }
  if (rule === 'AML_FAN_OUT') {
    return {
      ...base,
      summary: `Halden Crest Logistics LLC paid ${n} different beneficiaries USD ${Math.round(total).toLocaleString('en-US')} within 10 minutes (fan-out)`,
      reasons: [
        { code: 'ONE_SENDER_MANY_BENEFICIARIES', text: `Sender account SIM-US-9100 paid ${n} distinct beneficiary accounts` },
        { code: 'SHORT_WINDOW', text: 'All within 10 minutes, each at least USD 2,000' },
      ],
      evidence: { senderAccount: 'SIM-US-9100', senderName: 'Halden Crest Logistics LLC', distinctBeneficiaries: n, beneficiaryAccounts: [], totalUsd: Math.round(total * 100) / 100, windowMinutes: 10, relatedPaymentIds: related, rulesVersion: 'aml-typologies-v1' },
    };
  }
  return {
    ...base,
    summary: `${n} payments kept just below the USD 10,000 reporting line to Marigold Bullion Traders within 24 hours (structuring)`,
    reasons: [
      { code: 'JUST_BELOW_THRESHOLD', text: 'This payment (USD 9,850) is within 10% under the USD 10,000 reporting line' },
      { code: 'REPEATED_PATTERN', text: `${n - 1} other just-below payment(s) to the same beneficiary in 24 hours` },
    ],
    evidence: { threshold: 'USD 10,000 reporting line', amounts: [], linkedBy: 'beneficiary', relatedPaymentIds: related, rulesVersion: 'aml-typologies-v1' },
  };
}

function sanctionsAlert(id: string, name: string, entry: { id: string; name: string }, score: number, field: 'debtor' | 'creditor'): PayloadMap['risk.alert_raised'] {
  const pct = Math.round(score * 100);
  return {
    alertId: `ALR-${id}-SANC`,
    kind: 'sanctions',
    severity: score >= 0.95 ? 'critical' : 'high',
    rule: 'SANCTIONS_FUZZY_MATCH',
    score,
    summary: `${field === 'debtor' ? 'Sender' : 'Beneficiary'} "${name}" is a potential match (${pct}%) for ${entry.name} on the FICTIONAL CONSOLIDATED LIST`,
    reasons: [{ code: 'NAME_MATCH', text: `${field === 'debtor' ? 'Sender' : 'Beneficiary'} name "${name}" vs listed name "${entry.name}" (${entry.id}, Varnia asset freeze)`, weight: score }],
    evidence: {
      listName: 'FICTIONAL CONSOLIDATED LIST',
      listVersion: 'fictional-sanctions-2026.2',
      algorithm: 'token-similarity-v1',
      threshold: 0.85,
      field,
      score,
      entry: { id: entry.id, type: 'entity', name: entry.name, aliases: [], countries: ['XR'], program: 'Varnia asset freeze', listedOn: '2024-03-01' },
      matchedName: entry.name,
      matches: [],
    },
  };
}

/** screened -> hit -> alert -> held at screening (sanctions holds are always human decisions). */
function sanctionsHold(p: Pay, i: number, name: string, entry: { id: string; name: string }, score: number, field: 'debtor' | 'creditor') {
  const alert = sanctionsAlert(`S${i}`, name, entry, score, field);
  p.push('payment.screened', { result: 'hit', listVersion: 'fictional-sanctions-2026.2' }, 'screening', { decision: 'hit', reasonCodes: ['SANCTIONS_FUZZY_MATCH'], inputs: { score }, ruleVersion: 'screen-v1', latencyMs: 25 }, 100);
  hold(p, {
    reason: `Sanctions screening: potential match for ${entry.name} (${Math.round(score * 100)}%)`,
    fraudScore: 0.12,
    combined: 0.12,
    usd: 18_400,
    codes: ['SANCTIONS_POTENTIAL_MATCH'],
    alerts: [alert],
    atStage: 'screening',
  });
}

const usdEntries = (amount: Money, creditAcct: string, debitAcct: string): LedgerEntry[] => [
  { account: debitAcct, direction: 'debit', amount },
  { account: creditAcct, direction: 'credit', amount },
];

/** quoted -> routed -> sent -> settled -> ledger.posted -> reconciled (the shared tail of an approved payment). */
function settleTail(p: Pay, i: number, amount: Money, opts: { spreadBps?: number; shock?: boolean; corridorId?: string; extraCodes?: string[] } = {}) {
  const c = CORRIDORS.find((x) => x.id === (opts.corridorId ?? 'US-IN'))!;
  const spreadBps = opts.spreadBps ?? 35;
  const mid = Number(c.midRate);
  const rateNum = r4(mid * (1 - spreadBps / 10_000));
  const target: Money = { amountMinor: Math.floor(amount.amountMinor * rateNum), currency: c.targetCurrency };
  const codes = [...(opts.shock ? ['FX_SHOCK_ACTIVE'] : []), ...(opts.extraCodes ?? []), 'SPREAD_APPLIED'];
  const vol = opts.shock ? spreadBps - 35 : 0;
  p.push(
    'payment.quoted',
    { quoteId: `Q-${i}`, rate: rateNum.toFixed(4), midRate: c.midRate, rateTimestamp: iso(p.t), spreadBps, sourceAmount: amount, targetAmount: target, expiresAt: iso(p.t + 30_000) },
    'fx',
    {
      decision: 'quoted',
      reasonCodes: codes,
      inputs: {
        corridor: c.id,
        midRate: c.midRate,
        spreadBps,
        spreadComponents: { baseBps: 30, tierAdjustmentBps: 5, volatilityBps: vol },
        ...(opts.shock ? { fxShocks: [{ shockId: 'gbp-php-spike', driftBps: 250, noiseMultiplier: 4, rampMs: 5000, since: iso(p.t - 4000), reason: 'Treasury scenario: sudden volatility' }] } : {}),
      },
      ruleVersion: 'fx-engine-v1',
      latencyMs: 25,
    },
    150,
  );
  const fee: Money = { amountMinor: 150 + Math.round(amount.amountMinor / 1000), currency: amount.currency };
  p.push(
    'payment.routed',
    {
      providerId: 'orion',
      rail: 'Rail-A (instant)',
      estimatedFee: fee,
      alternatives: [{ providerId: 'lyra', score: 0.8 }],
      attempt: 1,
      scoring: [
        { providerId: 'orion', eligible: true, fee, successRate: 0.985, latencyMs: 800, score: 0.9 },
        { providerId: 'lyra', eligible: true, fee, successRate: 0.972, latencyMs: 2500, score: 0.8 },
      ],
    },
    'routing',
    { decision: 'routed', reasonCodes: ['BEST_SCORE'], inputs: { weights: { success: 0.5, cost: 0.3, speed: 0.2 }, breakers: { orion: { state: 'closed' }, lyra: { state: 'closed' } } }, ruleVersion: 'routing-v3', latencyMs: 12 },
    150,
  );
  p.push('payment.sent', { providerId: 'orion', messageType: 'pacs.008', messageId: `M-${i}`, attempt: 1 }, 'settlement', null, 100);
  p.push('payment.settled', { providerId: 'orion', settlementRef: `S-${i}`, statusMessage: 'pacs.002', attempt: 1, settledAmount: target, valueDate: '2026-03-01' }, 'settlement', null, 800);
  const entries = usdEntries(amount, 'customer-funds', 'provider-orion');
  p.push('ledger.posted', { journalId: `J-${i}`, entries }, 'ledger', null, 50);
  p.push('payment.reconciled', { statementRef: `ST-${i}`, matched: true, journalId: `J-${i}`, breaks: [] }, 'reconciliation', null, 500);
  return entries;
}

function normalPayment(p: Pay, i: number, spec: Spec & { spreadBps?: number; shock?: boolean } = {}) {
  const amount = initiate(p, i, spec);
  screenedClear(p);
  approve(p, r4(0.04 + (i % 7) * 0.02));
  settleTail(p, i, amount, { ...(spec.spreadBps ? { spreadBps: spec.spreadBps } : {}), ...(spec.shock ? { shock: true } : {}), ...(spec.corridor ? { corridorId: spec.corridor } : {}) });
}

export function syntheticM4Log(scenarioId: SyntheticM4ScenarioId, opts: { seed?: string; t0?: number } = {}): SyntheticM4Log {
  const seed = opts.seed ?? 'm4';
  const t0 = opts.t0 ?? Date.parse('2026-03-01T10:00:00.000Z');
  const runId = `run-${deterministicId(seed, scenarioId).slice(0, 8)}`;
  let ctl = 0;
  const cid = () => deterministicId(seed, scenarioId, 'control', String(ctl++));
  const titles: Record<SyntheticM4ScenarioId, string> = {
    'fraud-ring': 'Fraud ring: money mules move stolen funds',
    'sanctions-hit': 'Sanctions hit: names that look like listed entities',
    'fx-spike': 'FX spike: GBP to PHP turns volatile',
  };
  const endAt = t0 + 60_000;
  const control: ControlEvent[] = [
    makeControlEvent('control.scenario.started', { runId, scenarioId, title: titles[scenarioId], seed }, { eventId: cid(), occurredAt: iso(t0), producer: 'orchestrator' }),
    makeControlEvent('control.scenario.step', { runId, scenarioId, stepId: 'baseline', title: 'Normal day' }, { eventId: cid(), occurredAt: iso(t0 + 1), producer: 'orchestrator' }),
  ];
  const shockStartAt = t0 + 20_000;
  const shockEndAt = t0 + 38_000;
  if (scenarioId === 'fx-spike') {
    control.push(
      makeControlEvent('control.fx_shock.started', { shockId: 'gbp-php-spike', corridorId: 'GB-PH', driftBps: 250, noiseMultiplier: 4, rampMs: 5000, reason: 'Treasury scenario: sudden volatility', runId }, { eventId: cid(), occurredAt: iso(shockStartAt), producer: 'orchestrator' }),
      makeControlEvent('control.fx_shock.ended', { shockId: 'gbp-php-spike', runId }, { eventId: cid(), occurredAt: iso(shockEndAt), producer: 'orchestrator' }),
    );
  }
  control.push(makeControlEvent('control.scenario.ended', { runId, scenarioId, outcome: 'completed' }, { eventId: cid(), occurredAt: iso(endAt), producer: 'orchestrator' }));

  const pays: Pay[] = [];
  const kinds = new Map<string, M4PaymentKind>();
  const mk = (i: number, kind: M4PaymentKind, at: number): Pay => {
    const p = new Pay(deterministicId(seed, scenarioId, 'payment', String(i)), at);
    pays.push(p);
    kinds.set(p.id, kind);
    return p;
  };
  let n = 0;
  const gap = 900;

  // Ordinary customers first.
  for (let k = 0; k < 6; k += 1) normalPayment(mk(n, 'normal', t0 + 500 + k * gap), n++);

  if (scenarioId === 'fraud-ring') {
    const amounts = [9_850, 9_920, 9_780, 9_960, 9_890];
    const mules: Pay[] = [];
    amounts.forEach((usd, k) => {
      const kind: M4PaymentKind = k === 3 ? 'released' : k === 4 ? 'rejected_by_operator' : 'held_fraud';
      const p = mk(n, kind, t0 + 8_000 + k * gap);
      const amount = initiate(p, n, { usd, debtor: `Mule ${k + 1}`, creditor: 'Marigold Bullion Traders' });
      screenedClear(p);
      const fs = r4(0.78 + k * 0.005);
      const rel = mules.map((m) => m.id);
      const alerts = [fraudAlert(`F${k}`, fs, usd)];
      const rules: ('AML_STRUCTURING' | 'AML_FAN_IN')[] = [];
      if (k >= 1) rules.push('AML_STRUCTURING');
      if (k >= 2) rules.push('AML_FAN_IN');
      for (const r of rules) alerts.push(amlAlert(r, `A${k}`, rel, k + 1, amounts.slice(0, k + 1).reduce((a, b) => a + b, 0)));
      const combined = r4(1 - (1 - fs) * (rules.length ? 0.2 : 1));
      hold(p, {
        reason: `Held for review: ${alerts.map((a) => a.rule).join(', ')} (risk score ${Math.round(combined * 100)}%)`,
        fraudScore: fs,
        combined,
        usd,
        codes: ['RISK_SCORE_ABOVE_HOLD', 'FRAUD_MODEL_HIGH', ...rules],
        alerts,
      });
      if (kind === 'released') {
        p.push('payment.released', { actor: ANALYST, reason: 'Documents verified with the sender; legitimate trade invoice', caseId: 'CASE-0007', approvedBy: MANAGER }, 'ops', null, 3_000);
        settleTail(p, n, amount, { extraCodes: ['RELEASED_BY_OPERATOR'] });
      } else if (kind === 'rejected_by_operator') {
        p.push('payment.rejected', { reason: 'Confirmed structuring pattern across linked mule accounts', atStage: 'ops', actor: ANALYST, caseId: 'CASE-0008', approvedBy: MANAGER }, 'ops', { decision: 'reject', reasonCodes: ['OPERATOR_REJECTED'], inputs: {}, ruleVersion: 'ops-v1', latencyMs: 5 }, 3_000);
      }
      mules.push(p);
      n += 1;
    });
    // fan-out leg: one collector account, still held
    for (let k = 0; k < 3; k += 1) {
      const usd = 4_900 + k * 25;
      const p = mk(n, 'held_fraud', t0 + 22_000 + k * gap);
      initiate(p, n, { usd, debtor: 'Halden Crest Logistics LLC', creditor: `Recipient ${n}` });
      screenedClear(p);
      const a = amlAlert('AML_FAN_OUT', `O${k}`, [], 3 + k, 14_725);
      hold(p, { reason: `Held for review: AML_FAN_OUT (risk score ${82 + k}%)`, fraudScore: 0.31, combined: r4(0.82 + k / 100), usd, codes: ['RISK_SCORE_ABOVE_HOLD', 'AML_FAN_OUT'], alerts: [a] });
      n += 1;
    }
    // a system rejection by the fraud model
    {
      const p = mk(n, 'rejected_by_system', t0 + 28_000);
      initiate(p, n, { usd: 9_990, debtor: 'Mule 9', creditor: 'Marigold Bullion Traders' });
      screenedClear(p);
      const fa = fraudAlert('R', 0.94, 9_990, 'high');
      fa.rule = 'FRAUD_MODEL_REJECT';
      fa.severity = 'high';
      p.push('risk.alert_raised', fa, 'risk', null, 20);
      p.push('payment.rejected', { reason: 'Fraud model score 94% is at or above the reject threshold 0.92', atStage: 'risk' }, 'risk', { decision: 'reject', reasonCodes: ['FRAUD_SCORE_ABOVE_REJECT'], inputs: { fraudScore: 0.94, amountUsd: 9_990 }, ruleVersion: 'risk-engine-v1', latencyMs: 15 }, 50);
      n += 1;
    }
    // first-attempt failure (no usable provider) that an operator retried, and a refunded payment
    {
      const p = mk(n, 'failed_retried', t0 + 30_000);
      const amount = initiate(p, n);
      screenedClear(p);
      approve(p, 0.05);
      const c = CORRIDORS[0]!;
      p.push('payment.quoted', { quoteId: `Q-${n}`, rate: '82.9586', midRate: c.midRate, rateTimestamp: iso(p.t), spreadBps: 35, sourceAmount: amount, targetAmount: { amountMinor: 8_295_860, currency: 'INR' }, expiresAt: iso(p.t + 30_000) }, 'fx', { decision: 'quoted', reasonCodes: ['SPREAD_APPLIED'], inputs: { midRate: c.midRate }, ruleVersion: 'fx-engine-v1', latencyMs: 20 }, 100);
      p.push('payment.failed', { reason: 'No eligible provider for US-IN: every provider is switched off', atStage: 'routing', attempts: 0 }, 'routing', { decision: 'failed', reasonCodes: ['NO_ELIGIBLE_PROVIDER'], inputs: {}, ruleVersion: 'routing-v3', latencyMs: 8 }, 100);
      p.push('payment.retry_requested', { actor: ANALYST, reason: 'Providers are back online; retry the payment' }, 'ops', null, 2_000);
      n += 1;
    }
    {
      const p = mk(n, 'refunded', t0 + 31_000);
      const amount = initiate(p, n, { usd: 2_400 });
      screenedClear(p);
      approve(p, 0.06);
      const entries = settleTail(p, n, amount);
      p.push('payment.refund_requested', { actor: ANALYST, reason: 'Customer reported a duplicate payment', approvedBy: MANAGER }, 'ops', null, 4_000);
      p.push('payment.refunded', { journalId: `JR-${n}`, entries: entries.map((e) => ({ ...e, direction: e.direction === 'debit' ? 'credit' : 'debit' }) as LedgerEntry) }, 'ledger', null, 100);
      n += 1;
    }
  } else if (scenarioId === 'sanctions-hit') {
    const entities = [
      { id: 'FCL-0007', name: 'Northern Reach Shipping Company' },
      { id: 'FCL-0012', name: 'KOVAL, Dmitri Ivanovich' },
    ];
    {
      const p = mk(n, 'held_sanctions', t0 + 12_000);
      initiate(p, n, { usd: 18_400, creditor: 'Nordern Reach Shiping Co' });
      sanctionsHold(p, n, 'Nordern Reach Shiping Co', entities[0]!, 0.9121, 'creditor');
      n += 1;
    }
    {
      const p = mk(n, 'rejected_by_operator', t0 + 20_000);
      initiate(p, n, { usd: 2_750, debtor: 'Koval Dimitri' });
      sanctionsHold(p, n, 'Koval Dimitri', entities[1]!, 0.8834, 'debtor');
      p.push('payment.rejected', { reason: 'Confirmed match to the listed individual after document review', atStage: 'ops', actor: ANALYST, caseId: 'CASE-0021', approvedBy: MANAGER }, 'ops', { decision: 'reject', reasonCodes: ['OPERATOR_REJECTED'], inputs: {}, ruleVersion: 'ops-v1', latencyMs: 5 }, 4_000);
      n += 1;
    }
    for (let k = 0; k < 4; k += 1) normalPayment(mk(n, 'normal', t0 + 26_000 + k * gap), n++);
  } else {
    // fx-spike: GB-PH quotes before, during and after the shock; a large-value hold on the side
    const gb = { corridor: 'GB-PH' };
    for (let k = 0; k < 3; k += 1) normalPayment(mk(n, 'before_quote', t0 + 10_000 + k * gap), n++, { ...gb, spreadBps: 35 + k });
    for (let k = 0; k < 4; k += 1) normalPayment(mk(n, 'shock_quote', shockStartAt + 6_000 + k * gap), n++, { ...gb, spreadBps: 52 + k * 11, shock: true });
    for (let k = 0; k < 3; k += 1) normalPayment(mk(n, 'after_quote', shockEndAt + 3_000 + k * gap), n++, { ...gb, spreadBps: 36 - k });
    {
      const p = mk(n, 'held_large', t0 + 41_000);
      const usd = 25_132;
      initiate(p, n, { usd });
      screenedClear(p);
      const a: PayloadMap['risk.alert_raised'] = {
        alertId: `ALR-L${n}`,
        kind: 'aml',
        severity: 'medium',
        rule: 'AML_LARGE_VALUE_REVIEW',
        summary: `Payment of about USD ${usd.toLocaleString('en-US')} is at or above the USD 25,000 manual-review threshold`,
        reasons: [{ code: 'MANUAL_REVIEW_AMOUNT', text: 'Payments of USD 25,000 or more always need a compliance review (config risk.manualReviewAboveUsd)' }],
        evidence: { amount: { amountMinor: usd * 100, currency: 'USD' }, amountUsd: usd, manualReviewAboveUsd: 25_000, configVersion: 0 },
      };
      hold(p, { reason: 'Held for review: AML_LARGE_VALUE_REVIEW (risk score 49%)', fraudScore: 0.49, combined: 0.49, usd, codes: ['MANUAL_REVIEW_AMOUNT'], alerts: [a] });
      n += 1;
    }
  }

  // merge by time: control events interleave with payment events in log order
  const all: { t: number; seq: number; e: BusEvent }[] = [];
  let seq = 0;
  for (const c of control) all.push({ t: Date.parse(c.occurredAt), seq: seq++, e: c });
  for (const p of pays) for (const e of p.evs) all.push({ t: Date.parse(e.occurredAt), seq: seq++, e });
  all.sort((a, b) => a.t - b.t || a.seq - b.seq);
  return {
    events: all.map((x) => x.e),
    runId,
    scenarioId,
    kinds,
    byKind: (k) => [...kinds].filter(([, v]) => v === k).map(([id]) => id),
  };
}
