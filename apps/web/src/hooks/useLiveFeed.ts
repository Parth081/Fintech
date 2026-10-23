// Live feed: WebSocket with auto-reconnect + backoff; while the socket is down after a few
// failed attempts, polls /api/payments, /api/stats and /api/control/state so the screen keeps moving.
// M3: also carries the control plane (ControlView pushes), reset notices and presenter focus requests.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { applyMessages, applyPoll, initialFeed, type FeedState } from '../lib/feed';
import { backoffMs, fetchControl, fetchPayments, fetchStats, parseFrame } from '../lib/api';
import type { ConnectionStatus, GatewayControlView, PaymentSummary, ServerMessage, Stats } from '../lib/types';

type Action = { type: 'messages'; messages: ServerMessage[] } | { type: 'poll'; payments: PaymentSummary[]; stats: Stats };

function reducer(state: FeedState, action: Action): FeedState {
  return action.type === 'messages' ? applyMessages(state, action.messages) : applyPoll(state, action.payments, action.stats);
}

const POLL_AFTER_FAILURES = 2;
const POLL_INTERVAL_MS = 2000;
/** Short cap so screens come back quickly after a 10-second reset. */
const BACKOFF_CAP_MS = 2500;
/** Drop a "Resetting…" notice if the gateway never went away (e.g. the reset failed). */
const RESET_NOTICE_MAX_MS = 45_000;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export interface ControlSnapshot {
  view: GatewayControlView;
  /** Local time the view arrived (for extrapolating scenario progress). */
  receivedAt: number;
}

export interface LiveFeed {
  feed: FeedState;
  connection: ConnectionStatus;
  control: ControlSnapshot | null;
  /** Set while a reset announced by the gateway is in progress (audience overlay). */
  resetNotice: { startedAt: string } | null;
  /** Latest presenter focus request (seq changes on every request). */
  focus: { paymentId: string | null; seq: number } | null;
  /** Re-fetch the control view now (after a presenter command). */
  refreshControl(fresh?: boolean): void;
  /** Merge a fresh orchestrator state (from a command response). */
  patchOrchestrator(o: GatewayControlView['orchestrator']): void;
}

export function useLiveFeed(): LiveFeed {
  const [feed, dispatch] = useReducer(reducer, initialFeed);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [control, setControl] = useState<ControlSnapshot | null>(null);
  const [resetNotice, setResetNotice] = useState<{ startedAt: string } | null>(null);
  const [focus, setFocus] = useState<{ paymentId: string | null; seq: number } | null>(null);
  const pollTimer = useRef<number | null>(null);

  const refreshControl = useCallback((fresh = true) => {
    fetchControl(fresh).then(
      (view) => setControl({ view, receivedAt: Date.now() }),
      () => undefined,
    );
  }, []);

  const patchOrchestrator = useCallback((o: GatewayControlView['orchestrator']) => {
    setControl((c) => (c && o ? { view: { ...c.view, orchestrator: o, orchestratorError: undefined }, receivedAt: Date.now() } : c));
  }, []);

  useEffect(() => {
    if (!resetNotice) return;
    const t = window.setTimeout(() => setResetNotice(null), RESET_NOTICE_MAX_MS);
    return () => window.clearTimeout(t);
  }, [resetNotice]);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let failures = 0;
    let polling = false;
    let pollAbort: AbortController | null = null;
    let focusSeq = 0;

    const stopPolling = () => {
      polling = false;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
      pollAbort?.abort();
    };

    const pollOnce = async () => {
      if (!polling || disposed) return;
      pollAbort = new AbortController();
      try {
        const [payments, stats] = await Promise.all([fetchPayments(100, pollAbort.signal), fetchStats(pollAbort.signal)]);
        if (!polling || disposed) return;
        dispatch({ type: 'poll', payments, stats });
        setConnection('polling');
        const view = await fetchControl(false, pollAbort.signal).catch(() => null);
        if (view && polling && !disposed) setControl({ view, receivedAt: Date.now() });
      } catch {
        if (!polling || disposed) return;
        setConnection('offline');
      }
      if (polling && !disposed) pollTimer.current = window.setTimeout(() => void pollOnce(), POLL_INTERVAL_MS);
    };

    const startPolling = () => {
      if (polling) return;
      polling = true;
      void pollOnce();
    };

    const handle = (messages: ServerMessage[]) => {
      const feedMessages: ServerMessage[] = [];
      for (const m of messages) {
        if (m.kind === 'control') setControl({ view: m.view, receivedAt: Date.now() });
        else if (m.kind === 'reset') setResetNotice(m.failed ? null : { startedAt: m.startedAt });
        else if (m.kind === 'focus') setFocus({ paymentId: m.paymentId, seq: ++focusSeq });
        else {
          if (m.kind === 'snapshot') setResetNotice(null);
          feedMessages.push(m);
        }
      }
      if (feedMessages.length) dispatch({ type: 'messages', messages: feedMessages });
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
        if (!opened) failures += 1;
        else failures = 1;
        if (failures >= POLL_AFTER_FAILURES) startPolling();
        if (!polling) setConnection('reconnecting');
        const delay = backoffMs(Math.max(0, failures - 1), 500, BACKOFF_CAP_MS);
        reconnectTimer = window.setTimeout(connect, delay);
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

  return { feed, connection, control, resetNotice, focus, refreshControl, patchOrchestrator };
}
