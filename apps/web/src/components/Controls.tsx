import { useState } from 'react';
import { sendSample } from '../lib/api';
import { SCENARIOS } from '../lib/detail';

type Kind = 'one' | 'ten' | 'hundred' | 'hold' | 'reject' | 'break';

const SINGLE: Record<'one' | 'hold' | 'reject' | 'break', { body: Record<string, unknown>; note: string }> = {
  one: { body: {}, note: 'Test payment sent' },
  hold: { body: { scenario: SCENARIOS.hold }, note: 'Held-scenario payment sent' },
  reject: { body: { scenario: SCENARIOS.providerReject }, note: 'Provider-reject payment sent (watch it retry)' },
  break: { body: { scenario: SCENARIOS.reconBreak }, note: 'Recon-break payment sent' },
};

/** Send n sample payments with bounded concurrency; returns failures. */
async function sendMany(n: number, concurrency: number, onProgress: (done: number) => void): Promise<unknown[]> {
  const errors: unknown[] = [];
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < n) {
      next += 1;
      try {
        await sendSample({});
      } catch (err) {
        errors.push(err);
      }
      done += 1;
      onProgress(done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));
  return errors;
}

export function Controls() {
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (kind: Kind) => {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      if (kind === 'ten' || kind === 'hundred') {
        const n = kind === 'ten' ? 10 : 100;
        const errors = await sendMany(n, 10, (d) => setNote(`Sending… ${d}/${n}`));
        if (errors.length) {
          const reason = errors[0];
          setNote(null);
          setError(`${errors.length} of ${n} failed: ${reason instanceof Error ? reason.message : String(reason)}`);
        } else setNote(`${n} payments sent`);
      } else {
        await sendSample(SINGLE[kind].body);
        setNote(SINGLE[kind].note);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const btn = (kind: Kind, label: string, cls = 'btn') => (
    <button type="button" className={cls} disabled={busy !== null} onClick={() => void run(kind)}>
      {busy === kind ? 'Sending…' : label}
    </button>
  );

  return (
    <section className="controls" aria-label="Controls">
      {btn('one', 'Send test payment', 'btn btn-primary')}
      {btn('ten', 'Send 10')}
      {btn('hundred', 'Send 100')}
      {btn('reject', 'Provider reject (retry demo)', 'btn btn-warn')}
      {btn('break', 'Recon break', 'btn btn-bad')}
      {btn('hold', 'Held scenario', 'btn btn-warn')}
      <span className="controls-msg" role="status" aria-live="polite">
        {error ? <span className="msg-error">⚠ {error}</span> : note ? <span className="msg-ok">{note}</span> : null}
      </span>
    </section>
  );
}
