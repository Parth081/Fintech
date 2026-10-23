// M5: the AI explainer (services/assistant, default http://127.0.0.1:7076). It NARRATES facts the system
// already recorded; it never makes or changes a payment decision. Browser access via the gateway at /api/assistant/*.

/** Where a question is asked from; scopes the facts the assistant may use. */
export type AskContext =
  | { kind: 'payment'; paymentId: string }
  | { kind: 'scenario' } // the currently running / most recent scenario
  | { kind: 'system' }; // general: ledger proof, provider health, totals

/** One fact the answer relies on: a field of a recorded event (or a computed aggregate over events). */
export interface Citation {
  /** Event id on the log, or null for an aggregate (then `source` explains how it was computed). */
  eventId: string | null;
  eventType?: string;
  /** Dotted path into the event, e.g. "trace.inputs.fraudScore" or "payload.scoring[1].score". */
  field: string;
  /** The exact value as recorded (numbers as recorded, money as Money objects, strings verbatim). */
  value: unknown;
  /** Plain-English label shown next to the value in the UI. */
  label: string;
  source?: string;
}

export type AnswerMode =
  | 'grounded' // deterministic answer built from the recorded facts (works offline, default)
  | 'llm' // phrased by Claude from the same facts via read-only tools; every number verified against citations
  | 'cached'; // a pre-generated, verified answer served when the model is unreachable

export interface Answer {
  question: string;
  context: AskContext;
  answer: string; // plain English, short (≤ ~120 words)
  citations: Citation[];
  mode: AnswerMode;
  /** True when every number/amount in `answer` was matched to a citation value. Never shown false to visitors. */
  verified: boolean;
  intent: string; // e.g. "why_held", "why_route", "fx_cost", "outage_story", "ledger_proof", "unknown"
  followUps: string[]; // 2–4 suggested next questions
  latencyMs: number;
}

export interface SuggestedQuestion {
  id: string;
  text: string;
  intent: string;
}

/**
 * Assistant API:
 *   GET  /health                                   -> { ok: true, llm: 'available' | 'unavailable' | 'disabled' }
 *   GET  /suggestions?context=payment:<id>|scenario|system   -> SuggestedQuestion[]  (4–6, context-aware)
 *   POST /ask { question, context }                -> Answer   (questions are free text, max 300 chars; the
 *        assistant answers only about this system's recorded data, politely declines anything else)
 *   GET  /eval/report                              -> last evaluation summary (see tools/verify verify:m5)
 */
export const ASSISTANT_API_DOC = true;
