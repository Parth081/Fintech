# Cloud deployment (demo between events)

Run the Control Tower on a VM or container platform so prospects can open it in a browser.
It is a **simulation with synthetic data**. It is not a production payment system, it holds no real
customers, banks or money, and nothing here is a compliance or security certification.
Decision record: [ADR 0020](../adr/0020-cloud-deployment.md).

## What you get

| File | Purpose |
|---|---|
| `deploy/Dockerfile.cloud` | Multi-stage image, non-root, code read-only to the service user, only `/data` writable |
| `deploy/docker-compose.cloud.yml` | All services + Caddy proxy; health checks, `restart: unless-stopped`, `no-new-privileges`, dropped capabilities, log rotation |
| `deploy/caddy/Caddyfile.open`, `Caddyfile.auth` | Reverse proxy without / with basic auth |
| `deploy/cloud.env.example` | Every setting, copy to `deploy/.env` |

Only the proxy publishes a port. It forwards everything (UI, `/api`, `/ws`) to the gateway, so the whole
app lives on one origin and one port. The other services talk to each other on the private compose network.

## Verification status (read this first)

Tested on 2026-11-07 on one Windows laptop with Docker Desktop (engine 29.9.2), through the proxy:

- The image builds and the stack starts. Containers run as non-root, `/app` is read-only to the service user,
  and only the proxy publishes a port. Compose fails closed when `BOOTH_STAFF_PIN` is missing.
- UI, API and WebSocket work on one origin. A payment reaches reconciled, the provider-outage scenario runs, and
  ops sign-in, the explainer and lead capture work. Leads need consent and the set PIN; the public default PIN
  is refused.
- `kill -9` of routing, ledger, broker and gateway: each restarted by itself and the ledger invariants still held.
- `down` then `up` without `-v`: journals and leads survived.
- `PROXY_MODE=auth`: 401 without or with wrong credentials, and no WebSocket messages without credentials;
  `/healthz` stays open. Both Caddyfiles pass `caddy validate`.
- `--profile postgres --profile redpanda` with `BUS=kafka`: the same smoke test passed, with tables in Postgres
  and a `payments` topic in Redpanda.

**Not tested:** any real cloud host or Linux VM, automatic HTTPS with a real domain, long runs, a real external
load through the proxy, or `deploy/.env` auto-discovery (the test passed `--env-file`). Treat the first cloud
deploy as a trial and run the smoke test below.

**Known limits of this profile:**

- There is no launcher in containers, so reset, safe mode and the presenter's system-health card are unavailable.
  The presenter console says so.
- Without reset, the counters only clear by deleting the data: `down -v`. That includes the big screen's
  "Payments failed" tile, which counts payments stopped with nothing posted to the ledger, so it can show
  a non-zero value after an outage scenario.
- The event log and the data volumes keep growing while the stack runs. Plan to recreate them between prospects.

## 1. Single VM (Linux, Docker Engine with the compose plugin)

1. Create a VM, install Docker Engine and the compose plugin, and clone this repository.
2. Create the settings file:
   ```bash
   cp deploy/cloud.env.example deploy/.env
   ```
   Edit `deploy/.env`. At minimum set `BOOTH_STAFF_PIN` to a new value (compose refuses to start without it).
3. Decide on access:
   - **Private check** (default): proxy listens on `127.0.0.1:8080` of the VM. Reach it with an SSH tunnel:
     `ssh -L 8080:127.0.0.1:8080 user@vm`, then open http://127.0.0.1:8080.
   - **Shared with prospects** (recommended setup): a DNS name pointing at the VM, then in `deploy/.env`:
     ```
     PROXY_BIND=0.0.0.0
     PROXY_PORT=80
     PROXY_TLS_PORT=443
     SITE_ADDRESS=demo.example.com
     PROXY_MODE=auth
     BASIC_AUTH_USER=prospect
     BASIC_AUTH_HASH='<bcrypt hash>'
     ```
     Make the hash (the password is typed once and never stored in the repo):
     ```bash
     docker run --rm -it caddy:2-alpine caddy hash-password
     ```
     Keep the single quotes around the hash in `.env`. Open only ports 80 and 443 in the VM firewall or
     security group. Share the username and password through a channel you trust, separately from the link.
     Never use basic auth over plain HTTP.
4. Start:
   ```bash
   docker compose -f deploy/docker-compose.cloud.yml up -d --build --wait
   ```
   (`deploy/.env` is picked up automatically because the compose file lives in `deploy/`.)
5. Smoke test:
   ```bash
   curl -fsS http://127.0.0.1:8080/healthz                       # proxy
   curl -fsS -u prospect http://127.0.0.1:8080/api/stats          # through the gateway (-u only if PROXY_MODE=auth)
   docker compose -f deploy/docker-compose.cloud.yml ps           # services with a health check show healthy; the pipeline stages show Up
   ```
   Then open the UI, send a test payment and watch it reach reconciled.
