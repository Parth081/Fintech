// verify:m6 safe-mode phase: record a short provider-outage run from the live system, switch to the recorded
// backup run through the launcher control API, prove the screens still show a moving system while payment
// sending is paused, then switch back to a fresh live system and complete a payment.
import { recordRun } from '../booth/record';
import { buildPaymentRequest } from '../../apps/web/src/kiosk/payment';
import type { Check } from './analyze';
import { check, type Rehearsal } from './m6-ctx';
import { http, sleep } from './m6-http';
import { makeVisitScripts, runVisit } from './m6-visitors';

export const RECORDING_NAME = 'm6-rehearsal';

interface Health {
  mode?: string;
  recording?: string | null;
  events?: number;
}

const healthOf = async (gw: string) => (await http<Health>('GET', `${gw}/health`, undefined, {}, 2000)).body ?? {};

async function waitMode(gw: string, want: 'live' | 'safe', timeoutMs: number): Promise<number | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const h = await http<Health>('GET', `${gw}/health`, undefined, {}, 1500);
    if (h.status === 200 && h.body?.mode === want) return Date.now() - t0;
    await sleep(100);
  }
  return null;
}

export async function recordBackup(rh: Rehearsal): Promise<Check[]> {
  const lines: string[] = [];
  try {
    const r = await recordRun({
      name: RECORDING_NAME,
      scenario: 'provider-outage',
      durationMs: rh.args.recordSeconds * 1000,
      dataDir: rh.dataDir,
      gatewayUrl: rh.urls.gateway,
      broker: rh.urls.brokerHttp,
      force: true,
      graceMs: 12_000,
      log: (l) => lines.push(l),
    });
    await http('POST', `${rh.urls.orchestrator}/scenarios/stop`, {});
    rh.details.recording = { name: RECORDING_NAME, events: r.meta.eventCount, payments: r.payments, controlEvents: r.controlEvents, closers: r.closers, unfinishedPayments: r.unfinishedPayments, durationMs: r.meta.durationMs };
    return [
      check('record.captured', `A ${rh.args.recordSeconds} s provider-outage run is recorded from the live system`, r.meta.eventCount > 0 && r.payments > 0 && r.controlEvents > 0 && r.unfinishedPayments === 0,
        `${r.meta.eventCount} events, ${r.payments} payments, ${r.controlEvents} control events, ${r.closers} closer(s), ${r.unfinishedPayments} unfinished`),
    ];
  } catch (err) {
    return [check('record.captured', 'A provider-outage run is recorded from the live system', false, (err as Error).message.split('\n')[0]!, lines.slice(-5))];
  }
}

