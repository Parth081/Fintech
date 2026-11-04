# Presenter training plan

60 minutes, in person, one trainer and up to six presenters, on the booth laptop with the big screen.
Prerequisites: the system runs (`npm start -- --llm off`), everyone has read the [FAQ](faq.md) and the
[runbook](presenter-runbook.md) once.

## Agenda

| Time | Topic | How |
| --- | --- | --- |
| 0:00 | Why this booth exists; what is real and what is simulated; the words we never use | Trainer talks (5 min). Read the "not claimed" list in [claims-register.md](claims-register.md) aloud. |
| 0:05 | The three screens and the presenter console, panel by panel | Walk through the table in the runbook; each person finds **Pace**, **Pause**, **Attract loop**, **Ask why**, **RESET DEMO**. |
| 0:15 | The outage story: 72 seconds, step by step | Trainer demos once with narration; then each presenter says the first three steps out loud while it runs (10 min). |
| 0:25 | The other scenarios in two minutes each | Fraud ring, sanctions hit, currency spike: one talking point each. |
| 0:33 | The kiosk and the AI explainer | Everyone completes one visit as a visitor, taps **Ask why** twice, and tries to break it with an off-topic question. |
| 0:40 | Audiences: banker, CTO, marketplace founder | Pairs role-play the first 60 seconds for a chosen audience. |
| 0:47 | Leads and privacy | Read [staff-lead-handling.md](staff-lead-handling.md); practise the consent wording and a deletion request. Do the export once with a test lead. |
| 0:52 | When things go wrong | Trainer kills a service on purpose; presenters find the row in the [failure playbook](failure-playbook.md) and switch to the recorded run and back. |
| 0:58 | Self-test | Below. 10 minutes may overrun: do it before the rehearsal. |

Every presenter must, before the event: run the 3-minute demo unprompted once, and take part in a dress
rehearsal.

## Ground rules to repeat

1. Say "simulation" and "made-up data" early.
2. Never say the system is compliant, certified, guaranteed, bank-grade or regulator-approved, and never name a real bank or payment company as a partner.
3. Every number the explainer shows has a citation; point at it.
4. Be honest about the recorded run: it is a recording.
5. A visitor's details are theirs. Do not read them, photograph them or copy them.
6. When in doubt, **RESET DEMO**; leads are kept.

## Self-test (10 questions)

Answer without the notes. The pass mark is 9 of 10.

1. A visitor asks: "Is this system compliant?" What do you say?
2. You are mid-demo and the big screen looks wrong. What is the first thing you press, and what does it keep?
3. How long is the provider-outage scenario, and what are the first two things the audience sees?
4. What does the circuit breaker do when Orion is "half-open"?
5. In the fraud-ring scenario, why is the money "untouched" while payments are held?
6. A visitor asks to have their details deleted. What do you do, and what must you never do with the leads list?
7. Name the words you must not use about the system, and the kind of names you must not mention.
8. The kiosk shows "The live demo is taking a short break." Is that a fault? What do you tell the visitor?
9. How can you tell, from the screen, that the recorded run is playing, and what do you say about it?
10. A banker asks: "Can it handle our volume?" What is an honest answer?

### Answers

1. "No. It is a demonstration; it has not been certified or approved by anyone. It shows how screening, holds, four-eyes approval and an audit trail work." Do not say "not yet".
2. **RESET DEMO**, then **Reset now**. It restarts the system in about 5 to 10 seconds. Visitor leads are kept; payments and the ledger of the demo are wiped.
3. 72 seconds. Normal payments flowing across three corridors (most through Orion), then at 10 s Orion fails and its payments are refused.
4. It lets only a few test payments through to Orion. If they succeed, Orion earns its traffic back and the breaker closes.
5. Nothing is posted to the ledger until a human decides, so a held payment has not moved any money.
6. Note who they are, erase the lead at a quiet moment (or end of day with the PIN), and tell them when it is done. Never show the leads list where visitors can see it, and never put the export in git, email or a shared drive.
7. Compliant, certified, guaranteed, bank-grade, regulator-approved (also "tamper-proof", "100% secure"). Do not name real banks, card networks or payment companies as partners or users. Fictional names (Orion, Lyra, Vega) are fine.
8. Not a fault: the system is in safe mode (the recorded run). Tell them: "Please watch the big screen; this is a recording while we fix the live demo."
9. A ribbon reading "RECORDED RUN - not live" on the screens. Say plainly that it is a recording of the same demo.
10. "We do not know yet. We have shown 10,000 payments on one laptop with the ledger balancing. Sizing your volume is part of a project." No numbers beyond that.
