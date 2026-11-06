# ADR 0020: Cloud deployment as a reusable sales asset

- **Status:** Accepted (M7)

## Context
The booth demo is built for one offline laptop. Between events it is useful to share a live copy with
prospects. This is a demo of simulated, synthetic data, not a production service.

## Decision
- A separate cloud profile (`deploy/docker-compose.cloud.yml`, `deploy/Dockerfile.cloud`); the local
  compose file and Dockerfile are unchanged.
- Multi-stage image, non-root user, root-owned code, only `/data` writable. The image does not set
  `HOST`, so it defaults to 127.0.0.1; compose sets `HOST=0.0.0.0` explicitly, inside the private network.
- Caddy is the only published port and serves the UI, REST and `/ws` through the gateway. Default bind is
  127.0.0.1; exposing it is an explicit `PROXY_BIND`. Optional basic auth (`PROXY_MODE=auth`) for prospects;
  automatic HTTPS when `SITE_ADDRESS` is a domain.
- Embedded PGlite on volumes by default; Postgres and Redpanda are opt-in profiles. `BOOTH_STAFF_PIN` has no
  default in this profile (compose refuses to start without it).
- No launcher in containers, so reset and safe-mode switching are unavailable (as in the local compose file).

## Consequences
Basic auth is a gate for a demo, not an identity system. Prospects can use presenter controls once past it.
Nothing here is a compliance or security certification. Untested on a real cloud host as of writing; see
`docs/cloud/README.md` for what was and was not verified.
