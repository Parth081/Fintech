# Failure playbook

Print this page and keep it next to the laptop. Each row: what you see, the likely cause, and what to do
in the first 30 seconds. Stay calm and keep talking: "While that reloads, let me tell you about ...".
The visitor never needs to know what broke.

**Golden rule:** if you are unsure, press **RESET DEMO** (about 5 to 10 seconds, leads are kept). If the
live demo still misbehaves, switch to the **recorded backup run**.

| Symptom | Likely cause | What to do in 30 s |
| --- | --- | --- |
| **Blank white page** at 7072 | UI not built, or system not running | Look at terminal 1: is `npm start` still running? If not, restart it (`npm start -- --llm off`). If the page is still blank, `npm run build:web` then reload. |
| **Big screen frozen** (nothing moves for 20 s) | Browser tab stalled, or the live feed dropped | Press F5 in that window. Then F11 for full screen. If traffic still does not move, press **RESET DEMO**. |
| **"Reconnecting..." or "Offline"** in the header | A service restarted or the gateway is down | Wait 10 s: the supervisor restarts crashed services by itself. Still there after 30 s: **RESET DEMO**. |
| **One service is down** (red in the status, or an error banner such as "Orchestrator unreachable") | Process crashed | Wait 10 s for the automatic restart. `curl http://127.0.0.1:7079/status` shows each service and its `restarts`. If a service keeps restarting or the banner stays, **RESET DEMO**, then safe mode if it comes back. |
| **Kiosk frozen** (touch does nothing) | Browser stalled, or touch device lost | Press F5 on the kiosk window. Unplug and replug the touch USB. Visitors can use the big screen meanwhile. |
| **Kiosk says "The live demo is taking a short break."** | The system is in safe mode (recorded run) | Not a fault: tell the visitor to watch the big screen. Switch back to live when the problem is fixed. |
| **Kiosk shows "The payment system is not answering right now."** | Gateway or payment API restarting | Wait 10 s and tap again. If it repeats, **RESET DEMO**. |
| **Ask why is slow or says it cannot answer** | The AI explainer is restarting, or Claude mode is waiting on a missing network | Wait up to 20 s. If it persists, the booth keeps working without it. For the rest of the day restart with `npm start -- --llm off` at the next quiet moment. |
| **Ask why answer looks wrong** | Should not happen: answers are checked against the record. | Do not repeat it. Note the question and time, tell the team lead, carry on. |
| **Reset hung** (overlay "Resetting..." for more than 30 s) | A service did not stop in time | Wait to 60 s. Then Ctrl+C in terminal 1 (everything stops), and run `npm start -- --llm off` again. Leads are kept. |
| **"Cannot start: port(s) busy"** | An old copy is still running | Close the old terminal, or find the program: `netstat -ano` (look for the line with :7072), then `taskkill /PID <pid> /F`. Check with `npm run booth:preflight`. |
| **Laptop slow / fan loud** | Memory pressure | Close browsers you do not need; pause the attract loop; Ambient traffic to **Calm**. |
| **Laptop woke from sleep and screens look odd** | Services were suspended | **RESET DEMO**. If that fails, Ctrl+C and `npm start -- --llm off`. |
| **Big screen went black / wrong resolution** | Display cable or projector lost | Replug the cable; Windows key + P > **Extend**; drag the window back; F11. |
| **Wrong or old screens** | Old build | `npm run build:web`, reload. |
| **A visitor asks about their details** | Privacy question | See [staff-lead-handling.md](staff-lead-handling.md). If they want their details removed: note their name and email, tell them it will be erased the same day, and erase it at the next quiet moment (below). |
| **Forgot the staff PIN** | | Ask the team lead. If nobody knows it, restart the system with a new `BOOTH_STAFF_PIN` (leads are kept). |
| **Everything is broken** | | Switch to the recorded run (below). If that fails too: swap to the spare laptop. |

## Switch to the recorded run (safe mode)

Use this when the live system keeps failing, or while you fix it with an audience in front of you.

1. Presenter console: the **safe-mode switch** (recorded backup run). Confirm. Or from a terminal: `curl -X POST http://127.0.0.1:7079/safe-mode -H "content-type: application/json" -d "{\"on\":true}"`.
2. The big screen shows **RECORDED RUN - not live** and plays the recorded outage story in a loop. The kiosk says "The live demo is taking a short break." Visitor leads are kept.
3. **Be honest:** "This is a recording of the same demo while we fix the live one." Never present it as live.
4. To return: the same switch (or `{"on":false}`): a fresh live system starts, like a reset.
5. If safe mode will not start: Ctrl+C in terminal 1, then `npm run booth:replay -- --name backup` starts only the recorded run (Ctrl+C to stop).
6. If it says there is no recording: you did not record one. Use the spare laptop, or present from the slides. Record one at the next break (see the setup checklist).

## Erase one visitor's lead (quiet moment)

```
curl -X GET  -H "X-Booth-Staff: <PIN>" http://127.0.0.1:7072/api/booth/leads
curl -X DELETE -H "X-Booth-Staff: <PIN>" http://127.0.0.1:7072/api/booth/leads/<id>
```

The first command prints personal data on the screen: do it away from visitors. The id is the `id` field of
the lead whose name matches.

## Escalation

1. Presenter tries the table above (2 minutes at most).
2. Call the **team lead** (number on the PIN card).
3. Team lead decides: safe mode, spare laptop, or pause the demo and put up the "Back in 10 minutes" sign.
4. After the event: write what happened in the rehearsal notes so the playbook gets better.
5. Anything involving **personal data** (a lead shown to the wrong person, a lost laptop, a lost export file) goes to the team lead and the data-protection contact immediately.

## What to collect for engineers afterwards

The time; what was on screen; the last 30 lines of terminal 1 (copy them, they contain no visitor data);
`curl http://127.0.0.1:7079/status`. Do not send lead files or screenshots of the leads list.
