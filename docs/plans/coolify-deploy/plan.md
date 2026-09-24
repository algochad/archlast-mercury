# Coolify Deploy Compatibility Plan (with PostgreSQL in the Main Compose File)

> Location: `docs/plans/coolify-deploy/`
> Status: Draft — 2026-09-24
> Scope: Make the repo pass Coolify's deployable scan out of the box, keep `docker-compose.yml` as the **single canonical file**, add PostgreSQL inside it (profile-gated), and document the Coolify deployment path. No application Rust code changes required.
> Supersedes Phase C of the former `docs/plans/postgres-enablement/` (`docker-compose.postgres.yml` override) per request to keep one compose file. Companion to `docs/plans/postgres/` (unified Postgres plan, merged from `postgres-enablement` + `postgres-docker-compose`).

## 0. Summary

Archlast Mercury is **already Coolify-compatible with no code changes** for chat/DMs/uploads — the Dockerfile, healthcheck, port, proxy support, and image publishing are all in place. Voice is the only gap (UDP 8443 cannot be routed by Coolify/Traefik — manual host firewall + UDP publish is required). This plan makes the repo **scan-clean** and **one-command deployable** via Coolify by:

1. Adding `postgres:16-alpine` to the **single checked-in `docker-compose.yml`** under `profiles: ["postgres"]` (same pattern as `livekit`), keeping `docker-compose up -d` on SQLite by default.
2. Fixing two scan friction points: `127.0.0.1:8090:8090` host binding and missing `.env` proxy/Postgres vars that Coolify surfaces.
3. Shipping `docs/coolify.md` (and `.env.example` updates) so Coolify's auto-detect + env UI + Traefik model map to `MERCURY_PUBLIC_URL` / `MERCURY_TRUST_PROXY` / `MERCURY_COOKIE_SECURE` / `MERCURY_AUTO_PORT_FORWARD` correctly.

SQLite stays the zero-config default; Postgres is opt-in (via `--profile postgres` locally, or via a Coolify-managed Postgres resource in production).

## 1. Codebase Scan — What Coolify Sees Today

Detailed scan run across `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`, `.env.example`, `config/mercury.toml`, `crates/mercury-server/src/{config,main}.rs`, `crates/mercury-api/src/lib.rs`, `crates/mercury-util/src/client_ip.rs`, `crates/mercury-ws/src/handler.rs`, `.github/workflows/ci.yml`, `.dockerignore`.

### 1.1 What passes (green)

