// Optional follow-up form, shown only after the value moment. Explicit consent checkbox (unticked by default).
// Values live in this component's state only (no browser storage, no autofill) and vanish on reset.
import { useState, type FormEvent } from 'react';
import { KioskApiError, submitLead } from './api';
import { CONSENT_TEXT, emptyLeadForm, FIELD_MAX, INTEREST_OPTIONS, leadFormErrors, toLeadInput, type LeadErrors, type LeadForm } from './lead';

interface Props {
  sessionId: string | undefined;
  onSubmitted: () => void;
  onSkip: () => void;
}

export function LeadScreen({ sessionId, onSubmitted, onSkip }: Props) {
  const [form, setForm] = useState<LeadForm>(emptyLeadForm);
  const [errors, setErrors] = useState<LeadErrors>({});
  const [sending, setSending] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const set = <K extends keyof LeadForm>(key: K, value: LeadForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (sending) return;
    const errs = leadFormErrors(form);
    setErrors(errs);
    const input = toLeadInput(form, sessionId);
    if (!input) return;
    setSending(true);
    setServerError(null);
    try {
      await submitLead(input);
      setForm(emptyLeadForm()); // drop the personal data from memory as soon as it is stored
      onSubmitted();
    } catch (err) {
      setServerError(
        err instanceof KioskApiError && err.status === 400 && err.details.length
          ? `Please check: ${err.details.join('; ')}`
          : 'We could not save that just now. Please try again, or ask someone on the team.',
      );
    } finally {
      setSending(false);
    }
  };

  const field = (key: 'name' | 'company' | 'email' | 'role', label: string, opts: { type?: string; optional?: boolean; inputMode?: 'email' | 'text' } = {}) => (
    <label className={`kiosk-field${errors[key] ? ' has-error' : ''}`}>
      <span>
        {label}
        {opts.optional && <em> (optional)</em>}
      </span>
      <input
        type={opts.type ?? 'text'}
        inputMode={opts.inputMode}
        value={form[key]}
        maxLength={FIELD_MAX[key]}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize={key === 'email' ? 'none' : 'words'}
        spellCheck={false}
        name={`kiosk-${key}-${sessionId ?? 'x'}`}
        onChange={(e) => set(key, e.target.value)}
      />
      {errors[key] && <small className="kiosk-error">{errors[key]}</small>}
    </label>
  );

  return (
    <section className="kiosk-lead">
      <h1>Want this demo in your inbox?</h1>
      <p className="kiosk-lede">Leave your details and we'll send a short follow-up. Entirely optional.</p>
      <form onSubmit={(e) => void submit(e)} autoComplete="off" noValidate>
        <div className="kiosk-form-grid">
          {field('name', 'Name')}
          {field('company', 'Company')}
          {field('email', 'Work email', { type: 'email', inputMode: 'email' })}
          {field('role', 'Role', { optional: true })}
        </div>
        <fieldset className={`kiosk-interest${errors.interest ? ' has-error' : ''}`}>
          <legend>What interests you most?</legend>
          <div className="kiosk-chips">
            {INTEREST_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={form.interest === o.id}
                className={`kiosk-chip${form.interest === o.id ? ' is-on' : ''}`}
                onClick={() => set('interest', o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {errors.interest && <small className="kiosk-error">{errors.interest}</small>}
        </fieldset>
        <label className={`kiosk-consent${errors.consent ? ' has-error' : ''}`}>
          <input type="checkbox" checked={form.consent} onChange={(e) => set('consent', e.target.checked)} />
          <span className="kiosk-box" aria-hidden="true">
            {form.consent ? '✓' : ''}
          </span>
          <span>{CONSENT_TEXT}</span>
        </label>
        {errors.consent && <small className="kiosk-error">{errors.consent}</small>}
        {serverError && (
          <p className="kiosk-error" role="alert">
            {serverError}
          </p>
        )}
        <div className="kiosk-actions">
          <button type="button" className="kiosk-ghost" onClick={onSkip}>
            Skip
          </button>
          <button type="submit" className="kiosk-primary" disabled={sending}>
            {sending ? 'Saving…' : 'Send me the follow-up'}
          </button>
        </div>
      </form>
    </section>
  );
}
