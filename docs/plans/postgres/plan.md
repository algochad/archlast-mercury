# PostgreSQL Plan (Unified)

> Location: `docs/plans/postgres/` — merged from `docs/plans/postgres-enablement/` + `docs/plans/postgres-docker-compose/`
> Status: Draft — 2026-09-24
> Scope: Make PostgreSQL a first-class deployment path — greenfield, brownfield migration, local dev/CI parity, backup/restore — with PostgreSQL **inside the single checked-in `docker-compose.yml`** (`profiles: ["postgres"]`). No `docker-compose.postgres.yml` override. SQLite stays the zero-config default.
> History: `postgres-enablement` proposed a `docker-compose.postgres.yml` override (Phase C); `postgres-docker-compose` replaced it with a single-file profile per your request. This folder is the merged canonical plan.

## 0. Summary

Paracord **already supports PostgreSQL natively** — it is not SQLite-only. Both engines share the same `sqlx::AnyPool` codepath (`crates/paracord-db/src/lib.rs:82` `AnyPool`, `crates/paracord-server/src/config.rs:117` `DatabaseConfig`, `crates/paracord-server/src/main.rs:538` `run_migrations_for_engine`). SQLite is the zero-config default (`config/paracord.toml:engine=sqlite`, `docker-compose.yml:37` `sqlite:///data/paracord.db`). Switching is config/env-only; no schema fork, no code fork.

This unified plan makes PostgreSQL a documented, one-command, Docker-Compose-and-bare-metal option with:
- **Greenfield** — fresh PG DB via env (`PARACORD_DATABASE_ENGINE=postgres` + `PARACORD_DATABASE_URL`)
- **Brownfield** — migrate existing SQLite → PG (`paracord-server migrate-to-postgres`)
- **Compose** — `postgres:16-alpine` **in the main `docker-compose.yml`** (`profiles: ["postgres"]`), keeping `docker compose up -d` on SQLite
- **Local dev / CI parity** — `PARACORD_TEST_POSTGRES_URL` workflow, optional `scripts/dev-postgres.sh`
- **Backup / restore parity** — `restore-backup --postgres-url-env` on PG
- **Coolify ready** — same compose PG service works locally; on Coolify prefer a managed Postgres resource (see `docs/plans/coolify-deploy/`)

No breaking change to existing SQLite deployments. No default-engine change. One file, two topologies.

## 1. Current State

### 1.1 What exists

| Area | File(s) | State |
|---|---|---|
| Dual-engine pool | `crates/paracord-db/src/lib.rs:82` (`DbPool = AnyPool`, `DatabaseEngine`), `Cargo.toml:40` (`sqlx` `sqlite,postgres,any`) | Done |
| Config switch | `crates/paracord-server/src/config.rs:117` (`DatabaseConfig{engine,url,max_connections,work_mem…}`), env `PARACORD_DATABASE_ENGINE`/`PARACORD_DATABASE_URL` (`config.rs:1153`) | Done |
| Auto-migrations | `crates/paracord-server/src/main.rs:538` `run_migrations_for_engine` | Done — PG migration track at boot |
| SQLite → PG migrator | `crates/paracord-server/src/cli.rs:22` `migrate-to-postgres`, `crates/paracord-db/src/migrate_export.rs` (`MIGRATION_TABLE_ORDER`, FK-safe) | Done — `docs/sqlite-to-postgres-migration.md` |
| Restore on PG | `crates/paracord-server/src/cli.rs:73` `restore-backup --postgres-url-env`, `crates/paracord-server/src/restore.rs` | Done |
| PG tuning knobs | `config/paracord.toml:18` `work_mem_mb`, `maintenance_work_mem_mb`, `statement_timeout_secs` | Done |
| CI PG coverage | `AGENTS.md:Verify`, `.github/workflows/ci.yml` (`PARACORD_TEST_POSTGRES_URL`) | Partial — SQLite default locally; PG only when `PARACORD_TEST_POSTGRES_URL` set |
| Docker default | `docker-compose.yml:37` `sqlite:///data/paracord.db` | SQLite-only as shipped |
| Docs | `docs/deployment.md:158`, `docs/sqlite-to-postgres-migration.md`, `docs/postgres-pg-trgm.md`, `SELF_HOSTING_DEPLOYMENT_GUIDE.md` | Documented but scattered |

### 1.2 Gaps

