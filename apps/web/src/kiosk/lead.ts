// Lead form logic (pure). The data lives only in React state and goes straight to the booth service.
import type { LeadInput } from '@ct/contracts/browser';

export const CONSENT_TEXT =
  "We'd like to email you about this demo. We store your details on this booth laptop only and delete them after the event. You can ask us to delete them at any time.";

export const INTEREST_OPTIONS: { id: LeadInput['interest']; label: string }[] = [
  { id: 'cross-border', label: 'Cross-border payments' },
  { id: 'orchestration', label: 'Payment orchestration' },
  { id: 'risk-compliance', label: 'Risk & compliance' },
  { id: 'ledger-recon', label: 'Ledger & reconciliation' },
  { id: 'ai', label: 'AI explanations' },
  { id: 'other', label: 'Something else' },
];

export const FIELD_MAX = { name: 100, company: 120, role: 100, email: 254 } as const;

export interface LeadForm {
  name: string;
  company: string;
  email: string;
  role: string;
  interest: LeadInput['interest'] | '';
  consent: boolean;
}

export const emptyLeadForm = (): LeadForm => ({ name: '', company: '', email: '', role: '', interest: '', consent: false });

const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[A-Za-z]{2,}$/;

export type LeadErrors = Partial<Record<keyof LeadForm, string>>;

/** Friendly checks before sending (the booth service validates again, strictly). */
export function leadFormErrors(f: LeadForm): LeadErrors {
  const e: LeadErrors = {};
  if (!f.name.trim()) e.name = 'Please add your name';
  else if (f.name.trim().length > FIELD_MAX.name) e.name = 'That name is too long';
  if (!f.company.trim()) e.company = 'Please add your company';
  else if (f.company.trim().length > FIELD_MAX.company) e.company = 'That company name is too long';
  if (!f.email.trim()) e.email = 'Please add your email';
  else if (!EMAIL.test(f.email.trim()) || f.email.trim().length > FIELD_MAX.email) e.email = 'That email address does not look right';
  if (f.role.trim().length > FIELD_MAX.role) e.role = 'That role is too long';
  if (!f.interest) e.interest = 'Pick what interests you most';
  if (!f.consent) e.consent = 'Please tick the box so we may email you';
  return e;
}

/** The booth API body. Returns null while the form has errors. Consent is the literal `true`. */
export function toLeadInput(f: LeadForm, sessionId: string | undefined): LeadInput | null {
  if (Object.keys(leadFormErrors(f)).length || !f.interest || f.consent !== true) return null;
  const lead: LeadInput = {
    name: f.name.trim(),
    company: f.company.trim(),
    email: f.email.trim(),
    interest: f.interest,
    consent: true,
    consentText: CONSENT_TEXT,
  };
  if (f.role.trim()) lead.role = f.role.trim();
  if (sessionId) lead.sessionId = sessionId;
  return lead;
}
