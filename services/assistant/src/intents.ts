// Intent classification: deterministic keyword rules. The question is untrusted free text; it only selects
// WHICH recorded facts to narrate (never which payment: that comes from the server-side AskContext).
import type { AskContext } from '@ct/contracts';

export type Intent =
  | 'payment_summary'
  | 'why_held'
  | 'why_rejected'
  | 'why_this_route'
  | 'why_retried'
  | 'fx_rate_and_cost'
  | 'how_long'
  | 'ledger_proof'
  | 'outage_story'
  | 'provider_health'
  | 'totals'
  | 'needs_payment'
  | 'unknown';

export const PAYMENT_INTENTS: readonly Intent[] = ['payment_summary', 'why_held', 'why_rejected', 'why_this_route', 'why_retried', 'fx_rate_and_cost', 'how_long'];

const RULES: [Exclude<Intent, 'needs_payment' | 'unknown'>, RegExp[]][] = [
  ['why_held', [/\bhe(ld|ld up)\b/, /\bhold(s|ing)?\b/, /\bmanual review\b/, /\bwaiting for (approval|review)\b/, /\bstuck\b/, /\breview(ed)?\b/, /\breleased?\b/, /\balert/]],
  ['why_rejected', [/\breject/, /\bdeclin/, /\bsanction/, /\bcompliance\b/, /\bblocked\b/, /\bfraud\b/, /\brisk score\b/, /\bscreen/]],
  ['why_retried', [/\bretr(y|ied|ies|ying)\b/, /\bfail(ed|ure|s)?\b/, /\bsecond attempt\b/, /\bagain\b/, /\brefus/, /\bbounced?\b/, /\breason code\b/, /\bpacs\.002\b/, /\bac04\b|\bam04\b|\bnarr\b/, /\battempts?\b/]],
  ['why_this_route', [/\brout(e|ed|ing)\b/, /\bprovider\b/, /\bpartner\b/, /\brail\b/, /\bcho(se|ose|sen)\b/, /\bpick(ed)?\b/, /\bselect(ed)?\b/, /\bwhy (orion|lyra|vega)\b/, /\b(orion|lyra|vega)\b/, /\bscor(e|es|ing)\b/, /\balternative/]],
  ['fx_rate_and_cost', [/\bfx\b/, /\bexchange\b/, /\brates?\b/, /\bspread\b/, /\bfees?\b/, /\bcost\b/, /\bcharge/, /\bconver(t|sion|ted)\b/, /\bmid[- ]?market\b|\bmid rate\b/, /\bhow much\b/, /\bprice\b/, /\breceive[ds]?\b|\bget\b.*\b(recipient|beneficiary)\b/, /\bmarkup\b/, /\bbps\b|\bbasis points?\b/]],
  ['how_long', [/\bhow long\b/, /\bhow fast\b/, /\btime\b/, /\btook\b/, /\bspeed\b|\bquick/, /\bduration\b/, /\blatency\b/, /\bseconds?\b/, /\bwhen\b/, /\btimeline\b/, /\bslow/]],
  ['ledger_proof', [/\bledger\b/, /\bjournal/, /\bbalanc/, /\bdebit/, /\bcredit/, /\breconcil/, /\bbooks?\b/, /\bdouble[- ]entry\b/, /\btrial balance\b/, /\bproof\b|\bprove\b/, /\baccount(ed|ing)?\b/, /\bstatement\b/, /\bcamt/]],
  ['outage_story', [/\boutage\b/, /\bdown\b/, /\bscenario\b/, /\bincident\b/, /\bre-?rout/, /\bbreaker\b/, /\bwent wrong\b/, /\bwhat happened\b/, /\blost\b/, /\brecover/, /\bunreliable\b|\bdegraded\b/]],
  ['provider_health', [/\bhealth(y)?\b/, /\bsuccess rate\b/, /\breliab/, /\buptime\b/, /\bperform/, /\bwhich provider/, /\bproviders\b/, /\bpartners\b/, /\bcircuit\b/]],
  ['totals', [/\bhow many\b/, /\btotals?\b/, /\bvolume\b/, /\bcount\b/, /\bthroughput\b/, /\boverall\b/, /\bsummary\b|\bsummar/, /\bpayments\b/, /\bstatistics\b|\bstats\b/, /\bso far\b/]],
  ['payment_summary', [/\bwhat happened\b/, /\bstatus\b/, /\bwhere is\b/, /\bexplain\b/, /\btell me about\b/, /\bthis payment\b/, /\bwhat is (this|it)\b/, /\boverview\b/]],
];

