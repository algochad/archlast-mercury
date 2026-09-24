# Deploying Archlast Mercury on Coolify

Archlast Mercury is deployable on Coolify with no code changes for chat, DMs, and uploads. This runbook covers the Coolify-specific wiring: build method, environment, volume, database, domain/claim flow, and the one manual voice step. For bare-metal compose usage see [Docker setup](docker-setup.md); for full production notes see the [Self-Hosting Deployment Guide](../SELF_HOSTING_DEPLOYMENT_GUIDE.md).

## 1. Deploy methods (two options)

- **Option A — GHCR image (recommended for a Coolify VPS with ≤4 GB RAM):** create a Coolify **Application → Dockerfile** resource (or **Docker Image** resource) with `ghcr.io/algochad/archlast-mercury:latest`. The image is published by the `docker-image` job in `.github/workflows/ci.yml` on every `main` push. Building the Rust release binary from source OOMs small VPSes, so pulling the prebuilt image avoids the 10–20 minute `cargo build --release` entirely. If you use the Compose resource instead, set `MERCURY_PULL_POLICY=missing` so Compose pulls rather than builds.
- **Option B — Build from source:** point Coolify at the repo (`https://github.com/algochad/archlast-mercury.git`, branch `main`) with **Build Pack → Dockerfile**. The multi-stage build (Node 22 client → Rust 1.91 server → Debian slim runtime) needs ~4–8 GB disk and >4 GB RAM.

The published image is `linux/amd64` only (`.github/workflows/ci.yml` sets `platforms: linux/amd64`). An ARM (Ampere) Coolify host cannot run it and must self-build.

## 2. Required environment (Coolify UI → Environment Variables)

Bold rows must be set before first boot:

| Variable | Value on Coolify | Why | Default if unset |
|---|---|---|---|
| `MERCURY_PUBLIC_URL` | `https://<coolify-domain>` | Invite links, CORS allowlist (`crates/mercury-api/src/lib.rs`), `setup-server` claim URL | Auto-detected (wrong behind proxy) — **set it** |
| `MERCURY_TRUST_PROXY` | `true` | Honor `X-Forwarded-For` from Traefik (`crates/mercury-util/src/client_ip.rs`) | `false` — all clients bucketed as `127.0.0.1` |
| `MERCURY_TRUSTED_PROXY_IPS` | Traefik CIDR (e.g. `10.0.0.0/8` or `172.18.0.0/16` — check `docker network inspect coolify`) | Restrict proxy trust (CIDR matching) — never `*` | empty — proxy not trusted |
| `MERCURY_COOKIE_SECURE` | `true` | Secure cookies behind HTTPS (`crates/mercury-api/src/routes/auth.rs`) | `false` |
| `MERCURY_AUTO_PORT_FORWARD` | `false` | Coolify VPS already has a public IP; UPnP/NAT-PMP requests are irrelevant and noisy behind Traefik (`crates/mercury-server/src/config.rs`) | `true` |
| `MERCURY_TLS_ENABLED` | `false` | TLS is terminated at Coolify/Traefik (`Dockerfile`) | `false` |
| `MERCURY_BIND_ADDRESS` | `0.0.0.0:8090` | Binds inside the container so Traefik can route to it | `0.0.0.0:8090` |

Without the proxy trio (`MERCURY_PUBLIC_URL` + `MERCURY_TRUST_PROXY` + `MERCURY_TRUSTED_PROXY_IPS`), invite links render `localhost`, browser cross-origin calls are CORS-blocked, and every client rate-limits as a single IP (`crates/mercury-ws/src/handler.rs`).

## 3. Persistent volume

In Coolify add a **Persistent Volume** (Storage mount) at container path `/data` (`Dockerfile` declares `VOLUME ["/data"]`; `docker-entrypoint.sh` creates the layout). It holds `mercury.toml` (the generated JWT secret), the database, uploads, media, certs, and backups. Without it, every redeploy mints a new JWT secret and a fresh database — sessions invalidate and uploads vanish.

Compose-local equivalents: `paracord-data (volume name unchanged for backward compat):/data` for the server, plus `pgdata:/var/lib/postgresql/data` when running with `--profile postgres`.

## 4. Database — three paths

