// Synthetic, deterministic event logs shaped like the real pipeline's output (decision traces, routing
// scoring for every provider, breaker states in routing traces, ISO reject reasons, holds, rejections,
// failures and balanced journals) around a scripted scenario run. Used by tests and the evaluation.
// All data is fictional.
import {
  CORRIDORS,
  SCHEMA_VERSION,
  deterministicId,
  makeControlEvent,
  type AnyEvent,
  type BusEvent,
  type ControlEvent,
  type DecisionTrace,
  type EventType,
  type Money,
  type PayloadMap,
  type ProviderScore,
  type StageName,
} from '@ct/contracts';

export type SyntheticScenarioId = 'provider-outage' | 'provider-degraded';

interface ProviderSpec {
  id: string;
  rail: string;
  corridors: string[];
  fixedMinor: number;
  bps: number;
  successRate: number;
  latencyMs: number;
}

const PROVIDERS: ProviderSpec[] = [
  { id: 'orion', rail: 'Rail-A (instant)', corridors: ['US-IN', 'DE-BR', 'GB-PH'], fixedMinor: 150, bps: 10, successRate: 0.985, latencyMs: 800 },
  { id: 'lyra', rail: 'Rail-B (same day)', corridors: ['US-IN', 'GB-PH'], fixedMinor: 90, bps: 18, successRate: 0.972, latencyMs: 2500 },
  { id: 'vega', rail: 'Rail-C (correspondent)', corridors: ['US-IN', 'DE-BR', 'GB-PH'], fixedMinor: 60, bps: 25, successRate: 0.955, latencyMs: 6000 },
];

const REJECT_CODES: [string, string][] = [
  ['AC04', 'Closed account number'],
  ['AM04', 'Insufficient funds at the provider'],
  ['NARR', 'Provider is not responding'],
];

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const iso = (ms: number) => new Date(ms).toISOString();
const hash = (s: string) => parseInt(deterministicId(s).slice(0, 8), 16) / 0xffffffff;

export interface SyntheticOptions {
  payments?: number;
  seed?: string;
  /** Start of the run (ms since epoch). */
  t0?: number;
}

export interface SyntheticLog {
  events: BusEvent[];
  runId: string;
  scenarioId: SyntheticScenarioId;
  /** paymentId -> what the generator made it do (for tests). */
  kinds: Map<string, PaymentKind>;
}

export type PaymentKind = 'normal' | 'held' | 'released' | 'rejected' | 'retried' | 'failed' | 'rerouted' | 'in_flight';