| Check | Evidence | Notes |
|---|---|---|
| Dockerfile present at repo root | `Dockerfile:1` | Multi-stage `node:22-bookworm-slim` (client) → `rust:1.91-bookworm` (server) → `debian:bookworm-slim` runtime |
| Client UI embedded | `Dockerfile:13-34` (`npm run build` → `COPY client/dist` → `cargo build --release --bin mercury-server` with `embed-ui`) | No separate `client/dist` mount needed at runtime |
| Runtime correct | `Dockerfile:37-58` (`debian:bookworm-slim`, `ca-certificates`, `libsqlite3-0`, `wget`, `groupadd -r mercury`, `USER mercury`) | Non-root, minimal deps |
| Env-only config | `Dockerfile:61-72` (`ENV MERCURY_BIND_ADDRESS=0.0.0.0:8090`, `…_DATABASE_URL=sqlite…`, `…_TLS_ENABLED=false`, `…_VOICE_NATIVE_MEDIA=true`) and `docker-compose.yml:31-90` | No secrets baked in; `crates/mercury-server/src/config.rs:1133` env overrides cover all knobs |
| Zero-config first run | `docker-entrypoint.sh:1` + `crates/mercury-server/src/config.rs:1086` (`Config::load` generates `/data/mercury.toml` with `0600` + random `jwt_secret`) and `crates/mercury-server/src/main.rs:548` (first-owner claim) | Coolify volume at `/data` persists `mercury.toml` + DB; no `.env` required for SQLite |
| Healthcheck | `Dockerfile:79` (`HEALTHCHECK … wget -qO- http://localhost:8090/health`) and `crates/mercury-api/src/lib.rs:100` (`GET /health`, unauthenticated) | Coolify healthcheck path: `/health` ✅ |
| Port | `Dockerfile:75-76` (`EXPOSE 8090`, `EXPOSE 8443/udp`) and `docker-compose.yml:18` (`"127.0.0.1:8090:8090"`, `"8443:8443/udp"`) | Detected as 8090; see yellow below |
| Volume | `Dockerfile:82` (`VOLUME ["/data"]`) and `docker-compose.yml:29` (`paracord-data:/data`) | Single persistent volume covers DB + uploads/files/certs/backups — Coolify needs one volume at `/data` |
| Proxy trust | `crates/mercury-util/src/client_ip.rs:13` (`MERCURY_TRUST_PROXY`) + `client_ip.rs:20` (`MERCURY_TRUSTED_PROXY_IPS`) and `crates/mercury-ws/src/handler.rs:756` | Matches `SELF_HOSTING_DEPLOYMENT_GUIDE.md:38-40` + `docs/deployment.md:78` |
| Image publishing | `.github/workflows/ci.yml:423` (`docker-image` job, `ghcr.io/${{ github.repository_owner }}/mercury:latest`, `linux/amd64`) + `docker-compose.yml:14` (`image: ghcr.io/algochad/archlast-mercury:latest` + `pull_policy: build`) | Coolify can pull GHCR and skip the heavy Rust build |
| Dual DB | `crates/mercury-db/src/lib.rs:82` (`DbPool = AnyPool`, `DatabaseEngine`), `crates/mercury-server/src/config.rs:117` + `config.rs:1153` (`MERCURY_DATABASE_ENGINE`), `main.rs:538` (`run_migrations_for_engine`) | SQLite + Postgres share codepath; no schema fork |
| WebSocket gateway | `docs/docker-setup.md:182-219` nginx example shows `Upgrade`/`Connection` + `X-Forwarded-*`; Coolify/Traefik handles WS upgrade for `/gateway` without extra config | |
| `.dockerignore` clean | `.dockerignore:1` excludes `target/`, `node_modules/`, `data/`, `.git/`, `dist/` | Keeps build context small for Coolify's git clone |

### 1.2 What creates friction (yellow — not blockers, but scan/doc fixes)

