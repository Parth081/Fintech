# Dress rehearsal script (Gate 3)

**Gate 3: no hard failures in rehearsals.** Run this script twice, start to finish, on the real booth
hardware with Wi-Fi off. Two people: a **Presenter** and a **Visitor** (someone who has not seen the kiosk).
A third person with a stopwatch and this page is the **Scribe**.

- **HARD** step: if it fails, the booth is not ready. Write down what happened, fix it, and repeat that
  step and everything after it. Rehearsal 2 only counts when no HARD step fails.
- **SOFT** step: a failure is noted and fixed if possible, but does not block.
- Tick `Pass` or `Fail` and write the time and a note. Mark `N/A` only with the team lead's agreement.

Preparation: complete sections A to D of [booth-setup-checklist.md](booth-setup-checklist.md). Terminal 1 is
where `npm start -- --llm off` runs, terminal 2 is free. Staff PIN set. Spare laptop nearby.

Date / rehearsal number: ____________  Laptop: ____________  Version (`git log -1 --oneline`): ____________

| # | Step | Kind | What must happen | Pass | Fail | Time / note |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `npm run booth:preflight` | HARD | No `[FAIL]`. Warnings explained. | [ ] | [ ] | |
| 2 | `npm run verify:copy` | HARD | Ends with `Copy check passed` | [ ] | [ ] | |
| 3 | `npm start -- --llm off` | HARD | Banner with URLs within 60 s; no error text in the terminal | [ ] | [ ] | |
| 4 | **Attract loop idle start.** Leave every screen untouched for 2 minutes (default idle time) | HARD | The big screen starts the story by itself ("Payments flowing across 3 corridors" ... "Your turn: try it yourself"), caption text readable from 3 m | [ ] | [ ] | |
| 5 | Touch the kiosk during the loop | SOFT | The loop hands control back; big screen returns to live traffic | [ ] | [ ] | |
| 6 | **Kiosk visit end to end** (Visitor, unprompted): *Send a payment*, pick a corridor and amount, **Send**, watch every step, **Ask why** on one step | HARD | Payment reaches "Delivered"; the answer appears with citations; no error text; under 3 minutes | [ ] | [ ] | |
| 7 | Kiosk: *Watch what happens when a provider fails* | SOFT | The payment is re-routed and delivered | [ ] | [ ] | |
| 8 | **Lead consent.** On the form, press **Send me the follow-up** without ticking the box | HARD | Refused with "Please tick the box so we may email you"; nothing is stored | [ ] | [ ] | |
| 9 | Read the consent sentence aloud; tick; enter `Test Person`, `Test Co`, `test@example.com`; submit | HARD | "Thank you" screen; sentence on screen matches [legal-review-pack.md](legal-review-pack.md) | [ ] | [ ] | |
| 10 | **Erase.** Terminal 2: `npm run booth:export-leads -- --out rehearsal-leads.csv --erase`, type `DELETE` | HARD | Saved 1 lead; "Erased 1 of 1"; PIN never printed; then rerun with `--out rehearsal-2.csv` (no `--erase`): "Saved 0 leads". Delete both files | [ ] | [ ] | |
| 11 | Wrong PIN: `npm run booth:export-leads -- --pin 0000 --out x.csv` | SOFT | Clear refusal; no file `x.csv` | [ ] | [ ] | |
| 12 | **Outage scenario.** Presenter: **Start** *Provider outage* and talk it through with the [runbook](presenter-runbook.md) | HARD | All 7 steps appear on time (0, 10, 18, 35, 42, 55, 63 s); Orion goes red, traffic moves, breaker half-open, ledger balanced at the end | [ ] | [ ] | |
| 13 | **Jump to explanation** at "Breaker trips" | SOFT | Drawer opens on the big screen with the reason; **Close drawer** closes it | [ ] | [ ] | |
| 14 | **Ask why** > Scenario: "Was any payment lost?" | HARD | Answer with citations; no invented numbers | [ ] | [ ] | |
| 15 | Other scenarios once each: *Fraud ring*, *Sanctions hit*, *Currency spike*, *Partial failure* | SOFT | Each runs to its last step without an error banner | [ ] | [ ] | |
| 16 | Pace Slow-motion, Pause, Resume, Fast, Normal | SOFT | Each takes effect within a few seconds | [ ] | [ ] | |
| 17 | **Reset x3.** **RESET DEMO** > **Reset now**, three times in a row, a scenario running during the second | HARD | Each: "System is back" within 15 s; ledger balanced; screens reconnect by themselves; no stuck overlay | [ ] | [ ] | t1 __ t2 __ t3 __ |
| 18 | Leads survive reset: submit a test lead (as step 9), reset, run the export | HARD | The test lead is still there; then erase it | [ ] | [ ] | |
| 19 | **Safe mode switch and back.** Use the safe-mode control in the presenter console (fallback: `curl -X POST http://127.0.0.1:7079/safe-mode -H "content-type: application/json" -d "{\"on\":true}"`) | HARD | Big screen shows **RECORDED RUN - not live** with moving traffic; kiosk shows "The live demo is taking a short break."; presenter console still usable | [ ] | [ ] | |
| 20 | Switch back to live (same control, or `{"on":false}`) | HARD | Fresh live system, ribbon gone, kiosk sends payments again, within 30 s | [ ] | [ ] | |
| 21 | **Kill a service on purpose.** Find a process: `curl http://127.0.0.1:7079/status`. Stop one stage (for example the process serving port 7071 or the assistant on 7076): Task Manager > end task, or `taskkill /PID <pid> /F` | HARD | The supervisor restarts it within about 10 s (the status shows `restarts: 1`); screens recover without a manual reset | [ ] | [ ] | |
| 22 | Kill the AI explainer (port 7076) | SOFT | Kiosk hides **Ask why** or shows a polite message; payments keep working; it returns after restart | [ ] | [ ] | |
| 23 | **Laptop sleep / wake.** Close the lid (or Sleep) for 1 minute, wake it | HARD | Screens reconnect; if the system looks wrong, **RESET DEMO** brings it back; no leftover processes (`booth:preflight` ports free after Ctrl+C) | [ ] | [ ] | |
| 24 | **Projector / display hot-plug.** Unplug the big-screen cable for 10 s, replug | HARD | The big-screen window returns on the big screen at the right resolution; if not, drag it back and press F11 | [ ] | [ ] | |
| 25 | **Touch screen unplug** USB for 5 s, replug | SOFT | Touch works again without a restart | [ ] | [ ] | |
| 26 | Port clash: start a second `npm start` in terminal 2 | SOFT | A clear "port(s) busy" message; the running booth is unaffected | [ ] | [ ] | |
| 27 | **Offline check.** Wi-Fi is off and Ethernet unplugged the whole time | HARD | Nothing above needed the network | [ ] | [ ] | |
| 28 | **Idle for 20 minutes** with the attract loop on | HARD | Still looping; no memory growth warning; no crashed service (`curl http://127.0.0.1:7079/status` shows all running) | [ ] | [ ] | |
| 29 | **Hot-spare swap.** Stop the main system, start the booth on the spare (steps in `booth:preflight -- --hot-spare`) | SOFT | Spare shows the stage within 3 minutes | [ ] | [ ] | |
| 30 | Presenter handover: every presenter runs the 3-minute demo | SOFT | Done without reading this page | [ ] | [ ] | |
| 31 | Close of day: export, erase, Ctrl+C | HARD | Export file saved; erased; `booth:preflight` shows ports free | [ ] | [ ] | |

## Result

| | Rehearsal 1 | Rehearsal 2 |
| --- | --- | --- |
| HARD steps failed | ____ | ____ |
| SOFT steps failed | ____ | ____ |
| Longest reset | ____ s | ____ s |
| Fixed before next run (what) | | |
| Scribe / Presenter / Visitor | | |

**Gate 3 passed** when Rehearsal 2 shows `HARD steps failed = 0`. Signed: ______________ (team lead)  Date: ________

Record what failed and how it was fixed; these notes feed the [failure playbook](failure-playbook.md).
