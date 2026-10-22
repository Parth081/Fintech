// Durable append-only JSONL log + committed consumer-group offsets for the local broker.
import { promises as fsp } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

export interface LogStoreOptions {
  dir: string;
  logger?: Pick<Console, 'warn' | 'error'>;
}

interface PendingAppend {
  line: string; // serialized event, no trailing newline
  resolve: (offset: number) => void;
  reject: (err: Error) => void;
}

/**
 * Append-only event log. Line N of `payments.log` is the event at offset N.
 * Appends are group-committed: everything queued while a write is in flight goes out in the next
 * write + datasync, and only then are offsets acknowledged. Offsets are strictly sequential.
 */
export class LogStore {
  /** Serialized events (JSON strings), index = offset. Only durable entries are here. */
  readonly lines: string[] = [];
  private readonly eventIdToOffset = new Map<string, number>();
  private readonly logPath: string;
  private readonly offsetsPath: string;
  private fh: FileHandle | null = null;
  private queue: PendingAppend[] = [];
  private writing: Promise<void> | null = null;
  private closed = false;
  private readonly logger: Pick<Console, 'warn' | 'error'>;

  readonly committed = new Map<string, number>();
  private offsetsDirty = false;
  private offsetsWriting: Promise<void> | null = null;

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
    await fsp.mkdir(this.opts.dir, { recursive: true });
    await this.loadLog();
    await this.loadOffsets();
    this.fh = await fsp.open(this.logPath, 'a');
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
      const end = nl === -1 ? buf.length : nl;
      const text = buf.subarray(pos, end).toString('utf8').trim();
      lineNo += 1;
      const isLast = nl === -1 || nl === buf.length - 1;
      if (text.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          if (isLast) {
            this.logger.warn(`[broker] dropping truncated/corrupt final log line ${lineNo} (${end - pos} bytes)`);
            break;
          }
          throw new Error(`[broker] corrupt log line ${lineNo} in ${this.logPath} (not the final line); refusing to start`);
        }
        this.addLine(JSON.stringify(parsed), parsed);
      }
      if (nl === -1) {
        // Complete JSON without its trailing newline: keep it, repair the newline below.
        validLength = buf.length;
        needsNewline = text.length > 0;
        break;
      }
      validLength = nl + 1;
      pos = nl + 1;
    }
    if (validLength < buf.length) await fsp.truncate(this.logPath, validLength);
    if (needsNewline) await fsp.appendFile(this.logPath, '\n');
  }

  private addLine(line: string, parsed: unknown): void {
    const offset = this.lines.push(line) - 1;
    const id = (parsed as { eventId?: unknown } | null)?.eventId;
    if (typeof id === 'string' && !this.eventIdToOffset.has(id)) this.eventIdToOffset.set(id, offset);
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

  /** Offset of an already-appended event with this id, if any. */
  findEventId(eventId: string): number | undefined {
    return this.eventIdToOffset.get(eventId);
  }

  append(event: unknown): Promise<number> {
    if (this.closed) return Promise.reject(new Error('broker log closed'));
    const line = JSON.stringify(event);
    return new Promise<number>((resolve, reject) => {
      this.queue.push({ line, resolve, reject });
      this.kick();
    });
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
    try {
      const data = batch.map((p) => p.line + '\n').join('');
      await fh.write(data);
      await fh.datasync();
    } catch (err) {
      // We cannot know how much reached disk; fail the batch loudly. The broker should be restarted.
      this.logger.error(`[broker] log append failed: ${String(err)}`);
      for (const p of batch) p.reject(err as Error);
      return;
    }
    const first = this.lines.length;
    for (const p of batch) {
      this.addLine(p.line, JSON.parse(p.line));
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
