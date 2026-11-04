// Pure analysis for `npm run verify:m6`: kill/recover timing, restart-policy accounting, the offline-proof
// connection parsers (netstat / Get-NetTCPConnection / ss / lsof) and the report builder. No I/O here, so
// everything is unit-tested on synthetic samples and captured command output.
import type { Check } from './analyze';

export type { Check };

// ---------------------------------------------------------------------------------------------------------
// Kill / recover timing

/** One poll of the launcher's supervisor view (launch().health()) plus an HTTP probe per service. */
export interface HealthSample {
  /** Epoch ms. */
  at: number;
  services: Record<string, { running: boolean; restarts: number; healthy: boolean }>;
}

export interface KillRecord {
  service: string;
  /** Epoch ms when kill() resolved (the process tree was dead). */
  killedAt: number;
  /** Restart counter of the service just before the kill. */
  restartsBefore: number;
}

export interface Recovery {
  service: string;
  killedAt: number;
  recovered: boolean;
  /** ms from the kill until the supervisor had the service running again, restart counted and healthy. */
  recoverMs: number | null;
  withinBound: boolean;
}

/**
 * For every kill: the first sample at or after the kill in which the service is running, its restart counter
 * went up (the supervisor did it, nobody called restart()) and its health probe passes.
 */
export function analyzeRecoveries(kills: readonly KillRecord[], samples: readonly HealthSample[], boundMs: number): Recovery[] {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  return kills.map((k) => {
    const hit = sorted.find((s) => {
      if (s.at < k.killedAt) return false;
      const v = s.services[k.service];
      return Boolean(v && v.running && v.healthy && v.restarts > k.restartsBefore);
    });
    const recoverMs = hit ? hit.at - k.killedAt : null;
    return { service: k.service, killedAt: k.killedAt, recovered: hit !== undefined, recoverMs, withinBound: recoverMs !== null && recoverMs <= boundMs };
  });
}

export function recoverySummary(recoveries: readonly Recovery[]): Record<string, { kills: number; maxMs: number | null; avgMs: number | null }> {
  const out: Record<string, { kills: number; maxMs: number | null; avgMs: number | null; sum: number; n: number }> = {};
  for (const r of recoveries) {
    const row = (out[r.service] ??= { kills: 0, maxMs: null, avgMs: null, sum: 0, n: 0 });
    row.kills += 1;
    if (r.recoverMs !== null) {
      row.n += 1;
      row.sum += r.recoverMs;
      row.maxMs = Math.max(row.maxMs ?? 0, r.recoverMs);
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { kills: v.kills, maxMs: v.maxMs, avgMs: v.n ? Math.round(v.sum / v.n) : null }]));
}

/**
 * Largest number of supervisor restarts of one service inside any `windowMs`, derived from the restart
 * counter of consecutive samples (each increase is stamped with the sample time that first showed it).
 */
