# Prospect-specific scenarios in under a week

A scenario pack is one JSON file that tells the orchestrator what story to run: narration steps, traffic per
corridor, a provider outage or FX shock on the control timeline, and what you expect to see. It needs no code
change to any stage. Design background: [ADR 0022](adr/0022-prospect-scenario-packs.md). Wording rules:
[ADR 0018](adr/0018-copy-and-claims-policy.md).

Everything stays a simulation with synthetic, fictional data. Do not put a prospect's real name, brand or data in a
pack.

## Quick start

```
npm run scenario:new -- --name acme-acceptance --audience psp     # psp | bank | marketplace
# edit services/orchestrator/src/packs/active/acme-acceptance.pack.json (replace every TODO)
npm run scenario:check -- services/orchestrator/src/packs/active/acme-acceptance.pack.json --trace
npm start                                                         # the scenario appears in the presenter console
```

`npm run scenario:check` with no file checks every pack in `packs/active` and `packs/examples`.
Two finished examples to copy from live in `services/orchestrator/src/packs/examples/`:

| Pack | Audience | Story |
| --- | --- | --- |
| `psp-acceptance-recovery` | psp | a partner refuses most instructions, routing adapts, the partner is brought back carefully |
| `bank-sanctions-backlog` | bank | a burst of near-match names builds a review queue that needs a manager's approval |

To try an example without writing anything, copy it into `packs/active/`. Set `PACKS_DIR` to load packs from
another folder (the orchestrator loads once, at start; restart it after changing a pack).

## Pack format

```jsonc
{
  "schemaVersion": 1,
  "name": "acme-acceptance",          // lower-case slug = scenario id = file name (acme-acceptance.pack.json)
  "title": "...", "audience": "psp",  // psp | bank | marketplace
  "description": "...",               // what happens and what to notice
  "durationMs": 66000,                // 10 s to 5 min; the last crafted payment must be sent before this
  "seed": "optional text",            // changes the generated names and amounts
  "steps": [
    { "id": "baseline", "atMs": 0, "title": "...", "narration": "what the presenter says",
      "events": [ /* see below */ ] }
  ],
  "expected": [
    { "id": "outage-opens", "text": "...", "check": { "kind": "event", "type": "provider_outage.started" } },
    { "id": "cases-appear", "text": "..." }   // no check = a person confirms it in rehearsal
  ]
}
```

Events (all optional, per step):

| `type` | Fields | Effect |
| --- | --- | --- |
| `traffic` | `label`, `corridor` (US-IN, DE-BR, GB-PH), `count` (1 to 50), `amountMajor {min,max}`, `spacingMs`, `listedParty {side, count}` | crafted synthetic payments on one corridor; `listedParty` makes the first `count` name a party resembling a fictional sanctions-list entry |
| `ambient` | `rate` (0 to 50 per second) | background traffic rate; restored when the run ends |
| `provider_outage` | `providerId` (orion, lyra, vega), `mode` down or degraded, `failureRate` (degraded only), `reason` | provider stops or becomes unreliable |
| `provider_recovery` | `providerId` | provider works again (an outage left open fails the check) |
| `fx_shock` / `fx_shock_end` | `shockId`, `corridor`, `driftBps`, `noiseMultiplier`, `rampMs`, `reason` | market shock on one corridor |

Expectation checks: `payments` (`min`, optional `corridor`), `listed-parties` (`min`), `event`
(`provider_outage.started|ended`, `fx_shock.started|ended`).

Not available in a pack: approved configuration changes (the maker-checker flow in the ops console) and
per-corridor background rates. If the story needs them, show them live in the console after the pack's steps, and
say so in the narration, or ask engineering for a new action (needs an ADR).

## What `scenario:check` proves

- The pack parses, every field is in range, corridors and providers exist.
- The orchestrator would accept the script (step order, no outage or shock left open, payments end before the run).
- Title, narration, reasons and expectations pass the copy policy (no "compliant", "certified", "tamper-proof",
  "guaranteed", real brand names, and so on) and contain no `TODO`.
- A dry run, done twice, gives the same list of events and payments (same digest).
- Every expectation with a `check` holds in the dry run.

It does not prove what the pipeline will decide (held, released, rejected). Rehearse for that.

## Writing narration that passes review

- Describe what the system does on screen: "Screening holds both payments before any money moves."
- Say what is synthetic: "The numbers on screen are synthetic."
- Do not promise outcomes for the prospect: say "in this simulation", not "you will".
- Use fictional providers (Orion, Lyra, Vega) and generic terms ("a card network", "a bank"); never the prospect's
  or a competitor's brand.
- Use "append-only audit trail", not "tamper-proof". Denials ("not certified for any regulation") are allowed.
- Run `npm run verify:copy` as well when you add anything outside the pack file.

## Checklist for a build that fits in a week

**Day 1: story (half a day with the sales lead)**
- [ ] One sentence: what problem does the prospect have, and what should the audience notice?
- [ ] Pick the audience template and the nearest example pack.
- [ ] Choose corridor(s) closest to their real flows; write the 4 to 6 steps as bullet points.

**Day 2: scaffold and events**
- [ ] `npm run scenario:new`, then set timings (a whole run of 45 to 75 seconds works best at a booth).
- [ ] Add the outage, shock or listed-party traffic that creates the moment; keep payments per send under about 20.
- [ ] `npm run scenario:check -- <file> --trace` until it passes apart from TODOs.

**Day 3: narration**
- [ ] Replace every TODO with plain-English narration, one idea per step, under about 60 words.
- [ ] Write 4 to 6 expectations; add a `check` wherever the dry run can prove it.
- [ ] `npm run scenario:check` and `npm run verify:copy` both pass.

**Day 4: rehearsal on the real stack**
- [ ] `npm start`, run the scenario from the presenter console at normal pace, twice, with someone who did not write it.
- [ ] Confirm each expectation without a `check` by eye (breaker, cases, ledger). Fix timing, not the pipeline.
- [ ] Time it; trim steps that run long.

**Day 5: review and hand-off**
- [ ] Legal/claims read-through of the narration ([legal review pack](booth/legal-review-pack.md)); record sign-off there, not here.
- [ ] Open a pull request with the pack file; `npm run ci` passes.
- [ ] Optional: record a backup run (`npm run booth:record`) so a recorded version exists for safe mode.

Slack for days 6 and 7: re-rehearsal after feedback, a second audience, and the presenter walk-through.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Scenario missing from the presenter console | Orchestrator logs `scenario pack skipped: ...` at start; run `scenario:check` on the file. Restart after edits. |
| `pack.name must match the file name` | File must be `<name>.pack.json`. |
| `outage left open` | Add a `provider_recovery` for every `provider_outage` (and `fx_shock_end` for each shock). |
| `still sending at the end` | Reduce `count` or `spacingMs`, or move the step earlier. |
| `copy policy` finding | Reword; see the list above. A denial ("not certified") is accepted. |
