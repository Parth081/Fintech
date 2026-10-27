// Input validation for the booth API. Visitor-facing input is untrusted: strip control characters,
// enforce lengths, require explicit consent, and keep personal data out of analytics.
import type { AnalyticsEvent, LeadInput } from '@ct/contracts';

export const LEAD_INTERESTS: readonly LeadInput['interest'][] = ['cross-border', 'orchestration', 'risk-compliance', 'ledger-recon', 'ai', 'other'];

export const ANALYTICS_TYPES: readonly AnalyticsEvent['type'][] = [
  'visit.start',
  'visit.end',
  'scenario.viewed',
  'question.asked',
  'payment.sent',
  'cta.shown',
  'lead.submitted',
];

export const LIMITS = {
  name: 100,
  company: 120,
  role: 100,
  email: 254,
  consentTextMin: 20,
  consentText: 600,
  eventsPerBatch: 50,
  dataKeys: 8,
  dataString: 300,
  dataBytes: 1024,
} as const;

export const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
// local@domain.tld, no spaces, one @, a dot in the domain, TLD of 2+ letters.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;
// C0/C1 control characters plus bidi overrides/isolates and zero-width characters (used to disguise text).
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** Remove control characters, collapse whitespace runs to one space and trim. */
export function cleanText(value: string): string {
  return value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

export function isEmail(value: string): boolean {
  return value.length <= LIMITS.email && EMAIL.test(value) && !value.includes('..');
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function text(body: Record<string, unknown>, key: string, max: number, required: boolean, errors: string[]): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null || raw === '') {
    if (required) errors.push(`${key} is required`);
    return undefined;
  }
  if (typeof raw !== 'string') {
    errors.push(`${key} must be a string`);
    return undefined;
  }
  const v = cleanText(raw);
  if (!v) {
    if (required) errors.push(`${key} is required`);
    return undefined;
  }
  if (v.length > max) {
    errors.push(`${key} must be at most ${max} characters`);
    return undefined;
  }
  return v;
}

/** Validate a lead. Unknown fields are ignored (never stored). */
export function validateLead(body: unknown): Result<LeadInput> {
  if (!isObject(body)) return { ok: false, errors: ['body must be a JSON object'] };
  const errors: string[] = [];
  const name = text(body, 'name', LIMITS.name, true, errors);
  const company = text(body, 'company', LIMITS.company, true, errors);
  const role = text(body, 'role', LIMITS.role, false, errors);
  const emailRaw = text(body, 'email', LIMITS.email, true, errors);
  // Already trimmed by cleanText; a space inside the address is a typo and is rejected, not silently joined.
  const email = emailRaw;
  if (email !== undefined && !isEmail(email)) errors.push('email is not a valid address');
  const interest = body.interest;
  if (typeof interest !== 'string' || !(LEAD_INTERESTS as readonly string[]).includes(interest)) {
    errors.push(`interest must be one of ${LEAD_INTERESTS.join(', ')}`);
  }
  // Consent must be the literal boolean true: not "true", not 1, not "yes".
  if (body.consent !== true) errors.push('consent is required (explicit opt-in)');
  const consentText = text(body, 'consentText', LIMITS.consentText, true, errors);
  if (consentText !== undefined && consentText.length < LIMITS.consentTextMin) errors.push('consentText must be the consent sentence shown to the visitor');
  let sessionId: string | undefined;
  if (body.sessionId !== undefined && body.sessionId !== null) {
    if (typeof body.sessionId !== 'string' || !SESSION_ID.test(body.sessionId)) errors.push('sessionId must be 8-64 characters [A-Za-z0-9_-]');
    else sessionId = body.sessionId;
  }
  if (errors.length || !name || !company || !email || !consentText) return { ok: false, errors: errors.length ? errors : ['invalid lead'] };
  const lead: LeadInput = { name, company, email, interest: interest as LeadInput['interest'], consent: true, consentText };
  if (role) lead.role = role;
  if (sessionId) lead.sessionId = sessionId;
  return { ok: true, value: lead };
}

