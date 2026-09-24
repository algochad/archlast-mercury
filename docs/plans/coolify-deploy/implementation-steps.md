# Implementation Steps — Coolify Deploy + PostgreSQL in the Main Compose File

> Companion to `plan.md`. Single-file compose, no `docker-compose.postgres.yml`, no Rust code changes.
> **Cohesion:** This is the **platform-layer** plan. Data-layer is `docs/plans/postgres/` (owns `postgres` service, `pgdata`, DB env, migration, backup). File-ownership contract: `plan.md:8`. Recommended order: `postgres` → `coolify-deploy`. When landing together, apply `postgres` Phase C once, then only the delta here (host-bind + proxy block + `docs/coolify.md`).

## 0. Pre-conditions & Invariants

- `docker-compose.yml` is the single canonical file (no override file).
- `docker compose up -d` without flags stays SQLite, zero `.env`, no new pull, no breaking change.
- Postgres is profile-gated (`profiles: ["postgres"]`) — same idiom as `livekit`.
- Coolify scan target is the `Dockerfile` resource (preferred) or `docker-compose.yml` resource — both must work.
- Server already supports both engines (`crates/mercury-db/src/lib.rs:82` `AnyPool`, `crates/mercury-server/src/config.rs:1153` `MERCURY_DATABASE_ENGINE`, `main.rs:538`).
- **Idempotence:** Every patch below is guarded by a `grep` so a second apply (after `postgres`) is a no-op. See `plan.md:8`.

## 1. `docker-compose.yml` — Single-File Diff

### 1.1 Add `postgres` service (profile-gated) — NORMALLY SKIPPED: canonical in `postgres` Phase C (C1.1)

Insert after `mercury` service, alongside `livekit`, before `volumes:` — **only if not already present** (grep for `image: postgres:16-alpine` first).

> **Cohesion:** This spec is identical to `postgres` C1.1. When `postgres` lands first (recommended), **skip this section entirely**. It is included here only for the standalone `coolify-deploy` path (Coolify VP wants to audit compose PG without pulling the Postgres plan).

```yaml
  # Optional PostgreSQL — NOT started by default. Bring it up explicitly:
  #   Local: docker compose --profile postgres up -d   (needs POSTGRES_PASSWORD in .env)
  #   Coolify: create a managed Postgres resource instead and point
  #            MERCURY_DATABASE_URL at it (see docs/coolify.md); this
  #            compose service is for local dev / non-Coolify hosts.
  postgres:
    image: postgres:16-alpine
    container_name: mercury-postgres
    profiles: ["postgres"]
    environment:
      POSTGRES_DB: mercury
      POSTGRES_USER: mercury
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env when using --profile postgres}
    volumes:
      - pgdata:/var/lib/postgresql/data
    # No host port mapping by default — internal only (mercury → postgres:5432).
    # To `psql` from the host, add temporarily:
    #   ports: ["127.0.0.1:5432:5432"]
    # or use: docker compose --profile postgres exec postgres psql -U mercury
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U mercury -d mercury"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s
    restart: unless-stopped
```

Pins `postgres:16-alpine` — matches `SELF_HOSTING_DEPLOYMENT_GUIDE.md:58`. Bump to `17-alpine` intentionally, never `latest`.
`${POSTGRES_PASSWORD:?...}` fails fast with a clear error when the profile is used without `.env`. Without the profile, Compose ignores the service entirely so SQLite users see no validation.
No `ports:` by default — `mercury → postgres:5432` via Docker DNS is all that is needed; exposing `5432` on the host collides with a host PG and widens attack surface.

### 1.2 Make `mercury` DB env interpolable + wire healthcheck dependency + document Coolify port handling — SPLIT OWNERSHIP

DB env + `depends_on` are **canonical in `postgres` C1.2** — this plan does not re-add them; verifies they exist. **Host-bind `"${MERCURY_HOST_BIND:-127.0.0.1}:8090:8090"` is canonical here** — `postgres` only documents it as joint/optional and skips the edit if the line already exists.

Current (hardcoded SQLite):
```yaml
    environment:
      - MERCURY_DATABASE_URL=sqlite:///data/mercury.db?mode=rwc
      - MERCURY_DATABASE_MAX_CONNECTIONS=20
```

