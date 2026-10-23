// TEMPORARY dev-only mock gateway for the main stage harness. Delete before finishing.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.MOCK_PORT ?? 7372);
const RATE = Number(process.env.RATE ?? 8); // payments / s
const CYCLE = 50_000;
const corridors = [
  { id: 'US-IN', p: ['orion', 'lyra', 'vega'] },
  { id: 'DE-BR', p: ['orion', 'vega'] },
  { id: 'GB-PH', p: ['orion', 'lyra', 'vega'] },
];
const weight = { orion: 6, lyra: 2.5, vega: 1.5 };
const latency = { orion: 1500, lyra: 3000, vega: 5000 };
const t0 = Date.now();
const phase = () => (Date.now() - t0) % CYCLE;
const outage = () => phase() >= 10_000 && phase() < 28_000;
function breaker() {
  const t = phase();
  if (t >= 13_000 && t < 28_000) return 'open';
  if (t >= 28_000 && t < 33_000) return 'half-open';
  return 'closed';
}
const steps = [
  [0, 'Normal traffic on all providers'],
  [10_000, 'Provider Orion goes down'],
  [13_000, 'Circuit breaker trips — traffic re-routes'],
  [28_000, 'Orion is back — probing with a few payments'],
  [33_000, 'Breaker closed — Orion gets traffic back'],
];
const stats = { total: 0, reconciled: 0, inFlight: 0, retriesTotal: 0, failed: 0 };
const byStatus = Object.fromEntries(['initiated', 'screened', 'scored', 'quoted', 'routed', 'sent', 'settled', 'reconciled', 'retrying', 'held', 'rejected', 'failed'].map((s) => [s, 0]));
const recent = [];
let n = 0;
const pending = new Map();
let events = [];
const counts = {};
const clients = new Set();

function statsObj() {
  const now = Date.now();
  while (recent.length && recent[0] < now - 60_000) recent.shift();
  return {
    ...stats, byStatus, held: 0, rejected: 0, retrying: 0, reconBreaks: 0, reconMatched: stats.reconciled, avgEndToEndMs: 4000, rejectedEvents: 0, events: 0,
    throughput: { windowSec: 60, paymentsPerMin: recent.length, completedPerMin: 0, eventsPerSec: 0, eventsLastMinute: 0, series: [] },
  };
}
function emit(p, type, status) {
  if (p.status) byStatus[p.status] = Math.max(0, byStatus[p.status] - 1);
  p.status = status;
  byStatus[status] += 1;
  pending.set(p.paymentId, { paymentId: p.paymentId, status, corridor: p.corridor, providerId: p.providerId, amount: { amountMinor: 1000, currency: 'USD' }, createdAt: p.createdAt, updatedAt: new Date().toISOString(), stepIndex: 0, lastPipelineIndex: 0, ledgerPosted: false, retries: p.retries });
  events.push({ eventId: `${p.paymentId}-${events.length}-${Math.random()}`, type, paymentId: p.paymentId, occurredAt: new Date().toISOString() });
  counts[type] = (counts[type] ?? 0) + 1;
}
function pick(c, excluded) {
  const opts = c.p.filter((x) => !excluded.includes(x) && !(x === 'orion' && breaker() === 'open'));
  if (breaker() === 'half-open' && opts.includes('orion') && Math.random() > 0.25) opts.splice(opts.indexOf('orion'), 1);
  const tot = opts.reduce((s, x) => s + weight[x], 0);
  let r = Math.random() * tot;
  for (const x of opts) if ((r -= weight[x]) <= 0) return x;
  return opts[0];
}
function route(p) {
  p.providerId = pick(p.c, p.excluded);
  if (!p.providerId) { emit(p, 'payment.failed', 'failed'); stats.failed++; stats.inFlight--; return; }
  emit(p, 'payment.routed', 'routed');
  setTimeout(() => {
    emit(p, 'payment.sent', 'sent');
    const fail = p.providerId === 'orion' && outage();
    setTimeout(() => {
      if (fail) {
        p.retries++; stats.retriesTotal++; p.excluded.push('orion');
        emit(p, 'payment.send_failed', 'retrying');
        setTimeout(() => route(p), 400);
      } else {
        emit(p, 'payment.settled', 'settled');
        setTimeout(() => { emit(p, 'payment.reconciled', 'reconciled'); stats.reconciled++; stats.inFlight--; }, 800);
      }
    }, fail ? 500 : latency[p.providerId] * (0.6 + Math.random() * 0.8));
  }, 400);
}
setInterval(() => {
  for (let k = 0; k < Math.ceil(RATE / 10); k++) { if (Math.random() > RATE / 10 / Math.ceil(RATE / 10)) continue;
  const c = corridors[n % 3];
  const p = { paymentId: `pay-${++n}`, corridor: c.id, c, excluded: [], retries: 0, createdAt: new Date().toISOString() };
  stats.total++; stats.inFlight++; recent.push(Date.now());
  emit(p, 'payment.initiated', 'initiated');
  setTimeout(() => route(p), 1200);
  }
}, 100);
setInterval(() => {
  if (!pending.size && !events.length) return;
  const msg = JSON.stringify({ kind: 'update', payments: [...pending.values()], events, eventCount: events.length, droppedEvents: 0, counts: { ...counts }, stats: statsObj() });
  pending.clear(); events = []; for (const k of Object.keys(counts)) delete counts[k];
  for (const ws of clients) if (ws.readyState === 1) ws.send(msg);
}, 50);

function control() {
  const t = phase();
  const step = [...steps].reverse().find(([at]) => t >= at);
  const b = breaker();
  return {
    control: {
      outages: outage() ? { orion: { providerId: 'orion', mode: 'down', reason: 'Scenario', since: new Date().toISOString() } } : {},
      scenario: { runId: 'r1', scenarioId: 'provider-outage', title: 'Provider outage', startedAt: '', step: { stepId: String(step[0]), title: step[1], at: '' } },
      speed: null, paused: false, lastOffset: 1,
    },
    breakers: [
      { providerId: 'orion', state: b, since: null, failureRate: b === 'open' ? 0.83 : 0.02, attempts: 40, reason: b === 'open' ? '5 of the last 6 instructions rejected' : b === 'half-open' ? 'Letting 25% of payments through as probes' : '' },
      { providerId: 'lyra', state: 'closed', since: null, failureRate: 0.05, attempts: 30, reason: '' },
      { providerId: 'vega', state: 'closed', since: null, failureRate: 0.01, attempts: 22, reason: '' },
    ],
    orchestrator: null, resetAvailable: false,
  };
}
const server = http.createServer((req, res) => {
  const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/api/control/state') return process.env.NO_CONTROL ? send(404, { error: 'not found' }) : send(200, control());
  if (req.url === '/api/stats') return send(200, statsObj());
  if (req.url?.startsWith('/api/ledger/trial-balance')) return send(200, { asOf: '', journals: stats.reconciled, entries: 0, byCurrency: [], balanced: true });
  send(404, { error: 'not found' });
});
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => { clients.add(ws); ws.send(JSON.stringify({ kind: 'snapshot', payments: [], stats: statsObj() })); ws.on('close', () => clients.delete(ws)); });
server.listen(PORT, '127.0.0.1', () => console.log(`mock on ${PORT}`));
