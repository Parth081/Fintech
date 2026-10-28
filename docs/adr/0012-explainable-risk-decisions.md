# ADR 0012: Explainable risk decisions (summary)

- **Status:** Accepted (M4)
- **Date:** 2026-10-27

## Context

Holding a customer's payment needs a reason an investigator can read, defend to the customer and
reproduce for an auditor. A score with no explanation does not meet that bar. The risk engine
(`services/stages`: screening and risk) is owned by its engineer. This ADR records the contract that the
console, the scenarios and verification rely on.

## Decision (summary)

- **Every alert explains itself.** `risk.alert_raised` carries `kind` (sanctions / fraud / aml),
  `severity`, a `rule` id, an optional 0..1 `score`, a one-sentence `summary`, a list of `reasons` (code,
  plain text, optional weight) and `evidence`. Evidence is the matched list entry and match strength, the
  related payments and accounts, or the model features. The console shows these fields exactly as they
  are on the log.
- **Fictional, versioned sanctions list.** Screening fuzzy-matches debtor and creditor names (and
  aliases) against `FICTIONAL CONSOLIDATED LIST` (`services/stages/src/risk/sanctions-list.ts`). Every
  name and jurisdiction on it is invented. `payment.screened.listVersion` records which list version
  was used.
- **Typologies, not a black box.** AML rules name the pattern they found: fan-in (many new senders to one
  beneficiary), fan-out (one account to many recipients), structuring (amounts just under the reporting
  line) and rapid in-out movement. The fraud model shows its factor contributions as weighted reasons.
- **Decision engine with configurable thresholds.** The combined score is compared with
  `risk.thresholds` (hold / reject) and `risk.manualReviewAboveUsd`. Both are changed only through
  maker-checker (ADR 0011). The decision trace on `payment.scored` / `payment.held` (ADR 0003) records the
  inputs and the configuration version, so a replay gives the same decision.
- **Alerts roll up into cases.** All alerts on one payment form one case. The case priority is the
  highest alert severity, and the SLA follows from the priority. Humans decide; the engine never
  releases a payment it held.

## Consequences

- + An investigator sees why a payment was held. An auditor can recompute the decision from the log.
- + The demo scenarios (`sanctions-hit`, `fraud-ring`) are just shaped payments. Nothing tells the engine
  what to decide, so the scenarios test the real rules.
- - The list, the typology thresholds and the model weights are demo values, tuned for a convincing
  story with synthetic traffic and not calibrated on real data.
