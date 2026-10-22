// Local event broker: a durable single-topic log served over WebSocket. Default event backbone for
// the offline demo. See ../README.md for the protocol.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { LogStore } from './log-store';
import { PROTOCOL_VERSION, type ClientMessage } from './protocol';

export interface BrokerOptions {
  host: string;
  port: number;
  /** Root data dir; the broker writes to `${dataDir}/broker/`. */
  dataDir: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface BrokerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

const MAX_CREDIT = 10_000;

interface BrokerSub {
  subId: number;
  conn: Conn;
  group: string;
  ephemeral: boolean;
  next: number;
  credit: number;
}

interface Conn {
  ws: WebSocket;
  clientId: string;
  subs: Map<number, BrokerSub>;
}

export async function startBroker(options: BrokerOptions): Promise<BrokerHandle> {
  const logger = options.logger ?? console;
  const store = new LogStore({ dir: path.join(options.dataDir, 'broker'), logger });
  await store.open();

  const conns = new Set<Conn>();

  const pump = (sub: BrokerSub): void => {
    const { ws } = sub.conn;
    while (sub.credit > 0 && sub.next < store.length && ws.readyState === WebSocket.OPEN) {
      const offset = sub.next;
      // The stored line is already JSON; splice it in to avoid re-serializing.
      ws.send(`{"op":"deliver","subId":${sub.subId},"offset":${offset},"event":${store.lines[offset]}}`);
      sub.next += 1;
      sub.credit -= 1;
    }
  };

  store.onAppended = () => {
    for (const c of conns) for (const s of c.subs.values()) pump(s);
  };

  const send = (ws: WebSocket, msg: object): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const handle = async (conn: Conn, msg: ClientMessage): Promise<void> => {
    switch (msg.op) {
      case 'hello':
        conn.clientId = String(msg.clientId ?? 'anonymous');
        send(conn.ws, { op: 'welcome', protocol: PROTOCOL_VERSION, length: store.length });
        return;
      case 'publish': {
        const ev = msg.event as { eventId?: unknown; paymentId?: unknown; type?: unknown } | null;
        if (!ev || typeof ev !== 'object' || typeof ev.eventId !== 'string' || typeof ev.paymentId !== 'string' || typeof ev.type !== 'string') {
          send(conn.ws, { op: 'error', reqId: msg.reqId, message: 'publish: event must be an object with string eventId, type and paymentId' });
          return;
        }
        if (msg.retry) {
          // A resend after a lost connection: if the first attempt made it, return its offset.
          const existing = store.findEventId(ev.eventId);
          if (existing !== undefined) {
            send(conn.ws, { op: 'ack', reqId: msg.reqId, offset: existing, duplicate: true });
            return;
          }
        }
        try {
          const offset = await store.append(ev);
          send(conn.ws, { op: 'ack', reqId: msg.reqId, offset });
        } catch (err) {
          send(conn.ws, { op: 'error', reqId: msg.reqId, message: `publish failed: ${(err as Error).message}` });
        }
        return;
      }
      case 'subscribe': {
        if (typeof msg.group !== 'string' || msg.group === '' || !Number.isInteger(msg.subId)) {
          send(conn.ws, { op: 'error', reqId: msg.reqId, message: 'subscribe: group and subId are required' });
          return;
        }
        const from = msg.from === 'latest' ? 'latest' : 'earliest';
        const ephemeral = msg.ephemeral === true;
        let start: number;
        if (typeof msg.position === 'number' && Number.isInteger(msg.position) && msg.position >= 0) {
          start = Math.min(msg.position, store.length);
          if (!ephemeral) store.commit(msg.group, start);
        } else if (ephemeral) {
          start = from === 'earliest' ? 0 : store.length;
        } else {
          start = store.committed.get(msg.group) ?? (from === 'earliest' ? 0 : store.length);
        }
        const sub: BrokerSub = {
          subId: msg.subId,
          conn,
          group: msg.group,
          ephemeral,
          next: start,
          credit: clampCredit(msg.credit),
        };
        conn.subs.set(sub.subId, sub);
        send(conn.ws, { op: 'subscribed', reqId: msg.reqId, subId: sub.subId, start });
        pump(sub);
        return;
      }
      case 'credit': {
        const sub = conn.subs.get(msg.subId);
        if (!sub) return;
        sub.credit = Math.min(MAX_CREDIT, sub.credit + clampCredit(msg.n));
        pump(sub);
        return;
      }
      case 'commit': {
        const sub = conn.subs.get(msg.subId);
        if (!sub || sub.ephemeral || !Number.isInteger(msg.offset)) return;
        store.commit(sub.group, msg.offset);
        return;
      }
      case 'unsubscribe':
        conn.subs.delete(msg.subId);
        send(conn.ws, { op: 'unsubscribed', reqId: msg.reqId, subId: msg.subId });
        return;
      default:
        send(conn.ws, { op: 'error', message: `unknown op "${String((msg as { op?: unknown }).op)}"` });
    }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && url.pathname === '/health') {
      json(200, { ok: true, events: store.length });
    } else if (req.method === 'GET' && url.pathname === '/events') {
      const from = Math.max(0, Number.parseInt(url.searchParams.get('from') ?? '0', 10) || 0);
      const limit = Math.min(1000, Math.max(1, Number.parseInt(url.searchParams.get('limit') ?? '100', 10) || 100));
      const out: { offset: number; event: unknown }[] = [];
      for (let o = from; o < Math.min(store.length, from + limit); o += 1) {
        out.push({ offset: o, event: JSON.parse(store.lines[o]!) });
      }
      json(200, out);
    } else {
      json(404, { error: 'not found' });
    }
  });

  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    const conn: Conn = { ws, clientId: 'anonymous', subs: new Map() };
    conns.add(conn);
    // Process messages from one connection strictly in order (a commit must land before a later unsubscribe ack).
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', (data: RawData) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        send(ws, { op: 'error', message: 'invalid JSON' });
        return;
      }
      // Publishes are handled without waiting for earlier publishes, so a connection can have many in flight
      // (the log still assigns offsets in arrival order). Everything else waits for the chain.
      if (msg.op === 'publish') {
        void handle(conn, msg);
        return;
      }
      chain = chain.then(() => handle(conn, msg)).catch((err) => logger.error(`[broker] ${String(err)}`));
    });
    ws.on('close', () => {
      conns.delete(conn);
      conn.subs.clear();
    });
    ws.on('error', () => {
      /* close follows */
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  let closing: Promise<void> | null = null;
  return {
    port,
    url: `ws://${options.host}:${port}`,
    close: () => {
      closing ??= (async () => {
        for (const c of conns) c.ws.terminate();
        conns.clear();
        await new Promise<void>((r) => wss.close(() => r()));
        server.closeAllConnections?.();
        await new Promise<void>((r) => server.close(() => r()));
        await store.close();
      })();
      return closing;
    },
  };
}

function clampCredit(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.min(MAX_CREDIT, Math.floor(n)) : 0;
}
