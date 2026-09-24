# Rebrand Plan — Archlast Mercury → Archlast Mercury

> Executed: 2026-09-24. See commit history.

> Location: `docs/plans/archlast-mercury-rebrand/`
> Status: Draft — 2026-09-24
> Scope: Rename every user-visible and internal reference from **Archlast Mercury / mercury / PARACORD** to **Archlast Mercury / mercury / MERCURY** (with `ARCHLAST_MERCURY` / `archlast-mercury` where uniqueness demands). No feature change — same server, same protocol, new name.
> Companion: `docs/plans/postgres/` (data layer) and `docs/plans/coolify-deploy/` (platform layer) — see §8 Cohesion. Cohesion contract: `plan.md:8` (this folder) ↔ `postgres/plan.md:8` ↔ `coolify-deploy/plan.md:8`.

## 0. Summary

The repository directory is already `archlast-mercury`, but **536 files** still carry `Archlast Mercury/mercury/PARACORD` branding — crate names, 161 `MERCURY_*` env vars, `com.mercury.desktop` bundle ID, `mercury://` deep-link, `x-mercury-*` headers, `mercury_*` cookies, `/_mercury/` federation paths, `mercury.db`/`mercury.toml`, `paracord-data` volume, `ghcr.io/algochad/archlast-mercury` image, `mercury-*` npm/workspace packages, and all docs/assets. The git history, database, and on-disk installs of existing users still speak `mercury`.

This plan makes Archlast Mercury the canonical name **without breaking upgrades**: every renamed surface keeps a backward-compatible alias/redirect/migration for at least one minor version, then deprecates. The compose-level change is additive (profile-gated Postgres and Coolify docs already follow the single-file `docker-compose.yml` rule) — the rebrand layers new names on top of the same file and env wiring. Land order does not matter, but **recommended is `postgres` → `coolify-deploy` → `archlast-mercury-rebrand`** so the rebrand can touch the already-unified compose/docs once.

## 1. Codebase Scan — What Carries the Old Name

Audit run 2026-09-24 via `grep -r "mercury|Archlast Mercury|PARACORD"` — 536 files. Full file-level map is in `codebase-scan.md`; key surfaces below with canonical new names proposed.

### 1.1 Decision → Canonical New Names (locked before Phase 1)

