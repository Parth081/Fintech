# Booth documents

Everything a conference team needs to run the Global Fintech Control Tower booth. Written for people who
are not engineers. Commands are for the terminal on the booth laptop, opened in the project folder.

> The system is a **simulation on synthetic data**. Nothing here is a regulatory approval, and the legal
> review pack is a checklist for a human reviewer, not a legal opinion.

## Read in this order

| # | Document | Who | When |
| --- | --- | --- | --- |
| 1 | [training-plan.md](training-plan.md) | every presenter | before the event (60 minutes + self-test) |
| 2 | [presenter-runbook.md](presenter-runbook.md) | presenters | training, then at the booth |
| 3 | [booth-setup-checklist.md](booth-setup-checklist.md) | team lead | day before and morning of |
| 4 | [dress-rehearsal-script.md](dress-rehearsal-script.md) | whole team | two full rehearsals; this is Gate 3 |
| 5 | [failure-playbook.md](failure-playbook.md) | everyone at the booth | printed, next to the laptop |
| 6 | [faq.md](faq.md) | presenters | honest answers to visitor and buyer questions |
| 7 | [staff-lead-handling.md](staff-lead-handling.md) | whoever closes the booth | consent, export, erase |
| 8 | [legal-review-pack.md](legal-review-pack.md) | legal / compliance reviewer | before the event; needs human sign-off |
| 9 | [claims-register.md](claims-register.md) | reviewer, team lead | every claim and the command that proves it |

## The five commands you will use

| Command | What it does |
| --- | --- |
| `npm run booth:preflight` | Checks this laptop is ready (Node, ports, disk, memory, recording, PIN). Add `-- --hot-spare` for the spare-laptop steps. |
| `npm run verify:copy` | Scans screens, narration, answers and these documents for banned claims, real brand names, a missing SIMULATION label, outside links and a drifting consent sentence. |
| `npm start` | Starts the booth (`npm start -- --llm off` for a fully offline AI explainer). |
| `npm run booth:export-leads` | End of day: saves the leads to a CSV and shows the booth summary (`-- --erase` to delete them afterwards). |
| `npm run booth:record` / `booth:replay` | Record the backup run, and try it. |

## Addresses (all on the booth laptop)

| Screen | Address |
| --- | --- |
| Big screen | http://127.0.0.1:7072/#/stage |
| Visitor kiosk | http://127.0.0.1:7072/#/kiosk |
| Presenter console | http://127.0.0.1:7072/#/presenter |
| Operations console | http://127.0.0.1:7072/#/console |
| Reset from a terminal | `curl -X POST http://127.0.0.1:7079/reset` |

## What a human must still do

These documents cannot do it for you: the legal review and sign-off, the physical rehearsals on the real
screens and touch hardware, choosing the staff PIN for the event, and recording the backup run on the
laptop that will be used. The checklists name each one.
