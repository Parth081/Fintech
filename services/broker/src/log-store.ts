// Durable append-only JSONL log + committed consumer-group offsets for the local broker.
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export interface LogStoreOptions {
  dir: string;
  logger?: Pick<Console, 'warn' | 'error'>;
}

export interface AppendResult {
  offset: number;
  /** True when an event with this eventId was already in the log (or being appended): nothing new was written. */
  duplicate: boolean;
}

interface PendingAppend {
  eventId: string;
  line: Buffer; // serialized event (UTF-8), no trailing newline
  resolve: (offset: number) => void;
  reject: (err: Error) => void;
}

const NEWLINE = Buffer.from('\n');

/**
 * Append-only event log. Line N of `payments.log` is the event at offset N.
 *
 * - Appends are group-committed: everything queued while a write is in flight goes out in the next
 *   write + datasync, and only then are offsets acknowledged. Offsets are strictly sequential.
 * - Appends are idempotent by eventId: an eventId that is already durable returns its offset, and one
 *   that is queued or being written (a concurrent duplicate) shares the first append's result.
 * - Lines are kept in memory as Buffers (slices of the file read at start + of each appended batch),
 *   so delivering them never re-serializes or re-encodes an event.
 */
export class LogStore {
  /** Serialized events (UTF-8 JSON), index = offset. Only durable entries are here. */
  readonly lines: Buffer[] = [];
  private readonly eventIdToOffset = new Map<string, number>();
  private readonly pendingIds = new Map<string, Promise<number>>();
  private readonly logPath: string;
  private readonly offsetsPath: string;
  private fh: FileHandle | null = null;
  private queue: PendingAppend[] = [];
  private writing: Promise<void> | null = null;
  private closed = false;
  /** Set when the file and the in-memory log may disagree; every later append is refused (restart the broker). */
  private broken: Error | null = null;
  private fileSize = 0;
  private readonly logger: Pick<Console, 'warn' | 'error'>;

  readonly committed = new Map<string, number>();
  private offsetsDirty = false;
  private offsetsWriting: Promise<void> | null = null;

  /** Statistics for /stats and the benchmark. */
  readonly stats = { loadMs: 0, bytes: 0, appendBatches: 0, duplicatesSuppressed: 0 };

  /** Called (synchronously) after new entries became durable. */
  onAppended: (firstOffset: number, count: number) => void = () => {};

  constructor(private readonly opts: LogStoreOptions) {
    this.logPath = path.join(opts.dir, 'payments.log');
    this.offsetsPath = path.join(opts.dir, 'offsets.json');
    this.logger = opts.logger ?? console;
  }

  get length(): number {
    return this.lines.length;
  }

  async open(): Promise<void> {
    const t0 = performance.now();
    await fsp.mkdir(this.opts.dir, { recursive: true });
    await this.loadLog();
    await this.loadOffsets();
    this.fh = await fsp.open(this.logPath, 'a');
    this.stats.loadMs = Math.round(performance.now() - t0);
  }