// Keys that would carry personal data. Compared after lowercasing and dropping _ - and spaces.
const PERSONAL_KEYS = new Set([
  'name', 'fullname', 'firstname', 'lastname', 'surname', 'givenname', 'email', 'mail', 'emailaddress', 'phone', 'mobile',
  'tel', 'telephone', 'company', 'employer', 'organisation', 'organization', 'address', 'street', 'postcode', 'zip',
  'linkedin', 'twitter', 'handle', 'username', 'user', 'contact', 'ip', 'ipaddress', 'birthday', 'dob', 'jobtitle', 'title',
  'role', 'consenttext',
]);
const EMAIL_ANYWHERE = /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/;
const PHONE_ANYWHERE = /(?:\+|00)\s?\d[\d\s().-]{6,}\d/;
const DATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const MAX_CLOCK_SKEW_MS = 7 * 24 * 3600_000;

/** Validate one anonymous analytics event. Anything that looks like personal data is refused. */
export function validateEvent(raw: unknown, nowMs: number = Date.now()): Result<AnalyticsEvent> {
  if (!isObject(raw)) return { ok: false, errors: ['event must be an object'] };
  const errors: string[] = [];
  const { sessionId, type, at, data } = raw;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) errors.push('sessionId must be 8-64 characters [A-Za-z0-9_-]');
  if (typeof type !== 'string' || !(ANALYTICS_TYPES as readonly string[]).includes(type)) errors.push(`type must be one of ${ANALYTICS_TYPES.join(', ')}`);
  const atMs = typeof at === 'string' && at.length <= 40 ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(atMs)) errors.push('at must be an ISO timestamp');
  else if (Math.abs(atMs - nowMs) > MAX_CLOCK_SKEW_MS) errors.push('at is too far from the booth clock');
  let clean: Record<string, string | number | boolean> | undefined;
  for (const k of Object.keys(raw)) {
    if (!['sessionId', 'type', 'at', 'data'].includes(k)) errors.push(`unknown field ${k}`);
  }
  if (data !== undefined && data !== null) {
    if (!isObject(data)) errors.push('data must be an object');
    else {
      const keys = Object.keys(data);
      if (keys.length > LIMITS.dataKeys) errors.push(`data may have at most ${LIMITS.dataKeys} keys`);
      clean = {};
      for (const key of keys) {
        const value = data[key];
        if (!DATA_KEY.test(key)) {
          errors.push(`data key ${JSON.stringify(key.slice(0, 40))} is not allowed`);
          continue;
        }
        if (PERSONAL_KEYS.has(key.toLowerCase().replace(/[_\-\s]/g, ''))) {
          errors.push(`data.${key} looks like personal data (not allowed in analytics)`);
          continue;
        }
        if (typeof value === 'string') {
          const v = cleanText(value);
          if (v.length > LIMITS.dataString) errors.push(`data.${key} is too long`);
          else if (EMAIL_ANYWHERE.test(v) || PHONE_ANYWHERE.test(v)) errors.push(`data.${key} looks like personal data (not allowed in analytics)`);
          else clean[key] = v;
        } else if (typeof value === 'number') {
          if (!Number.isFinite(value)) errors.push(`data.${key} must be a finite number`);
          else clean[key] = value;
        } else if (typeof value === 'boolean') {
          clean[key] = value;
        } else {
          errors.push(`data.${key} must be a string, number or boolean`);
        }
      }
      if (JSON.stringify(clean).length > LIMITS.dataBytes) errors.push(`data must be at most ${LIMITS.dataBytes} bytes`);
    }
  }
  if (errors.length) return { ok: false, errors };
  const event: AnalyticsEvent = { sessionId: sessionId as string, type: type as AnalyticsEvent['type'], at: new Date(atMs).toISOString() };
  if (clean && Object.keys(clean).length) event.data = clean;
  return { ok: true, value: event };
}