| Surface | Old | New (canonical) | Why this form |
|---|---|---|---|
| Project / repo | `Archlast Mercury` / `mercury` | **`Archlast Mercury`** (display) / **`archlast-mercury`** (kebab, repo, image, file) | User asked for `archlast-mercury` as the app name |
| Rust crates | `mercury-api`, `mercury-db`, … (14 crates) | **`mercury-api`, `mercury-db`, …** (short prefix) + workspace alias `archlast-mercury-*` where uniqueness needs it | `archlast-mercury-api` is too long for every import; `mercury-*` is readable, `archlast-mercury` stays the product name. Keep `mercury` as crate namespace, publish as `archlast-mercury-*` only if uniqueness collides. |
| Crate dirs/files | `crates/mercury-*/` | `crates/mercury-*/` (with `package.name = "mercury-*"`; `archlast-mercury` as `[[bin]]` name) | Filesystem mirrors crate name |
| Env var prefix | `MERCURY_*` (161 vars, `config.rs:1133`) | **`MERCURY_*`** primary, **`ARCHLAST_MERCURY_*`** accepted where ambiguity matters; **`MERCURY_*` stays as fallback for 1 version** | 161 vars cannot break in one cut. `MERCURY_*` is short; `ARCHLAST_MERCURY_*` is the fully-qualified alias where Coolify docs show it. Dual-read keeps upgrades non-breaking. |
| Config file | `config/mercury.toml` / `/data/mercury.toml` | **`config/mercury.toml`** / **`/data/mercury.toml`** (with symlink/compat read of `mercury.toml` for 1 version) | Server `Config::load("/data/mercury.toml")` falls back to `/data/mercury.toml` if new file absent. |
| Database file | `mercury.db`, `mercury.db-shm/wal` | **`mercury.db`** (migrate via `mv` on first run; keep old path as fallback) | Default fallback `crates/mercury-server/src/config.rs:154` `sqlite://./data/mercury.db` with fallback probe for `mercury.db`. |
| On-disk dirs | `/data/uploads`, `/data/files`, `/data/certs`, `/data/backups`, `/data/federation_signing_key.hex`, `/data/first-owner-claim.txt` | **Keep `/data/*` paths** — only the top-level names that embed the brand change (`mercury.db` → `mercury.db`, `mercury.toml` → `mercury.toml`) | Avoid migrating media dirs; rename only identity-bearing files. |
| Docker image | `ghcr.io/algochad/archlast-mercury:latest` (`docker-compose.yml:14`, `Dockerfile`, `ci.yml:450`) | **`ghcr.io/<org>/archlast-mercury:latest`** (publish both tags for transition; `:latest` on new name is canonical) | GHCR package rename: `mercury` → `archlast-mercury`. |
| Compose service/volume | `mercury:` + `paracord-data:/data`, `mercury-postgres`, `mercury-livekit` (`docker-compose.yml:14,25,112`) | **`mercury:`** + **`mercury-data:/data`**, **`mercury-postgres`**, **`mercury-livekit`** (keep alias `paracord-data` volume for 1 version via external volume compat) | Compose service rename is visible to operators; alias volume prevents data loss on upgrade. |
| `.env` prefix | `MERCURY_*`, `MERCURY_PULL_POLICY`, `MERCURY_BUILD_CONTEXT` | **`MERCURY_*`** / `ARCHLAST_MERCURY_*`; **keep `MERCURY_*` read as fallback** | Same env dual-read as server. |
| Desktop app | `productName: "Archlast Mercury"`, `identifier: "com.mercury.desktop"`, `title: "Archlast Mercury"`, `schemes: ["mercury"]` (`client/src-tauri/tauri.conf.json`) | **`"Archlast Mercury"`**, **`"com.archlast.mercury"`** (or `com.archlast.mercury.desktop`), **`"Archlast Mercury"`**, **`["mercury", "archlast-mercury"]`** (register both schemes; old `mercury://` handled as redirect) | Product rename; keep old scheme as handler for invite links already in the wild. |
| Client package | `mercury-client` (`client/package.json:2`), `archlast-mercury-bot-sdk` (`packages/archlast-mercury-bot-sdk`) | **`archlast-mercury-client`** (or `mercury-client` display `Archlast Mercury`), **`archlast-mercury-bot-sdk`** (npm scope unchanged if any) | `package.json:name` change; keep old name as deprecated alias only if published. |
| HTTP headers | `x-mercury-trace-id`, `x-mercury-csrf`, `x-mercury-history-epoch` (`crates/mercury-api/src/lib.rs`, `client/src/api/client.ts`) | **`x-mercury-*`** (or `x-archlast-mercury-*`) **+ accept `x-mercury-*` for 1 version** | Middleware reads `x-mercury-*` first, falls back to `x-mercury-*`. |
| Cookies | `mercury_access`, `mercury_csrf`, `mercury_refresh` (`crates/mercury-api`) | **`mercury_access`, `mercury_csrf`, `mercury_refresh`** + accept `mercury_*` for 1 version | Auth middleware checks new names first, then old. |
| Federation / internal paths | `/_mercury/federation/v1/*`, `/.well-known/mercury/server` (`crates/mercury-api/src/lib.rs`, `crates/mercury-federation`) | **`/_mercury/federation/v1/*`** + **`/_mercury/`** kept as 308 redirect; well-known `/.well-known/mercury/server` + redirect from old | Federation peers may be on old deploy; dual route keeps sync. |
| WebSocket / realtime | `/gateway` (unchanged), `/_paracord` in `vite.config.ts:46` denylist | Keep `/gateway` stable; add `/_mercury` alongside `/_paracord` in denylist | `/_paracord` path is infra, not brand — brand the prefix to `/_mercury` going forward. |
| Docs / assets | `docs/images/brand/mercury.webp`, `docs/*.md`, `README.md`, `SELF_HOSTING_DEPLOYMENT_GUIDE.md`, `AGENTS.md`, `LICENSE` | **`docs/images/brand/mercury.webp`** + updated docs, plus **redirect note** in old-brand docs | One asset rename + doc sweep; keep old image for transition if already shipped. |
| CI / scripts | `.github/workflows/ci.yml:450` `ghcr.io/.../mercury`, `scripts/install.sh`, `scripts/backup-db.sh` | **GHCR `archlast-mercury`**, scripts updated to new names with old-name fallback | See Phase 6. |
| Database / at-rest var | `MERCURY_AT_REST_KEY` (`config.rs:709`), `MERCURY_TEST_POSTGRES_URL` | `MERCURY_AT_REST_KEY` (fallback `MERCURY_AT_REST_KEY`) | Part of env dual-read. |

