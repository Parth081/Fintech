# ADR 0013: Grounded-first AI explainer

- **Status:** Accepted (M5)
- **Date:** 2026-10-27

## Context

At the booth, visitors ask "why was my payment held?", "why did it go through Lyra?", "what did the outage
do?". An LLM answers fluently, but a payments demo that shows a wrong number (a fee, a rate, a count)
damages trust more than no answer at all. The booth also has to work with Wi-Fi off, and a model call can
be slow, rate-limited or unavailable.

## Decision

1. **The explainer narrates; it never decides.** It reads the event log (decision traces, ADR 0003) and
   has no write path: no tool that publishes events, calls the orchestrator or changes configuration.
   Questions are free text (max 300 characters) and only about this system's recorded data; anything else
   is politely declined.
2. **Grounded first.** For every supported intent a deterministic builder produces the answer from recorded
   facts. Each fact is a citation `{ eventId, field, value }` (or an aggregate with `eventId: null` and a
   `source` saying how it was computed). This answer works offline and is the default when
   `ASSISTANT_LLM=off`.
3. **Claude only phrases.** With `ASSISTANT_LLM=auto` and working credentials (environment only), Claude
   rewrites the answer from the same facts via read-only tools. Every number in its text must match a
   citation (same rendering rules as the grounded builder); otherwise the grounded or a cached verified
   answer is served. `answer.verified` is never shown false to visitors.
4. **Independent proof.** `npm run verify:m5` asks ≥ 100 questions per scripted scenario through the
   gateway with `ASSISTANT_LLM=off` and re-derives every fact from the broker log with its own code
   (`tools/verify/m5-analyze.ts`, `m5-aggregates.ts`): citation values at `eventId` + `field`, aggregates
   recomputed, every number matched, key facts for the intent present. It also probes off-topic and
   prompt-injection questions. CI runs it with no credentials.

## Consequences

- The demo answers correctly with no network; Claude is an enhancement, not a dependency.
- Aggregate citations must use a `source` that the verifier can recompute; a new aggregate needs a
  recogniser in `tools/verify/m5-aggregates.ts` (an unknown aggregate fails verification by design).
- Answers are limited to intents the grounded builders cover; new question types need a builder first.
