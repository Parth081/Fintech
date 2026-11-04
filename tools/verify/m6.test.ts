import { describe, expect, it } from 'vitest';
import {
  analyzeRecoveries,
  buildReport,
  descendantPids,
  findOfflineViolations,
  GATE3_FAILED,
  GATE3_PASSED,
  maxRestartsInWindow,
  parseCimProcessTable,
  parseGetNetTcpConnection,
  parseLsof,
  parseNetstatWindows,
  parsePsTable,
  parseSs,
  recoverySummary,
  verdict,
  visitChecks,
  type HealthSample,
  type VisitSummary,
} from './m6-analyze';
import { parseVerifyM6Args } from './m6-args';
import { KILL_CLASSES, planKills } from './m6-chaos';
import { journalBalanced, makeVisitScripts } from './m6-visitors';

const sample = (at: number, restarts: number, running = true, healthy = true): HealthSample => ({ at, services: { ledger: { running, restarts, healthy }, fx: { running: true, restarts: 0, healthy: true } } });

describe('args', () => {
  it('has full and quick defaults', () => {
    expect(parseVerifyM6Args([]).visitors).toBe(40);
    const q = parseVerifyM6Args(['--quick']);
    expect(q).toMatchObject({ quick: true, visitors: 10, killsPerClass: 1, resets: 1, safeRoundTrips: 1 });
    expect(parseVerifyM6Args(['--quick', '--visitors', '5']).visitors).toBe(5);
  });
  it('rejects unknown and bad values', () => {
    expect(() => parseVerifyM6Args(['--nope'])).toThrow(/Unknown option/);
    expect(() => parseVerifyM6Args(['--visitors', '0'])).toThrow();
  });
});

describe('kill planner and visitor scripts', () => {
  it('is deterministic and covers every class, the broker included', () => {
    expect(planKills(6, 2)).toEqual(planKills(6, 2));
    expect(planKills(6, 2)).not.toEqual(planKills(7, 2));
    const plan = planKills(6, 1);
    expect(plan).toHaveLength(KILL_CLASSES.length);
    expect(plan).toContain('broker');
    expect(plan.filter((s) => ['screening', 'risk', 'fx', 'routing', 'settlement', 'reconciliation'].includes(s))).toHaveLength(1);
    expect(new Set(planKills(6, 2).filter((s) => s !== 'ledger' && s !== 'broker')).size).toBeGreaterThan(5);
  });
  it('generates the same visitors for the same seed, with the intended mix', () => {
    const a = makeVisitScripts(6, 200);
    expect(makeVisitScripts(6, 200)).toEqual(a);
    expect(makeVisitScripts(7, 200)).not.toEqual(a);
    const share = (f: (s: (typeof a)[number]) => boolean) => a.filter(f).length / a.length;
    expect(share((s) => s.lead)).toBeGreaterThan(0.2);
    expect(share((s) => s.lead)).toBeLessThan(0.4);
    expect(share((s) => s.abandon !== null)).toBeGreaterThan(0.08);
    expect(share((s) => s.mode === 'fail')).toBeGreaterThan(0.2);
    expect(a.some((s) => s.concurrentWithNext)).toBe(true);
  });
  it('checks journals', () => {
    const m = (c: string, n: number) => ({ amountMinor: n, currency: c });
    expect(journalBalanced([{ direction: 'debit', amount: m('USD', 5) }, { direction: 'credit', amount: m('USD', 5) }])).toBe(true);
    expect(journalBalanced([{ direction: 'debit', amount: m('USD', 5) }, { direction: 'credit', amount: m('USD', 4) }])).toBe(false);
    expect(journalBalanced([])).toBe(false);
  });
});

describe('recovery timing', () => {
  const kill = { service: 'ledger', killedAt: 1000, restartsBefore: 0 };
  it('measures time to the first healthy sample with a counted restart', () => {
    const samples = [sample(900, 0), sample(1100, 0, false), sample(2500, 1, true, false), sample(3200, 1)];
    const [r] = analyzeRecoveries([kill], samples, 5000);
    expect(r).toMatchObject({ recovered: true, recoverMs: 2200, withinBound: true });
  });
  it('flags late and missing recoveries', () => {
    expect(analyzeRecoveries([kill], [sample(20_000, 1)], 5000)[0]).toMatchObject({ recovered: true, withinBound: false });
    expect(analyzeRecoveries([kill], [sample(1100, 0, false), sample(1500, 0)], 5000)[0]).toMatchObject({ recovered: false, recoverMs: null, withinBound: false });
  });
  it('summarises per service', () => {
    const r = analyzeRecoveries([kill, { ...kill, killedAt: 10_000, restartsBefore: 1 }], [sample(2000, 1), sample(13_000, 2)], 5000);
    expect(recoverySummary(r).ledger).toEqual({ kills: 2, maxMs: 3000, avgMs: 2000 });
  });
  it('counts restarts inside the policy window', () => {
    const s = [sample(0, 0), sample(1000, 1), sample(2000, 2), sample(3000, 3), sample(200_000, 4)];
    expect(maxRestartsInWindow(s, 120_000).ledger).toBe(3);
    expect(maxRestartsInWindow(s, 1_000_000).ledger).toBe(4);
  });
});