Detail with line numbers: `codebase-scan.md`.

### 1.2 What passes without change (green)

- `Dockerfile` multi-stage, `EXPOSE 8090` + `8443/udp`, `HEALTHCHECK /health`, `VOLUME ["/data"]`, `USER mercury` — none is brand-specific beyond the `ENV MERCURY_*` defaults, which become `MERCURY_*` with alias.
- `docker-entrypoint.sh` layout (`/data/uploads`, …) — brand-agnostic.
- `tauri` webview embedding (`embed-ui`) — unaffected.
- Postgres/Cockify compose profile `profiles: ["postgres"]` / `["livekit"]` — brand-agnostic.
- `crates/mercury-db` SQLx dual-engine pool — brand-agnostic.

## 2. Goals / Non-Goals

**Goals**
- One canonical name: **Archlast Mercury** everywhere the user looks (app window, installer, invite links, docs, Docker Hub/GHCR, CLI help).
- One canonical crate/ID prefix: **`mercury-`** (crate), **`archlast-mercury`** (repo/image/file/product).
- Back-compat for existing installs: old env vars, old cookies/headers/paths, old config/DB files continue to work for ≥1 minor version — upgrades do not brick.
- No `archlast-mercury` vs `mercury` collision: document when to use which (see §1.1 table).
- Single-file `docker-compose.yml` stays single-file; volume/service rename uses alias, not a second file.
- All three active plans stay cohesive — no file is renamed by two plans at once (see §8).

**Non-Goals**
- Changing database schema or protocol (only names).
- Shipping `coolify.json`/`nixpacks.toml` (not needed — Coolify detects `Dockerfile`).
- Switching default DB (SQLite stays default) or adding multi-writer.
- Renaming git history (`git log` keeps old commit messages; only `Cargo.toml` `package.name` changes).
- Immediate removal of `MERCURY_*` env vars — removal is a follow-up after deprecation window.

## 3. Architecture Impact

### 3.1 Env + config dual-read (the core compat layer)

```
Client / Compose / Coolify → ENV inject
              │
              ├─► MERCURY_* ──────────┐
              ├─► ARCHLAST_MERCURY_* ──┤
              └─► MERCURY_* (fallback, deprecated, logged) ─┘
                              │
                   Config::load() (config.rs)
                   reads MERCURY_* first, then ARCHLAST_MERCURY_*, then MERCURY_*
                   warns when fallback is used
                              │
              ┌───────────────▼────────────────┐
              │ mercury_server::Config         │
              │ .bind_address  .database.*      │
              │ .storage.*     .voice.* …       │
              └───────────────┬────────────────┘
                              │
              ┌───────────────▼────────────────┐
              │ create_pool_full /              │
              │ run_migrations_for_engine       │
              │ AnyPool — unchanged             │
              └───────────────────────────────┘
```

- Every `std::env::var("MERCURY_…")` in `config.rs` (≈40+), `mercury-util/client_ip.rs`, `mercury-ws/handler.rs`, `mercury-api/lib.rs` becomes a helper `env_var_with_fallback("MERCURY_…", "MERCURY_…")` (or `ARCHLAST_MERCURY_*`) that prefers new, falls back to old, and emits a `tracing::warn!` when the fallback fires.
- Same for `client/src-tauri/src/lib.rs:1564` (`MERCURY_*` gating native media / `SCREEN_SIMULCAST` etc.) → dual-read with new names.
- Config file: `Config::load("/data/mercury.toml")` tries new path first; if absent, loads `/data/mercury.toml`, logs a migration notice, and writes the new file on next successful save/migration. Old file left in place until operator removes it.

