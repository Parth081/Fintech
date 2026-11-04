# ADR 0018: Copy and claims policy

- **Status:** Accepted (M6)
- **Date:** 2026-11-05

## Context

The booth shows a financial-services demo to buyers, and collects real visitors' contact details. Words on
screens, in narration, in the AI explainer's answers and in the team's documents can create legal exposure
without anyone intending it ("compliant", a bank's name beside our logo, a consent sentence that does not
match what staff do). Humans review text once; code and documents change afterwards.

## Decision

1. **No unearned claims.** The booth never says the system is compliant, certified, guaranteed, bank-grade,
   regulator-approved, tamper-proof or 100% secure. Denials ("not certified for any regulation") are allowed.
2. **No real brands.** Only fictional providers and open standards (ISO 20022, pacs.008, camt.053) appear.
   Real countries and currencies are fine.
3. **Always labelled.** Every top-level screen shows a SIMULATION / synthetic-data label; the recorded backup
   run is additionally marked "RECORDED RUN · not live" and is never presented as live.
4. **One consent sentence.** The kiosk constant `CONSENT_TEXT` is the single source; the legal pack must quote
   it verbatim and it must state the contact purpose, storage on the booth laptop and deletion.
5. **Every claim has evidence.** `docs/booth/claims-register.md` maps each claim to a command and says what
   is not claimed.
6. **A machine checks the mechanical part, a human the rest.** `npm run verify:copy`
   (`tools/booth/copy-check.ts`) enforces rules 1 to 4 plus "no hard-coded outside links in screens" and "no
   real people's email addresses or phone numbers". Its rule list, scan targets and allow-list (each with a
   reason) live in that one file; an inline `copy-check:allow <rule> -- <reason>` comment covers a single line.
   `verify:m6` runs it. It never replaces the human review in `docs/booth/legal-review-pack.md`, which is
   marked as requiring sign-off and claims no approval.

## Consequences

- A new screen, narration line or document that breaks a rule fails `verify:copy` before the event.
- The check is a scan of text, not of meaning: a sentence can be misleading without containing a banned word.
  The legal review and the presenter training cover that.
- Allow-listing is a deliberate act with a written reason, visible in review.
- The consent sentence says details stay on the booth laptop; the end-of-day export moves them. The legal
  pack records this as an open point for the reviewer instead of the code hiding it.
