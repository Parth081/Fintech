// Live feed: WebSocket with auto-reconnect + backoff; while the socket is down after a few
// failed attempts, polls /api/payments and /api/stats so the screen keeps moving.
import { useEffect, useReducer, useRef, useState } from 'react';
import { applyMessages, applyPoll, initialFeed, type FeedState } from '../lib/feed';
import { backoffMs, fetchPayments, fetchStats, parseFrame } from '../lib/api';
import type { ConnectionStatus, PaymentSummary, ServerMessage, Stats } from '../lib/types';

type Action = { type: 'messages'; messages: ServerMessage[] } | { type: 'poll'; payments: PaymentSummary[]; stats: Stats };

function reducer(state: FeedState, action: Action): FeedState {
  return action.type === 'messages' ? applyMessages(state, action.messages) : applyPoll(state, action.payments, action.stats);
}

const POLL_AFTER_FAILURES = 2;
const POLL_INTERVAL_MS = 2000;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

export function useLiveFeed(): { feed: FeedState; connection: ConnectionStatus } {
  const [feed, dispatch] = useReducer(reducer, initialFeed);
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const pollTimer = useRef<number | null>(null);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let failures = 0;
    let polling = false;
    let pollAbort: AbortController | null = null;

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
        if (messages.length) dispatch({ type: 'messages', messages });
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
        const delay = backoffMs(Math.max(0, failures - 1));
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

  return { feed, connection };
}
