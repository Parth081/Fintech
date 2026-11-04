# Booth setup checklist

Tick every box. Where a box has a command, the expected result is next to it. Items marked **(human)** can
only be checked by a person looking at the real hardware.

## A. A week before (with internet)

- [ ] Legal/compliance reviewer has been given [legal-review-pack.md](legal-review-pack.md) and has signed the table, or the team lead has recorded in writing what is still open. **(human)**
- [ ] `git pull` (or copy the agreed version) onto the booth laptop and the spare laptop; note the version (`git log -1 --oneline`).
- [ ] `npm install` finished without errors on both laptops.
- [ ] Choose the event's **staff PIN** (4+ characters, not 2468). Write it on the team lead's card, not on the laptop.
- [ ] Decide AI mode: `npm start -- --llm off` (recommended: fully offline, grounded answers) or the default (Claude phrases answers only while the internet works).

## B. Day before (still with internet if possible)

- [ ] Laptop: mains power, battery health OK, updates installed **and automatic updates paused for the event days**, sleep set to Never, screen saver off, notifications off. **(human)**
- [ ] Set the PIN in the terminal you will start from:
  - PowerShell: `$env:BOOTH_STAFF_PIN="<PIN>"`
  - Git Bash: `export BOOTH_STAFF_PIN=<PIN>`
- [ ] `npm run build:web` (builds the screens; works offline).
- [ ] `npm run verify:copy` ends with `Copy check passed`.
- [ ] `npm run booth:preflight` shows no `[FAIL]`. Read every `[WARN]`: the usual ones are "no recording yet" (fixed below) and "built screens older than sources" (run `npm run build:web`).
- [ ] **Record the backup run** (safe mode needs it). Terminal 1: `npm start -- --llm off`. Terminal 2: `npm run booth:record -- --name backup --scenario provider-outage --duration 90`. Wait for it to finish. Then stop the system (Ctrl+C in terminal 1).
- [ ] Test the recording: `npm run booth:replay -- --name backup`, open http://127.0.0.1:7072/#/stage, see **RECORDED RUN - not live** and moving traffic. Ctrl+C.
- [ ] `npm run booth:preflight -- --hot-spare` and follow the printed steps to prepare the spare laptop. Run the spare's own preflight.
- [ ] Leads folder is empty: preflight says "No leads folder yet". If it warns that `.data/booth` exists, decide: export what you need (`npm run booth:export-leads`), then `npm run booth:clear-leads` with the system stopped.
- [ ] Print: [failure-playbook.md](failure-playbook.md), the runbook scenario table, and the PIN card.

## C. Hardware at the booth (morning of, 60 minutes before opening)

- [ ] **Big screen** connected; set to native resolution: **4K (3840x2160) or 1080p (1920x1080)**; display scaling 100% on the big screen. **(human)**
- [ ] If the big screen is a second display: Windows Settings > Display > **Extend** (not duplicate); the big screen's browser window is on it. **(human)**
- [ ] **Touch screen** (kiosk): cursor/touch calibrated, tap targets reachable, on-screen keyboard appears when a form field is tapped. Edge swipes and multi-finger gestures disabled if the OS allows. **(human)**
- [ ] Cables: power, display, touch USB; spare display cable in the bag. **(human)**
- [ ] **Network off**: turn Wi-Fi off and unplug Ethernet. The booth needs no internet. (If you chose Claude phrasing, the explainer falls back to grounded answers.)
- [ ] Sound muted; Bluetooth off. **(human)**
- [ ] Browser windows: big screen window full-screen (F11) on `#/stage`; kiosk window full-screen on `#/kiosk` on the touch screen; presenter console in a normal window on the laptop. Zoom 100%, bookmarks bar hidden, password-save prompts off. **(human)**
- [ ] Spare laptop in its bag, charged, labelled SPARE.
- [ ] A printed sign at the kiosk: the consent notice is on the form itself; also see [staff-lead-handling.md](staff-lead-handling.md).

## D. Start-up (45 minutes before opening)

1. Close every other program (browsers, chat, cloud sync).
2. `npm run booth:preflight` shows no `[FAIL]`.
3. `npm start -- --llm off` (with the PIN variable set in this terminal). Wait for the banner with the URLs.
4. Open the three windows from section C. Big screen shows live traffic; **Live status** shows the ledger balanced.
5. Send one payment on the kiosk, tap **Ask why** once, then **Start over**. Do **not** submit the lead form with real data; test it only with a fictional visitor `Test Person / Test Co / test@example.com` and erase it afterwards (see below).
6. Press **RESET DEMO** once to confirm it comes back ("System is back").
7. Presenter console: **Attract loop = On**.
8. Erase the test lead: stop nothing; run `npm run booth:export-leads -- --erase` (it saves a file named for today; delete that test file afterwards).

## E. Rehearsals: how many

- **Two full dress rehearsals** from [dress-rehearsal-script.md](dress-rehearsal-script.md): the first on the day before at the booth (or an identical set-up), the second the morning of, in full costume, with Wi-Fi off.
- Rehearsal 2 must be **entirely free of hard failures** (a hard failure = anything on the script marked HARD that fails). Any HARD failure in rehearsal 2 means: fix, then run rehearsal 2 again.
- **Everyone who will present runs the 3-minute demo once** during rehearsal.

## F. End of each day

- [ ] `npm run booth:export-leads` (see [staff-lead-handling.md](staff-lead-handling.md)): file saved, count matches what the team saw.
- [ ] Copy the file to the agreed secure place (not email, not a shared drive); then `npm run booth:export-leads -- --erase` or `booth:clear-leads`.
- [ ] Stop the system with Ctrl+C. Charge the laptops.