Proposed (backward-compatible interpolation defaults, same block, keep comments):
```yaml
    environment:
      # Database — SQLite by default (zero config). When running with
      # --profile postgres, set in .env:
      #   POSTGRES_PASSWORD=<strong random: openssl rand -hex 32>
      #   MERCURY_DATABASE_URL=postgresql://mercury:${POSTGRES_PASSWORD}@postgres:5432/mercury
      #   MERCURY_DATABASE_ENGINE=postgres
      # On Coolify with a managed Postgres resource, set MERCURY_DATABASE_URL
      # to that resource's internal URL instead (see docs/coolify.md).
      # The defaults below keep `docker compose up -d` on SQLite.
      - MERCURY_DATABASE_URL=${MERCURY_DATABASE_URL:-sqlite:///data/mercury.db?mode=rwc}
      - MERCURY_DATABASE_ENGINE=${MERCURY_DATABASE_ENGINE:-sqlite}
      - MERCURY_DATABASE_MAX_CONNECTIONS=${MERCURY_DATABASE_MAX_CONNECTIONS:-20}
      # … rest of mercury.environment unchanged
      # Coolify / Traefik: keep MERCURY_TLS_ENABLED=false and MERCURY_BIND_ADDRESS=0.0.0.0:8090
      # so Traefik can route to container:8090. See docs/coolify.md for the proxy trio.
```

Host port for Coolify Compose resource: keep current but make it overridable so Coolify's port injection (or Traefik network routing) does not clash with the loopback-only default. Change `ports:` on `mercury` from hardcoded `127.0.0.1:8090:8090` to:

```yaml
    ports:
      # HTTP API + WebSocket gateway. Default is loopback-only for bare-metal safety.
      # For Coolify (Traefik routes to the container), either:
      #   - Use the Dockerfile resource (ports ignored, Traefik uses EXPOSE 8090), or
      #   - Set MERCURY_HOST_BIND=0.0.0.0 in .env when using the Compose resource.
      - "${MERCURY_HOST_BIND:-127.0.0.1}:8090:8090"
      # Native QUIC / WebTransport media (raw QUIC desktop + browser WebTransport).
      # Coolify/Traefik cannot proxy UDP — this must be published on the host
      # and opened on the VPS firewall separately (see docs/coolify.md).
      - "8443:8443/udp"
```

Default `127.0.0.1` keeps bare-metal safety. On Coolify, the Dockerfile resource ignores `ports:` entirely (Coolify reads `Dockerfile:75` `EXPOSE 8090` and routes via Docker network); for the Compose resource on Coolify, set `MERCURY_HOST_BIND=0.0.0.0` in Coolify's env UI so Traefik can reach the published port if needed. Document both.

`depends_on` — add optional health-gated dependency so `docker compose --profile postgres up -d` orders correctly without breaking non-PG compose:

```yaml
    depends_on:
      postgres:
        condition: service_healthy
        required: false
```

`required: false` (Compose Spec 2.20+) makes the dependency optional: without the `postgres` profile the service is absent and Compose does not error. If the Coolify host runs an older Compose without `required: false`, omit the `depends_on` entirely — the server's 5 s pool-acquire timeout (`crates/mercury-db/src/lib.rs:POOL_ACQUIRE_TIMEOUT`) + `pg_isready` healthcheck covers the race. Prefer `required: false` when available; document minimum Compose version.

### 1.3 Add volume `pgdata` — NORMALLY SKIPPED: canonical in `postgres` C1.3

At bottom alongside `paracord-data` — **only if `pgdata:` is not already present** (grep before patching). When `postgres` lands first, skip.

```yaml
volumes:
  paracord-data:
  pgdata:
```

### 1.4 File invariant after change

```bash
docker compose config                           # → mercury + sqlite, no postgres, no pgdata consumer, 127.0.0.1:8090:8090
docker compose --profile postgres config        # → + postgres:16-alpine, pgdata, 8443:8443/udp, MERCURY_DATABASE_URL=postgresql://…
docker compose --profile postgres --profile livekit config  # → postgres + livekit + mercury
```

### 1.5 What not to change in compose

- `build:` / `image:` duality (`docker-compose.yml:14-16`) stays — Coolify pulls `ghcr.io/algochad/archlast-mercury:latest` when `MERCURY_PULL_POLICY=missing`, otherwise builds locally.
- `livekit` stays on `profiles: ["livekit"]`, unchanged.
- `MERCURY_VOICE_NATIVE_MEDIA=true` default stays (native QUIC primary).
- `MERCURY_TLS_ENABLED=false` default stays — Coolify/Traefik owns TLS.