1. **No `postgres` service in `docker-compose.yml`** — operator must hand-write it (guide shows it in `SELF_HOSTING_DEPLOYMENT_GUIDE.md` but not in checked-in compose).
2. **No `.env.example` entry for PG** — only `PARACORD_PUBLIC_URL` + LiveKit there.
3. The earlier `postgres-enablement` plan proposed a `docker-compose.postgres.yml` override to avoid touching the main file — superseded by the single-file profile per your request (`postgres-docker-compose` plan).
4. **Local dev defaults to SQLite** — `cargo run --no-default-features` gets SQLite unless env is set.
5. **`pg_trgm` extension** requires `CREATE EXTENSION` privilege; managed PG may block it (`docs/postgres-pg-trgm.md`).
6. **SQLCipher-encrypted SQLite** cannot be migrated directly; needs decrypted export first (`docs/sqlite-to-postgres-migration.md`).

### 1.3 Decision

**No application code change required.** Configuration/deployment/documentation only. Add `postgres` to the **single `docker-compose.yml`** under `profiles: ["postgres"]` (same idiom as `livekit`). Keep `paracord` defaults on SQLite via `${VAR:-default}` interpolation. No override file.

Do NOT change default engine — keep `sqlite` default for zero-ops. PG is opt-in.

## 2. Goals / Non-Goals

**Goals**
- One-command PG deployment via Docker Compose (`docker compose --profile postgres up -d`).
- Clear bare-metal PG setup for systemd/binary installs.
- Safe brownfield migration with rollback (`migrate-to-postgres` + runbook).
- Backup/restore, retention, and at-rest encryption parity on PG.
- Dev and CI can target PG without friction.
- One canonical `docker-compose.yml` — no second compose file.

**Non-Goals**
- Changing default DB to PG.
- Supporting MySQL/other engines.
- Multi-writer / read-replica.
- Shipping `docker-compose.postgres.yml` (rejected — one file).

## 3. Architecture Impact

### 3.1 Server DB wiring (unchanged)

```
                 Config (paracord.toml + PARACORD_* env)
                           │
              ┌────────────┴────────────┐
              │  paracord-server::Config::load()
              │  validates engine/url     │
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  create_pool_full(url, max_connections, engine,
              │    sqlite_key_hex, PgConnectOptions{statement_timeout,…})
              │  cr: crates/paracord-db/src/lib.rs
              └────────────┬────────────┘
                           │
              ┌────────────▼────────────┐
              │  run_migrations_for_engine(pool, engine)
              │  → engine-specific migration track
              │    crates/paracord-db/migrations/*.sql
              └────────────┬────────────┘
                           │
                    AppState{db: AnyPool}
                           │
              ┌────────────┼────────────┐
              │  paracord-core (services)  paracord-api (routes)
              │  paracord-ws (gateway)      paracord-media/federation
              └──────────────────────────────┘
```

All downstream crates use `AnyPool`/`AnyConnection` — no engine branching in handlers beyond dialect `sqlx::Any` abstracts. PG tuning is per-connection (`SET work_mem`, `statement_timeout`) via `PgConnectOptions`.

### 3.2 Compose topology (single file, two modes) — from `postgres-docker-compose`

```
Without profile (default):
  paracord ──► sqlite:///data/paracord.db  (volume: paracord-data)
  livekit  (off, profile: livekit)
  postgres (off, profile: postgres)

With --profile postgres:
  postgres:16-alpine ──► pgdata:/var/lib/postgresql/data  (healthcheck: pg_isready)
         ▲
         │ depends_on (service_healthy)
      paracord ──► postgresql://paracord:${POSTGRES_PASSWORD}@postgres:5432/paracord
  livekit (still off unless --profile livekit also)

With --profile postgres --profile livekit:
  postgres + livekit + paracord (all wired; livekit unchanged)
```

Config wire: `crates/paracord-server/src/config.rs:1153` reads `PARACORD_DATABASE_ENGINE`/`PARACORD_DATABASE_URL` from env, which compose injects via `${VAR:-default}` interpolation. Server picks migration track at boot (`main.rs:538`).

**Why `profiles: ["postgres"]`:** Matches existing `livekit` pattern (`docker-compose.yml:livekit.profiles`). Avoids pulling/starting Postgres for SQLite users, keeps `docker compose config` honest, `docker compose --profile postgres config` validates wiring.

## 4. Implementation

See `implementation-steps.md`. Summary phases:

| Phase | What | Risk |
|---|---|---|
| **A — Greenfield** (zero code) | Env/config switch (`PARACORD_DATABASE_ENGINE=postgres`) + fresh PG DB | Low |
| **B — Brownfield migration** | `migrate-to-postgres` (`--dry-run` → live copy, FK-order, single tx) | Medium — downtime, empty target |
| **C — Docker Compose (single file)** | `docker-compose.yml` — add `postgres:16-alpine` `profiles: ["postgres"]` + `pgdata` + healthcheck + interpolation defaults for `paracord` + `.env.example` + `docs/docker-setup.md` | Low |
| **D — Local dev parity** | `PARACORD_TEST_POSTGRES_URL` workflow, optional `scripts/dev-postgres.sh` | Low |
| **E — Backup/restore & ops** | `restore-backup --postgres-url-env`, retention/at-rest on PG | Low |

Phases A+B are immediately usable (no PR); **Phase C is the PR** — single-file profile. D+E are follow-up docs.

## 5. Alternatives Considered

| Option | Verdict |
|---|---|
| Keep SQLite only | Rejected — already supports PG; prod at scale needs PG |
| Switch default to PG | Rejected — breaks zero-ops promise |
| Separate PG fork / feature flag | Rejected — `AnyPool` already unifies |
| `docker-compose.postgres.yml` override | Rejected per request — keep one file (supersedes `postgres-enablement` Phase C) |
| Always-on `postgres` (no profile) | Rejected — pulls PG for every SQLite user |
| Separate `compose.yaml` with `include:` | Rejected — fragments the single file |
| Env-conditional `depends_on` without profile | Not expressible in Compose spec — profile is the idiom |

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Target not empty / has app data (migrator) | Expects fresh DB; `—dry-run` validation; runbook says refuse non-empty |
| `pg_trgm` blocked on managed PG | `docs/postgres-pg-trgm.md` workaround; compose PG is superuser (no issue locally) |
| SQLCipher source cannot be migrated | Require decrypted export first (documented) |
| Downtime during migration (no snapshot) | Require stopped server; 5 s `POOL_ACQUIRE_TIMEOUT` + WAL note |
| Secrets not in DB (`JWT_SECRET`, `paracord.toml`, certs, federation key, at-rest `PARACORD_AT_REST_KEY`) | Retain alongside DB backup (`docs/backup-recovery.md`) |
| Pool too low for PG | `max_connections=50` for PG (vs 20 SQLite); `PARACORD_DATABASE_MAX_CONNECTIONS` |
| `POSTGRES_PASSWORD` empty with `--profile postgres` | `${POSTGRES_PASSWORD:?...}` fail-fast; SQLite path needs no `.env` |
| `pgdata` left behind on `down` | Document `down` vs `down -v`; named volume intentional |
| Host already has PG on 5432 | Internal-only (no `ports: 5432:5432`); `exec psql` access |

## 7. Open Questions

- Pin PG tag: `postgres:16-alpine` (matches guide) vs `postgres:17-alpine`? Keep `16-alpine`, bump intentionally.
- Add `make`/`just` target for `PG_URL=… cargo test -p paracord-api`?
- Should `PARACORD_DATABASE_MAX_CONNECTIONS` default bump to `50` when on PG? Keep `20` default, recommend `50` in `.env.example` for PG.
- Expose PG host port helper: `docker compose --profile postgres exec postgres psql -U paracord` vs `ports: ["127.0.0.1:5432:5432"]`? Prefer exec/internal-only.

## 8. Cohesion with `coolify-deploy` (No-Collision Contract)

The two active plans — **`postgres` (this folder)** and **`coolify-deploy`** — share one composition surface and are designed to be applied together in any order without double-patching. This section is the contract; it must be kept in sync with `docs/plans/coolify-deploy/plan.md:8`.

### Shared File Ownership (single writer per region)