describe('offline proof parsers', () => {
  const netstat = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1040
  TCP    127.0.0.1:38072        127.0.0.1:50211        ESTABLISHED     4242
  TCP    127.0.0.1:50211        127.0.0.1:38072        ESTABLISHED     5000
  TCP    192.168.1.5:50300      142.250.74.46:443      ESTABLISHED     4242
  TCP    [::1]:38070            [::]:0                 LISTENING       4243
`;
  it('parses netstat -ano', () => {
    const c = parseNetstatWindows(netstat);
    expect(c).toHaveLength(5);
    expect(c[3]).toMatchObject({ pid: 4242, remoteAddr: '142.250.74.46', remotePort: 443, state: 'ESTABLISHED' });
    expect(c[4]).toMatchObject({ localAddr: '::1', localPort: 38070 });
  });
  it('flags only remote peers of our pids', () => {
    const c = parseNetstatWindows(netstat);
    expect(findOfflineViolations(c, new Set([4242, 4243, 5000]))).toEqual([expect.objectContaining({ pid: 4242, kind: 'remote-connection' })]);
    expect(findOfflineViolations(c, new Set([5000]))).toEqual([]);
    expect(findOfflineViolations(c, new Set([1040]))).toEqual([expect.objectContaining({ kind: 'non-loopback-listener' })]);
  });
  it('parses Get-NetTCPConnection JSON (array and single object)', () => {
    const row = { OwningProcess: 7, LocalAddress: '127.0.0.1', LocalPort: 1, RemoteAddress: '10.0.0.9', RemotePort: 80, State: 'Established' };
    expect(findOfflineViolations(parseGetNetTcpConnection(JSON.stringify([row])), new Set([7]))).toHaveLength(1);
    expect(parseGetNetTcpConnection(JSON.stringify(row))).toHaveLength(1);
    expect(parseGetNetTcpConnection('garbage')).toEqual([]);
  });
  it('parses ss -tanp', () => {
    const ss = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0 511 127.0.0.1:38072 0.0.0.0:* users:(("node",pid=11,fd=20))
ESTAB  0 0 127.0.0.1:38072 127.0.0.1:41000 users:(("node",pid=11,fd=21))
ESTAB  0 0 10.0.0.2:44000 93.184.216.34:443 users:(("node",pid=12,fd=22))
ESTAB  0 0 [::1]:38073 [::1]:41001 users:(("node",pid=13,fd=22))`;
    const c = parseSs(ss);
    expect(c).toHaveLength(4);
    expect(findOfflineViolations(c, new Set([11, 12, 13]))).toEqual([expect.objectContaining({ pid: 12 })]);
  });
  it('parses lsof', () => {
    const lsof = `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
node 21 me 18u IPv4 0xabc 0t0 TCP 127.0.0.1:38072 (LISTEN)
node 21 me 19u IPv4 0xabd 0t0 TCP 127.0.0.1:38072->127.0.0.1:50000 (ESTABLISHED)
node 22 me 19u IPv4 0xabe 0t0 TCP 192.168.0.2:50001->151.101.1.69:443 (ESTABLISHED)
node 23 me 19u IPv6 0xabf 0t0 TCP [::1]:5->[::1]:6 (ESTABLISHED)`;
    const c = parseLsof(lsof);
    expect(c).toHaveLength(4);
    expect(findOfflineViolations(c, new Set([21, 22, 23]))).toEqual([expect.objectContaining({ pid: 22 })]);
  });
  it('finds descendants from ps and CIM tables', () => {
    const t = parsePsTable('  1 0 init\n 10 1 node\n 11 10 node\n 12 11 sh\n 99 1 other\n');
    expect([...descendantPids(10, t)].sort((a, b) => a - b)).toEqual([10, 11, 12]);
    const cim = parseCimProcessTable(JSON.stringify([{ ProcessId: 5, ParentProcessId: 1, Name: 'node.exe' }, { ProcessId: 6, ParentProcessId: 5, Name: 'node.exe' }]));
    expect(descendantPids(5, cim).has(6)).toBe(true);
  });
});

describe('visit checks and report', () => {
  const visit = (over: Partial<VisitSummary> = {}): VisitSummary => ({ visit: 0, paymentId: 'p', status: 'reconciled', mode: 'send', abandoned: false, leadId: null, leadAttempted: false, questions: 1, verifiedAnswers: 1, transient: 0, issues: [], ...over });
  it('passes clean visits and fails on a coded issue', () => {
    expect(visitChecks([visit(), visit({ visit: 1 })]).every((c) => c.ok)).toBe(true);
    const bad = visitChecks([visit({ issues: [{ visit: 0, code: 'answer-unverified', detail: 'x' }] })]);
    expect(bad.filter((c) => !c.ok).map((c) => c.id)).toEqual(['visitors.assistant']);
  });
  it('builds the verdict', () => {
    const ok = buildReport({ checks: [{ id: 'a', title: 'a', ok: true, detail: '' }], mode: 'launched', quick: true, params: {}, details: {}, totalDurationS: 1 });
    expect(ok.ok).toBe(true);
    expect(verdict(ok)).toContain(GATE3_PASSED);
    expect(verdict(ok)).toContain('physical rehearsal'.slice(0, 0) + 'hardware');
    const bad = buildReport({ checks: [{ id: 'a', title: 'a', ok: false, detail: '' }], mode: 'launched', quick: true, params: {}, details: {}, totalDurationS: 1 });
    expect(verdict(bad)).toContain(GATE3_FAILED);
    expect(buildReport({ checks: [], mode: 'url', quick: false, params: {}, details: {}, totalDurationS: 0 }).ok).toBe(false);
  });
});