### 3.2 HTTP compat (headers/cookies/paths)

```
Request ──► tower layer / axum extractors
              │
              ├─ check Cookie: mercury_access (new) → if absent, try mercury_access
              ├─ check Header: x-mercury-csrf / x-mercury-trace-id → fallback x-mercury-*
              ├─ route: /_mercury/federation/* (new) → handler
              │        /_mercury/federation/* (old) → 308 → /_mercury/…  (1 version)
              └─ federation signing: accept both key paths (mercury_signing_key.hex fallback)
```

- Auth middleware: `mercury_access` / `mercury_csrf` / `mercury_refresh` → `mercury_*` primary, `mercury_*` fallback. After login, set **both** cookies so an old client and a new client both authenticate.
- Headers: `x-mercury-*` primary; `x-mercury-*` accepted (logged). Clients send new headers after upgrade; server accepts old until removal.
- Well-known: `/.well-known/mercury/server` primary; `/.well-known/mercury/server` 308 to new for 1 version.

### 3.3 Filesystem / Docker compat

```
Host volume paracord-data (old) ──► still mounts at /data (brand-agnostic)
                │
                ├─ /data/mercury.toml (new) ←── if absent, read /data/mercury.toml, then write new
                ├─ /data/mercury.db   (new) ←── if absent, probe /data/mercury.db, mv/copy to new
                ├─ /data/mercury.toml / mercury.db left until operator prunes (docs note)
                └─ uploads/files/certs/backups — unchanged paths

GHCR: ghcr.io/<org>/archlast-mercury:latest (canonical)
  └─ ghcr.io/<org>/mercury:latest → retag/push alias for 1 version so old pulls still work

Compose: service mercury: + volume mercury-data:/data  (new)
  └─ alias external volume paracord-data when old installs are detected (docker-compose.yml comment)
```

## 4. Implementation — At a Glance

| Phase | What | Files | Risk | Owner after |
|---|---|---|---|---|
| **0 — Lock names** | Confirm §1.1 table; decide `mercury` vs `archlast-mercury` for crates/npm scope | This doc, `AGENTS.md` | None | — |
| **1 — Dual-read env/config** | `crates/mercury-server/src/config.rs` (~40 env sites), `crates/mercury-util/src/client_ip.rs`, `crates/mercury-ws/handler.rs`, `client/src-tauri/src/lib.rs`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `config/mercury.toml` template generation (keep `config/mercury.toml` symlink/compat) | Low — additive | `postgres` C1.2/C2 overlaps — see §8 |
| **2 — Crate/filesystem rename** | `Cargo.toml` workspace `members`, 14× `crates/mercury-*` → `crates/mercury-*` (or `archlast-mercury-*` as `package.name`), `Cargo.lock`, `client/src-tauri/Cargo.toml`, `crates/*/Cargo.toml` `[dependencies]` `mercury-*` refs, `packages/archlast-mercury-bot-sdk` → `archlast-mercury-bot-sdk` | Medium — touches every compile | None — exclusive to this plan |
| **3 — Docker/Tauri/CLI rename** | `Dockerfile` `ENV MERCURY_*`, `docker-compose.yml` service `mercury`, volume `mercury-data`, `GHCR` image, `client/src-tauri/tauri.conf.json` (`productName`, `identifier`, `title`, `schemes`), `client/package.json:name`, deep-link `mercury://`, CLI `mercury-server` bin alias | Medium — visible to operators | Overlaps `postgres`+`coolify-deploy` compose surface — see §8 |
| **4 — HTTP compat layer** | Cookies `mercury_*` + `mercury_*` fallback, headers `x-mercury-*`, federation `/_mercury/*` + `/_mercury/` 308, well-known redirect, `vite.config.ts` denylist `_mercury`, Tauri CSP, invite/CORS `MERCURY_PUBLIC_URL` | Medium | None |
| **5 — Client UI rebrand** | `client/src/**` brand strings (`"Archlast Mercury"` → `"Archlast Mercury"`), `docs/images/brand/mercury.webp` → `mercury.webp`, `index.html` title/meta, error boundaries, brand in `customization/CustomCSS` | Low | None |
| **6 — Docs/CI/scripts** | `README.md`, `AGENTS.md`, `LICENSE`, `docs/**`, `.github/workflows/**`, `scripts/*.sh`, `docs/coolify.md` (if already shipped), `docs/plans/**` history note, `CLAUDE.md` | Low | Overlaps `postgres` + `coolify-deploy` docs — see §8 |
| **7 — Deprecation** | Emit warnings for old env/paths/headers, schedule removal of `MERCURY_*` aliases (≥1 minor version), provide migration helper script | Low | Follow-up release |

