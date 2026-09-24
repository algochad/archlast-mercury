# Implementation Steps — PostgreSQL (Unified)

> Companion to `plan.md`. Merged from `postgres-enablement` (Phases A, B, D, E) + `postgres-docker-compose` (Phase C single-file). One canonical `docker-compose.yml`, no `docker-compose.postgres.yml`.
> **Cohesion:** This is the **data-layer** plan. It owns the `postgres` service, `pgdata` volume, DB env interpolation, migration, backup, and dev parity. The **platform-layer** plan `coolify-deploy` builds on top of it (host-bind, proxy/Traefik, GHCR, claim flow). File-ownership contract: `plan.md:8`. Either plan can land first; recommended order is `postgres` → `coolify-deploy`. When landing together, apply this file's Phase C once, then apply only the delta from `coolify-deploy` (host-bind + proxy block + `docs/coolify.md`).

## 0. Pre-conditions & Invariants

- `docker-compose.yml` is the single canonical file (no override file).
- `docker compose up -d` without flags stays SQLite, zero `.env`, no new pull, no breaking change.
- Postgres is profile-gated (`profiles: ["postgres"]`) — same idiom as `livekit`.
- Server already supports both engines (`crates/paracord-db/src/lib.rs:82` `AnyPool`, `crates/paracord-server/src/config.rs:1153` `PARACORD_DATABASE_ENGINE`, `main.rs:538` `run_migrations_for_engine`).
- **Idempotence:** Every Phase C patch below is guarded by a `grep` before apply so a second apply (e.g. after `coolify-deploy`) is a no-op. See `plan.md:8` Shared File Ownership.

---

## Phase A — Greenfield PostgreSQL (zero code, already shippable)

No PR needed — current capability. Document as baseline.

### A1. Greenfield with env only

```bash
# config/paracord.toml
[database]
engine = "postgres"
url = "postgresql://paracord:PASSWORD@localhost:5432/paracord?sslmode=prefer"
max_connections = 50
```

Or env (wins over file — `crates/paracord-server/src/config.rs:1150`):

```bash
PARACORD_DATABASE_ENGINE=postgres
PARACORD_DATABASE_URL=postgresql://paracord:PASSWORD@db:5432/paracord
PARACORD_DATABASE_MAX_CONNECTIONS=50
```

- Create empty DB first: `createdb paracord` / `CREATE DATABASE paracord OWNER paracord;`
- Start server: `cargo run --bin paracord-server --no-default-features` or `docker compose --profile postgres up -d` with PG env (Phase C).
- Migrations auto-run (`main.rs:538`). Verify: `psql $URL -c "\dt"` + server log `run_migrations_for_engine: postgres`.

### A2. Required secrets alongside DB

Retain `paracord.toml` (JWT `auth.jwt_secret`), `data/certs/*` (self-signed TLS), `data/federation_signing_key.hex`, and `PARACORD_AT_REST_KEY` if `[at_rest].enabled` (`docs/backup-recovery.md`). DB alone is not a full backup.

---

## Phase B — Brownfield Migration (existing SQLite → PostgreSQL)

One-shot, offline, transactional. Uses `crates/paracord-db/src/migrate_export.rs` (`MIGRATION_TABLE_ORDER`, FK-safe order, Snowflake PK order).

### B1. Pre-checks

- Stop server + ensure no writers (no shared snapshot across source reads — `docs/sqlite-to-postgres-migration.md`).
- Target must be **fresh empty PG DB** (migrator applies PG migrations itself; upserts PKs, does not clean target-only rows).
- Ensure role can `CREATE EXTENSION pg_trgm` (`docs/postgres-pg-trgm.md`); on managed PG pre-create via superuser or grant.
- If source is SQLCipher-encrypted → export plaintext SQLite first (migrator does not take encryption key).

### B2. Dry run (validate without copying)

```bash
paracord-server migrate-to-postgres \
  --source "sqlite://./data/paracord.db" \
  --target "postgresql://paracord:PASSWORD@localhost:5432/paracord" \
  --dry-run
# validates column maps, counts source rows, applies target migrations/seeds, keeps epoch
```

### B3. Live copy

```bash
paracord-server migrate-to-postgres \
  --source "sqlite://./data/paracord.db" \
  --target "postgresql://paracord:PASSWORD@localhost:5432/paracord"
# single PG transaction: per-table row copy (batch-size 1000, PK-ordered) →
# COUNT(*) verification per table → channel tail repair → new history epoch → commit
```

### B4. Cutover

