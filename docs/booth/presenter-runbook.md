# Presenter runbook

How to run the demo. Everything below was written from the real screens and the real scenario narration
(`services/orchestrator/src/scenarios*.ts`, `attract.ts`, the presenter console). If a screen differs from
this page, trust the screen and tell the team lead so this page can be fixed.

**Say it once at the start of every conversation:** "This is a simulation on made-up data. The banks, the
providers (Orion, Lyra, Vega) and the customers are fictional." The screens also say SIMULATION.

## 1. The three screens

| Screen | Address | Who uses it |
| --- | --- | --- |
| **Big screen** | `#/stage` | Everybody; runs by itself when idle (attract loop) |
| **Kiosk** | `#/kiosk` | Visitors, by touch. Starts over after 60 s without a touch (a "Still there?" box appears for the last 15 s) |
| **Presenter console** | `#/presenter` | You. Open it in a separate browser window on the laptop |

The presenter console and the other screens run on the booth laptop only (they listen on 127.0.0.1). A
tablet cannot open them unless the team changes the setup, which has not been rehearsed; use a second
window on the laptop.

### Presenter console, panel by panel

| Panel | What it does | When to use it |
| --- | --- | --- |
| **Scenarios** | One card per scenario with a **Start** button. Starting one takes over from the attract loop. | Start of every demo |
| **Now** (appears while running) | Which step the scenario is on, with the narration text and a **Stop** button | Read the narration from here |
| **Attract loop** On / Off | On: the big screen plays its own 90-second story after the booth has been idle (default 2 minutes). Off: it stays on live traffic. | Off during a client meeting, On when you walk away |
| **Ask why** (Payment / Scenario / System) | The AI explainer. Pick what you are asking about, tap a suggested question or type one. | After a scenario, or when a visitor asks "why" |
| **Live status** | Active outage, payments in flight, reconciled count, ledger balanced or not | To show "nothing was lost" |
| **Controls: Ambient traffic** Off / Calm / Busy | How many background payments run | Calm for talking, Busy for a lively screen, Off to isolate one payment |
| **Controls: Pace** Normal / Slow-motion / Fast | Changes delays only, never decisions | Slow-motion for a technical audience |
| **Pause / Resume** | Freezes the scenario and traffic | When a visitor asks a long question |
| **Jump to explanation** | Opens the explanation of the re-routed payment on the big screen. **Close drawer on big screen** closes it. | In the outage scenario, at "Breaker trips" |
| **RESET DEMO** | Asks "Reset the demo?"; **Reset now** wipes payments and restarts the services in about 5 to 10 seconds. **Visitor leads are not deleted.** | Between audiences; whenever the screen looks odd |

## 2. Before every demo (20 seconds)

1. Presenter console shows no red banner and the connection says **Live**.
2. The ledger line under **Live status** says balanced.
3. If anything looks odd, press **RESET DEMO** and wait for "System is back".

## 3. Scenario guide

Durations are the scripted lengths. The narration text appears in the **Now** panel; the lines below are the
talking points, in the order the scenario shows them.

| Scenario | Length | One-line idea |
| --- | --- | --- |
| Provider outage: Orion goes down | 72 s | A payment partner fails and nothing is lost |
| Partial failure: Orion gets unreliable | 48 s | The same, but harder to spot |
| Fraud ring | 60 s | Risk catches a mule pattern; people decide |
| Sanctions hit | 42 s | Fuzzy name matching holds the payment; a manager must approve |
| Currency spike | 60 s | Quotes widen when the market is jumpy, then tighten |

### Provider outage (72 s) - the main story