## 2. `.env.example` — Proxy Trio + Postgres Block — SPLIT OWNERSHIP

Append after the LiveKit block (keep existing comments verbatim, add new sections commented out). **Split ownership:** proxy block is **canonical here**, postgres block is **canonical in `postgres` C2**. Guarded append — check for existing markers before writing. Order when landing together: proxy block first (this plan), then postgres block (`postgres`).

```dotenv
# --- Reverse proxy (Coolify / Traefik, nginx, Caddy) -------------------------
# Behind a reverse proxy, set all three. MERCURY_PUBLIC_URL is required for
# correct invite links and CORS. TRUST_PROXY + TRUSTED_PROXY_IPS make
# X-Forwarded-For trusted only from Traefik/nginx (see crates/mercury-util/src/client_ip.rs).
# Without them, all clients appear as 127.0.0.1 and rate-limit as one IP.
#   MERCURY_PUBLIC_URL=https://chat.example.com
#   MERCURY_TRUST_PROXY=true
#   MERCURY_TRUSTED_PROXY_IPS=172.18.0.0/16   # set to your Traefik/proxy CIDR — do not use "*"
#   MERCURY_COOKIE_SECURE=true
#   MERCURY_AUTO_PORT_FORWARD=false
#   MERCURY_TLS_ENABLED=false
# For Coolify Compose resource exposing via host port, also:
#   MERCURY_HOST_BIND=0.0.0.0

# --- PostgreSQL (optional) ---------------------------------------------------
# SQLite is the default (zero config) — `docker compose up -d` needs nothing here.
# For PostgreSQL via this compose file:
#   1. cp .env.example .env
#   2. Set POSTGRES_PASSWORD below (generate: openssl rand -hex 32)
#   3. Uncomment the three MERCURY_* lines
#   4. docker compose --profile postgres up -d
#
# For Coolify: prefer a managed Postgres resource. Create it in Coolify's
# dashboard, then set MERCURY_DATABASE_URL to its internal URL instead of
# using --profile postgres (see docs/coolify.md).
#   POSTGRES_PASSWORD=
#   MERCURY_DATABASE_ENGINE=postgres
#   MERCURY_DATABASE_URL=postgresql://mercury:${POSTGRES_PASSWORD}@postgres:5432/mercury
#   MERCURY_DATABASE_MAX_CONNECTIONS=50
```

Keep everything commented — no `.env` required for SQLite. `POSTGRES_PASSWORD` has no default for security; the `:?` guard in compose enforces it when the profile is active.

## 3. New Doc — `docs/coolify.md` (Required)

Single runbook, linked from `README.md` + `docs/docker-setup.md`. Sections:

### 3.1 Deploy methods (two options, recommend GHCR for small VPS)

- **Option A — GHCR image (recommended for Coolify VPS with ≤4 GB RAM, no build OOM):** Create Coolify **Application → Dockerfile** resource or **Docker Image** resource with `ghcr.io/algochad/archlast-mercury:latest` (published by `.github/workflows/ci.yml:423`, `linux/amd64` only). Set `MERCURY_PULL_POLICY=missing` if using compose pull.
- **Option B — Build from source:** Point Coolify at the repo (`https://github.com/algochad/archlast-mercury.git`, branch `main`). Note build needs ~4–8 GB disk, >4 GB RAM, 10–20 min Rust release compile; ARM Ampere VPS will fail (no `arm64` image).

### 3.2 Required environment (Coolify UI → Environment Variables)

Table — bold = must set before first boot:

| Variable | Value on Coolify | Why | Default if unset |
|---|---|---|---|
| `MERCURY_PUBLIC_URL` | `https://<coolify-domain>` | Invite links, CORS allowlist (`crates/mercury-api/src/lib.rs:1143`), `setup-server` claim URL | Auto-detected (wrong behind proxy) — **set it** |
| `MERCURY_TRUST_PROXY` | `true` | Honor `X-Forwarded-For` from Traefik (`client_ip.rs:13`) | `false` — all clients bucketed as `127.0.0.1` |
| `MERCURY_TRUSTED_PROXY_IPS` | Traefik CIDR (e.g. `10.0.0.0/8` or `172.18.0.0/16` — check `docker network inspect coolify`) | Restrict proxy trust (`client_ip.rs:66` CIDR matching) — never `*` | empty — proxy not trusted |
| `MERCURY_COOKIE_SECURE` | `true` | Secure cookies behind HTTPS (`crates/mercury-api/src/routes/auth.rs:773`) | `false` |
| `MERCURY_AUTO_PORT_FORWARD` | `false` | Coolify VPS already has public IP; UPnP/NAT-PMP irrelevant and noisy behind Traefik (`config.rs:924`) | `true` |
| `MERCURY_TLS_ENABLED` | `false` | TLS terminated at Coolify/Traefik (`Dockerfile:70`) | `false` ✅ |
| `MERCURY_BIND_ADDRESS` | `0.0.0.0:8090` | Binds inside container for Traefik (`config.rs:107`) | `0.0.0.0:8090` ✅ |

### 3.3 Persistent volume

- In Coolify: add a **Persistent Volume** (or Storage mount) at container path `/data` (`Dockerfile:82` `VOLUME ["/data"]`, `docker-entrypoint.sh:15` layout). Without it, `mercury.toml` (JWT secret), `mercury.db`, `uploads/files/backups/certs` reset every redeploy.
- Compose local: `paracord-data:/data` + `pgdata:/var/lib/postgresql/data` (when `--profile postgres`).

### 3.4 Database — two paths

- **SQLite (default):** no extra env; volume at `/data` holds `mercury.db` (`MERCURY_DATABASE_URL=sqlite:///data/mercury.db?mode=rwc`). Fine for small communities.
- **PostgreSQL via compose (`--profile postgres`) for local/non-Coolify:** see §1.1–1.2. Set `POSTGRES_PASSWORD` + `MERCURY_DATABASE_ENGINE=postgres` + `MERCURY_DATABASE_URL=postgresql://mercury:${POSTGRES_PASSWORD}@postgres:5432/mercury`.
- **PostgreSQL via Coolify managed resource (recommended for production on Coolify):** Create a **Database → PostgreSQL** resource in Coolify, note its internal hostname (e.g. `mercury-postgres`), set in the app's env: `MERCURY_DATABASE_ENGINE=postgres`, `MERCURY_DATABASE_URL=postgresql://mercury:<password>@mercury-postgres:5432/mercury`, `MERCURY_DATABASE_MAX_CONNECTIONS=50`. Do **not** also enable `--profile postgres` in this topology — the managed PG is already the DB. Migrations run on first boot (`main.rs:538`). Brownfield from SQLite: `mercury-server migrate-to-postgres --source sqlite://… --target postgresql://…` (`docs/sqlite-to-postgres-migration.md`).

### 3.5 Domain & first-owner claim

- Set `MERCURY_PUBLIC_URL` **before** first boot so the claim link is `https://<coolify-domain>/setup-server#claim=…`.
- Retrieve the one-time token: **Coolify → Application → Logs** on first boot, line `Finish setting up — open this link:` (`main.rs:91`), or **Terminal → `cat /data/first-owner-claim.txt`** (mode `0600`). Link is single-use; consumed on first owner creation (`crates/mercury-server/src/main.rs:548`).
- Open `/setup-server` in browser, paste token if not auto-filled.

### 3.6 Healthcheck & WebSocket

- Healthcheck path: `GET /health` (and `/api/v1/health`) — unauthenticated, `crates/mercury-api/src/lib.rs:100`. Dockerfile already has `HEALTHCHECK … http://localhost:8090/health` (`Dockerfile:79`). Coolify healthcheck: `/health`, interval 30 s, expects 200.
- WebSocket gateway at `/gateway`: Coolify/Traefik proxies WS upgrade (`Upgrade: websocket`, `Connection: upgrade`) without extra config; nginx example in `docs/docker-setup.md:202` is for bare-metal only.

### 3.7 Voice — UDP manual step (caveat, not a blocker)

- Native QUIC/WebTransport voice lives on **`8443/udp`** (`Dockerfile:76` `EXPOSE 8443/udp`, `config/mercury.toml:97`). Traefik only proxies HTTP/TCP — it cannot route UDP.
- **Manual host step (required for voice):** on the Coolify host, `ufw allow 8443/udp` + ensure the app publishes `8443:8443/udp` (Dockerfile EXPOSE is enough for host firewall; for Compose resource ensure `8443:8443/udp` is in `ports:` on the mercury service). Without this, chat/DMs/uploads work; browser voice fails ("UDP unreachable"), desktop raw-QUIC also fails. Document "deploy without voice first" path.