- Update `paracord.toml` / env to PG.
- Start with PG, stop all old SQLite instances, reconnect clients (new epoch invalidates cached projections — `docs/sqlite-to-postgres-migration.md:148`).
- Keep SQLite file + `data/uploads`/`data/files` until verified. Rollback = stop PG, point config back to SQLite, restart.

---

## Phase C — Docker Compose First-Class (the PR, single file)

This is the only code-adjacent change. Keep `docker-compose.yml` backward-compatible (SQLite default). No `docker-compose.postgres.yml` — single file per your request.

### C1. `docker-compose.yml` — Single-File Diff

#### C1.1 Add `postgres` service (profile-gated) — CANONICAL; `coolify-deploy` skips this if present

Insert after `paracord` service, alongside `livekit` (order matters only for readability), before `volumes:`. Guard: grep for `image: postgres:16-alpine` before patching.

> **Collision guard:** If `coolify-deploy` landed first and already created this service, skip. Service spec is identical in both plans; the only difference is the comment line mentioning Coolify — either wording is fine.

```yaml
  # Optional PostgreSQL — NOT started by default. Bring it up explicitly:
  #   Local: docker compose --profile postgres up -d   (needs POSTGRES_PASSWORD in .env)
  #   Coolify: create a managed Postgres resource instead and point
  #            PARACORD_DATABASE_URL at it (see docs/coolify.md); this
  #            compose service is for local dev / non-Coolify hosts.
  postgres:
    image: postgres:16-alpine
    container_name: paracord-postgres
    profiles: ["postgres"]
    environment:
      POSTGRES_DB: paracord
      POSTGRES_USER: paracord
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env when using --profile postgres}
    volumes:
      - pgdata:/var/lib/postgresql/data
    # No host port mapping by default — internal only (paracord → postgres:5432).
    # To `psql` from the host, add temporarily:
    #   ports: ["127.0.0.1:5432:5432"]
    # or use: docker compose --profile postgres exec postgres psql -U paracord
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U paracord -d paracord"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 10s
    restart: unless-stopped
```

Pins `postgres:16-alpine` — matches `SELF_HOSTING_DEPLOYMENT_GUIDE.md:58`. Bump to `17-alpine` intentionally, never `latest`.
`${POSTGRES_PASSWORD:?...}` fails fast with a clear error when the profile is used without `.env`. Without the profile, Compose ignores the service entirely so SQLite users see no validation.
No `ports:` by default — `paracord → postgres:5432` via Docker DNS is all that is needed; exposing a host port collides with a host PG.

#### C1.2 Make `paracord` DB env interpolable + wire healthcheck dependency + optional host-bind for Coolify — CANONICAL for DB env; host-bind is JOINT

DB env + `depends_on` are canonical here. Host-bind `"${PARACORD_HOST_BIND:-127.0.0.1}:8090:8090"` is **joint ownership** — canonical in `coolify-deploy` §1.2; this plan documents it but patches only if `PARACORD_HOST_BIND` is not already present (grep before edit). Either order works; recommended `postgres` → `coolify-deploy`.

Current (hardcoded SQLite):

```yaml
    environment:
      - PARACORD_DATABASE_URL=sqlite:///data/paracord.db?mode=rwc
      - PARACORD_DATABASE_MAX_CONNECTIONS=20
```

Proposed (backward-compatible interpolation defaults):

```yaml
    environment:
      # Database — SQLite by default (zero config). When running with
      # --profile postgres, set in .env:
      #   POSTGRES_PASSWORD=<strong random: openssl rand -hex 32>
      #   PARACORD_DATABASE_URL=postgresql://paracord:${POSTGRES_PASSWORD}@postgres:5432/paracord
      #   PARACORD_DATABASE_ENGINE=postgres
      # On Coolify with a managed Postgres resource, set PARACORD_DATABASE_URL
      # to that resource's internal URL instead (see docs/coolify.md).
      # The defaults below keep `docker compose up -d` on SQLite.
      - PARACORD_DATABASE_URL=${PARACORD_DATABASE_URL:-sqlite:///data/paracord.db?mode=rwc}
      - PARACORD_DATABASE_ENGINE=${PARACORD_DATABASE_ENGINE:-sqlite}
      - PARACORD_DATABASE_MAX_CONNECTIONS=${PARACORD_DATABASE_MAX_CONNECTIONS:-20}
      # … rest of paracord.environment unchanged
```

Why `${VAR:-default}` and not hardcoded? Operator can now:

```bash
# SQLite (default) — nothing to set
docker compose up -d

# Postgres — set .env, then one command
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)" >> .env
echo 'PARACORD_DATABASE_URL=postgresql://paracord:${POSTGRES_PASSWORD}@postgres:5432/paracord' >> .env
echo 'PARACORD_DATABASE_ENGINE=postgres' >> .env
echo 'PARACORD_DATABASE_MAX_CONNECTIONS=50' >> .env
docker compose --profile postgres up -d
```

SQLite users with no `.env` see zero change (`docker compose config` without profile shows `sqlite://…`).

Host port for Coolify Compose resource: keep `127.0.0.1:8090:8090` by default (bare-metal safety) but make it overridable so Traefik can reach it. Change `ports:` on `paracord` from hardcoded to:

```yaml
    ports:
      # HTTP API + WebSocket gateway. Default is loopback-only for bare-metal safety.
      # For Coolify (Traefik routes to the container), either:
      #   - Use the Dockerfile resource (ports ignored, Traefik uses EXPOSE 8090), or
      #   - Set PARACORD_HOST_BIND=0.0.0.0 in .env when using the Compose resource.
      - "${PARACORD_HOST_BIND:-127.0.0.1}:8090:8090"
      # Native QUIC / WebTransport media (raw QUIC desktop + browser WebTransport).
      # Coolify/Traefik cannot proxy UDP — this must be published on the host
      # and opened on the VPS firewall separately (see docs/coolify.md).
      - "8443:8443/udp"
```

Default `127.0.0.1` keeps bare-metal safety. On Coolify, the Dockerfile resource ignores `ports:` entirely (`EXPOSE 8090`); for the Compose resource, set `PARACORD_HOST_BIND=0.0.0.0`.

`depends_on` — add optional health-gated dependency so `docker compose --profile postgres up -d` orders correctly without breaking non-PG compose:

```yaml
    depends_on:
      postgres:
        condition: service_healthy
        required: false
```

`required: false` (Compose Spec 2.20+) makes the dependency optional: without the `postgres` profile the service is absent and Compose does not error. If older Compose without `required: false`, omit `depends_on` — server's 5 s pool-acquire timeout (`crates/paracord-db/src/lib.rs:POOL_ACQUIRE_TIMEOUT`) + `pg_isready` covers the race.

#### C1.3 Add volume `pgdata` — CANONICAL; `coolify-deploy` skips if `pgdata:` already present

```yaml
volumes:
  paracord-data:
  pgdata:
```

#### C1.4 File invariant after change

```bash
docker compose config                           # → paracord + sqlite, no postgres, no pgdata consumer, 127.0.0.1:8090:8090
docker compose --profile postgres config        # → + postgres:16-alpine, pgdata, 8443:8443/udp, PARACORD_DATABASE_URL=postgresql://…
docker compose --profile postgres --profile livekit config  # → postgres + livekit + paracord
```

#### C1.5 What not to change in compose

- `build:` / `image:` duality (`docker-compose.yml:14-16`) stays — Coolify pulls GHCR when `PARACORD_PULL_POLICY=missing`, otherwise builds locally.
- `livekit` stays on `profiles: ["livekit"]`, unchanged.
- `PARACORD_VOICE_NATIVE_MEDIA=true` default stays (native QUIC primary).
- `PARACORD_TLS_ENABLED=false` default stays — Traefik/reverse proxy owns TLS.

### C2. `.env.example` — document PG + proxy vars — SPLIT OWNERSHIP: proxy=CANONICAL in `coolify-deploy`, postgres=CANONICAL here

Append after LiveKit block (keep existing comments verbatim, add new sections commented out). Guarded append — check for existing markers before writing. Order when landing together: proxy block first (`coolify-deploy`), then postgres block (this plan). When landing alone, include both blocks. Full combined block (identical in both plans; skip second write if marker exists):