  private async loadLog(): Promise<void> {
    let buf: Buffer;
    try {
      buf = await fsp.readFile(this.logPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    let pos = 0;
    let validLength = 0;
    let lineNo = 0;
    let needsNewline = false;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      let end = nl === -1 ? buf.length : nl;
      lineNo += 1;
      const isLast = nl === -1 || nl === buf.length - 1;
      // Trim surrounding whitespace (\r from an editor, stray spaces) without copying.
      let start = pos;
      while (start < end && isSpace(buf[start]!)) start += 1;
      while (end > start && isSpace(buf[end - 1]!)) end -= 1;
      if (end > start) {
        const slice = buf.subarray(start, end);
        let parsed: unknown;
        try {
          parsed = JSON.parse(slice.toString('utf8'));
        } catch {
          if (isLast) {
            this.logger.warn(`[broker] dropping truncated/corrupt final log line ${lineNo} (${end - pos} bytes)`);
            break;
          }
          throw new Error(`[broker] corrupt log line ${lineNo} in ${this.logPath} (not the final line); refusing to start`);
        }
        const id = (parsed as { eventId?: unknown } | null)?.eventId;
        // The stored line is kept byte for byte (it is valid JSON); no re-serialization.
        this.addLine(slice, typeof id === 'string' ? id : undefined);
      }
      if (nl === -1) {
        // Complete JSON without its trailing newline: keep it, repair the newline below.
        validLength = buf.length;
        needsNewline = end > start;
        break;
      }
      validLength = nl + 1;
      pos = nl + 1;
    }
    if (validLength < buf.length) await fsp.truncate(this.logPath, validLength);
    if (needsNewline) await fsp.appendFile(this.logPath, '\n');
    this.fileSize = validLength + (needsNewline ? 1 : 0);
  }

  private addLine(line: Buffer, eventId: string | undefined): void {
    const offset = this.lines.push(line) - 1;
    this.stats.bytes += line.length;
    if (eventId !== undefined && !this.eventIdToOffset.has(eventId)) this.eventIdToOffset.set(eventId, offset);
  }

  private async loadOffsets(): Promise<void> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.offsetsPath, 'utf8')) as { groups?: Record<string, unknown> };
      for (const [group, value] of Object.entries(raw.groups ?? {})) {
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
          this.committed.set(group, Math.min(value, this.lines.length));
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.logger.warn(`[broker] could not read ${this.offsetsPath}, starting with no committed offsets: ${String(err)}`);
      }
    }
  }

  /** Offset of an already-appended (durable) event with this id, if any. */
  findEventId(eventId: string): number | undefined {
    return this.eventIdToOffset.get(eventId);
  }

  /**
   * Append one serialized event (`line` must be its JSON, `eventId` its id). Idempotent by eventId:
   * a duplicate (durable or still in flight) resolves to the original offset with `duplicate: true`.
   */
  append(eventId: string, line: string | Buffer): Promise<AppendResult> {
    const existing = this.eventIdToOffset.get(eventId);
    if (existing !== undefined) {
      this.stats.duplicatesSuppressed += 1;
      return Promise.resolve({ offset: existing, duplicate: true });
    }
    const inFlight = this.pendingIds.get(eventId);
    if (inFlight) {
      this.stats.duplicatesSuppressed += 1;
      return inFlight.then((offset) => ({ offset, duplicate: true }));
    }
    if (this.closed) return Promise.reject(new Error('broker log closed'));
    if (this.broken) return Promise.reject(new Error(`broker log unavailable after a failed write: ${this.broken.message}`));
    const buf = typeof line === 'string' ? Buffer.from(line, 'utf8') : line;
    const promise = new Promise<number>((resolve, reject) => {
      this.queue.push({ eventId, line: buf, resolve, reject });
      this.kick();
    });
    this.pendingIds.set(eventId, promise);
    const clear = () => {
      if (this.pendingIds.get(eventId) === promise) this.pendingIds.delete(eventId);
    };
    promise.then(clear, clear);
    return promise.then((offset) => ({ offset, duplicate: false }));
  }

  private kick(): void {
    if (this.writing || this.queue.length === 0) return;
    this.writing = this.writeBatch().finally(() => {
      this.writing = null;
      this.kick();
    });
  }

  private async writeBatch(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    const fh = this.fh;
    if (!fh) {
      for (const p of batch) p.reject(new Error('broker log not open'));
      return;
    }
    // One contiguous buffer per batch; each line becomes a slice of it (no per-line copies kept).
    const parts: Buffer[] = [];
    for (const p of batch) parts.push(p.line, NEWLINE);
    const data = Buffer.concat(parts);
    try {
      await fh.write(data);
      await fh.datasync();
    } catch (err) {
      this.logger.error(`[broker] log append failed: ${String(err)}`);
      // Part of the batch may have reached the file. Cut it back so file line N stays offset N;
      // if even that fails, refuse all further appends (the broker must be restarted).
      try {
        await fh.truncate(this.fileSize);
        await fh.datasync();
      } catch (truncErr) {
        this.broken = truncErr as Error;
        this.logger.error(`[broker] could not roll back the failed append; refusing further appends: ${String(truncErr)}`);
      }
      for (const p of batch) p.reject(err as Error);
      return;
    }
    this.fileSize += data.length;
    this.stats.appendBatches += 1;
    const first = this.lines.length;
    let pos = 0;
    for (const p of batch) {
      this.addLine(data.subarray(pos, pos + p.line.length), p.eventId);
      pos += p.line.length + 1;
    }
    batch.forEach((p, i) => p.resolve(first + i));
    this.onAppended(first, batch.length);
  }

  commit(group: string, nextOffset: number): void {
    const n = Math.max(0, Math.min(nextOffset, this.lines.length));
    if (this.committed.get(group) === n) return;
    this.committed.set(group, n);
    this.offsetsDirty = true;
    this.flushOffsetsSoon();
  }

  private flushOffsetsSoon(): void {
    if (this.offsetsWriting) return;
    this.offsetsWriting = (async () => {
      while (this.offsetsDirty) {
        this.offsetsDirty = false;
        try {
          await this.writeOffsetsFile();
        } catch (err) {
          this.logger.error(`[broker] failed to persist offsets: ${String(err)}`);
          break;
        }
      }
    })().finally(() => {
      this.offsetsWriting = null;
    });
  }

  private async writeOffsetsFile(): Promise<void> {
    const body = JSON.stringify({ groups: Object.fromEntries(this.committed) }, null, 2) + '\n';
    const tmp = `${this.offsetsPath}.${process.pid}.tmp`;
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(body);
      await fh.datasync();
    } finally {
      await fh.close();
    }
    // Windows can briefly refuse a rename onto a file another process (AV, indexer) holds open.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(tmp, this.offsetsPath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 10 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    while (this.writing) await this.writing;
    for (const p of this.queue) p.reject(new Error('broker log closed'));
    this.queue = [];
    while (this.offsetsWriting) await this.offsetsWriting;
    if (this.offsetsDirty) {
      this.offsetsDirty = false;
      await this.writeOffsetsFile().catch((err) => this.logger.error(`[broker] failed to persist offsets: ${String(err)}`));
    }
    await this.fh?.close();
    this.fh = null;
  }
}

function isSpace(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a;
}