| # | Check | Current | Why it matters for Coolify | Fix (this plan) |
|---|---|---|---|---|
| Y1 | Port host binding | `docker-compose.yml:25` = `"127.0.0.1:8090:8090"` (loopback-only, intentional for bare-metal safety) | Coolify/Traefik routes to the container network, not to `127.0.0.1` on the host. With this binding, Coolify's Traefik cannot reach the container via published host port if it expects `0.0.0.0`. For **Dockerfile**-based Coolify resource the binding is ignored (Traefik uses container port), but for **Compose**-based import the binding is wrong. | Document: keep Dockerfile `EXPOSE 8090` as source of truth; for Compose-based import note to use `${MERCURY_HOST_BIND:-127.0.0.1}:8090:8090` or let Coolify inject its own port. Provide commented alternative + `docs/coolify.md` note. |
| Y2 | No Postgres in checked-in compose | `docker-compose.yml` only has `mercury` + `livekit`; PG snippet only in `SELF_HOSTING_DEPLOYMENT_GUIDE.md:26` | Coolify Postgres resource is separate, but local dev/parity wants the same compose to offer PG via `--profile postgres`. Missing service = "works on guide, not on repo." | Add `postgres` service under `profiles: ["postgres"]` in the **single file** (see §4). No override file. |
| Y3 | `.env.example` missing Coolify + PG vars | Only `MERCURY_PUBLIC_URL`, `MERCURY_TLS_ENABLED`, `MERCURY_LIVEKIT_API_SECRET` | Coolify surfaces `.env` vars in its UI; operator won't know to set `MERCURY_TRUST_PROXY`, `TRUSTED_PROXY_IPS`, `COOKIE_SECURE`, `AUTO_PORT_FORWARD`, `POSTGRES_PASSWORD`, `MERCURY_DATABASE_*` | Expand `.env.example` with commented proxy + PG block (see implementation-steps) |
| Y4 | No Coolify doc | No `docs/coolify.md`, no `coolify.json`/`app.json` | Scan passes but deploy is undiscoverable. Coolify's scan looks for `Dockerfile`; docs tell operator which env to set. | Ship `docs/coolify.md` (runbook), link from `README.md` + `docs/docker-setup.md` |
| Y5 | UDP 8443 | `Dockerfile:76` `EXPOSE 8443/udp`, `docker-compose.yml:27` `8443:8443/udp` | Coolify/Traefik only proxies HTTP/WS. Native QUIC/WebTransport voice (raw QUIC desktop + browser WebTransport) needs `8443/udp` open on the VPS firewall/host, not Traefik. If skipped, chat works, browser voice fails (HTTPS present, UDP absent). Desktop raw-QUIC also needs it. | Document as **one manual step**: open `8443/udp` on VPS firewall + publish port. Offer "deploy without voice first" path. |
| Y6 | Build cost | `rust:1.91` release build in Dockerfile needs ~4–8 GB disk, >4 GB RAM; CI image is `linux/amd64` only | Small Coolify VPS (2 GB) OOMs building from source. ARM (Ampere) VPS fails (no arm64 image). | Document: use `ghcr.io/algochad/archlast-mercury:latest` (`MERCURY_PULL_POLICY=missing`) on Coolify; note `linux/amd64` arch requirement |
| Y7 | First-owner claim flow | `config.rs:1086` + `main.rs:548` prints `https://…/setup-server#claim=…` and writes `/data/first-owner-claim.txt` (`0600`) | Behind Coolify/Traefik, the claim URL must be `https://<coolify-domain>/setup-server#claim=…` — requires `MERCURY_PUBLIC_URL` before first run. Operator needs to know where to find the token (Coolify logs or `exec cat /data/first-owner-claim.txt`) | Document in `docs/coolify.md`: set `MERCURY_PUBLIC_URL` before first boot; how to retrieve token via Coolify's terminal/logs |
| Y8 | `.dockerignore` ignores `docker-compose.yml` | `.dockerignore:22` lists `docker-compose.yml` | Harmless for Dockerfile-based Coolify builds (compose not needed), but prevents `docker-compose.yml` from being in build context if someone `docker build -f Dockerfile .` after copying compose-based docs. Keeps image smaller; not a bug, but note. | No change needed; document that Coolify Dockerfile resource ignores compose (uses Dockerfile directly) |

### 1.3 What would block (red — none for chat; voice has one infra requirement)

| # | Block | Scope | Mitigation |
|---|---|---|---|
| R1 | No `coolify.json` required | No file `**/coolify*` in repo | None needed — Coolify detects `Dockerfile` automatically. Optional `coolify.json` is not required; this plan does not add one. |
| R2 | Voice without UDP | Native media `config/mercury.toml:97` `port = 8443` + `Dockerfile:76` | **Manual step**: open `8443/udp` on Coolify VPS (`ufw allow 8443/udp` + `docker run -p 8443:8443/udp` / Compose `8443:8443/udp`). Document, not code. |

### 1.4 Decision

**No Rust application code change required.** This is a compose/env/docs-only change. Keep SQLite default; make Postgres available in the same `docker-compose.yml` via profile; make Coolify deploy discoverable and correct behind Traefik.

## 2. Goals / Non-Goals

**Goals**
- Pass Coolify deployable scan (Dockerfile resource) with no warnings that mislead the operator.
- Single `docker-compose.yml` serves both SQLite (default) and Postgres (`--profile postgres`) — no `docker-compose.postgres.yml` override.
- `docs/coolify.md` runbook: env, volume, Postgres (SQLite vs Coolify-managed PG), domain, claim flow, voice UDP step, GHCR vs build.
- `.env.example` covers Coolify proxy trio + Postgres vars (commented, zero-config default unchanged).
- `docker-compose.yml` port/coordination comments explain Coolify/Traefik routing so scanner output is not surprising.

**Non-Goals**
- Changing default DB to Postgres.
- Adding `docker-compose.postgres.yml` (rejected — one file).
- Supporting MySQL / other engines.
- Multi-writer / read-replica.
- Shipping `coolify.json` / `nixpacks.toml` (not needed for detection).
- Auto-forwarding UDP via Traefik (impossible — Traefik is TCP/HTTP only; UDP needs host publish).

## 3. Architecture Impact

### 3.1 Deploy topologies after this plan

