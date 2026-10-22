// Resident memory of another process, best effort (Windows: tasklist working set; elsewhere: ps).
import { execFile } from 'node:child_process';

export function processRssBytes(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (err, out) => {
        if (err) return resolve(null);
        const m = /"([\d.,\s]+) K"/.exec(out);
        resolve(m ? Number(m[1]!.replace(/[^\d]/g, '')) * 1024 : null);
      });
    } else {
      execFile('ps', ['-o', 'rss=', '-p', String(pid)], (err, out) => {
        if (err) return resolve(null);
        const kb = Number(out.trim());
        resolve(Number.isFinite(kb) && kb > 0 ? kb * 1024 : null);
      });
    }
  });
}
