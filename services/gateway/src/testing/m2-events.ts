// Synthetic M2-shaped event sequences (scoring, retries, ISO 20022 payloads, statement entries,
// reconciliation results) for gateway tests, scale measurements and UI smoke runs. Fictional data only.
import { CORRIDORS, type AnyEvent, type EventType, type Money, type PayloadMap, type ProviderScore, type StageName } from '@ct/contracts';

export type M2Outcome = 'settled' | 'retry' | 'failed' | 'break' | 'held';

export interface M2PaymentOptions {
  outcome?: M2Outcome;
  corridorIndex?: number;
  startMs?: number;
  stepMs?: number;
  amountMinor?: number;
}

const PROVIDER_ORDER = ['orion', 'lyra', 'vega'] as const;
const RAILS: Record<string, string> = { orion: 'Rail-A (instant)', lyra: 'Rail-B (same day)', vega: 'Rail-C (correspondent)' };
const SERVES: Record<string, string[]> = { orion: ['US-IN', 'DE-BR', 'GB-PH'], lyra: ['US-IN', 'GB-PH'], vega: ['US-IN', 'DE-BR', 'GB-PH'] };

export function fakePacs008(paymentId: string, amount: Money, providerId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><FIToFICstmrCdtTrf><GrpHdr><MsgId>MSG-${paymentId}</MsgId><NbOfTxs>1</NbOfTxs></GrpHdr><CdtTrfTxInf><PmtId><EndToEndId>${paymentId}</EndToEndId></PmtId><IntrBkSttlmAmt Ccy="${amount.currency}">${(amount.amountMinor / 100).toFixed(2)}</IntrBkSttlmAmt><InstdAgt><FinInstnId><BICFI>${providerId.toUpperCase()}XXX</BICFI></FinInstnId></InstdAgt></CdtTrfTxInf></FIToFICstmrCdtTrf></Document>`;
}

export function fakePacs002(paymentId: string, status: 'ACSC' | 'RJCT', reasonCode?: string): string {
  const rsn = reasonCode ? `<StsRsnInf><Rsn><Cd>${reasonCode}</Cd></Rsn></StsRsnInf>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.002.001.10"><FIToFIPmtStsRpt><TxInfAndSts><OrgnlEndToEndId>${paymentId}</OrgnlEndToEndId><TxSts>${status}</TxSts>${rsn}</TxInfAndSts></FIToFIPmtStsRpt></Document>`;
}

