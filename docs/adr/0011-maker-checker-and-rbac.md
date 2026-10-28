# ADR 0011: Maker-checker (four-eyes) and role-based access

- **Status:** Accepted (M4)
- **Date:** 2026-10-27

## Context

On a real payment platform, one person must not be able to move risky money or change risk controls
alone. Regulators expect segregation of duties: one person makes a request and another person checks it.
The demo has no identity provider and has to run offline, but it still has to show this behaviour.

## Decision

- **Demo identities, real authorisation.** `POST /auth/login { userId }` signs in as one of the fictional
  demo users (no password: a simulation). It returns a bearer token that is stored hashed and expires.
  Every other ops route needs the token, so a missing or expired token gets 401.
- **Roles map to permissions** (`ROLE_PERMISSIONS` in `@ct/contracts` ops-api.ts) and each route asks for
  exactly one permission (403 otherwise):

  | Role | Demo users | Can |
  |---|---|---|
  | ops_analyst | Maya Chen | search payments, retry failed, request refunds |
  | compliance_analyst | Daniel Okafor, Amara Nwosu | work cases, decide (propose for high/critical) |
  | compliance_manager | Priya Raman, Tomas Lindqvist | approve case decisions and refunds, read audit |
  | treasury | Lucas Meyer | reconciliation breaks |
  | admin | Sofia Alvarez, Ken Adeyemi | request and approve configuration changes |
  | auditor | Hiro Tanaka | read everything, including the audit trail; change nothing |

- **Four-eyes where the risk is.**
  - Case decisions on **high/critical** cases become a *proposal* (`pending_approval`). Only a user with
    `cases.approve` other than the proposer can approve it, and the proposer gets 403. Low/medium
    decisions take effect directly.
  - **Refunds** are requested by operations and approved by a manager. The requester cannot approve their
    own request.
  - **Configuration changes** (risk thresholds, routing weights, provider on/off, forced breakers) are
    change requests. The value is validated when it is requested and again when it is approved: a change
    can never disable every provider of a corridor. A second admin must approve it. Only the approval
    publishes `control.config.updated` (ADR 0010).
- **Both names are kept.** Events carry `actor` (the maker) and `approvedBy` (the checker). Audit rows are
  written by whoever called the API, so the trail shows both steps.

## Consequences

- + Segregation of duties can be shown and tested: `verify:m4` checks that the proposer, a same-role
  colleague and the auditor are refused, and that the approval by a second person takes effect.
- - Demo sign-in is not authentication. A real deployment would put an identity provider in front and
  keep the same roles, permissions and four-eyes rules.
- - The four-eyes threshold (high/critical) is fixed in code (`needsFourEyes`). It is not configurable,
  on purpose: the rule that protects the controls is not a control itself.