Full step-by-step: `implementation-steps.md`. Gate: `verification.md`. Inventory: `codebase-scan.md`.

## 5. Alternatives Considered

| Option | Verdict |
|---|---|
| Hard cut — delete `MERCURY_*` everywhere in one PR | Rejected — bricks existing installs (161 env vars, cookies, DB paths). Users upgrading via `install.sh` would lose auth and need manual migration. |
| Keep `mercury-*` crate names forever, only change display name | Rejected — leaves `Cargo.toml` claiming a different product; package registry (`crates.io`/npm scope) would be forever mismatched with GHCR/docs. Crate rename is mechanical and worth doing once. |
| `archlast-mercury-*` for every crate (fully-qualified) | Rejected for default; too long (`archlast-mercury-federation`); `mercury-*` is readable when product is already Archlast Mercury. Exception: npm `archlast-mercury-bot-sdk` keeps the org prefix for discoverability. |
| Rename `/data` itself to `/mercury-data` | Rejected — `/data` is brand-agnostic (Docker `VOLUME ["/data"]`); only identity-bearing files (`mercury.toml`, `mercury.db`) get new names. |
| `/_paracord → /_mercury` as hard cut | Rejected — federation peers may be on old deploy; dual route + 308 redirect keeps sync. |
| Keep old GHCR `mercury` forever as canonical | Rejected — new GHCR `archlast-mercury` is canonical; old image stays as retag alias for transition. |

## 6. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Upgrade from `mercury` install loses JWT/claim/DB (new paths) | `Config::load` fallback probe: if `mercury.toml`/`mercury.db` absent but `mercury.*` exists, read old, then write new (copy, not move, until verified). Docs: backup before upgrade. |
| Compose volume `paracord-data` left behind as orphan after rename to `mercury-data` | Keep alias: `docker-compose.yml` declares `mercury-data` but also declares external alias `paracord-data` comment; migration helper `scripts/migrate-mercury-to-mercury.sh` does `docker volume create` compat check + `cp -a`. No second file. |
| Cookies break — old clients send `mercury_access` after server expects only `mercury_access` | Dual-read cookies: check new first, then old; after login set both cookies so both generations authenticate. |
| Federation split — old peer hits `/_mercury/` that new server dropped | Keep `/_mercury/` as 308 to `/_mercury/` for 1 version; log when hit. |
| Coolify/Traefik `MERCURY_PUBLIC_URL` silently ignored (env renamed) | Env helper reads `MERCURY_PUBLIC_URL` → `ARCHLAST_MERCURY_PUBLIC_URL` → `MERCURY_PUBLIC_URL`; warns when fallback fires. |
| Tauri deep-link `mercury://` invites in the wild stop working | Register both schemes `["mercury", "mercury", "archlast-mercury"]` in `tauri.conf.json` `deep-link.schemes`; handler accepts either. |
| GHCR pulls break (`mercury:latest` not found) | Push both tags for transition; `README`/`SELF_HOSTING_DEPLOYMENT_GUIDE` shows new name with "old tag still works" note. |
| 536 files — rename PR is huge and review-hostile | Phase the PR: **PR 1 is §4 Phase 1 only** (dual-read, no renames, tests green, zero visible change). **PR 2 is Phase 2** (crate/file rename, mechanical, `cargo test` + `cargo clippy`). Phases 3–6 follow similarly small. See `implementation-steps.md` Phase F. |
| `grep` misses (comments, generated `dist/`) | `codebase-scan.md` enumerates sources vs generated (`client/dist/`, `target/`). Generated is not renamed; only sources. |

