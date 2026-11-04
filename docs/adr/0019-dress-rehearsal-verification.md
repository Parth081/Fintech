# ADR 0019: Dress-rehearsal verification (`npm run verify:m6`)

Status: accepted (M6, Gate 3: "no hard failures in rehearsals")

## Context
Gate 3 asks for rehearsals without hard failures. A physical rehearsal cannot be automated, but most of what
goes wrong at a booth can: services crashing, a visitor walking away mid-flow, a reset in the middle of the
day, the backup recording, leads, and the promise that nothing leaves the machine.

## Decision
One command launches the whole system itself (supervisor on, ambient traffic on, assistant LLM off, ports
38070-38079, temp data dir) and runs, in order: preflight; scripted virtual kiosk visitors; chaos with
self-healing; demo resets under load; safe-mode round trips; copy check; lead export and erase. The offline
check runs in the background through all phases. `--quick` (CI) shrinks every count: 10 visitors, one kill
per class, one reset, one round trip.

- **Visitors** (`m6-visitors.ts`) are seeded scripts (same seed, same visitors) that call the gateway exactly
  like the kiosk and reuse the kiosk's own pure modules (payment body, lead form, session ids, explain
  helpers). They pay (a third with the provider-fail mode), poll, ask the assistant, post analytics, submit
  leads with consent, abandon, overlap, and idle. A failed POST is retried with the same idempotency key, as a
  visitor tapping again would.
- **Chaos** kills every service class with `crash()` (kill -9 of the process tree, not marked intentional)
  and never calls `restart()`. Recovery bound: **15 s** (`--recover-bound`), measured from the kill until
  `health()` shows the service running, with a higher restart counter and, for HTTP services, `/health` 200.
  Stage processes have no health URL, so for them "recovered" means running again. Afterwards the M2
  invariants are applied to the whole log (terminal, no duplicates, valid walks, one journal per reconciled
  payment, ledger balanced, rejectedEvents 0) plus the restart policy and lead survival. The broker is
  killed at least once.
- **Resets** must finish in under 10 s, keep leads and leave the system healthy.
- **Safe mode**: a 30-40 s provider-outage run is recorded from the live system, then `/safe-mode` on/off is
  exercised: mode reported within 10 s, events and counters keep moving, payment POSTs answer 503 "demo
  paused", leads and the explainer still work, the recorded outage is visible, and back in live mode a
  payment completes.
- **Offline proof** lists TCP sockets (netstat -ano on Windows, ss/lsof elsewhere) owned by this process
  tree (the launcher runs in-process) every few seconds and fails on any non-loopback peer or any listener
  bound off loopback. UDP/DNS and processes outside the tree are out of scope.
- Parsers, the recovery analyser, the planner, the script generator and the report builder are pure and
  unit-tested on synthetic data (`tools/verify/m6.test.ts`); `tests/e2e/m6-rehearsal.test.ts` runs the quick path.

## Consequences
The report is a JSON file plus a per-check table; exit code is non-zero on any failed check. A pass prints
"GATE 3 (software part) PASSED". Software cannot prove: rehearsal on the event hardware and venue network,
legal review of the consent text and retention promise, real visitor behaviour on the real touch screen.
Provider failures are off (`providerFailureScale 0`) so a visitor payment has one expected outcome; the
outage story is covered by the recorded provider-outage run and the kiosk's provider-fail mode.