```dotenv
# --- Reverse proxy (Coolify / Traefik, nginx, Caddy) -------------------------
# Behind a reverse proxy, set all three. PARACORD_PUBLIC_URL is required for
# correct invite links and CORS. TRUST_PROXY + TRUSTED_PROXY_IPS make
# X-Forwarded-For trusted only from Traefik/nginx (see crates/paracord-util/src/client_ip.rs).
# Without them, all clients appear as 127.0.0.1 and rate-limit as one IP.
#   PARACORD_PUBLIC_URL=https://chat.example.com
#   PARACORD_TRUST_PROXY=true
#   PARACORD_TRUSTED_PROXY_IPS=172.18.0.0/16   # set to your Traefik/proxy CIDR — do not use "*"
#   PARACORD_COOKIE_SECURE=true
#   PARACORD_AUTO_PORT_FORWARD=false
#   PARACORD_TLS_ENABLED=false
# For Coolify Compose resource exposing via host port, also:
#   PARACORD_HOST_BIND=0.0.0.0

# --- PostgreSQL (optional) ---------------------------------------------------
# SQLite is the default (zero config) — `docker compose up -d` needs nothing here.
# For PostgreSQL via this compose file:
#   1. cp .env.example .env
#   2. Set POSTGRES_PASSWORD below (generate: openssl rand -hex 32)
#   3. Uncomment the three PARACORD_* lines
#   4. docker compose --profile postgres up -d
#
# The postgres service is profile-gated — it only starts with --profile postgres,
# so SQLite users are unaffected.
# For Coolify: prefer a managed Postgres resource (see docs/coolify.md) instead
# of --profile postgres on the Coolify host.
#   POSTGRES_PASSWORD=
#   PARACORD_DATABASE_ENGINE=postgres
#   PARACORD_DATABASE_URL=postgresql://paracord:${POSTGRES_PASSWORD}@postgres:5432/paracord
#   PARACORD_DATABASE_MAX_CONNECTIONS=50
```

Keep everything commented — no `.env` required for SQLite. `POSTGRES_PASSWORD` has no default for security; the `:?` guard in compose enforces it when the profile is active.

### C3. Optional — `docker-entrypoint.sh` auto-switch (nice-to-have, not required) — NO COLLISION (only this plan touches it)

If zero extra env beyond `POSTGRES_PASSWORD` is desired, add at top of `docker-entrypoint.sh` (before `exec`):

```sh
# If POSTGRES_PASSWORD is set but DATABASE_URL still points at SQLite (the
# compose default), assume --profile postgres is active and wire to postgres.
if [ -n "${POSTGRES_PASSWORD:-}" ] && [ "${PARACORD_DATABASE_URL:-}" = "sqlite:///data/paracord.db?mode=rwc" ]; then
  export PARACORD_DATABASE_URL="postgresql://paracord:${POSTGRES_PASSWORD}@postgres:5432/paracord"
  export PARACORD_DATABASE_ENGINE="postgres"
  [ -z "${PARACORD_DATABASE_MAX_CONNECTIONS:-}" ] && export PARACORD_DATABASE_MAX_CONNECTIONS=50
fi
```

Trade-off: magic vs explicit. Explicit `.env` is clearer; auto-switch is convenient. Choose explicit for the plan; mention auto-switch as follow-up if operators request it.

### C4. Docs — DISJOINT OWNERSHIP (see `plan.md:8` table)

`postgres` owns the **PostgreSQL-vs-SQLite** section; `coolify-deploy` owns the **Coolify/proxy (`docs/coolify.md`)** callouts. Different paragraphs, same files — never rewrite the same hunk.

| File | Change |
|---|---|
| `docs/docker-setup.md` | Add **PostgreSQL** section: `docker compose up -d` (SQLite) vs `docker compose --profile postgres up -d` (PG), `.env` steps, `pgdata` volume, host `psql` via `exec`, migration (`migrate-to-postgres`) still works both ways. Update Environment Variables table with `PARACORD_DATABASE_ENGINE`, `PARACORD_DATABASE_URL`, `POSTGRES_PASSWORD`. Link to `docs/coolify.md` for proxy env. |
| `docs/deployment.md` §4 | Replace "hand-write postgres service" guidance with pointer to `docker-compose.yml` `postgres` profile. Keep `[database]` TOML example for bare-metal. |
| `SELF_HOSTING_DEPLOYMENT_GUIDE.md` §2 | Update compose example to match shipped file (profile-gated PG, interpolation defaults). Or keep as expanded example with note "shipped compose already contains this as `profiles: [\"postgres\"]`." |
| `docs/deployment-profiles.md` | Add PG values under Single-Node Production (DB URL, connections 50, `pgdata` volume). |
| `README.md` (Running it) | Note PG option under Docker Compose. Link to `docs/coolify.md` when both plans are implemented. |
| `docs/sqlite-to-postgres-migration.md` | Add note: migration can target either external PG or the compose `postgres` service (via host-mapped port or `docker compose exec`). |
| `docs/postgres-pg-trgm.md` | Clarify compose PG is superuser (no `pg_trgm` issue); external managed PG still needs the workaround. |
| `docs/coolify.md` (if not already created by `coolify-deploy` plan) | Full Coolify runbook — see `docs/plans/coolify-deploy/implementation-steps.md` §3. |

---