- **SQLite (default):** no extra env; the volume at `/data` holds `mercury.db` (`MERCURY_DATABASE_URL=sqlite:///data/mercury.db?mode=rwc`). Fine for small communities.
- **PostgreSQL via compose (`--profile postgres`) for local/non-Coolify hosts:** copy `.env.example` to `.env`, set `POSTGRES_PASSWORD` (`openssl rand -hex 32`), uncomment the three `MERCURY_DATABASE_*` lines, then `docker compose --profile postgres up -d`. See [Docker setup](docker-setup.md) for the full walkthrough.
- **PostgreSQL via a Coolify-managed resource (recommended for production on Coolify):** create a **Database → PostgreSQL** resource in Coolify, note its internal hostname, and set on the app: `MERCURY_DATABASE_ENGINE=postgres`, `MERCURY_DATABASE_URL=postgresql://mercury:<password>@<pg-host>:5432/mercury`, `MERCURY_DATABASE_MAX_CONNECTIONS=50`. Do **not** also enable `--profile postgres` in this topology — the managed database is already the DB. Migrations run automatically on first boot. Coming from SQLite, migrate with `mercury-server migrate-to-postgres --source sqlite://… --target postgresql://…` (full runbook: [sqlite-to-postgres-migration](sqlite-to-postgres-migration.md)).

## 5. Domain & first-owner claim

Set `MERCURY_PUBLIC_URL` **before** first boot so the claim link is `https://<coolify-domain>/setup-server#claim=…`. A fresh instance refuses every registration until it is claimed. Retrieve the one-time token from **Coolify → Application → Logs** on first boot (the `Finish setting up — open this link:` line), or via **Terminal → `cat /data/first-owner-claim.txt`** (mode `0600`). The link is single-use and consumed on first owner creation. For unattended provisioning instead, pre-set `MERCURY_SETUP_CLAIM_TOKEN` (≥32 characters) or `MERCURY_SETUP_REQUIRE_CLAIM=false` — see `docker-compose.yml` comments.

## 6. Healthcheck & WebSocket

- Healthcheck path: `GET /health` (also `/api/v1/health`) — unauthenticated, no database hit (`crates/mercury-api/src/lib.rs`). The Dockerfile already defines `HEALTHCHECK … http://localhost:8090/health`; point Coolify's healthcheck at `/health`, port `8090`, expecting 200.
- WebSocket gateway at `/gateway`: Coolify/Traefik proxies the `Upgrade: websocket` / `Connection: upgrade` handshake natively — no extra config. (The nginx examples in [Docker setup](docker-setup.md#reverse-proxy-nginx) are for bare-metal only.)

## 7. Voice — UDP manual step (caveat, not a blocker)

Native QUIC/WebTransport voice lives on **`8443/udp`** (`Dockerfile` `EXPOSE 8443/udp`). Traefik only proxies HTTP/TCP — it cannot route UDP. **Manual host step (required for voice):** on the Coolify host run `ufw allow 8443/udp` and ensure the app publishes `8443:8443/udp` (for a Compose-based Coolify resource the shipped `docker-compose.yml` already maps it; for a Dockerfile resource add it via Coolify's port mappings). Without this, chat/DMs/uploads work but browser voice fails ("UDP unreachable") and desktop raw-QUIC calls fail too. Safe rollout: deploy without voice first, confirm chat works, then open UDP. Users can self-diagnose at **Settings → Voice & Video → Run connection check**.

## 8. Build cost & arch

From-source Docker builds compile the Rust release binary (`rust:1.91`) — allow ~4–8 GB disk, >4 GB RAM, 10–20 minutes. Prefer the GHCR image on small VPSes (see §1). The published image is `linux/amd64` only; ARM hosts need a self-built image.

## 9. Further reading

- [Docker setup](docker-setup.md) — local compose reference (SQLite vs `--profile postgres`, env table, nginx example).
- [Self-Hosting Deployment Guide](../SELF_HOSTING_DEPLOYMENT_GUIDE.md) — full production runbook (Postgres tuning, backups, monitoring, S3).
- [Deployment](deployment.md) — internet-facing notes (proxy headers, UDP port, `PUBLIC_URL`, migration).
- [SQLite → PostgreSQL migration](sqlite-to-postgres-migration.md) — brownfield runbook.

> **Note:** Env vars use `MERCURY_*` (deprecated alias `PARACORD_*` still works for one minor version).