export function maxRestartsInWindow(samples: readonly HealthSample[], windowMs: number): Record<string, number> {
  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const stamps: Record<string, number[]> = {};
  const last: Record<string, number> = {};
  for (const s of sorted) {
    for (const [name, v] of Object.entries(s.services)) {
      const prev = last[name] ?? v.restarts;
      for (let i = prev; i < v.restarts; i++) (stamps[name] ??= []).push(s.at);
      last[name] = v.restarts;
    }
  }
  const out: Record<string, number> = {};
  for (const [name, ts] of Object.entries(stamps)) {
    let best = 0;
    let lo = 0;
    for (let hi = 0; hi < ts.length; hi++) {
      while (ts[hi]! - ts[lo]! > windowMs) lo++;
      best = Math.max(best, hi - lo + 1);
    }
    out[name] = best;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Offline proof: TCP connections of the launched process tree

export interface TcpConn {
  pid: number;
  localAddr: string;
  localPort: number;
  remoteAddr: string;
  remotePort: number;
  state: string;
}

/** "127.0.0.1:7072", "[::1]:7072", "::1.7072" (lsof/BSD), "*:*" -> address and port. */
export function splitHostPort(text: string): { addr: string; port: number } {
  const t = text.trim();
  const m = /^\[(.+)\]:(\d+|\*)$/.exec(t) ?? /^(.*):(\d+|\*)$/.exec(t);
  if (!m) return { addr: t, port: 0 };
  return { addr: m[1]!, port: m[2] === '*' ? 0 : Number(m[2]) };
}

/** Windows `netstat -ano -p TCP` (also `-p TCPv6`). */
export function parseNetstatWindows(text: string): TcpConn[] {
  const out: TcpConn[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+)\s+(\S+)\s+([A-Z_]+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    const l = splitHostPort(m[1]!);
    const r = splitHostPort(m[2]!);
    out.push({ pid: Number(m[4]), localAddr: l.addr, localPort: l.port, remoteAddr: r.addr, remotePort: r.port, state: m[3]! });
  }
  return out;
}

/** `Get-NetTCPConnection | Select OwningProcess,LocalAddress,LocalPort,RemoteAddress,RemotePort,State | ConvertTo-Json`. */
export function parseGetNetTcpConnection(json: string): TcpConn[] {
  let data: unknown;
  try {
    data = JSON.parse(json.replace(/^﻿/, ''));
  } catch {
    return [];
  }
  const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  const out: TcpConn[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    if (typeof r.OwningProcess !== 'number') continue;
    out.push({
      pid: r.OwningProcess,
      localAddr: String(r.LocalAddress ?? ''),
      localPort: Number(r.LocalPort ?? 0),
      remoteAddr: String(r.RemoteAddress ?? ''),
      remotePort: Number(r.RemotePort ?? 0),
      // Get-NetTCPConnection prints enum names ("Established") or numbers; normalise names.
      state: typeof r.State === 'string' ? r.State.toUpperCase() : String(r.State ?? ''),
    });
  }
  return out;
}

/** Linux `ss -tanp` (header optional): State Recv-Q Send-Q Local Peer Process, process as users:(("node",pid=123,fd=4)). */
export function parseSs(text: string): TcpConn[] {
  const out: TcpConn[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] === 'State') continue;
    const [state, , , local, peer] = cols as [string, string, string, string, string];
    const pids = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
    const l = splitHostPort(local);
    const r = splitHostPort(peer);
    for (const pid of pids.length ? new Set(pids) : []) {
      out.push({ pid, localAddr: l.addr, localPort: l.port, remoteAddr: r.addr, remotePort: r.port, state: state.toUpperCase().replace('-', '_') });
    }
  }
  return out;
}

/** `lsof -nP -iTCP`: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (STATE). */
export function parseLsof(text: string): TcpConn[] {
  const out: TcpConn[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\S+\s+(\d+)\s+\S+\s+\S+\s+IPv[46]\s+\S+\s+\S+\s+TCP\s+(\S+?)(?:->(\S+))?\s*(?:\(([A-Z_]+)\))?\s*$/.exec(line.trim());
    if (!m) continue;
    const l = splitHostPort(m[2]!);
    const r = m[3] ? splitHostPort(m[3]) : { addr: '*', port: 0 };
    out.push({ pid: Number(m[1]), localAddr: l.addr, localPort: l.port, remoteAddr: r.addr, remotePort: r.port, state: m[4] ?? (m[3] ? 'ESTABLISHED' : 'LISTEN') });
  }
  return out;
}

export function isLoopbackAddr(addr: string): boolean {
  const a = addr.replace(/%.*$/, '').toLowerCase();
  return a === '::1' || a === 'localhost' || /^127\./.test(a) || /^::ffff:127\./.test(a);
}

/** An address that means "no peer" (listening sockets, unconnected). */
export function isUnspecified(addr: string): boolean {
  return addr === '' || addr === '*' || addr === '0.0.0.0' || addr === '::' || addr === '[::]';
}