/** One live -> safe -> live round trip. `n` is 1-based. */
export async function safeRoundTrip(rh: Rehearsal, n: number): Promise<Check[]> {
  const gw = rh.urls.gateway;
  const ctl = rh.urls.control!;
  const pin = { 'x-booth-staff': rh.args.staffPin };
  const id = (s: string) => `safe.${n}.${s}`;
  const checks: Check[] = [];
  const bound = rh.args.safeBoundMs;
  const t0 = Date.now();
  const on = await http<{ ok?: boolean; mode?: string; recording?: string | null; durationMs?: number; error?: string }>('POST', `${ctl}/safe-mode`, { on: true, name: RECORDING_NAME }, {}, 90_000);
  const reported = on.status === 200 ? await waitMode(gw, 'safe', Math.max(0, t0 + bound - Date.now()) + 500) : null;
  const toSafe = Date.now() - t0;
  checks.push(check(id('enter'), `Safe mode on: /health reports mode 'safe' within ${bound / 1000} s`, on.status === 200 && reported !== null && toSafe <= bound, `POST /safe-mode -> ${on.status} ${on.body?.error ?? ''}; gateway reports safe after ${toSafe} ms; recording ${on.body?.recording ?? '?'}`));
  rh.details[`safeRoundTrip${n}`] = { toSafeMs: toSafe };
  if (on.status !== 200 || reported === null) {
    await http('POST', `${ctl}/safe-mode`, { on: false }, {}, 90_000);
    return checks;
  }
  const h = await healthOf(gw);
  const st = await http<{ mode?: string; recording?: string | null }>('GET', `${ctl}/status`);
  checks.push(check(id('status'), 'Gateway /health and launcher /status agree on mode and recording', h.mode === 'safe' && h.recording === RECORDING_NAME && st.body?.mode === 'safe' && st.body?.recording === RECORDING_NAME, `gateway ${h.mode}/${h.recording}, launcher ${st.body?.mode}/${st.body?.recording}`));

  // Screens keep getting data: the log head moves while the recording plays.
  const e1 = (await healthOf(gw)).events ?? 0;
  const s1 = (await http<{ total?: number }>('GET', `${gw}/api/stats`)).body?.total ?? 0;
  await sleep(6000);
  const e2 = (await healthOf(gw)).events ?? 0;
  const s2 = (await http<{ total?: number }>('GET', `${gw}/api/stats`)).body?.total ?? 0;
  const list = await http<{ payments?: unknown[] } | unknown[]>('GET', `${gw}/api/payments?limit=5`);
  const listed = Array.isArray(list.body) ? list.body.length : Array.isArray((list.body as { payments?: unknown[] })?.payments) ? (list.body as { payments: unknown[] }).payments.length : 0;
  checks.push(check(id('moving'), 'Stage data still moves in safe mode: events arrive, counters increase, payments are listed', e2 > e1 && s2 > s1 && listed > 0, `events ${e1} -> ${e2}, payments ${s1} -> ${s2}, listed ${listed}`));

  // Sending is paused.
  const body = buildPaymentRequest('US-IN', 100, 'send');
  const post = await http<{ error?: string }>('POST', `${gw}/api/payments`, body, { 'idempotency-key': `m6-safe-${n}-${Date.now()}` });
  const sample = await http('POST', `${gw}/api/payments/sample`, {});
  checks.push(check(id('paused'), "Payment POSTs answer 503 'demo paused' (the kiosk cannot send)", post.status === 503 && post.body?.error === 'demo paused' && sample.status === 503, `POST /api/payments -> ${post.status} ${post.text.slice(0, 80)}; /sample -> ${sample.status}`));

  // Leads and the explainer keep working.
  const leads = await http<{ id: string }[]>('GET', `${gw}/api/booth/leads`, undefined, pin);
  const have = new Set(Array.isArray(leads.body) ? leads.body.map((l) => l.id) : []);
  const lost = [...rh.leads.keys()].filter((l) => !have.has(l));
  const lead = await http<{ id?: string }>('POST', `${gw}/api/booth/leads`, {
    name: `Safe Mode Visitor ${n}`, company: 'Synthetic Co', email: `m6-safe-${n}@example.test`, interest: 'ai', consent: true, consentText: 'I agree to be contacted about this demo. (verify:m6 synthetic visitor)',
  });
  if (lead.status === 201 || lead.status === 200) if (lead.body?.id) rh.leads.set(lead.body.id, `m6-safe-${n}@example.test`);
  checks.push(check(id('leads'), 'Leads stay reachable in safe mode: staff list has every acknowledged lead, new leads are accepted', leads.status === 200 && lost.length === 0 && lead.status < 300, `list ${leads.status}, ${lost.length} lost of ${rh.leads.size}; new lead -> ${lead.status}`));
  const ask = await http<{ verified?: boolean }>('POST', `${gw}/api/assistant/ask`, { question: 'Is the ledger balanced?', context: { kind: 'system' } }, {}, 25_000);
  checks.push(check(id('assistant'), 'The explainer still answers (verified) from the recorded events', ask.status === 200 && ask.body?.verified === true, `ask -> ${ask.status} verified=${String(ask.body?.verified)}`));

  // The recording contains the outage: it shows up in the control state while the loop plays.
  let sawOutage = false;
  const until = Date.now() + (Number((rh.details.recording as { durationMs?: number } | undefined)?.durationMs) || 45_000) + 15_000;
  while (Date.now() < until && !sawOutage) {
    const cs = await http<{ control?: { outages?: Record<string, unknown> } }>('GET', `${gw}/api/control/state`);
    sawOutage = Object.keys(cs.body?.control?.outages ?? {}).length > 0;
    if (!sawOutage) await sleep(500);
  }
  checks.push(check(id('outage'), 'Control state shows the recorded provider outage', sawOutage, sawOutage ? 'outage visible in /api/control/state' : 'no outage seen during one loop of the recording'));

  // Back to live.
  const t1 = Date.now();
  const off = await http<{ ok?: boolean; error?: string }>('POST', `${ctl}/safe-mode`, { on: false }, {}, 90_000);
  const live = off.status === 200 ? await waitMode(gw, 'live', Math.max(0, t1 + bound - Date.now()) + 500) : null;
  const toLive = Date.now() - t1;
  checks.push(check(id('exit'), `Safe mode off: /health reports mode 'live' within ${bound / 1000} s`, off.status === 200 && live !== null && toLive <= bound, `POST /safe-mode -> ${off.status} ${off.body?.error ?? ''}; live after ${toLive} ms`));
  rh.details[`safeRoundTrip${n}`] = { toSafeMs: toSafe, toLiveMs: toLive };
  if (live === null) return checks;
  const script = { ...makeVisitScripts(rh.args.seed + 1000 + n, 1)[0]!, abandon: null, lead: false, asks: 1, probes: false, mode: 'send' as const, concurrentWithNext: false, idleAfterMs: 0 };
  const v = await runVisit(script, rh.visitContext(() => false));
  checks.push(check(id('payment'), 'Back in live mode a new visitor payment completes (reconciled, ledger balanced)', v.issues.length === 0 && v.status === 'reconciled', `payment ${v.paymentId} ${v.status}; ${v.issues.map((i) => i.code).join(', ') || 'no issues'}`, v.issues));
  const leads2 = await http<{ id: string }[]>('GET', `${gw}/api/booth/leads`, undefined, pin);
  const have2 = new Set(Array.isArray(leads2.body) ? leads2.body.map((l) => l.id) : []);
  const lost2 = [...rh.leads.keys()].filter((l) => !have2.has(l));
  checks.push(check(id('leads-after'), 'Every acknowledged lead survived the round trip', leads2.status === 200 && lost2.length === 0, `${lost2.length} of ${rh.leads.size} missing`));
  return checks;
}