export function syntheticScenarioLog(scenarioId: SyntheticScenarioId = 'provider-outage', opts: SyntheticOptions = {}): SyntheticLog {
  const seed = opts.seed ?? 'synthetic';
  const n = opts.payments ?? 40;
  const t0 = opts.t0 ?? Date.parse('2026-03-01T10:00:00.000Z');
  const degraded = scenarioId === 'provider-degraded';
  const outStart = t0 + (degraded ? 8_000 : 10_000);
  const outEnd = t0 + (degraded ? 30_000 : 35_000);
  const breakerOpen = outStart + 6_000;
  const breakerClose = outEnd + 10_000;
  const endAt = t0 + (degraded ? 48_000 : 72_000);
  const runId = `run-${deterministicId(seed, scenarioId).slice(0, 8)}`;
  let ctl = 0;
  const cid = () => deterministicId(seed, scenarioId, 'control', String(ctl++));
  const control: ControlEvent[] = [
    makeControlEvent('control.scenario.started', { runId, scenarioId, title: degraded ? 'Partial failure: Orion gets unreliable' : 'Provider outage: Orion goes down', seed }, { eventId: cid(), occurredAt: iso(t0), producer: 'orchestrator' }),
    makeControlEvent('control.scenario.step', { runId, scenarioId, stepId: 'baseline', title: 'Normal day' }, { eventId: cid(), occurredAt: iso(t0 + 1), producer: 'orchestrator' }),
    makeControlEvent('control.provider_outage.started', degraded
      ? { providerId: 'orion', mode: 'degraded', failureRate: 0.6, reason: 'Scenario: Orion is refusing 60% of payments', runId }
      : { providerId: 'orion', mode: 'down', reason: 'Scenario: Orion is not responding', runId }, { eventId: cid(), occurredAt: iso(outStart), producer: 'orchestrator' }),
    makeControlEvent('control.provider_outage.ended', { providerId: 'orion', runId }, { eventId: cid(), occurredAt: iso(outEnd), producer: 'orchestrator' }),
    makeControlEvent('control.scenario.ended', { runId, scenarioId, outcome: 'completed' }, { eventId: cid(), occurredAt: iso(endAt), producer: 'orchestrator' }),
  ];

  const payEvents: AnyEvent[] = [];
  const kinds = new Map<string, PaymentKind>();
  const spacing = Math.floor((endAt - t0 - 6_000) / n);
  let allFailDone = false;

  for (let i = 0; i < n; i += 1) {
    const pid = deterministicId(seed, scenarioId, 'payment', String(i));
    const corridor = CORRIDORS[i % CORRIDORS.length]!;
    let t = t0 + 500 + i * spacing;
    let seq = 0;
    let prevId: string | null = null;
    const push = <T extends EventType>(type: T, payload: PayloadMap[T], producer: StageName, trace: Omit<DecisionTrace, 'stage'> | null, dt: number) => {
      t += dt;
      const e = {
        eventId: deterministicId(pid, type, String(seq++)),
        type,
        schemaVersion: SCHEMA_VERSION,
        paymentId: pid,
        occurredAt: iso(t),
        correlationId: pid,
        causationId: prevId,
        producer,
        payload,
        ...(trace ? { trace: { stage: producer, ...trace } } : {}),
      } as AnyEvent;
      prevId = e.eventId;
      payEvents.push(e);
    };

    const amount: Money = { amountMinor: 100_000 + i * 13_757, currency: corridor.sourceCurrency };
    push('payment.initiated', {
      amount, targetCurrency: corridor.targetCurrency, corridor: corridor.id,
      debtor: { name: `Sender ${i}`, country: corridor.sourceCountry, accountId: `ACC-${corridor.sourceCountry}-${1000 + i}` },
      creditor: { name: `Recipient ${i}`, country: corridor.targetCountry, accountId: `ACC-${corridor.targetCountry}-${2000 + i}` },
      idempotencyKey: `syn-${seed}-${i}`, scenario: runId,
    }, 'payment-api', null, 0);

    const isLast = i >= n - 2;
    const rejected = i % 17 === 9;
    const held = !rejected && i % 13 === 5;
    const released = held && i % 26 === 5;

    if (rejected) {
      push('payment.screened', { result: 'hit', listVersion: 'fict-2026.1' }, 'screening', { decision: 'hit', reasonCodes: ['SANCTIONS_FUZZY_MATCH'], inputs: { creditor: `Recipient ${i}` }, ruleVersion: 'screen-v1', latencyMs: 40 }, 100);
      push('risk.alert_raised', {
        alertId: `AL-${i}`, kind: 'sanctions', severity: 'critical', rule: 'SANCTIONS_FUZZY_MATCH', score: 0.93,
        summary: 'Recipient name closely matches a fictional sanctions list entry.', reasons: [{ code: 'NAME_MATCH', text: 'Name similarity above threshold' }], evidence: {},
      }, 'screening', null, 50);
      push('payment.rejected', { reason: 'Recipient matches the sanctions list', atStage: 'screening' }, 'screening', { decision: 'reject', reasonCodes: ['SANCTIONS_CONFIRMED'], inputs: {}, ruleVersion: 'screen-v1', latencyMs: 30 }, 100);
      kinds.set(pid, 'rejected');
      continue;
    }
    push('payment.screened', { result: 'clear', listVersion: 'fict-2026.1' }, 'screening', { decision: 'clear', reasonCodes: ['NO_LIST_MATCH'], inputs: {}, ruleVersion: 'screen-v1', latencyMs: 35 }, 100);
    const fraudScore = held ? 0.81 : round4(0.02 + hash(`${pid}|fraud`) * 0.3);
    push('payment.scored', { fraudScore, amlAlerts: [], decision: held ? 'hold' : 'approve' }, 'risk', { decision: held ? 'hold' : 'approve', reasonCodes: held ? ['SCORE_ABOVE_HOLD'] : ['SCORE_BELOW_THRESHOLD'], inputs: { fraudScore, thresholds: { hold: 0.7, reject: 0.92 } }, ruleVersion: 'risk-v1', latencyMs: 60 }, 150);
    if (held) {
      push('risk.alert_raised', {
        alertId: `AL-${i}`, kind: 'fraud', severity: 'high', rule: 'FRAUD_MODEL_HIGH', score: 0.81,
        summary: 'Unusual amount for this sender compared with their history.', reasons: [{ code: 'AMOUNT_SPIKE', text: 'Amount far above the usual' }], evidence: {},
      }, 'risk', null, 30);
      push('payment.held', { reason: 'Fraud score above the review threshold', atStage: 'risk', alertIds: [`AL-${i}`] }, 'risk', { decision: 'hold', reasonCodes: ['SCORE_ABOVE_HOLD'], inputs: { fraudScore }, ruleVersion: 'risk-v1', latencyMs: 20 }, 50);
      if (!released) {
        kinds.set(pid, 'held');
        continue;
      }
      push('payment.released', { actor: { userId: 'u-2', name: 'Maya Okafor', role: 'analyst' }, reason: 'Sender confirmed the payment by phone' }, 'ops', null, 3_000);
    }

    // FX quote
    const spreadBps = 35 + (i % 3) * 5;
    const mid = Number(corridor.midRate);
    const rateNum = round4(mid * (1 - spreadBps / 10_000));
    const rate = rateNum.toFixed(4);
    const target: Money = { amountMinor: Math.floor(amount.amountMinor * rateNum), currency: corridor.targetCurrency };
    push('payment.quoted', { quoteId: `Q-${i}`, rate, midRate: corridor.midRate, rateTimestamp: iso(t), spreadBps, sourceAmount: amount, targetAmount: target, expiresAt: iso(t + 30_000) }, 'fx', { decision: 'quoted', reasonCodes: ['SPREAD_APPLIED'], inputs: { midRate: corridor.midRate, spreadBps }, ruleVersion: 'fx-engine-v1', latencyMs: 25 }, 150);

    // routing + settlement attempts
    const excluded: string[] = [];
    let attempt = 1;
    let kind: PaymentKind = released ? 'released' : 'normal';
    const forceAllFail = !allFailDone && t >= outStart + 500 && t < breakerOpen && corridor.id !== 'DE-BR';
    if (forceAllFail) allFailDone = true;
    for (;;) {
      const now = t + 150;
      const breaker = now >= breakerOpen && now < breakerClose ? 'open' : 'closed';
      const scoring: ProviderScore[] = PROVIDERS.map((p) => {
        const fee: Money = { amountMinor: p.fixedMinor + Math.round((amount.amountMinor * p.bps) / 10_000), currency: amount.currency };
        const row: ProviderScore = { providerId: p.id, eligible: true, fee, successRate: p.successRate, latencyMs: p.latencyMs, score: 0 };
        if (!p.corridors.includes(corridor.id)) row.excludedReason = 'CORRIDOR_NOT_SERVED';
        else if (excluded.includes(p.id)) row.excludedReason = 'FAILED_THIS_PAYMENT';
        else if (p.id === 'orion' && breaker === 'open') row.excludedReason = 'CIRCUIT_OPEN';
        if (row.excludedReason) row.eligible = false;
        return row;
      });
      const eligible = scoring.filter((s) => s.eligible);
      if (eligible.length === 0) {
        push('payment.failed', { reason: `No eligible provider left for ${corridor.id} after ${attempt - 1} failed attempt(s)`, atStage: 'routing', attempts: attempt - 1 }, 'routing', { decision: 'failed', reasonCodes: ['NO_ELIGIBLE_PROVIDER'], inputs: { excludedProviders: [...excluded] }, ruleVersion: 'routing-v3', latencyMs: 10 }, 150);
        kind = 'failed';
        break;
      }
      const minFee = Math.min(...eligible.map((s) => s.fee.amountMinor));
      const minLat = Math.min(...eligible.map((s) => s.latencyMs));
      for (const s of eligible) s.score = round4(0.5 * s.successRate + 0.3 * (minFee / s.fee.amountMinor) + 0.2 * (minLat / s.latencyMs));
      scoring.sort((a, b) => (b.eligible ? b.score : -1) - (a.eligible ? a.score : -1));
      const chosen = scoring.find((s) => s.eligible)!;
      const reasonCodes = ['BEST_SCORE'];
      if (attempt > 1) reasonCodes.push('RETRY_AFTER_FAILURE');
      const blocked = breaker === 'open' && corridor.id !== 'DE-BR' ? true : breaker === 'open';
      if (blocked && !excluded.includes('orion')) reasonCodes.push('CIRCUIT_OPEN_REROUTED');
      if (blocked && kind === 'normal') kind = 'rerouted';
      push('payment.routed', {
        providerId: chosen.providerId, rail: PROVIDERS.find((p) => p.id === chosen.providerId)!.rail, estimatedFee: chosen.fee,
        alternatives: eligible.filter((s) => s !== chosen).map((s) => ({ providerId: s.providerId, score: s.score })),
        attempt, excludedProviders: [...excluded], scoring,
      }, 'routing', {
        decision: chosen.providerId, reasonCodes,
        inputs: {
          corridor: corridor.id, attempt, excludedProviders: [...excluded], weights: { success: 0.5, cost: 0.3, speed: 0.2 },
          breakers: Object.fromEntries(PROVIDERS.map((p) => [p.id, { state: p.id === 'orion' ? breaker : 'closed', since: p.id === 'orion' && breaker === 'open' ? iso(breakerOpen) : null }])),
        },
        ruleVersion: 'routing-v3', latencyMs: 15,
      }, 150);
      if (isLast) {
        push('payment.sent', { providerId: chosen.providerId, messageType: 'pacs.008', messageId: `MSG-${i}-${attempt}`, attempt }, 'settlement', { decision: 'sent', reasonCodes: ['INSTRUCTION_SENT'], inputs: {}, ruleVersion: 'settle-v1', latencyMs: 12 }, 150);
        kind = 'in_flight';
        break;
      }
      push('payment.sent', { providerId: chosen.providerId, messageType: 'pacs.008', messageId: `MSG-${i}-${attempt}`, attempt }, 'settlement', { decision: 'sent', reasonCodes: ['INSTRUCTION_SENT'], inputs: {}, ruleVersion: 'settle-v1', latencyMs: 12 }, 150);
      const inOutage = chosen.providerId === 'orion' && t >= outStart && t < outEnd;
      const outageFails = inOutage && (!degraded || hash(`${pid}|${attempt}|outage`) < 0.6);
      const fails = forceAllFail || outageFails;
      if (fails) {
        const [code, reason] = chosen.providerId === 'orion' ? REJECT_CODES[2]! : REJECT_CODES[i % 2]!;
        push('payment.send_failed', { providerId: chosen.providerId, attempt, reasonCode: code, reason, statusMessage: 'pacs.002' }, 'settlement', { decision: 'rejected', reasonCodes: [code], inputs: { providerId: chosen.providerId }, ruleVersion: 'settle-v1', latencyMs: 500 }, 600);
        excluded.push(chosen.providerId);
        attempt += 1;
        if (kind === 'normal' || kind === 'rerouted' || kind === 'released') kind = 'retried';
        continue;
      }
      push('payment.settled', { providerId: chosen.providerId, settlementRef: `SET-${i}`, statusMessage: 'pacs.002', attempt, settledAmount: target, valueDate: iso(t).slice(0, 10) }, 'settlement', { decision: 'settled', reasonCodes: ['ACSC'], inputs: {}, ruleVersion: 'settle-v1', latencyMs: chosen.latencyMs }, 1_000 + (i % 5) * 200);
      push('ledger.posted', {
        journalId: `J-${i}`,
        entries: [
          { account: `customer:${corridor.sourceCountry}-${1000 + i}`, direction: 'debit', amount },
          { account: `fx-position:${amount.currency}`, direction: 'credit', amount },
          { account: `fx-position:${target.currency}`, direction: 'debit', amount: target },
          { account: `provider:${chosen.providerId}:payable`, direction: 'credit', amount: target },
        ],
      }, 'ledger', { decision: 'posted', reasonCodes: ['BALANCED'], inputs: {}, ruleVersion: 'ledger-v1', latencyMs: 8 }, 100);
      push('payment.reconciled', { statementRef: `STMT-${chosen.providerId}-${i}`, matched: true, journalId: `J-${i}`, breaks: [] }, 'reconciliation', { decision: 'matched', reasonCodes: ['AMOUNT_AND_REF_MATCH'], inputs: {}, ruleVersion: 'recon-v1', latencyMs: 9 }, 900);
      break;
    }
    kinds.set(pid, kind);
  }

  // merge by time (stable: control first at equal times)
  const all: { at: number; order: number; e: BusEvent }[] = [
    ...control.map((e, k) => ({ at: Date.parse(e.occurredAt), order: k, e: e as BusEvent })),
    ...payEvents.map((e, k) => ({ at: Date.parse(e.occurredAt), order: 1_000 + k, e: e as BusEvent })),
  ];
  all.sort((a, b) => a.at - b.at || a.order - b.order);
  // payments whose events run past the scenario end still belong to the run (first seen inside it)
  return { events: all.map((x) => x.e), runId, scenarioId, kinds };
}