export interface OfflineFinding {
  pid: number;
  kind: 'remote-connection' | 'non-loopback-listener';
  detail: string;
}

/**
 * Connections of the given PIDs that talk to a non-loopback peer, plus listeners bound to a non-loopback
 * address. A LISTEN socket on a loopback address is fine; so are TIME_WAIT leftovers to loopback peers.
 */
export function findOfflineViolations(conns: readonly TcpConn[], pids: ReadonlySet<number>): OfflineFinding[] {
  const out: OfflineFinding[] = [];
  for (const c of conns) {
    if (!pids.has(c.pid)) continue;
    const listening = c.state === 'LISTEN' || c.state === 'LISTENING';
    if (listening) {
      if (!isLoopbackAddr(c.localAddr)) out.push({ pid: c.pid, kind: 'non-loopback-listener', detail: `listens on ${c.localAddr}:${c.localPort}` });
      continue;
    }
    if (isUnspecified(c.remoteAddr)) continue;
    if (!isLoopbackAddr(c.remoteAddr)) {
      out.push({ pid: c.pid, kind: 'remote-connection', detail: `${c.localAddr}:${c.localPort} -> ${c.remoteAddr}:${c.remotePort} (${c.state})` });
    }
  }
  return out;
}

export interface ProcRow {
  pid: number;
  ppid: number;
  name?: string;
}

/** PIDs of `rootPid` and all its descendants from a (pid, ppid) table. */
export function descendantPids(rootPid: number, table: readonly ProcRow[]): Set<number> {
  const kids = new Map<number, number[]>();
  for (const { pid, ppid } of table) {
    const l = kids.get(ppid);
    if (l) l.push(pid);
    else kids.set(ppid, [pid]);
  }
  const out = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    for (const k of kids.get(queue.pop()!) ?? []) {
      if (!out.has(k)) {
        out.add(k);
        queue.push(k);
      }
    }
  }
  return out;
}

/** `ps -eo pid=,ppid=` output. */
export function parsePsTable(text: string): ProcRow[] {
  const out: ProcRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*(\S*)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), ...(m[3] ? { name: m[3] } : {}) });
  }
  return out;
}

/** Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId | ConvertTo-Json. */
export function parseCimProcessTable(json: string): ProcRow[] {
  try {
    const data = JSON.parse(json.replace(/^﻿/, '')) as unknown;
    const rows = Array.isArray(data) ? data : [data];
    return (rows as Record<string, unknown>[])
      .filter((r) => typeof r.ProcessId === 'number' && typeof r.ParentProcessId === 'number')
      .map((r) => ({ pid: r.ProcessId as number, ppid: r.ParentProcessId as number, ...(typeof r.Name === 'string' ? { name: r.Name } : {}) }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------------------------------------
// Visitor results -> checks

export interface VisitIssue {
  visit: number;
  code: string;
  detail: string;
}

export interface VisitSummary {
  visit: number;
  paymentId: string | null;
  status: string | null;
  mode: 'send' | 'fail';
  abandoned: boolean;
  leadId: string | null;
  leadAttempted: boolean;
  questions: number;
  verifiedAnswers: number;
  /** Transient errors that a real kiosk retries or hides (service restarting). Counted, not failures. */
  transient: number;
  issues: VisitIssue[];
}

export function visitChecks(visits: readonly VisitSummary[], idPrefix = 'visitors'): Check[] {
  const issues = visits.flatMap((v) => v.issues);
  const byCode = (...codes: string[]) => issues.filter((i) => codes.includes(i.code));
  const paid = visits.filter((v) => v.paymentId);
  const leadsTried = visits.filter((v) => v.leadAttempted);
  const questions = visits.reduce((n, v) => n + v.questions, 0);
  const verified = visits.reduce((n, v) => n + v.verifiedAnswers, 0);
  const examples = (list: VisitIssue[]) => (list.length ? list.slice(0, 10) : undefined);
  const mk = (id: string, title: string, bad: VisitIssue[], detail: string): Check => ({ id: `${idPrefix}.${id}`, title, ok: bad.length === 0, detail, examples: examples(bad) });
  return [
    mk('payments', 'Every visitor payment was accepted and reached a terminal status (retry path: same idempotency key)', byCode('payment-rejected', 'payment-stuck', 'payment-missing'), `${paid.length}/${visits.filter((v) => !v.abandoned || v.paymentId).length} paid visits; ${visits.filter((v) => v.abandoned).length} abandoned`),
    mk('reconciled', 'Kiosk payments end reconciled; provider-fail payments reroute and still reconcile', byCode('not-reconciled', 'no-reroute'), `${paid.filter((v) => v.status === 'reconciled').length}/${paid.length} reconciled`),
    mk('ledger', 'Ledger balanced for every visitor payment (balanced posting, exactly one journal)', byCode('ledger-unbalanced', 'journal-count'), `${paid.length} payments checked`),
    mk('assistant', 'Every assistant answer is verified:true; suggestions are returned', byCode('answer-unverified', 'answer-http', 'suggestions-empty'), `${verified}/${questions} answers verified`),
    mk('consent', 'The booth rejects a lead without consent; analytics refuse personal data', byCode('consent-accepted', 'analytics-personal'), 'consent and privacy probes'),
    mk('leads', 'Every acknowledged lead is stored and readable by staff', byCode('lead-rejected', 'lead-missing'), `${visits.filter((v) => v.leadId).length}/${leadsTried.length} leads acknowledged`),
    mk('analytics', 'Anonymous analytics batches accepted', byCode('analytics-rejected'), 'session ids reset between visits'),
  ];
}

// ---------------------------------------------------------------------------------------------------------
// Report

export interface M6Report {
  ok: boolean;
  generatedAt: string;
  mode: 'launched' | 'url';
  quick: boolean;
  params: Record<string, unknown>;
  checks: Check[];
  details: Record<string, unknown>;
  totalDurationS: number;
}

export function buildReport(input: { checks: Check[]; mode: 'launched' | 'url'; quick: boolean; params: Record<string, unknown>; details: Record<string, unknown>; totalDurationS: number; now?: Date }): M6Report {
  return {
    ok: input.checks.length > 0 && input.checks.every((c) => c.ok),
    generatedAt: (input.now ?? new Date()).toISOString(),
    mode: input.mode,
    quick: input.quick,
    params: input.params,
    checks: input.checks,
    details: input.details,
    totalDurationS: input.totalDurationS,
  };
}

export function renderChecksTable(checks: readonly Check[]): string {
  const w = Math.max(...checks.map((c) => c.id.length), 2);
  return checks.map((c) => `  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(w)}  ${c.detail}`).join('\n');
}

export const GATE3_PASSED = 'GATE 3 (software part) PASSED';
export const GATE3_FAILED = 'GATE 3 (software part) FAILED';

export const NOT_PROVEN_BY_SOFTWARE = [
  'A physical rehearsal on the event hardware (laptop, screens, kiosk touch screen, power, venue network)',
  'Legal / privacy review of the lead consent text, the retention promise and local data-protection rules',
  'Real visitors: wording, dwell time, accessibility on the actual touch screen',
  'Anything outside this machine: Docker/Kafka profile, other processes, the venue Wi-Fi',
];

export function verdict(report: Pick<M6Report, 'ok' | 'checks'>): string {
  if (report.ok) {
    return [GATE3_PASSED, '', 'Software cannot prove:', ...NOT_PROVEN_BY_SOFTWARE.map((s) => `  - ${s}`)].join('\n');
  }
  const failed = report.checks.filter((c) => !c.ok).map((c) => c.id);
  return `${GATE3_FAILED}: ${failed.join(', ')}`;
}