| File / Region | Canonical Owner | Other Plan Does | How to Avoid Collision |
|---|---|---|---|
| `docker-compose.yml` → `postgres:16-alpine` service + `pgdata` volume + `healthcheck` | **`postgres` Phase C, C1.1 + C1.3** | `coolify-deploy` reuses it verbatim; adds only `${PARACORD_HOST_BIND:-127.0.0.1}:8090:8090` + UDP comment (C1.2) | Apply `postgres` C1.1/C1.3 once. If `coolify-deploy` is applied first, `postgres` skips service creation and goes straight to interpolation wiring. |
| `docker-compose.yml` → `paracord` DB env interpolation (`PARACORD_DATABASE_URL/ENGINE/MAX_CONNECTIONS`) + `depends_on: postgres {required:false}` | **`postgres` Phase C, C1.2** | `coolify-deploy` does not re-add; verifies the interpolation exists | Idempotent `${VAR:-default}` — second apply is a no-op. |
| `docker-compose.yml` → `ports: "${PARACORD_HOST_BIND:-127.0.0.1}:8090:8090"` | **Joint** — `postgres` C1.2 documents it, `coolify-deploy` 1.2 implements it | Either plan may land it; the other skips if the line already exists. | Grep for `PARACORD_HOST_BIND` before patching. |
| `.env.example` → Proxy block (`PARACORD_PUBLIC_URL`, `TRUST_PROXY`, `TRUSTED_PROXY_IPS`, `COOKIE_SECURE`, `AUTO_PORT_FORWARD`, `TLS_ENABLED`, `HOST_BIND`) | **`coolify-deploy` §2** (canonical) | `postgres` C2 includes the same commented block for completeness, marked "shared with coolify-deploy" — if `coolify-deploy` already landed, skip proxy lines | Append proxy block before PG block; second append is skipped if `PARACORD_PUBLIC_URL` already in file. |
| `.env.example` → Postgres block (`POSTGRES_PASSWORD`, `PARACORD_DATABASE_*`) | **`postgres` Phase C, C2** (canonical) | `coolify-deploy` step 3 is identical and says "sibling — skip if postgres already applied" | Same block, same comments; dupe is harmless (commented lines) but skip to keep `git diff` clean. |
| `docs/docker-setup.md`, `docs/deployment.md`, `SELF_HOSTING_DEPLOYMENT_GUIDE.md` | Both touch, different sections | `postgres` owns the **PostgreSQL-vs-SQLite** section; `coolify-deploy` owns the **Coolify/proxy** callouts and link to `docs/coolify.md` | Edit disjoint paragraphs; never rewrite the same hunk. |
| `docs/coolify.md` (new) | **`coolify-deploy` §3** only | `postgres` only links to it (`see docs/coolify.md`) | No conflict. |

### Sequencing

Either plan can land first; **recommended order is `postgres` → `coolify-deploy`** because the postgres service is the larger compose diff and `coolify-deploy` layers the small host-bind tweak on top.

- **If implementing both together:** land `postgres` Commit A (`docker-compose.yml` + `.env.example`) then `coolify-deploy` Commit A delta (host-bind + proxy lines + `docs/coolify.md`). Never open two PRs that both touch `docker-compose.yml:services.postgres` at the same time.
- **If landing separately:** the second PR's CI must verify `docker compose config` (with and without `--profile postgres`) before and after, to prove idempotence.

### Shared Invariants (both plans guarantee)

- `docker compose up -d` without flags stays SQLite, zero `.env` — enforced by `${VAR:-default}` interpolation and `profiles: ["postgres"]`.
- No `docker-compose.postgres.yml` / `docker-compose.override.yml` is ever created — both plans explicitly reject it.
- `postgres:16-alpine` pinned, `pgdata` named, `healthcheck: pg_isready`, `${POSTGRES_PASSWORD:?...}` fail-fast, internal-only (no `5432:5432`), and `required:false` on `depends_on`.
- Verification is split: `postgres/verification.md` gates local compose PG; `coolify-deploy/verification.md` gates Coolify scan, GHCR, proxy, and `/health`. Run both when landing together.

## 9. References

- `config/paracord.toml:1` — default config
- `crates/paracord-server/src/config.rs:117` — `DatabaseConfig` + env overrides (`config.rs:1153`)
- `crates/paracord-db/src/lib.rs:82` — `DatabaseEngine`, `DbPool = AnyPool`
- `crates/paracord-server/src/cli.rs:22` — `migrate-to-postgres` args
- `crates/paracord-db/src/migrate_export.rs` — table order (`MIGRATION_TABLE_ORDER`), batching, tx
- `crates/paracord-server/src/main.rs:538` — `run_migrations_for_engine`
- `docs/sqlite-to-postgres-migration.md` — migrator runbook
- `docs/deployment.md:158` — PG section
- `docs/postgres-pg-trgm.md` — extension guidance for external PG
- `docs/backup-recovery.md` — `restore-backup --postgres-url-env` on PG
- `docs/docker-setup.md`, `SELF_HOSTING_DEPLOYMENT_GUIDE.md` — compose PG docs
- `docker-compose.yml:37` — current SQLite default
- `.env.example` — env template
- Prior plans merged: `docs/plans/postgres-enablement/` + `docs/plans/postgres-docker-compose/` → this folder
- Coolify companion: `docs/plans/coolify-deploy/` (shares the same single-file compose PG service)