6. Operate: `docker compose -f deploy/docker-compose.cloud.yml logs -f gateway`, update with `git pull` and
   the same `up -d --build`, stop with `down`. `down -v` also deletes the data volumes.

Optional profiles (add the flag to every compose command, e.g. `--profile postgres`):

- **Postgres:** set `POSTGRES_PASSWORD` and `DATABASE_URL=postgres://ct:<same password>@postgres:5432/ledger`.
  Without these the ledger and ops use embedded PGlite on their own volumes (the default).
- **Redpanda:** set `BUS=kafka` and add `--profile redpanda`. The local broker stays the default.

## 2. Generic container platform

The platform needs to run several containers from one image plus a proxy, so a compose-capable service
(or a managed container service where you recreate the same pieces) is the easiest fit. The shape to reproduce:

1. Build and push the image: `docker build -f deploy/Dockerfile.cloud -t <registry>/control-tower:cloud .`
2. Run one container per service from that image. The command (the container "arguments") selects the service,
   exactly as in `deploy/docker-compose.cloud.yml` (for example `services/gateway/src/index.ts`, or
   `services/stages/src/index.ts --stage fx`). The entrypoint is `node --import tsx`.
3. Give them one private network with DNS names equal to the service names used in the compose file
   (`broker`, `payment-api`, `ledger`, `ops`, `orchestrator`, `assistant`, `booth`, `gateway`), or override the
   `*_URL` variables. Set `HOST=0.0.0.0` explicitly; without `HOST` a service binds `127.0.0.1` and other
   containers cannot reach it.
4. Mount a persistent volume at `/data` for broker, ledger, ops and booth (one volume each).
5. Expose **only the gateway** (port 7072) through the platform's HTTPS load balancer or ingress, with
   WebSocket support enabled for `/ws`. Do not expose broker, payment-api, ledger, ops, orchestrator,
   assistant or booth. Use the platform's own access control, or run the Caddy container with `PROXY_MODE=auth`.
6. Health checks: every service answers `GET /health` on its port. The proxy answers `GET /healthz`.
7. Replicas: run exactly **one** instance of each service. The services keep state on their volume and are
   not designed to be scaled out.

## Security notes

- **Demo only, synthetic data only.** Do not enter real personal, banking or card data. The booth lead form is
  for events; do not invite prospects to submit real details into a shared cloud copy.
- **Change the staff PIN.** The default PIN in the repository is public. This profile requires you to set one.
  Anyone who knows it can export booth leads.
- **No real credentials.** No secrets are baked into the image. `ANTHROPIC_API_KEY` is optional, off by default
  (`ASSISTANT_LLM=off`), and only reaches the assistant container; if you set it, the assistant makes outbound
  calls, so the "runs offline" claim no longer applies to that deployment.
- **Exposure.** Default bind is `127.0.0.1`. Anything wider is your explicit choice (`PROXY_BIND`, and `HOST`
  inside containers). Behind basic auth, a prospect can still use the presenter console (start scenarios, change
  pace) and the ops console as the built-in demo users; there is no per-user identity. Share it only with people
  you are comfortable giving that control.
- **Basic auth** is a simple shared gate, not an identity system, and has no lockout. Use a long random password
  and HTTPS, and rotate it (change the hash, recreate the proxy) after each prospect round.
- **Reset and safe mode are unavailable** (no launcher process in containers). To start clean:
  `down -v`, then `up -d --build --wait`.
- Optional extra hardening you can try, not tested here: `read_only: true` with `tmpfs: [/tmp]` on the app services.
- Keep the VM patched, restrict SSH, and use the provider's firewall. Remove the deployment when it is not needed.

## Cost and size guidance

No prices or benchmarks are given here because none were measured. How to size it yourself:

- The stack is about 12 small Node.js processes (broker, payment-api, six stages, ledger, ops, orchestrator,
  assistant, booth, gateway) plus the proxy, so memory use is the sum of the processes. Start on a small VM,
  watch `docker stats` while ambient traffic runs, and size up if services restart or the UI lags.
- Postgres and Redpanda add more memory (Redpanda is configured for `--memory=512M`); skip them unless you
  want to show them.
- Lower `AMBIENT_RATE` (default 3 payments/s) to reduce load and disk growth; `0` turns ambient traffic off.
- Data grows with traffic (event log, ledger). Watch disk, and run `down -v` between prospect rounds.
- Cost is the provider's VM price for the size you pick plus a public IP or domain. Check the provider's own
  calculator; stop or delete the VM between uses to avoid paying for idle time.
