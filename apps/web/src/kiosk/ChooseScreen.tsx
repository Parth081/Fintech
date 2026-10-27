import type { KioskMode } from './flow';
import { amountChips, chipLabel, CORRIDOR_CARDS, previewTarget } from './payment';

interface Props {
  mode: KioskMode;
  corridorId: string;
  amountMajor: number;
  sending: boolean;
  error: string | null;
  onCorridor: (id: string) => void;
  onAmount: (amountMajor: number) => void;
  onSend: () => void;
}

export function ChooseScreen({ mode, corridorId, amountMajor, sending, error, onCorridor, onAmount, onSend }: Props) {
  const card = CORRIDOR_CARDS.find((c) => c.id === corridorId) ?? CORRIDOR_CARDS[0];
  return (
    <section className="kiosk-choose">
      <h1>{mode === 'fail' ? 'Pick a payment, then watch its provider fail' : 'Where should the money go?'}</h1>
      {mode === 'fail' && (
        <p className="kiosk-note">We'll tell the first provider to refuse this payment, exactly like a real outage. Nothing else on the booth is affected.</p>
      )}
      <div className="kiosk-corridors" role="radiogroup" aria-label="Corridor">
        {CORRIDOR_CARDS.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={c.id === corridorId}
            className={`kiosk-corridor${c.id === corridorId ? ' is-on' : ''}`}
            onClick={() => onCorridor(c.id)}
            disabled={sending}
          >
            <span className="kiosk-route">
              <b>{c.fromCode}</b>
              <svg viewBox="0 0 120 24" aria-hidden="true">
                <path d="M4 18 Q 60 -6 116 18" fill="none" strokeWidth="2.5" strokeDasharray="5 6" />
                <circle cx="116" cy="18" r="3.5" />
              </svg>
              <b>{c.toCode}</b>
            </span>
            <span className="kiosk-corridor-name">
              {c.from} → {c.to}
            </span>
            <span className="kiosk-corridor-ccy">
              {c.sourceCurrency} → {c.targetCurrency}
            </span>
            <small>{c.story}</small>
          </button>
        ))}
      </div>
      {card && (
        <>
          <h2>How much?</h2>
          <div className="kiosk-chips" role="radiogroup" aria-label="Amount">
            {amountChips(card.id).map((a) => (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={a === amountMajor}
                className={`kiosk-chip kiosk-chip-lg${a === amountMajor ? ' is-on' : ''}`}
                onClick={() => onAmount(a)}
                disabled={sending}
              >
                {chipLabel(a, card.sourceCurrency)}
              </button>
            ))}
          </div>
          <p className="kiosk-dim">
            {card.debtor.name} pays {card.creditor.name}: {chipLabel(amountMajor, card.sourceCurrency)} arrives as {previewTarget(card.id, amountMajor)} (before fees).
          </p>
        </>
      )}
      {error && (
        <p className="kiosk-error" role="alert">
          {error}
        </p>
      )}
      <div className="kiosk-actions">
        <button type="button" className="kiosk-primary kiosk-send" onClick={onSend} disabled={sending}>
          {sending ? 'Sending…' : 'Send it'}
        </button>
      </div>
    </section>
  );
}