```
Local dev (no Coolify):
  docker compose up -d                          → mercury + SQLite (paracord-data:/data)
  docker compose --profile postgres up -d       → + postgres:16-alpine (pgdata:/…/data, healthcheck)
  docker compose --profile postgres --profile livekit up -d → + livekit fallback

Coolify (VPS, Traefik in front):
  Resource: Dockerfile (repo or GHCR image) + persistent volume at /data
  Network: Traefik → container:8090 (HTTP+WS /gateway), TLS at Traefik
  Env set in Coolify UI:
    MERCURY_PUBLIC_URL=https://chat.example.com       (CORS + invite links)
    MERCURY_TRUST_PROXY=true
    MERCURY_TRUSTED_PROXY_IPS=<traefik CIDR, e.g. 10.0.0.0/16>
    MERCURY_COOKIE_SECURE=true
    MERCURY_AUTO_PORT_FORWARD=false
    MERCURY_TLS_ENABLED=false
    # optional PG: point at Coolify Postgres resource
    MERCURY_DATABASE_ENGINE=postgres
    MERCURY_DATABASE_URL=postgresql://mercury:${POSTGRES_PASSWORD}@<pg-host>:5432/mercury
  Infra (manual once):
    Host firewall: ufw allow 8443/udp
    Host publish: 8443:8443/udp (if using Compose resource; for Dockerfile resource, add via Coolify's port mapping)
  Result: chat/DMs/uploads fully working; voice works once UDP step done
```

Config wire remains `crates/mercury-server/src/config.rs:1153` (`MERCURY_*` env overrides) → `main.rs:538` (`run_migrations_for_engine`) → `AppState{db: AnyPool}` (`crates/mercury-db/src/lib.rs:82`). No branching beyond env.

### 3.2 Why `profiles: ["postgres"]` (not always-on)

Matches existing `livekit` (`docker-compose.yml:profiles: ["livekit"]`). Avoids pulling/starting Postgres for SQLite users, keeps `docker compose config` honest, `docker compose --profile postgres config` validates PG wiring.

## 4. Implementation

See `implementation-steps.md` for exact diffs. Summary:

| Step | File | Change | Risk |
|---|---|---|---|
| 1 | `docker-compose.yml` | Add `postgres` service (`postgres:16-alpine`, `profiles: ["postgres"]`, `pgdata` volume, `healthcheck: pg_isready`, `${POSTGRES_PASSWORD:?...}`) | Low |
| 2 | `docker-compose.yml` | Make `mercury` DB env interpolable: `${MERCURY_DATABASE_URL:-sqlite:///data/mercury.db?mode=rwc}` / `${MERCURY_DATABASE_ENGINE:-sqlite}` / `${MERCURY_DATABASE_MAX_CONNECTIONS:-20}` + `depends_on: postgres {condition: service_healthy, required: false}` + `${MERCURY_HOST_BIND:-127.0.0.1}:8090:8090` note | Low |
| 3 | `.env.example` | Add commented Proxy (Trust/COOKIE/AUTO_PORT_FORWARD) + Postgres (`POSTGRES_PASSWORD`, `MERCURY_DATABASE_*`) blocks | Low |
| 4 | `docs/coolify.md` (new) | Full runbook: Dockerfile vs GHCR, env table, volume at `/data`, Postgres (SQLite vs Coolify PG), `MERCURY_PUBLIC_URL` + claim retrieval, Traefik WS, voice UDP manual step, build cost/arch | Low |
| 5 | `docs/docker-setup.md` | Document `docker compose up -d` vs `--profile postgres up -d` parity; link to Coolify doc | Low |
| 6 | `README.md` + `docs/deployment.md` + `SELF_HOSTING_DEPLOYMENT_GUIDE.md` | Add Coolify pointer; update compose PG guidance to profile in single file | Low |

See `verification.md` for the pre-merge gate.

## 5. Alternatives Considered

