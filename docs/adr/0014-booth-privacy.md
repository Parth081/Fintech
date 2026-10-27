# ADR 0014: Booth privacy - leads stay on the laptop

- **Status:** Accepted (M5)
- **Date:** 2026-10-27

## Context

Booth mode collects visitor contact details (leads) at the kiosk and counts what visitors do (anonymous
analytics) to tell the team which scenarios and questions land. These are real people's personal data on a
demo laptop at a public event, while everything else in the system is synthetic.

## Decision

1. **Local only.** The booth service (`services/booth`) stores leads and analytics in embedded PGlite under
   `DATA_DIR/booth` and makes no outbound requests. `verify:m5` scans `services/booth/src` for HTTP/socket
   clients and non-local URLs and fails if it finds one.
2. **Explicit consent.** A lead is accepted only with `consent: true` and the exact consent sentence shown
   to the visitor (stored with the time of consent), and with a valid email. Otherwise 400.
3. **Staff-only access.** Listing, CSV export, summary and deletion require the staff PIN in
   `X-Booth-Staff` (`BOOTH_STAFF_PIN`, demo default 2468, to be changed per event). The gateway passes the
   header through to the booth; nothing else.
4. **Anonymous analytics.** Events carry a random per-visit session id (reset on idle) and refuse anything
   that looks like personal data (name/email/phone keys or values). Leads link to engagement only through
   that session id.
5. **Leads survive resets; deletion is deliberate.** A demo reset stops and wipes everything except
   `DATA_DIR/booth`, and the booth process keeps running through it. Leads are removed only by staff
   (`DELETE /leads/:id`, right to erasure) or `npm run booth:clear-leads` (typed confirmation).

## Consequences

- Resetting the demo all day never loses the day's leads; the staff must export and clear them at the end.
- In Docker the leads live in the `booth-data` volume; `docker compose down -v` deletes them.
- The PIN is a booth-grade control, not authentication: the laptop itself must stay with the team.
