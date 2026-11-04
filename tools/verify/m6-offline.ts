// verify:m6 offline proof, I/O side: list the TCP connections owned by this process tree (the launcher runs
// in-process, so its services are our descendants) with the platform's own tools, and hand them to the pure
// parsers/filters in m6-analyze.ts. Windows: netstat -ano (fallback Get-NetTCPConnection) + CIM process
// table. Linux: ss -tanp (fallback lsof) + ps. macOS: lsof + ps.
import { execFile } from 'node:child_process';
import {
  descendantPids,
  findOfflineViolations,
  parseCimProcessTable,
  parseGetNetTcpConnection,
  parseLsof,
  parseNetstatWindows,
  parsePsTable,
  type ProcRow,
  parseSs,
  type OfflineFinding,
  type TcpConn,
} from './m6-analyze';

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(String(stdout));
    });
  });
}

export async function processTable(): Promise<ProcRow[]> {
  if (process.platform === 'win32') {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress']);
    return parseCimProcessTable(out);
  }
  return parsePsTable(await run('ps', ['-eo', 'pid=,ppid=,comm=']));
}

export async function listTcp(): Promise<{ conns: TcpConn[]; tool: string }> {
  if (process.platform === 'win32') {
    try {
      const conns = parseNetstatWindows(await run('netstat.exe', ['-ano', '-p', 'TCP'])).concat(parseNetstatWindows(await run('netstat.exe', ['-ano', '-p', 'TCPv6']).catch(() => '')));
      if (conns.length) return { conns, tool: 'netstat -ano' };
    } catch {
      /* fall through */
    }
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetTCPConnection | Select-Object OwningProcess,LocalAddress,LocalPort,RemoteAddress,RemotePort,State | ConvertTo-Json -Compress']);
    return { conns: parseGetNetTcpConnection(out), tool: 'Get-NetTCPConnection' };
  }
  if (process.platform === 'linux') {
    try {
      const conns = parseSs(await run('ss', ['-tanp']));
      if (conns.length) return { conns, tool: 'ss -tanp' };
    } catch {
      /* fall through */
    }
  }
  return { conns: parseLsof(await run('lsof', ['-nP', '-iTCP'])), tool: 'lsof -nP -iTCP' };
}

export interface OfflineSnapshot {
  at: string;
  tool: string;
  pids: number;
  connections: number;
  loopbackConnections: number;
  violations: OfflineFinding[];
}

/** One snapshot: every TCP socket of this process and its descendants, and which of them leave the machine. */
export async function offlineSnapshot(rootPid: number = process.pid): Promise<OfflineSnapshot> {
  const [table, tcp] = await Promise.all([processTable(), listTcp()]);
  const pids = descendantPids(rootPid, table);
  const mine = tcp.conns.filter((c) => pids.has(c.pid));
  const violations = findOfflineViolations(tcp.conns, pids);
  return {
    at: new Date().toISOString(),
    tool: tcp.tool,
    pids: pids.size,
    connections: mine.length,
    loopbackConnections: mine.filter((c) => c.state !== 'LISTEN' && c.state !== 'LISTENING').length - violations.filter((v) => v.kind === 'remote-connection').length,
    violations,
  };
}

/** node processes of this tree right now (name known), for the orphan check. */
export async function nodeDescendants(rootPid: number = process.pid): Promise<number[]> {
  const table = await processTable();
  const mine = descendantPids(rootPid, table);
  return table.filter((r) => mine.has(r.pid) && r.pid !== rootPid && /^node(\.exe)?$/i.test(r.name ?? '')).map((r) => r.pid);
}

/** Which of these pids are still alive node processes? */
export async function stillAlive(pids: readonly number[]): Promise<number[]> {
  const table = await processTable();
  return pids.filter((p) => table.some((r) => r.pid === p && /^node(\.exe)?$/i.test(r.name ?? '')));
}

/** Name and command line of a pid (Windows CIM / ps), to make a violation actionable. Best effort. */
export async function explainPid(pid: number): Promise<string> {
  try {
    if (process.platform === 'win32') {
      return (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p){ "$($p.Name) ppid=$($p.ParentProcessId) cmd=$($p.CommandLine)" } else { 'gone' }`])).trim().slice(0, 300);
    }
    return (await run('ps', ['-o', 'pid=,ppid=,args=', '-p', String(pid)])).trim().slice(0, 300) || 'gone';
  } catch {
    return 'unknown';
  }
}
