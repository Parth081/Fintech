# Claims register

Every claim the booth makes, the command that proves it, and what is **not** claimed. A presenter may say
a claim only if its evidence command passed on the version being shown. Re-run the commands before the
event and write the date in the last column.

How each claim was checked, as of this document:

- **Run for this register** = run on the booth-team laptop while writing it (2026-11-05, Windows 11, Node 24.19).
- **Proved at milestone** = the command was built and passed in its milestone (M2 to M5, see README); it was **not** re-run for this register. Re-run it; the "Date re-run" column is for you.
- **Static** = a mechanical scan, re-run by `npm run verify:copy`.

| # | Claim (as said at the booth) | Evidence command | How checked | Date re-run |
| --- | --- | --- | --- | --- |
| 1 | "Debits equal credits": the double-entry ledger balances in every currency across 10,000 payments, with no duplicates on retry | `npm run verify:m2` (full, 10,000 payments, about 10+ minutes). Quick: `npm run verify:m2:quick` (500) | Quick version **run for this register: all checks passed** (500 payments, 0 duplicates, ledger balanced, `rejectedEvents = 0`). Full 10,000 run: proved at milestone | |
| 2 | "Every payment is accounted for; nothing lost, nothing counted twice" (outage story) | `npm run verify:m3` (10 runs) or `npm run verify:m3:quick` (2 runs) | Proved at milestone | |
| 3 | "The circuit breaker trips within 10 seconds, no first-attempt traffic goes to the failed provider, and traffic returns after recovery" | `npm run verify:m3` checks b, c, d | Proved at milestone | |
| 4 | "Reset takes under 10 seconds and brings back an empty, healthy system" | `npm run verify:m3` check h; also step 17 of the [dress rehearsal](dress-rehearsal-script.md) on the real laptop | Proved at milestone; measure on the booth laptop | |
| 5 | "Held payments have not moved a cent: no ledger entry until a human decides" | `npm run verify:m4` checks a, b, d | Proved at milestone | |
| 6 | "Four eyes: the person who proposes cannot approve; a manager must approve high-risk releases, rejections, refunds and configuration changes" | `npm run verify:m4` checks c, d, f, g | Proved at milestone | |
| 7 | "Every action in the console is recorded in an append-only audit trail with who did it" | `npm run verify:m4` check i | Proved at milestone | |
| 8 | "Quotes widen when the market is jumpy and tighten again afterwards" | `npm run verify:m4` check h | Proved at milestone | |
| 9 | "Fuzzy matching catches near-matches to the (fictional) sanctions list" | `npm run verify:m4` check a | Proved at milestone | |
| 10 | "The AI explainer answers only from what the system recorded; every number is shown with a citation" | `npm run verify:m5` (all scenarios, at least 100 questions each); `npm run verify:m5:quick` (one scenario) | Proved at milestone | |
| 11 | "Questions outside the system are declined, and instructions typed into a question are ignored" | `npm run verify:m5` (safety checks) | Proved at milestone | |
| 12 | "The explainer works fully offline" | `npm start -- --llm off`, Wi-Fi off, ask three questions; `npm run verify:m5` runs with no credentials | Proved at milestone; do it on the booth laptop in rehearsal | |
| 13 | "Visitor details stay on this laptop; the booth service makes no outbound connections" | `npm run verify:m5` (static scan of `services/booth/src`) | Proved at milestone | |
| 14 | "Leads need explicit consent and survive a reset; only staff with the PIN can read, export or erase them" | `npm run verify:m5` (booth checks) | Proved at milestone | |
| 15 | "Usage statistics are anonymous" | `npm run verify:m5` (analytics refuse personal data) | Proved at milestone | |
| 16 | "The screens say SIMULATION / synthetic data" | `npm run verify:copy` (rule: sim-label) | Static; **run for this register** | |
| 17 | "No real bank, card network or payment company is named" | `npm run verify:copy` (rule: brand-name) | Static; **run for this register** | |
| 18 | "The consent sentence on the kiosk is the one in the legal pack and mentions contact, storage on the booth laptop and deletion" | `npm run verify:copy` (rule: consent-text) | Static; **run for this register** | |
| 19 | "The booth works with the network off" | Rehearsal steps 27 and 28; `npm run booth:preflight` ("Network") | Human rehearsal | |
| 20 | "The system restarts a crashed service by itself and can fall back to a recorded run" | `npm run verify:m6` and rehearsal steps 19 to 21 | Built in M6 (launcher supervisor and safe mode); confirm in the rehearsal | |
| 21 | "The laptop is ready" (Node, dependencies, ports, disk, memory, recording, PIN) | `npm run booth:preflight` | **Run for this register** (result in the final report) | |
| 22 | "Lead export saves a CSV, never prints personal data, and erases only after a typed confirmation" | `npx vitest run tools/booth` | **Run for this register** (tests pass) | |

## Messages and standards

"ISO 20022" means the system builds and validates pacs.008, pacs.002 and camt.053 style messages
(`packages/iso20022`, `npm test`). Say "uses ISO 20022 message formats".

## What is NOT claimed

Say these out loud if asked. The booth does not claim, and nobody should say, that the system:

- is compliant with, certified for, or approved under any regulation, standard or scheme (including PCI, ISO, SOC 2, GDPR, or any sanctions regime);
- has been reviewed or approved by a regulator, bank, auditor or lawyer (the legal review is a separate human step: [legal-review-pack.md](legal-review-pack.md));
- is a production payment system, or has processed real money, real customers or real sanctions data;
- is secure against attack: it binds to the local machine and has a booth-grade PIN, nothing more. No penetration test has been done;
- is guaranteed to perform at any speed or volume outside the measured simulation (the throughput numbers printed by `verify:m2` come from one laptop with zero delays);
- uses real providers, real exchange rates or real fees: Orion, Lyra, Vega, rates, spreads and fees are simulated;
- will give the same figures on a different machine: timings vary;
- is endorsed by, or partnered with, any real bank, network or payment company;
- keeps an audit trail that nobody could ever alter (the interface offers no way to change it; that is all that is said).

## Changing a claim

Add the row first (claim, command, how checked), run the command, then use the words. If a command fails,
remove the claim from the script until it passes.
