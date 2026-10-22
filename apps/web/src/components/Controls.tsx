import { useState } from 'react';
import { sendSample } from '../lib/api';

type Kind = 'one' | 'ten' | 'hold';

export function Controls() {
  const [busy, setBusy] = useState<Kind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (kind: Kind) => {
    setBusy(kind);
    setError(null);
    setNote(null);
    try {
      if (kind === 'ten') {
        const results = await Promise.allSettled(Array.from({ length: 10 }, () => sendSample({})));
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed.length) {
          const reason = failed[0]!.reason;
          setError(`${failed.length} of 10 failed: ${reason instanceof Error ? reason.message : String(reason)}`);
        } else setNote('10 payments sent');
      } else {
        await sendSample(kind === 'hold' ? { scenario: 'force-hold' } : {});
        setNote(kind === 'hold' ? 'Held-scenario payment sent' : 'Test payment sent');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="controls" aria-label="Controls">
      <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void run('one')}>
        {busy === 'one' ? 'Sending…' : 'Send test payment'}
      </button>
      <button type="button" className="btn" disabled={busy !== null} onClick={() => void run('ten')}>
        {busy === 'ten' ? 'Sending…' : 'Send 10 payments'}
      </button>
      <button type="button" className="btn btn-warn" disabled={busy !== null} onClick={() => void run('hold')}>
        {busy === 'hold' ? 'Sending…' : 'Send held-scenario payment'}
      </button>
      <span className="controls-msg" role="status" aria-live="polite">
        {error ? <span className="msg-error">⚠ {error}</span> : note ? <span className="msg-ok">{note}</span> : null}
      </span>
    </section>
  );
}