const OFF_TOPIC = [
  /\bweather\b/, /\bjoke\b/, /\bpoem\b/, /\bsong\b/, /\brecipe\b/, /\bstocks?\b/, /\binvest/, /\bcrypto|\bbitcoin\b/, /\bshould i (buy|sell)\b/,
  /\bpolitic/, /\belection\b/, /\bpresident\b/, /\bsports?\b/, /\bmovie\b/, /\bwrite (me )?(a|an|some) (code|essay|story)\b/, /\bwho are you\b/,
  /\bsystem prompt\b/, /\byour instructions\b/, /\bapi key\b/, /\bpassword\b/, /\bhack/, /\bcapital of\b/, /\bdate today\b|\bwhat day\b/,
];

/** Domain words that mean "this is about the control tower" even without a specific intent. */
const DOMAIN = /\b(payment|transfer|money|it|this|ledger|provider|scenario|demo|system|platform|tower|bank|transaction)\b/;

export interface Classified {
  intent: Intent;
  /** True when no rule matched and the question is not about this system. */
  offTopic: boolean;
}

export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, ' ').trim();
}

function score(q: string): Map<Intent, number> {
  const m = new Map<Intent, number>();
  for (const [intent, res] of RULES) {
    let n = 0;
    for (const re of res) if (re.test(q)) n += 1;
    if (n > 0) m.set(intent, n);
  }
  return m;
}

/** Pick the intent for a question in its context. */
export function classify(question: string, context: AskContext, facts: { status?: string } = {}): Classified {
  const q = normalizeQuestion(question);
  const scores = score(q);
  const offTopicHit = OFF_TOPIC.some((re) => re.test(q));
  if (offTopicHit && !(scores.size > 0 && /\b(payment|ledger|provider|scenario|fx|route|journal)\b/.test(q))) return { intent: 'unknown', offTopic: true };
  if (scores.size === 0) {
    if (!DOMAIN.test(q)) return { intent: 'unknown', offTopic: true };
    const fallback: Intent = context.kind === 'payment' ? 'payment_summary' : context.kind === 'scenario' ? 'outage_story' : 'totals';
    return { intent: fallback, offTopic: false };
  }
  // contextual tie-breaks
  const status = facts.status;
  if (context.kind === 'payment') {
    if (scores.has('why_retried') && status === 'rejected' && !/\bprovider|attempt|retr/.test(q)) scores.set('why_rejected', (scores.get('why_rejected') ?? 0) + 2);
    if (/\bheld\b|\bhold\b/.test(q)) scores.set('why_held', (scores.get('why_held') ?? 0) + 2);
    if (/\breject/.test(q) && status !== 'rejected' && !scores.has('why_held')) scores.set('why_retried', (scores.get('why_retried') ?? 0) + 1);
    if (/\breject/.test(q) && status === 'rejected') scores.set('why_rejected', (scores.get('why_rejected') ?? 0) + 2);
    if (/\b(fee|spread|rate|cost)\b/.test(q)) scores.set('fx_rate_and_cost', (scores.get('fx_rate_and_cost') ?? 0) + 1);
    if (/\bhow long\b|\bhow fast\b/.test(q)) scores.set('how_long', (scores.get('how_long') ?? 0) + 2);
    if (/\bwhy\b.*\b(orion|lyra|vega|provider|route|routed)\b/.test(q)) scores.set('why_this_route', (scores.get('why_this_route') ?? 0) + 2);
    if (/\bledger\b|\bjournal\b|\bbalanc/.test(q)) scores.set('ledger_proof', (scores.get('ledger_proof') ?? 0) + 2);
  } else {
    if (/\bbreaker\b|\boutage\b|\bre-?rout|\blost\b|\bscenario\b/.test(q)) scores.set('outage_story', (scores.get('outage_story') ?? 0) + 2);
    if (/\bre-?rout|\blost\b|\bbreaker\b/.test(q)) scores.set('outage_story', (scores.get('outage_story') ?? 0) + 1);
    if (/\bledger\b|\bjournal\b|\bbalanc/.test(q)) scores.set('ledger_proof', (scores.get('ledger_proof') ?? 0) + 3);
    if (/\bhow many\b|\btotal\b/.test(q)) scores.set('totals', (scores.get('totals') ?? 0) + 2);
    if (/\bhealth|\bsuccess rate|\breliab/.test(q)) scores.set('provider_health', (scores.get('provider_health') ?? 0) + 2);
  }
  let best: Intent = 'unknown';
  let bestScore = 0;
  for (const [intent] of RULES) {
    const s = scores.get(intent) ?? 0;
    if (s > bestScore) {
      best = intent;
      bestScore = s;
    }
  }
  if (context.kind !== 'payment') {
    if (best === 'why_retried' || best === 'why_this_route' || best === 'how_long') best = context.kind === 'scenario' ? 'outage_story' : 'provider_health';
    else if (PAYMENT_INTENTS.includes(best)) best = 'needs_payment';
  }
  return { intent: best, offTopic: false };
}
