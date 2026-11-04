# Legal and compliance review pack

> **REQUIRES HUMAN REVIEW.** This is a checklist prepared by the engineering team for a qualified legal /
> compliance reviewer. **It is not legal advice and it does not state or imply that anything has been
> legally approved.** Nothing in this repository has been reviewed by a lawyer. The tool
> `npm run verify:copy` checks a few mechanical things (banned words, brand names, labels, links); it
> cannot judge whether a sentence is acceptable.

How to use: for each section read the quoted text in its place on the real screen, decide *acceptable /
change needed*, write the change, and sign the table at the end. Engineering will apply changes and re-run
`npm run verify:copy` and the rehearsal.

Re-generate the list of public text with: `npm run verify:copy` (scans the places below) and by reading the
files named in each section.

## 1. What the booth is, in one paragraph (to be confirmed)

A demonstration of an event-driven cross-border payments platform. **Simulation, synthetic data, offline.**
No real customers, banks, providers or money. Provider names (Orion, Lyra, Vega), the sanctions list and the
customers are fictional. It is a sales and demonstration asset, **not** a production payment system and **not**
certified for any regulation (`PROJECT_OVERVIEW.md`).

## 2. Public claims

Every claim the booth makes, with the evidence that backs it, is in [claims-register.md](claims-register.md).
Reviewer: confirm each *claim wording* is acceptable and each *"not claimed"* line is right.

| Where | File | Review |
| --- | --- | --- |
| Big-screen attract story (7 captions) | `services/orchestrator/src/attract.ts` | [ ] |
| Five scenario scripts and descriptions | `services/orchestrator/src/scenarios.ts`, `scenarios-m4.ts` | [ ] |
| Kiosk screens and button text | `apps/web/src/kiosk/*.tsx`, `explain.ts`, `payment.ts` | [ ] |
| Presenter console text | `apps/web/src/components/PresenterConsole.tsx` | [ ] |
| AI explainer answer templates | `services/assistant/src/grounded.ts`, `knowledge.ts`, `suggestions.ts` | [ ] |
| Operations console copy | `apps/web/src/console/**` | [ ] |
| README and project overview | `README.md`, `PROJECT_OVERVIEW.md` | [ ] |
| Booth documents (talking points, FAQ) | `docs/booth/*.md` | [ ] |

### Words the booth must not use (checked by `verify:copy`)

compliant, certified, certification, guaranteed, bank-grade, PCI-compliant, ISO-certified,
regulator-approved, "100% secure", tamper-proof, unhackable, production-ready, enterprise-grade, SOC 2 /
HIPAA / FedRAMP. Uses that deny the claim ("not certified for any regulation") are allowed.
Reviewer: add or remove words.

### Statements that need judgement (reviewer decides)

| Statement | Where | Note |
| --- | --- | --- |
| "Every payment is accounted for ... Nothing was lost and nothing was counted twice." | outage narration | True for the simulation; evidenced by `verify:m2` / `verify:m3`. Confirm the wording is not read as a promise for real systems. [ ] |
| "Four eyes on every risky decision" | fraud-ring narration | Describes the demo's approval rule. [ ] |
| Fuzzy matching "does not fall for it" | sanctions narration | Describes behaviour on the fictional list only. [ ] |
| Audit trail: "append-only" | README, console | The API offers no change or delete; this is not a claim of tamper-proofing (that word is banned). [ ] |
| "Answers only from what the system recorded" | explainer, README | Evidence: `verify:m5`. Claude mode is optional. [ ] |
| ISO 20022 messages (pacs.008, pacs.002, camt.053) | README, console | The system builds and validates messages in these formats; it is not certified by any standards body. [ ] |

## 3. Consent text (lead form)

Source of truth: `apps/web/src/kiosk/lead.ts`, constant `CONSENT_TEXT`. Shown next to an unticked box.
`npm run verify:copy` fails if this document no longer quotes it word for word, or if it stops mentioning
contact purpose, storage on the booth laptop and deletion.

> We'd like to email you about this demo. We store your details on this booth laptop only and delete them after the event. You can ask us to delete them at any time.