## 7. Open Questions

- Crate prefix final: `mercury-*` (short, proposed) vs `archlast-mercury-*` (fully-qualified everywhere). Recommend `mercury-*` with `archlast-mercury` as product/repo/image name — confirm before Phase 2.
- Tauri `identifier` migration: `com.mercury.desktop` → `com.archlast.mercury` (clean) vs `com.archlast.mercury.desktop` (explicit). Pick one and never change again.
- Should old brand stay visible as "Archlast Mercury (formerly Archlast Mercury)" in docs for one release for SEO?
- Deprecation window: 1 minor version or 2? Recommend ≥1 minor (with warnings), removal tracked as `docs/known-limitations.md` deprecation notice.

## 8. Cohesion with `postgres` + `coolify-deploy` (No-Collision Contract)

Three active plans share one composition surface and are designed to land together in any order without double-patching. This is the contract; keep it in sync with `docs/plans/postgres/plan.md:8` and `docs/plans/coolify-deploy/plan.md:8`.

### Shared File Ownership (single writer per region)

| File / Region | Canonical Owner | Sibling Plans Do | How to Avoid Collision |
|---|---|---|---|
| `docker-compose.yml` → `postgres:16-alpine` service + `pgdata` | **`postgres` Phase C (C1.1 + C1.3)** | `coolify-deploy` + `archlast-mercury-rebrand` **reuse verbatim**; add only service/volume rename to `mercury` on top | Apply `postgres` C1.1/C1.3 once. The rebrand then renames `mercury:` → `mercury:` and `paracord-data` → `mercury-data` (with alias), but does not re-add `postgres:16-alpine`. |
| `docker-compose.yml` → `mercury: environment` DB vars + `depends_on: postgres {required:false}` | **`postgres` C1.2** | `coolify-deploy` + `archlast-mercury-rebrand` verify interpolation; rebrand renames env prefix `MERCURY_*` → `MERCURY_*` with fallback | Grep for `MERCURY_DATABASE_URL` before patching; idempotent `${MERCURY_:-${MERCURY_:-default}}` discipline. |
| `docker-compose.yml` → `ports: "${MERCURY_HOST_BIND:-…}"` | Joint — **`coolify-deploy` canonical** | `postgres` documents, `archlast-mercury-rebrand` renames to `${MERCURY_HOST_BIND:-…}` with `MERCURY_HOST_BIND` fallback | Grep for `HOST_BIND` before patching. |
| `docker-compose.yml` → `image: ghcr.io/.../mercury` | **This plan Phase 3** | `postgres` + `coolify-deploy` do not touch image tag | Only this plan renames GHCR path (`mercury` → `archlast-mercury`). |
| `.env.example` → Proxy block + PG block | Split: Proxy=`coolify-deploy`, PG=`postgres` | This plan renames `MERCURY_*` → `MERCURY_*` prefix with old-name comment, but does not change prose | Prefix rename is mechanical; guarded append (skip if `MERCURY_` still present as alias). |
| `Dockerfile` `ENV MERCURY_*` / `EXPOSE` / `VOLUME` | **This plan Phase 3** | `postgres` + `coolify-deploy` only add comments | Only this plan renames `ENV` defaults to `MERCURY_*`. |
| `crates/mercury-*` dirs / `Cargo.toml` members | **This plan Phase 2** | No sibling touches | Exclusive to rebrand. |
| `client/src-tauri/tauri.conf.json` + `client/package.json` | **This plan Phase 3** | No sibling touches | Exclusive to rebrand. |
| `docs/coolify.md`, `docs/docker-setup.md`, `docs/deployment.md` | Split by paragraph (see `postgres/plan.md:8`) | This plan adds **rebrand rename** paragraphs on top, never overwrites PG/Coolify prose | Edit disjoint paragraphs; link to `docs/coolify.md` via new name. |
| Verification gates | Split | `postgres/verification.md` = PG, `coolify-deploy/verification.md` = Coolify scan/GHCR/proxy/`/health`, **this plan** `verification.md` = grep-brand + compat smoke | Run all three gates when landing together. |