/** One payment's full event sequence. Deterministic ids: `${paymentId}:${n}`. */
export function m2Payment(paymentId: string, opts: M2PaymentOptions = {}): AnyEvent[] {
  const outcome = opts.outcome ?? 'settled';
  const corridor = CORRIDORS[(opts.corridorIndex ?? 0) % CORRIDORS.length]!;
  const stepMs = opts.stepMs ?? 100;
  let t = opts.startMs ?? Date.parse('2026-10-22T09:00:00.000Z');
  const events: AnyEvent[] = [];
  let prevId: string | null = null;
  const emit = <T extends EventType>(type: T, producer: StageName, payload: PayloadMap[T], trace?: AnyEvent['trace']) => {
    const eventId = `${paymentId}:${events.length}`;
    const e = {
      eventId, type, schemaVersion: 1 as const, paymentId, occurredAt: new Date(t).toISOString(), correlationId: paymentId,
      causationId: prevId, producer, payload, ...(trace ? { trace } : {}),
    };
    events.push(e as unknown as AnyEvent);
    prevId = eventId;
    t += stepMs;
  };

  const amount: Money = { amountMinor: opts.amountMinor ?? 125_000, currency: corridor.sourceCurrency };
  const mid = Number(corridor.midRate);
  const spreadBps = 35;
  const rate = mid * (1 - spreadBps / 10_000);
  const target: Money = { amountMinor: Math.round(amount.amountMinor * rate), currency: corridor.targetCurrency };
  const src = corridor.sourceCountry;
  const dst = corridor.targetCountry;

  emit('payment.initiated', 'payment-api', {
    amount, targetCurrency: corridor.targetCurrency, corridor: corridor.id,
    debtor: { name: 'Northwind Marketplace', country: src, accountId: `ACC-${src}-0001` },
    creditor: { name: 'Asha Textiles', country: dst, accountId: `ACC-${dst}-0001` },
    idempotencyKey: `idem-${paymentId}`,
    ...(outcome === 'retry' ? { scenario: 'provider-reject' } : outcome === 'break' ? { scenario: 'recon-break' } : outcome === 'held' ? { scenario: 'force-hold' } : {}),
  });
  emit('payment.screened', 'screening', { result: 'clear', listVersion: 'fict-2026.2' });
  if (outcome === 'held') {
    emit('payment.held', 'risk', { reason: 'Manual review (scenario)', atStage: 'risk' });
    return events;
  }
  emit('payment.scored', 'risk', { fraudScore: 0.05, amlAlerts: [], decision: 'approve' });
  emit('payment.quoted', 'fx', {
    quoteId: `q-${paymentId}`, rate: rate.toFixed(4), midRate: mid.toFixed(4), rateTimestamp: new Date(t).toISOString(), spreadBps,
    sourceAmount: amount, targetAmount: target, expiresAt: new Date(t + 30_000).toISOString(),
  });

  const eligible = PROVIDER_ORDER.filter((p) => SERVES[p]!.includes(corridor.id));
  const failures = outcome === 'retry' ? 1 : outcome === 'failed' ? eligible.length : 0;
  const excluded: string[] = [];
  for (let attempt = 1; attempt <= eligible.length; attempt++) {
    const scoring: ProviderScore[] = PROVIDER_ORDER.map((p, i) => {
      const serves = SERVES[p]!.includes(corridor.id);
      const failed = excluded.includes(p);
      const s: ProviderScore = {
        providerId: p, eligible: serves && !failed,
        fee: { amountMinor: 100 + i * 80, currency: amount.currency }, successRate: 0.97 - i * 0.02, latencyMs: 900 * (i + 1),
        score: serves && !failed ? Math.round((0.9 - i * 0.1) * 1000) / 1000 : 0,
      };
      if (!serves) s.excludedReason = 'CORRIDOR_NOT_SERVED';
      else if (failed) s.excludedReason = 'FAILED_THIS_PAYMENT';
      return s;
    });
    const chosen = eligible.find((p) => !excluded.includes(p))!;
    const fee = scoring.find((s) => s.providerId === chosen)!.fee;
    emit('payment.routed', 'routing', {
      providerId: chosen, rail: RAILS[chosen]!, estimatedFee: fee,
      alternatives: scoring.filter((s) => s.eligible && s.providerId !== chosen).map((s) => ({ providerId: s.providerId, score: s.score })),
      attempt, excludedProviders: [...excluded], scoring,
    }, { stage: 'routing', decision: chosen, reasonCodes: ['BEST_SCORE'], inputs: { attempt }, ruleVersion: 'route-2', latencyMs: 2 });
    emit('payment.sent', 'settlement', { providerId: chosen, messageType: 'pacs.008', messageId: `MSG-${paymentId}-${attempt}`, attempt, message: fakePacs008(paymentId, amount, chosen) });
    if (attempt <= failures) {
      emit('payment.send_failed', 'settlement', {
        providerId: chosen, attempt, reasonCode: 'AC04', reason: 'Closed account number', statusMessage: 'pacs.002', message: fakePacs002(paymentId, 'RJCT', 'AC04'),
      });
      excluded.push(chosen);
      if (outcome === 'failed' && attempt === eligible.length) {
        emit('payment.failed', 'routing', { reason: 'All eligible providers rejected the instruction', atStage: 'routing', attempts: attempt });
        return events;
      }
      continue;
    }
    const date = new Date(t).toISOString().slice(0, 10);
    emit('payment.settled', 'settlement', {
      providerId: chosen, settlementRef: `STL-${paymentId}`, statusMessage: 'pacs.002', attempt, settledAmount: target, valueDate: date,
      message: fakePacs002(paymentId, 'ACSC'),
      statementEntry: {
        statementId: `STMT-${chosen}-${date}-${target.currency}`, entryRef: `NTRY-${paymentId}`, providerId: chosen,
        amount: outcome === 'break' ? { ...target, amountMinor: target.amountMinor - 100 } : target, bookingDate: date, endToEndId: paymentId,
      },
    });
    const journalId = `J-${paymentId}`;
    emit('ledger.posted', 'ledger', {
      journalId,
      entries: [
        { account: `customer:ACC-${src}-0001`, direction: 'debit', amount },
        { account: `fx-position:${amount.currency}`, direction: 'credit', amount },
        { account: `fx-position:${target.currency}`, direction: 'debit', amount: target },
        { account: `provider:${chosen}:payable`, direction: 'credit', amount: target },
      ],
    });
    emit('payment.reconciled', 'reconciliation', {
      statementRef: `STMT-${chosen}-${date}-${target.currency}`, matched: outcome !== 'break', journalId,
      breaks: outcome === 'break' ? ['AMOUNT_MISMATCH: statement 1.00 below journal'] : [],
    });
    return events;
  }
  return events;
}

/** n payments, interleaved like a busy log (each payment's events stay in order). */
export function m2Log(n: number, opts: { startMs?: number; spacingMs?: number; mix?: (i: number) => M2Outcome } = {}): AnyEvent[] {
  const start = opts.startMs ?? Date.parse('2026-10-22T09:00:00.000Z');
  const spacing = opts.spacingMs ?? 50;
  const mix = opts.mix ?? ((i: number) => (i % 50 === 7 ? 'failed' : i % 10 === 3 ? 'retry' : i % 40 === 11 ? 'break' : i % 60 === 5 ? 'held' : 'settled'));
  const all: { at: number; seq: number; e: AnyEvent }[] = [];
  let seq = 0;
  for (let i = 0; i < n; i++) {
    const evs = m2Payment(`pay-${String(i).padStart(6, '0')}`, { outcome: mix(i), corridorIndex: i, startMs: start + i * spacing, stepMs: 120 });
    for (const e of evs) all.push({ at: Date.parse(e.occurredAt), seq: seq++, e });
  }
  all.sort((a, b) => a.at - b.at || a.seq - b.seq);
  return all.map((x) => x.e);
}