## Phase D — Local Dev Parity

### D1. Document dev against PG (no new dep)

```bash
# One-time: start PG 16 locally (docker, brew, or existing)
createdb paracord_test
PARACORD_DATABASE_URL=postgresql://localhost/paracord_test \
PARACORD_DATABASE_ENGINE=postgres \
cargo run --bin paracord-server --no-default-features
```

Or via compose PG for local dev:

```bash
docker compose --profile postgres up -d postgres  # PG only, host can psql via mapped port if added
```

### D2. Optional helper `scripts/dev-postgres.sh` (if team wants it)

- `docker run -d --name paracord-pg -e POSTGRES_PASSWORD=paracord -p 5432:5432 postgres:16-alpine`
- `createdb`, `psql` healthcheck, `cargo run` wrapper.

### D3. Tests

Already support PG via `PARACORD_TEST_POSTGRES_URL` (`AGENTS.md`). Document:

```bash
PARACORD_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/paracord_test \
  cargo test -p paracord-api -- --test-threads=4
cargo test --workspace --all-targets  # still SQLite by default
```

---

## Phase E — Backup / Restore & Ops on PostgreSQL

### E1. Backups

Admin Backups panel + API use `pg_dump`/`pg_restore` on PG (same as SQLite file snapshot). Verify via `docs/backup-recovery.md`.

### E2. Restore (isolated, never in-place)

```bash
createdb --owner=paracord_recovery paracord_recovery_20260912
export PARACORD_RECOVERY_DATABASE_URL='postgres://paracord_recovery@localhost/paracord_recovery_20260912'
paracord-server --config /srv/paracord/paracord.toml restore-backup \
  --archive /srv/backups/paracord-backup.tar.gz \
  --output-dir /srv/paracord-recovery-20260912 \
  --postgres-url-env PARACORD_RECOVERY_DATABASE_URL
# refuses source DB as target, refuses non-empty target
```

For DB-only archives add `--media-dir /srv/backups/matching-media-export` (must contain `uploads/`+`files/`).

### E3. Retention / at-rest

`[retention]` and `[at_rest]` apply on PG as on SQLite; verify `statement_timeout`/`idle_in_transaction_timeout` do not conflict with long backup/restore.

---

## Phase F — Sequencing & Rollout — JAMMED WITH `coolify-deploy`

1. **Commit A — `docker-compose.yml` + `.env.example` — COORDINATION REQUIRED** (single commit, additive, behind `profiles: ["postgres"]`). Shared with `coolify-deploy` — **only one PR may touch `docker-compose.yml:services.postgres`**. Recommended: `postgres` lands first (C1.1 `postgres` service + C1.3 `pgdata` + DB env `C1.2`); `coolify-deploy` then adds only the host-bind delta (`"${PARACORD_HOST_BIND:-127.0.0.1}:8090:8090"`). If `coolify-deploy` lands first, this plan skips service creation. Never open two PRs that both create the service.
2. **Commit B — docs** (`docs/docker-setup.md`, `docs/deployment.md`, `SELF_HOSTING_DEPLOYMENT_GUIDE.md`, etc.) — docs only. Disjoint paragraphs per `plan.md:8`: `postgres` touches PG-vs-SQLite paragraphs; `coolify-deploy` touches Coolify/proxy paragraphs.
3. **Commit C — optional dev helper** (`scripts/dev-postgres.sh`) if desired — `postgres` only; no coolify overlap.
4. Verify (see `verification.md`): `docker compose config` invariants, `docker compose --profile postgres` smoke, brownfield `migrate-to-postgres`, lint/tests. When landing together, run **both** `postgres/verification.md` and `coolify-deploy/verification.md` (split gates).
5. No version bump needed (`docker-compose.yml` change is additive, behind profile).
6. **Deprecation:** `docs/plans/postgres-enablement/` Phase C (`docker-compose.postgres.yml` override) is superseded — this unified plan replaces it. See `docs/plans/coolify-deploy/` for Coolify-specific additions that share the same compose service.

## 6. What This Plan Explicitly Does NOT Do

- No `docker-compose.postgres.yml` override file (single-file constraint).
- No `coolify.json` / `nixpacks.toml` checked in — Coolify detects `Dockerfile` automatically.
- No Rust code change for Postgres (server already dual-engine).
- No default-engine switch (SQLite stays default).
- No Traefik UDP routing for `8443/udp` (host-level UDP publish + firewall is the fix).
- No always-on Postgres (profile-gated to keep zero-config).
- No host `5432:5432` mapping by default (internal-only `postgres:5432`).