| Check | Reviewer |
| --- | --- |
| Identifies who is contacting the visitor (the form shows "Global Fintech Control Tower"; the **organisation's legal name is not on the form**) | [ ] needs decision |
| Purpose stated: contact about this demo | [ ] |
| Storage place and period: "this booth laptop only", "after the event" | [ ] |
| Right to deletion stated | [ ] |
| Consent is explicit, unticked by default, optional, separate from using the demo | [ ] |
| Consent text and time are stored with each lead as evidence | [ ] |
| Languages: the form is English only. Is that acceptable for the event's audience? | [ ] |
| **Open question: "stored on this booth laptop only" versus the end-of-day export.** Staff export the leads to a file in order to send the follow-up emails. The sentence does not say the details will be copied to the company's contact list or mail tool. Decide: change the sentence, or define a process that makes the sentence true. | [ ] **blocking** |
| **Open question: "delete them after the event"** depends on staff running the erase routine. Who is accountable and by when? | [ ] |
| Legal basis for storing the details and for the follow-up email, and any marketing-consent rules in the countries of the audience | [ ] |

## 4. Privacy statements and data handling

| Fact (engineering) | Evidence | Reviewer |
| --- | --- | --- |
| Leads are stored only on the booth laptop, in `.data/booth` (embedded database). | ADR 0014; `verify:m5` static check that the booth code has no outbound client | [ ] |
| The booth service makes no outbound network requests. | `verify:m5` | [ ] |
| Listing, exporting, summarising and deleting leads need a staff PIN; the PIN should be changed per event. | `verify:m5`; `booth:preflight` warns on the default | [ ] |
| Usage analytics are anonymous (random visit id; personal-looking values are refused). | `verify:m5` | [ ] |
| A demo reset never deletes leads. | `verify:m5` | [ ] |
| Staff can erase a single lead, or all leads, and the export tool saves a file first. | `booth:export-leads`, `booth:clear-leads` | [ ] |
| The PIN is a booth-grade control, not strong authentication; the laptop must stay with staff. | ADR 0014 | [ ] |
| No visitor data is in the repository; export files are kept out of git (the tool warns). | `booth:export-leads` | [ ] |
| Is a privacy notice (beyond the consent sentence) needed at the stand? Where is it displayed? | | [ ] |
| Retention period and the person who answers access / deletion requests | [staff-lead-handling.md](staff-lead-handling.md) table | [ ] |
| Does the Claude mode (optional, `ASSISTANT_LLM=auto`) send anything about visitors to a third party? Engineering: the assistant code never reads lead data (no reference to the booth service), but it sends the visitor's typed question and recorded synthetic facts to the model provider, so personal details typed into an Ask-why question would leave the laptop; confirm with the assistant code and decide whether to use `--llm off` at the event. | `services/assistant/src`, `verify:m5` | [ ] |

## 5. Brand and company names

Policy: no real bank, card network, payment company or competitor is named on screens, in narration, in
answers or in booth documents. Only fictional names (Orion, Lyra, Vega, fictional people and companies) and
open standards (ISO 20022, pacs.008, camt.053) appear. Real country and currency names are fine.
`npm run verify:copy` enforces a list of about 60 names (card networks, wallets, payment companies, banks,
core-banking and compliance vendors). Third-party **technology** names do appear in the README and are
fine to disclose: Node.js, React, Postgres, Kafka, Docker, Claude / Anthropic (the optional AI mode).

| Check | Reviewer |
| --- | --- |
| The banned-name list is complete for the event's market (add names) | [ ] |
| Technology names in README / overview are acceptable (including Claude / Anthropic) | [ ] |
| Any logo or trademark use: none in the repository | [ ] |

## 6. Synthetic-data labelling

Every top-level screen carries the label: big screen "SIMULATION · SYNTHETIC DATA"; kiosk "SIMULATION ·
fictional data"; presenter console "Control Tower · simulation · synthetic data"; operations console
"Sandbox · synthetic data" (plus the sign-in page); audience header "SIMULATION · SYNTHETIC DATA".
The recorded backup run adds the ribbon "RECORDED RUN · not live".
`npm run verify:copy` fails if one of these screens loses its label.

| Check | Reviewer |
| --- | --- |
| Labels are visible enough at booth distance (look at the real screens) | [ ] |
| The recorded run is clearly marked as not live | [ ] |
| Printed material (flyers, badges, slides) carries the same label: outside this repository | [ ] |

## 7. Other items for the reviewer

- [ ] Sanctions-list scenario uses a fictional list and fictional names; check the names do not resemble real listed persons or companies (`SANCTIONS_NEAR_MATCHES`, `services/stages`).
- [ ] Fictional customer names in the traffic generator do not match real public figures.
- [ ] Accessibility, if required for the event (contrast, touch target size).
- [ ] Recording of visitors (cameras, photos at the stand) is outside this system.
- [ ] Open-source licences of dependencies (`package-lock.json`) if the code is shared.

## 8. Sign-off

**Not signed. Do not mark a row until a named human has reviewed it.**

| Section | Reviewer name and role | Decision (accepted / changes needed) | Date | Signature |
| --- | --- | --- | --- | --- |
| 2 Public claims | | | | |
| 3 Consent text | | | | |
| 4 Privacy and data handling | | | | |
| 5 Brand names | | | | |
| 6 Synthetic-data labelling | | | | |
| 7 Other | | | | |

Changes requested by the reviewer: ______________________________________________