| Time | Step | What the audience sees | What you say |
| --- | --- | --- | --- |
| 0 s | Normal day | Payments flowing on three corridors (US to India, UK to Philippines, Germany to Brazil) | "Payments flow between the US and India, the UK and the Philippines, and Germany and Brazil. Most go through Orion, our fastest partner." |
| 10 s | Orion goes down | Orion turns red | "Orion just failed. Every payment we hand to it is refused. Watch the circuit breaker." |
| 18 s | Breaker trips, traffic re-routes | Traffic moves to Lyra and Vega on the map | "The breaker tripped. We send payments through Lyra and Vega, and refused ones are retried elsewhere, so nobody is left waiting." **Tap Jump to explanation** and read the reason on the big screen. |
| 35 s | Orion comes back | Orion recovers | "Orion works again, but we do not trust it straight away." |
| 42 s | Testing Orion carefully | Breaker half-open | "Only a few test payments go to Orion. If they get through, it earns its traffic back." |
| 55 s | Back to normal | Traffic returns to Orion | "It passed its tests. Traffic is flowing back." |
| 63 s | What the ledger proves | Ledger balanced | "Every payment is accounted for. The ledger balances to the cent: nothing lost, nothing counted twice." Point at **Live status**. |

Then ask the explainer: "What happened during the outage?" or "Was any payment lost?". Say: "Every number it
shows has a citation; it answers only from what the system recorded."

### Partial failure (48 s)

Normal day (0 s); Orion becomes unreliable and refuses about six in ten payments (8 s); the breaker counts
failures and opens (16 s); Orion healthy again (30 s); summary (40 s). Say: "Partial failure is harder than
a full outage because it does not look broken. The breaker handles both the same way."

### Fraud ring (60 s) - for compliance and risk people

Normal day (0 s). Eight brand-new accounts each send just under 10,000 dollars to one company in India
(6 s): "One payment like this looks harmless. Eight in a row do not." A collector account splits money out to
six new recipients (20 s). Alerts and cases appear (30 s). The investigator view (42 s): each reason with its
weight, linked payments, no black box. Summary (52 s): "Held payments have not moved a cent. Nothing is posted
to the ledger until a human decides." To go further, open the operations console as Daniel (compliance
analyst) and show the four-eyes rule (README, "Investigator walkthrough").

### Sanctions hit (42 s)

Normal day (0 s). A payment to a company spelled slightly differently from a listed one (5 s): "Fuzzy
matching does not fall for small spelling changes." A sender whose name closely matches a listed person
(12 s). Both held with the list entry and match score (20 s). Four eyes (30 s): "An analyst can recommend,
a manager has to approve. If rejected, no money moves." Always say: **the sanctions list is fictional.**

### Currency spike (60 s)

Calm market (0 s). The pound jumps against the peso and prices swing four times more (8 s). Spreads widen
automatically (16 s): "The wider margin is a safety buffer, and the customer still gets a firm price."
The market calms (36 s). Back to normal pricing (44 s): "Every payment settled and the ledger balances in
every currency."

## 4. The kiosk (what a visitor does, about two minutes)

1. **Welcome:** "Move money across the world. See every decision it takes." Two big buttons: *Send a payment across the world* and *Watch what happens when a provider fails*.
2. **Choose:** a corridor, then an amount; **Send**.
3. **Track:** the payment is followed step by step in plain English; each step has an **Ask why** button.
4. **Done:** "Delivered, ledger balanced". The visitor may leave their details (optional, with a consent tick box), start the other demo, or finish.
5. **Thanks:** returns to the welcome screen after 15 s, or after 60 s without a touch.

Stay a step away while a visitor uses it; walk over when they finish. Never type for them into the form.

## 5. Demo scripts

### 3-minute demo (a passer-by)

1. (0:00) Point at the big screen: "A simulated cross-border payment platform. Everything on it is made up."
2. (0:20) Presenter console: **Start** *Provider outage*. Read steps 1 and 2 from the **Now** panel.
3. (1:00) At "Breaker trips, traffic re-routes" tap **Jump to explanation**. Read the reason aloud.
4. (1:40) At "What the ledger proves": point at the balanced ledger.
5. (2:10) **Ask why**: "Was any payment lost?" Show the citation chips.
6. (2:40) Invite them to the kiosk. If they have a card or an email address to share: they use the kiosk form themselves.