### 3.8 Build cost & arch

- From-source Docker build: `rust:1.91` release compile needs disk + RAM; prefer GHCR image on small VPS. Published image is `linux/amd64` only (`.github/workflows/ci.yml:458` `platforms: linux/amd64`); ARM hosts need a self-built image.

### 3.9 Linking

- `README.md` → "Deploy → [Coolify](docs/coolify.md)".
- `docs/docker-setup.md` → link to `docs/coolify.md` for Coolify-specific env/proxy notes.

## 4. Docs Updates Beyond `docs/coolify.md`

| File | Change |
|---|---|
| `docs/docker-setup.md` | Add `PostgreSQL` subsection under Quick Start contrasting `docker compose up -d` (SQLite) vs `--profile postgres up -d` (PG) with `.env` steps, `pgdata` volume, `exec psql` access. Link to `docs/coolify.md` for proxy env. Update Environment Variables table with `MERCURY_DATABASE_ENGINE`, `MERCURY_TRUST_PROXY`, `TRUSTED_PROXY_IPS`, `COOKIE_SECURE`, `AUTO_PORT_FORWARD`, `HOST_BIND`. |
| `docs/deployment.md` §4 | Replace hand-written PG compose snippet with reference to shipped `docker-compose.yml` `postgres` profile; keep bare-metal `[database]` TOML example. |
| `SELF_HOSTING_DEPLOYMENT_GUIDE.md` §2 | Update compose example to match shipped file (profile-gated PG, interpolation defaults); or keep as expanded example with note "shipped compose already contains this as `profiles: [\"postgres\"]`." |
| `docs/sqlite-to-postgres-migration.md` | Note migration target can be either external PG or the compose `postgres` service (via `exec` or temporarily mapped host port). |
| `docs/postgres-pg-trgm.md` | Clarify compose PG is superuser (no `pg_trgm` issue); external managed PG still needs the workaround. |
| `README.md` | Under "Running it" / "Docker Compose" add: "PostgreSQL: see [Coolify deploy](docs/coolify.md) and `docker compose --profile postgres up -d`." |

## 5. Sequencing & Rollout — JAMMED WITH `postgres`

1. **Commit A — `docker-compose.yml` + `.env.example` — COORDINATION REQUIRED** (additive, behind `profiles: ["postgres"]`). Shared with `postgres` — **only one PR may touch `docker-compose.yml:services.postgres`**. Recommended: `postgres` lands first (C1.1 `postgres` service + C1.3 `pgdata` + DB env C1.2); this plan then adds only the host-bind delta (`"${MERCURY_HOST_BIND:-127.0.0.1}:8090:8090"`). Never open two PRs that both create the service.
2. **Commit B — `docs/coolify.md` + `docs/docker-setup.md` + `README.md`/`deployment.md` guide updates.** Docs only. Disjoint paragraphs per `plan.md:8`: `postgres` touches PG-vs-SQLite paragraphs, this plan touches Coolify/proxy paragraphs.
3. Verify (see `verification.md`): `docker compose config` invariants, `docker compose --profile postgres` smoke, Coolify Dockerfile resource deploy smoke via GHCR, voice caveat noted. When landing together, run **both** `postgres/verification.md` and this plan's `verification.md` (split gates).
4. No version bump needed (compose/docs additive, behind profile).

## 6. What This Plan Explicitly Does NOT Do (and relationship to `postgres`)

- No `docker-compose.postgres.yml` override file (single-file constraint — both plans reject it).
- No duplicate `postgres:16-alpine` service — this plan skips C1.1/C1.3 when `postgres` already applied (see §1.1).
- No `coolify.json` / `nixpacks.toml` checked in — Coolify detects `Dockerfile` automatically.
- No Rust code change (`embed-ui`, `bind_address`, `health` route already correct).
- No default-engine switch (SQLite stays default).
- No Traefik UDP routing for `8443/udp` (host-level UDP publish + firewall is the fix).
- No always-on Postgres (profile-gated to keep zero-config).
- No host `5432:5432` mapping by default (internal-only `postgres:5432`).