| Option | Verdict |
|---|---|
| `docker-compose.postgres.yml` override | Rejected per request — keep one file |
| `coolify.json` checked in | Rejected — Coolify detects `Dockerfile` without it; adds maintenance |
| Always-on `postgres` (no profile) | Rejected — penalizes SQLite zero-config |
| Expose Postgres on host `5432:5432` by default | Rejected — internal-only; host PG collision risk |
| Switch default engine to `postgres` | Rejected — SQLite correct default for small groups |
| `include:` or separate `compose.yaml` | Rejected — fragments the single file |
| Traefik UDP routing for voice | Not possible — Traefik HTTP only; voice needs `8443:8443/udp` host publish |

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Operator deploys on Coolify without `MERCURY_PUBLIC_URL` → wrong invite links, CORS failure for second-server browser flow | `docs/coolify.md` marks `MERCURY_PUBLIC_URL` as **required**; server auto-detects but docs make it explicit |
| All clients appear as `127.0.0.1` / rate-limit as one IP (`crates/mercury-ws/src/handler.rs:755` and `crates/mercury-util/src/client_ip.rs:13`) | Docs require `MERCURY_TRUST_PROXY=true` + `MERCURY_TRUSTED_PROXY_IPS` scoped to Traefik CIDR; do not set `*` |
| Missing `POSTGRES_PASSWORD` with `--profile postgres` | `${POSTGRES_PASSWORD:?...}` fails fast with clear message; SQLite path needs no `.env` at all |
| Old `docker-compose down` leaves `pgdata` behind | Document `down -v` semantics; `pgdata` is named intentional persistence |
| `pg_trgm` privilege on managed (non-compose) PG | Compose PG is superuser (no issue); external managed PG still covered by `docs/postgres-pg-trgm.md` |
| Build OOM on small Coolify VPS (2 GB) | Recommend `ghcr.io/algochad/archlast-mercury:latest` + `MERCURY_PULL_POLICY=missing`; note `linux/amd64` only |
| Voice silently broken (no UDP) | Call out as top caveat: chat works, browser voice fails without `8443/udp` publish + firewall; offer "deploy without voice first" path |
| `127.0.0.1:8090:8090` vs Coolify Traefik | Document that Dockerfile resource ignores compose ports (Traefik routes to container port 8090); for Compose resource, Coolify injects host port or use `${MERCURY_HOST_BIND:-0.0.0.0}:8090:8090` override |

## 7. Open Questions

- Provide a one-click **Coolify Deploy** badge in `README.md` that points to `docs/coolify.md` + `ghcr.io/...`?
- Pin Postgres tag: `postgres:16-alpine` (matches `SELF_HOSTING_DEPLOYMENT_GUIDE.md`) vs `postgres:17-alpine`? Keep `16-alpine`, bump intentionally.
- Should `MERCURY_DATABASE_MAX_CONNECTIONS` default bump to `50` when on Postgres? Keep interpolation default `20` and recommend `50` in `.env.example` for PG (SQLite and PG share the env name).
- Expose PG host port helper: document `docker compose --profile postgres exec postgres psql -U mercury` rather than `ports: ["5432:5432"]`?

## 8. Cohesion with `postgres` (No-Collision Contract)

The two active plans — **`coolify-deploy` (this folder)** and **`postgres`** — share one composition surface and are designed to be applied together in either order without double-patching. This section is the contract; keep it in sync with `docs/plans/postgres/plan.md:8`.

### Shared File Ownership (single writer per region)

