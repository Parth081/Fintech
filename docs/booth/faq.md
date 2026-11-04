# Visitor and buyer FAQ

Honest answers, in the words a presenter can use. If you do not know, say so and offer to find out; do not
guess. Evidence for each factual answer is in [claims-register.md](claims-register.md).

**Is this real?**
The software is real: separate services, one ordered event log, a real double-entry ledger, real message
formats. The world around it is simulated: the customers, banks, providers (Orion, Lyra, Vega), exchange
rates and the sanctions list are all made up. No real money moves.

**Does it use real data?**
No. Everything is synthetic. The only real data at the booth is what a visitor chooses to type into the
optional follow-up form on the kiosk, and that stays on this laptop.

**Is it compliant?** (or: "certified", "approved", "bank-grade")
No, and we do not claim that. It is a demonstration. It shows how a platform can screen payments, hold
suspicious ones, ask for a second person's approval and keep an audit trail, but it has not been certified or
approved by any regulator, auditor or standards body. A real deployment would go through that process for the
client's own rules.

**Does it run on real banks or networks?**
No. The providers are fictional. We do not name real banks or payment companies on the screens because it
would suggest a relationship that does not exist.

**How does the AI avoid making things up?**
It does not decide anything, and it does not use general knowledge about payments. Each answer is built from
what the system recorded for that payment or scenario, and every number comes with a citation you can open
(which event, which field). If Claude is used to phrase the answer, every number in its text is checked
against those citations first; if the check fails, the plain recorded answer is shown instead. Questions
about anything else are politely declined. The booth can also run with the AI mode switched off (grounded
answers only, no internet).

**Does the AI see my data?**
The explainer reads the simulated payments only. It never reads the follow-up form. In the optional Claude
mode, the question typed by the visitor is sent to the model provider, so do not type personal details into
it. With the offline mode nothing leaves the laptop.

**What happens to my details if I fill the form?**
They are stored on this laptop only, you can ask us to delete them at any time, and we delete them after the
event. Leaving them is optional. (Exact sentence: [legal-review-pack.md](legal-review-pack.md).)

**Is it safe? Could it be hacked?**
It is built to run on one laptop for a demo. It listens only on the local machine and is not designed to face
the internet. We do not claim it is secure against attack.

**Why did that payment go through Lyra and not Orion?**
Ask the explainer on the kiosk ("Ask why"). Routing scores each provider on reliability, cost and speed, and
records the reason for the choice; during the outage the breaker excluded Orion.

**Is the outage faked?**
The failure is injected on purpose (a scenario tells the simulated provider to refuse payments), exactly like
a test. Everything after that is the system reacting by itself: the breaker, re-routing, retries, recovery.
The reaction is not scripted.

**Is the speed real?**
We slow things down on purpose so people can watch (about 0.4 s per step). Our own test with the delays off processed about 56 payments per second end to end on a laptop (500 payments, 2026-11-05), but that figure is for the simulation and does not
predict production performance.

**Can it handle our volume?**
We do not know yet. The proof we have is 10,000 payments on one laptop with the ledger balancing. Sizing for
a real deployment is part of a project.

**What would it take to build ours?**
Start with a workshop on your flows, rules and providers first. Then a proof of concept against your
sandbox providers using this platform as a base. Production needs security
review, formal approvals, your compliance team and operations: those are the client's and ours together.
We do not quote a date or price at the booth; leave a contact and we will follow up. (Presenters: do not
promise timescales.)

**Which technologies?**
TypeScript on Node, React for the screens, an event log with an adapter for Kafka or Redpanda, Postgres for
the ledger (embedded offline), ISO 20022 message formats. Docker is optional.

**Does it support our currency / country?**
The demo shows three corridors: US to India, UK to the Philippines, Germany to Brazil. Others can be added.

**Can we try it?**
Yes, on the kiosk: send a payment, or watch a provider fail. Take your time.

**Who are you?**
Say the company name the event owner gave you, and that the booth shows a demonstration built by the team.
(The legal name is not on the screens: see the open point in the legal pack.)

**Can I take a photo of the screen?**
Yes. Please do not photograph other visitors' details on the form.

## Questions to hand to someone else

Legal or regulatory questions, pricing, contracts, data-protection requests: take the person's card or let them use the
form, and pass it to the team lead. Do not improvise.
