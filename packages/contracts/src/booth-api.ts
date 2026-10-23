// M5: booth mode back end (services/booth, default http://127.0.0.1:7077) — visitor lead capture with explicit
// consent and anonymous engagement analytics. Everything stays on this machine (no outbound requests).
// Browser access via the gateway at /api/booth/*.

export interface LeadInput {
  name: string; // required
  company: string; // required
  role?: string;
  email: string; // required, validated
  interest: 'cross-border' | 'orchestration' | 'risk-compliance' | 'ledger-recon' | 'ai' | 'other';
  /** Explicit consent to be contacted about this demo; required (lead rejected without it). */
  consent: true;
  consentText: string; // the exact consent sentence shown to the visitor
  /** Anonymous session id of the kiosk visit, to link the lead to what they explored. */
  sessionId?: string;
}

export interface Lead extends Omit<LeadInput, 'consent'> {
  id: string;
  createdAt: string;
  consentAt: string;
  /** Scenarios and questions this visitor engaged with (from analytics for sessionId). */
  engagement: { scenarios: string[]; questions: string[]; dwellSeconds: number };
}

/** Anonymous engagement events (no personal data). */
export interface AnalyticsEvent {
  sessionId: string; // random per kiosk visit, reset on idle
  type: 'visit.start' | 'visit.end' | 'scenario.viewed' | 'question.asked' | 'payment.sent' | 'cta.shown' | 'lead.submitted';
  at: string;
  data?: Record<string, string | number | boolean>;
}

export interface BoothSummary {
  visits: number;
  avgDwellSeconds: number;
  leads: number;
  topScenarios: { scenarioId: string; views: number }[];
  topQuestions: { text: string; count: number }[];
  byHour: { hour: string; visits: number; leads: number }[];
}

/**
 * Booth API:
 *   GET  /health
 *   POST /analytics { events: AnalyticsEvent[] }      -> { accepted }
 *   POST /leads LeadInput                             -> Lead          (400 without consent / invalid email)
 *   GET  /leads            (presenter/staff only: header X-Booth-Staff: <BOOTH_STAFF_PIN>) -> Lead[]
 *   GET  /leads/export.csv (staff)                    -> text/csv
 *   DELETE /leads/:id      (staff; right to erasure)  -> { deleted }
 *   GET  /summary          (staff)                    -> BoothSummary
 */
export const BOOTH_API_DOC = true;