| File / Region | Canonical Owner | Other Plan Does | How To Avoid Collision |
|---|---|---|---|
| `docker-compose.yml` → `postgres:16-alpine` service + `pgdata` volume + `healthcheck` + `POSTGRES_PASSWORD` guard | **`postgres` Phase C (C1.1 + C1.3)** | This plan reuses verbatim; do not re-add. | Apply `postgres` C1.1/C1.3 once. If this plan lands first, create the service here and `postgres` skips creation — but preferred order is `postgres` → `coolify-deploy` (below). |
| `docker-compose.yml` → `mercury` DB env interpolation (`MERCURY_DATABASE_URL/ENGINE/MAX_CONNECTIONS`) + `depends_on: postgres {required:false}` | **`postgres` Phase C (C1.2)** | This plan does not re-add; verifies the interpolation exists. | Idempotent `${VAR:-default}` — second apply is a no-op. Grep for `MERCURY_DATABASE_URL` before patching. |
| `docker-compose.yml` → `ports: "${MERCURY_HOST_BIND:-127.0.0.1}:8090:8090"` + UDP comment | **Joint — this plan is canonical** for the host-bind tweak; `postgres` C1.2 documents it as optional | `postgres` mentions it as "optional host-bind for Coolify" and skips the actual edit if the line already exists | Grep for `MERCURY_HOST_BIND` before patching. Either plan may land it; the other skips. |
| `.env.example` → Proxy block (`MERCURY_PUBLIC_URL`, `TRUST_PROXY`, `TRUSTED_PROXY_IPS`, `COOKIE_SECURE`, `AUTO_PORT_FORWARD`, `TLS_ENABLED`, `HOST_BIND`) | **This plan §2 (canonical)** | `postgres` C2 includes the same commented block for completeness, marked "shared — skip if coolify-deploy already applied" | Append proxy block before PG block; second append is skipped if `MERCURY_PUBLIC_URL` is already in file. |
| `.env.example` → Postgres block (`POSTGRES_PASSWORD`, `MERCURY_DATABASE_*`) | **`postgres` Phase C, C2 (canonical)** | This plan §2 is identical and says "sibling — skip if postgres already applied" | Same block, same comments; harmless dupe (commented lines) but skip to keep `git diff` clean. |
| `docs/docker-setup.md`, `docs/deployment.md`, `SELF_HOSTING_DEPLOYMENT_GUIDE.md` | Both touch, disjoint sections | `postgres` owns **PostgreSQL-vs-SQLite** section; this plan owns **Coolify/proxy** callouts + link to `docs/coolify.md` | Edit disjoint paragraphs; never rewrite the same hunk. |
| `docs/coolify.md` (new) | **This plan §3 only** | `postgres` only links to it (`see docs/coolify.md`) | No conflict. |

### Sequencing

Either plan can land first; **recommended order is `postgres` → `coolify-deploy`** because the postgres service is the larger compose diff and this plan layers the small host-bind tweak on top.

- **If implementing both together:** land `postgres` Commit A (`docker-compose.yml` + `.env.example` PG block) then this plan's Commit A delta (host-bind + proxy lines + `docs/coolify.md`). Never open two PRs that both touch `docker-compose.yml:services.postgres` at the same time.
- **If landing separately:** the second PR's CI must verify `docker compose config` (with and without `--profile postgres`) before and after, to prove idempotence.

### Shared Invariants (both plans guarantee)

- `docker compose up -d` without flags stays SQLite, zero `.env` — enforced by `${VAR:-default}` + `profiles: ["postgres"]`.
- No `docker-compose.postgres.yml` / `docker-compose.override.yml` is ever created — both plans explicitly reject it.
- `postgres:16-alpine` pinned, `pgdata` named, `healthcheck: pg_isready`, `${POSTGRES_PASSWORD:?...}` fail-fast, internal-only (no `5432:5432`), and `required: false` on `depends_on`.
- Verification is split: `postgres/verification.md` gates local compose PG; this plan's `verification.md` gates Coolify scan, GHCR, proxy, and `/health`. Run both when landing together.

## 9. References

- `Dockerfile:1-88` — multi-stage build, `EXPOSE 8090`/`8443/udp`, `HEALTHCHECK`, `USER mercury`, `VOLUME ["/data"]`
- `docker-compose.yml:14` — `image: ghcr.io/algochad/archlast-mercury:latest` + `build:` duality, `ports: 127.0.0.1:8090:8090` + `8443:8443/udp`, `paracord-data:/data`
- `docker-entrypoint.sh:1` — `/data` layout + `exec "$@"`
- `.env.example` — tracked template (public URL, TLS, LiveKit)
- `config/mercury.toml` / `crates/mercury-server/src/config.rs:117` — `DatabaseConfig` + env overrides `config.rs:1133` / `config.rs:924` (`AUTO_PORT_FORWARD`)
- `crates/mercury-api/src/lib.rs:100` — `GET /health` (unauthenticated)
- `crates/mercury-util/src/client_ip.rs:13,20,66` — `MERCURY_TRUST_PROXY` / `TRUSTED_PROXY_IPS` / CIDR matching
- `crates/mercury-ws/src/handler.rs:756,1390` — rate-limit/CORS behind proxy
- `.github/workflows/ci.yml:423` — `docker-image` job publishing GHCR `linux/amd64`
- `docs/plans/postgres/` — unified Postgres plan (merged from `postgres-enablement` + `postgres-docker-compose`)
