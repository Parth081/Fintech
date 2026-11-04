# Staff guide: handling visitor leads

Visitors can leave their name, company, work email, optional role and an area of interest on the kiosk.
That is **real personal data** on a laptop in a public place, while everything else in the demo is made up.
Handle it carefully. This page is operating guidance, not legal advice; the legal review pack lists what the
reviewer must confirm.

## What the kiosk does

- The form appears only **after** the visitor has seen a payment delivered, and is entirely optional ("Skip").
- The consent tick box starts **unticked**. The system refuses a lead without it.
- The sentence shown next to the box is exactly:

> We'd like to email you about this demo. We store your details on this booth laptop only and delete them after the event. You can ask us to delete them at any time.

- Leads are stored on this laptop only (folder `.data/booth`). The booth service makes no outbound
  connections. A demo **reset never deletes leads**.
- Usage counts (which scenario, which question) are anonymous: a random visit id, no names or emails.
- Only people with the **staff PIN** can list, export or erase leads. The PIN must not be the public demo
  default 2468 (`npm run booth:preflight` warns).

## What to tell visitors

- "It is optional. If you leave your email we will send you a short follow-up about this demo."
- "Your details stay on this laptop, and we delete them after the event. If you want them gone sooner, tell me and I will remove them today."
- "Nothing you type on the demo screens is sent anywhere else."
  (True for the booth service and the kiosk. Do not say it about anything you do afterwards with the exported file: see the open question in the legal pack.)

Do not promise anything the sentence does not say: no newsletters, no sharing, no price lists.

## During the day

- Never open the leads list where visitors can see the screen.
- Never type a visitor's details for them. They enter their own.
- If a visitor asks you to delete their details: note their email, then at a quiet moment follow "Erase one lead" in the [failure playbook](failure-playbook.md), or erase all at end of day. Tell them when it is done.
- If a laptop is lost or a lead list is shown to the wrong person: tell the team lead at once.

## End of every day

1. Keep the system running (the export needs the booth).
2. In a second terminal, with the PIN in the environment (best, keeps it out of the history):
   - PowerShell: `$env:BOOTH_STAFF_PIN="<PIN>"`
   - Git Bash: `export BOOTH_STAFF_PIN=<PIN>`
3. `npm run booth:export-leads`
   - Saves `leads-<date>.csv` in the current folder (use `--out <file>` to choose). It refuses to overwrite (add `--force`).
   - Prints how many leads were saved, the booth summary (visits, leads, top scenarios and questions). It never prints the PIN or any visitor's details.
   - If it says the booth is unreachable or the PIN was not accepted, nothing was written.
4. Open the file and check the number of rows matches what the command printed.
5. Move the file to the agreed place (see below) and delete the copy in the project folder. **Do not commit it to git, email it, or put it on a shared drive.**
6. When the file is safe, delete the leads from the booth: `npm run booth:export-leads -- --out leads-<date>-b.csv --erase` and type `DELETE` when asked. It saves again first, then erases exactly the leads that were exported. (Or stop the system and run `npm run booth:clear-leads`, which also deletes the anonymous usage counts.)
7. Check: run `npm run booth:export-leads -- --out check.csv` and see "Saved 0 leads"; delete `check.csv`.

## Where the file goes, how long it is kept

These must be decided by the event owner and the data-protection contact **before** the event, and written here:

| Question | Decision |
| --- | --- |
| Where do exports go (system, folder, who has access)? | ____________________ |
| Who sends the follow-up email and by when? | ____________________ |
| How long are the exported leads kept? | ____________________ |
| Who answers a visitor's request to delete or see their data? | ____________________ |
| Data-protection contact (name, address) | ____________________ |

## What the CSV contains

`id, createdAt, name, company, role, email, interest, consentAt, consentText, scenarios, questions, dwellSeconds`.
The consent sentence and the time of consent are stored with each lead as evidence. A cell that starts with
`=`, `+`, `-` or `@` is prefixed with an apostrophe so a spreadsheet cannot run it as a formula.
The file mode is user-only on macOS/Linux; on Windows it follows the folder permissions, so keep it in your
own user folder.

## Docker and spare laptops

In Docker the leads live in a volume; `docker compose down -v` deletes them. If you copied `.data/booth` to
the spare laptop, it holds visitor data too: export and erase it with the same routine.
