# ADR 0022: Prospect scenario packs

- **Status:** Accepted (M7)
- **Date:** 2026-11-07

## Context

Every serious prospect asks to see "our problem" on the screen: a PSP wants its acceptance rate dipping and
recovering, a bank wants a sanctions backlog, a marketplace wants payout pricing during a currency swing. The
five built-in scenarios are TypeScript, so each new story meant editing code, re-running the whole test suite and
asking an engineer. The goal for M7 is a prospect-specific scenario in under one week by someone who does not
touch the pipeline.

## Decision

1. **A pack is a JSON file**, `services/orchestrator/src/packs/active/<name>.pack.json`: name, title, audience
   (`psp`, `bank`, `marketplace`), description, duration, narration steps, events per step, and expected outcomes.
2. **Events map onto the orchestrator's existing actions** and nothing else: per-corridor traffic
   (`payments.send`), ambient rate, provider outage and recovery, FX shock start and end. Traffic can name
   listed-party (sanctions near-match) payments. A pack compiles to the same `ScenarioScript` the built-ins use,
   so no stage, contract or broker change is needed, and the existing rules (`validateScript`) still apply.
3. **Generation is deterministic.** Names, amounts and accounts come from a PRNG seeded by the pack name (or its
   `seed`), the label and the position. Account ids keep the `{run}` token, so each run uses fresh accounts, and
   idempotency keys are the orchestrator's usual ones, so a replay never creates a second payment.
4. **Loading is fail-soft.** The orchestrator loads the `active` folder (or `PACKS_DIR`) at start, after the
   built-ins. An invalid, draft or clashing pack is skipped with a log line; it never stops the orchestrator or
   removes a built-in scenario. Examples in `packs/examples` are opt-in: copy one to `active`.
5. **Copy policy applies to packs** (ADR 0018). The pack validator reuses the forbidden-claim and brand lists of
   `verify:copy` on every title, narration, reason and expectation. A scaffold is full of `TODO` markers; a
   pack with any `TODO` is a draft and is neither accepted by `scenario:check` nor loaded.
6. **Tooling.** `npm run scenario:new -- --name x --audience psp|bank|marketplace` writes a runnable starter pack.
   `npm run scenario:check [-- files]` validates, dry-runs twice, compares digests (determinism) and evaluates the
   machine-checkable expectations. Expectations without a `check` are listed as "for a person to confirm in
   rehearsal".

## Consequences

- A new prospect story is mostly writing: narration, a handful of events and expectations. Engineering is needed
  only for something the event list cannot express.
- **Not expressible yet:** approved configuration changes (`control.config.updated`, maker-checker in the ops
  console), per-corridor ambient rates (ambient is one global rate; per-corridor shape comes from `traffic`
  events), and new kinds of provider failure. These need a new orchestrator action and an ADR.
- The dry run predicts what the orchestrator sends (a test runs a pack in the real orchestrator and compares), but it
  does not predict what the pipeline decides: held, rejected or released depends on screening and risk, so
  those expectations stay manual until a rehearsal confirms them.
- Narration passes a text scan, not a human review. A pack shown to a prospect still gets the read-through in
  `docs/booth/legal-review-pack.md`.
- Packs are code-adjacent data: they are committed and reviewed like code; the loader trusts files in its own
  folder and does not execute anything from them.
