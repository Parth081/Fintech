// The main stage's own live feed: same WebSocket (/ws) and reducer as useLiveFeed, but it also hands
// every payment message to `onMessages` (the map needs the event briefs, which FeedState drops), and
// it surfaces the control plane (control views), demo resets and presenter focus requests.
// While the socket is down it polls /api/stats so the KPIs keep moving (no dots without events).
import { useEffect, useReducer, useRef, useState } from 'react';
import { applyMessages, initialFeed, type FeedState } from '../lib/feed';
import { backoffMs, fetchStats, parseFrame } from '../lib/api';
import type { ConnectionStatus, ServerMessage } from '../lib/types';
import { parseControlView, type StageControl } from './data';
import { RESET_IDLE, stageResetReducer, type StageResetState } from './reset';

const POLL_AFTER_FAILURES = 2;
const POLL_INTERVAL_MS = 2000;
/** Short cap so the stage comes back quickly after a ~10 s reset. */
const BACKOFF_CAP_MS = 2500;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export interface StageFeedHandlers {
  /** Payment messages (snapshot / update / stats), in order. */
  onMessages(messages: ServerMessage[]): void;
  /** A control view pushed on the socket. */
  onControl(view: StageControl): void;
  /** The demo is being reset: drop everything on screen. */
  onReset(): void;
}

export interface StageFeed {
  feed: FeedState;
  connection: ConnectionStatus;
  reset: StageResetState;
  /** Latest presenter focus request (seq changes on every request). */
  focus: { paymentId: string | null; seq: number } | null;
}

export function useStageFeed(handlers: StageFeedHandlers): StageFeed {
  const [feed, dispatch] = useReducer(applyMessages, initialFeed);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [reset, dispatchReset] = useReducer(stageResetReducer, RESET_IDLE);
  const [focus, setFocus] = useState<StageFeed['focus']>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Time out the reset notice (only ticks while one is showing).
  useEffect(() => {
    if (reset.phase === 'idle') return;
    const t = window.setInterval(() => dispatchReset({ type: 'tick', nowMs: Date.now() }), 500);
    return () => window.clearInterval(t);
  }, [reset.phase]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let pollTimer: number | null = null;
    let pollAbort: AbortController | null = null;
    let failures = 0;
    let polling = false;
    let focusSeq = 0;

    const stopPolling = () => {
      polling = false;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
      pollTimer = null;
      pollAbort?.abort();
    };
    const pollOnce = async () => {
      if (!polling || disposed) return;
      pollAbort = new AbortController();
      try {
        const stats = await fetchStats(pollAbort.signal);
        if (!polling || disposed) return;
        dispatch([{ kind: 'stats', stats }]);
        setConnection('polling');
      } catch {
        if (!polling || disposed) return;
        setConnection('offline');
      }
      if (polling && !disposed) pollTimer = window.setTimeout(() => void pollOnce(), POLL_INTERVAL_MS);
    };
    const startPolling = () => {
      if (polling) return;
      polling = true;
      void pollOnce();
    };

    const handle = (messages: ServerMessage[]) => {
      const h = handlersRef.current;
      const payments: ServerMessage[] = [];
      for (const m of messages) {
        if (m.kind === 'control') {
          const view = parseControlView(m.view);
          if (view) h.onControl(view);
        } else if (m.kind === 'reset') {
          if (!m.failed) h.onReset();
          dispatchReset({ type: 'reset', failed: !!m.failed, nowMs: Date.now() });
        } else if (m.kind === 'focus') {
          setFocus({ paymentId: m.paymentId, seq: ++focusSeq });
        } else {
          if (m.kind === 'snapshot') dispatchReset({ type: 'snapshot', nowMs: Date.now() });
          payments.push(m);
        }
      }
      if (!payments.length) return;
      // A bug in the map path must not take the socket (and the KPIs) down with it.
      try {
        h.onMessages(payments);
      } catch (err) {
        console.error('[stage] feed handler failed', err);
      }
      dispatch(payments);
    };

    const connect = () => {
      if (disposed) return;
      let opened = false;
      const ws = new WebSocket(wsUrl());
      socket = ws;
      ws.onopen = () => {
        opened = true;
        failures = 0;
        stopPolling();
        setConnection('live');
      };
      ws.onmessage = (ev: MessageEvent) => {
        const messages = parseFrame(typeof ev.data === 'string' ? ev.data : '');
        if (messages.length) handle(messages);
      };
      ws.onerror = () => {
        /* onclose follows */
      };
      ws.onclose = () => {
        if (disposed || socket !== ws) return;
        socket = null;
        failures = opened ? 1 : failures + 1;
        if (failures >= POLL_AFTER_FAILURES) startPolling();
        if (!polling) setConnection('reconnecting');
        reconnectTimer = window.setTimeout(connect, backoffMs(Math.max(0, failures - 1), 500, BACKOFF_CAP_MS));
      };
    };

    connect();
    return () => {
      disposed = true;
      stopPolling();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      const ws = socket;
      socket = null;
      ws?.close();
    };
  }, []);

  return { feed, connection, reset, focus };
}

/** True while the user prefers reduced motion (live: follows the OS setting). */
export function usePrefersReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)';
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}