### Sequencing

**Recommended order:** `postgres` → `coolify-deploy` → `archlast-mercury-rebrand`

- `postgres` (largest compose diff: `postgres:16-alpine` + interpolation) → `coolify-deploy` (host-bind + proxy lines + `docs/coolify.md`) → `archlast-mercury-rebrand` (rename `mercury:`→`mercury:`, `ENV` prefix, crates, Tauri, docs sweep, GHCR retag).
- Either order remains safe because every Phase C/Phase 3 check is **grep-before-patch** idempotent — a second apply is a no-op.
- **Never open two PRs that both touch `docker-compose.yml:services.postgres` or `crates/mercury-*` dirs at the same time.** Phase 2 (crate rename) must land alone.

### Shared Invariants (all three plans guarantee)

- `docker compose up -d` without flags stays SQLite on the default file, zero `.env` — enforced by `${VAR:-default}` + `profiles: ["postgres"]`; rebrand preserves this with new-prefix fallback.
- No `docker-compose.postgres.yml` / `docker-compose.override.yml` is ever created — both prior plans reject it; rebrand respects this.
- `postgres:16-alpine` pinned, `pgdata` named, `healthcheck: pg_isready`, `${POSTGRES_PASSWORD:?...}` fail-fast, internal-only (no `5432:5432`) — rebrand does not loosen.
- `HEALTHCHECK` path `/health` and `EXPOSE 8090` / `8443/udp` and `VOLUME ["/data"]` are stable; only the env names and service/volume display names change.

## 9. References

- `Cargo.toml:3-15` — `members = ["crates/mercury-*", "client/src-tauri"]`
- `crates/mercury-server/src/config.rs:1133` — `MERCURY_BIND_ADDRESS` and 161 env vars (`grep -rho MERCURY_ | wc -l` = 161)
- `crates/mercury-server/src/main.rs:384,546` — `bind_port`/`provision_instance_setup`, first-owner claim
- `crates/mercury-api/src/lib.rs:100,1129` — `GET /health`, `build_cors_layer` / `MERCURY_PUBLIC_URL`
- `crates/mercury-util/src/client_ip.rs:13` — `MERCURY_TRUST_PROXY`, `crates/mercury-ws/src/handler.rs:756` — `MERCURY_TRUSTED_PROXY_IPS`
- `docker-compose.yml:14,25,29,37,112` — `image: ghcr.io/.../mercury`, `127.0.0.1:8090:8090`, `paracord-data:/data`, `MERCURY_DATABASE_URL`
- `Dockerfile:37-87` — `debian:bookworm-slim`, `ENV MERCURY_*`, `EXPOSE`, `HEALTHCHECK /health`, `USER mercury`, `VOLUME ["/data"]`
- `client/src-tauri/tauri.conf.json:3-30` — `productName: "Archlast Mercury"`, `identifier: "com.mercury.desktop"`, `schemes: ["mercury"]`
- `client/package.json:2` — `"name": "mercury-client"`
- `packages/archlast-mercury-bot-sdk` — bot SDK npm name
- `.github/workflows/ci.yml:423,450` — `ghcr.io/${owner}/mercury:latest` `linux/amd64`, `.github/workflows/release.yml` — no semver image tag yet
- `docs/plans/postgres/` — unified Postgres plan (this plan's data layer)
- `docs/plans/coolify-deploy/` — Coolify scan + deploy (platform layer)
- Prior merged sources: `docs/plans/postgres-enablement/` + `docs/plans/postgres-docker-compose/` → `docs/plans/postgres/`