### 10-minute demo (a buyer's team)

1. (0:00) Introduction and the fictional-data sentence. Ask what they build or run.
2. (1:00) *Provider outage* in full (72 s), with the talking points above and **Jump to explanation**.
3. (3:30) **Ask why** (Scenario tab): "How did the circuit breaker react?"
4. (4:30) Switch to the audience's interest:
   - risk and compliance: *Sanctions hit* (42 s) then the operations console as Daniel and Priya (four eyes);
   - treasury and pricing: *Currency spike* (60 s);
   - engineering: set **Pace** to Slow-motion and click through a payment in `#/live`.
5. (8:30) Show **Live status**: ledger balanced. "That is checked on every run by `verify:m3`."
6. (9:00) Next step: "We can build this against your own rules." Offer the kiosk form for follow-up.

### 20-minute demo (a technical or compliance deep dive; book a quiet slot)

1. (0:00) Context and audience.
2. (2:00) *Provider outage* with **Pace: Slow-motion**; open one payment's decision trace in `#/live`.
3. (6:00) *Partial failure* (48 s): "harder to spot".
4. (8:00) *Fraud ring* (60 s), then the operations console: Daniel assigns and proposes release, tries to approve (refused), Priya approves.
5. (14:00) *Sanctions hit* (42 s), manager rejects: no ledger journal.
6. (17:00) **Ask why** (System tab): "Does the ledger balance?" Explain the citations.
7. (19:00) Questions; the FAQ covers the usual ones. Reset before the next audience.

## 6. What to say to whom

| Audience | They care about | Lead with | Avoid |
| --- | --- | --- | --- |
| **Banker / payments operations** | Not losing money, audit, who approved what | Outage story, ledger balance, four eyes, audit trail in the console | Promising it replaces their core system |
| **CTO / architect** | How it is built, failure behaviour | Event log (one ordered log, each stage its own process), idempotent events, slow-motion pace, the decision trace on each event, `verify:m2` and `verify:m3` | Hand-waving; say "simulated" where it is |
| **Marketplace / platform founder** | Paying sellers abroad cheaply and reliably | Routing across providers with a reason for each choice, the currency spike, the kiosk "send a payment" | Fee or savings numbers: the figures here are simulated |
| **Compliance / risk lead** | Explainability, human decisions | Fraud ring and sanctions hit, reasons with weights, four eyes | Calling anything "compliant" or "approved" <!-- copy-check:allow forbidden-claim -- the Avoid column names the banned word --> |

### Words never to use

Do not say the system is *compliant*, *certified*, *guaranteed*, *bank-grade* or *regulator-approved*, and
do not name real banks, card networks or payment companies as partners or users. Say "it demonstrates",
"supports", "in this simulation". If asked, use the FAQ answers. (`npm run verify:copy` enforces this for
everything on screen and in these documents.)

## 7. Pace, pause, attract loop, reset: quick rules

- **Slow-motion** for explaining; **Fast** to skip waiting; **Normal** for the rest. Decisions never change.
- **Pause** when a visitor asks something long; **Resume** after.
- **Attract loop On** whenever nobody is at the booth; **Off** during a one-to-one meeting so the big screen does not change under your hands.
- **Reset** between audiences, or whenever something looks off. It takes about 5 to 10 seconds and keeps leads.
- Starting a scenario while the attract loop plays is fine: it takes over.
- If the screen shows **RECORDED RUN - not live**, the backup run is playing. Say so honestly: see the failure playbook.

## 8. Do and do not

Do: say "simulated"; let visitors touch the kiosk; use **Ask why** to show citations; admit what is not built.
Do not: promise dates or prices; show the operations console to a passer-by (it is a back-office tool with demo users); read out a visitor's details; leave the laptop unattended with the presenter console open.
