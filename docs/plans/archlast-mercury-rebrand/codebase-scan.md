# Codebase Scan — Archlast Mercury → Archlast Mercury

> Location: `docs/plans/archlast-mercury-rebrand/codebase-scan.md`
> Date: 2026-09-24 — `main` @ `9530f5c` — repo dir already `archlast-mercury`, code still `mercury`
> Methods: `grep -r "mercury|Archlast Mercury|PARACORD"` (536 files), `grep -rho MERCURY_[A-Z_]*` (161 distinct env vars), `ls crates/ packages/`, file reads of `Cargo.toml`, `tauri.conf.json`, `Dockerfile`, `docker-compose.yml`, `config/mercury.toml`
> Companion: `plan.md` (§1.1 decision table) + `implementation-steps.md` (phased renames) — this file is the inventory.

## 1. Executive Summary

| Signal | Count | Canonical New | Notes |
|---|---|---|---|
| `Archlast Mercury/mercury/PARACORD` files | **536** | `Archlast Mercury / mercury / MERCURY` | `mercury-*` crates, `MERCURY_*` env, `archlast-mercury` repo/image |
| `MERCURY_*` env vars (`grep -rho`) | **161 distinct** | `MERCURY_*` (primary) + `ARCHLAST_MERCURY_*` (long alias), `MERCURY_*` fallback 1 version | ~40 in `config.rs`, rest in `mercury-api/lib.rs`, `mercury-util`, `mercury-ws`, `src-tauri` |
| `crates/mercury-*` dirs | **14** | `crates/mercury-*` (files), `mercury-*` crate names (or `archlast-mercury-*` as `package.name` where chosen) | + `packages/archlast-mercury-bot-sdk` → `archlast-mercury-bot-sdk` |
| `mercury_*` cookies/headers/paths | **~30 sites** | `mercury_*` / `x-mercury-*` / `/_mercury/` with `mercury_*` fallback | Auth cookies, trace/csrf headers, federation `/_mercury/` + `/.well-known/mercury` |
| Client brand strings (`grep "Archlast Mercury" client/src`) | **139 sites** | `"Archlast Mercury"` | `App.tsx`, `InviteModal`, `GuildSettings`, `CustomCSS`, `ErrorBoundary`, … |
| Cargo crate deps (`mercury-* =`) | **~50** | `mercury-*` | Every `Cargo.toml` inter-crate dep |
| GHCR / Docker / volume | `mercury:latest`, `paracord-data`, `mercury-postgres` | `archlast-mercury:latest`, `mercury-data`, `mercury-postgres` | + retag old for transition |

No Rust feature change; crate rename is mechanical once env dual-read is in place.

---

## 2. What Carries the Old Name (File-Level)

### 2.1 Crate layout — `Cargo.toml` + `crates/mercury-*`

```
Workspace (Cargo.toml:3-15)
  members = [
    "crates/mercury-server", "crates/mercury-api", "crates/mercury-ws",
    "crates/mercury-core", "crates/mercury-db", "crates/mercury-federation",
    "crates/mercury-models", "crates/mercury-contracts",
    "crates/mercury-media", "crates/mercury-util",
    "crates/mercury-transport", "crates/mercury-relay",
    "crates/mercury-codec", "crates/mercury-media-dev",
    "client/src-tauri",
  ]
  [workspace.package] { version = "3.1.1", … }
  [workspace.dependencies]
    mercury-contracts = { path = "crates/mercury-contracts" }
    mercury-api = { path = "crates/mercury-api" }  # etc — 10+
```

Every crate: `crates/mercury-*/Cargo.toml:1` `name = "mercury-…"` and inter-crate `[dependencies]` `mercury-* = { workspace = true }`. `client/src-tauri/Cargo.toml` `name = "mercury-desktop"` plus `crates/mercury-server/Cargo.toml:54` `default = ["embed-ui"]` wiring `rust-embed` `../../client/dist`. `Cargo.lock` pins all `mercury-*` names.

**197 Rust files** import `mercury_*` (`grep -rn "mercury" crates/ --include="*.rs" -l | wc -l` = 197). Example chain: `mercury-api/src/middleware.rs:17` `ACCESS_COOKIE_NAME: &str = "mercury_access"` + `HISTORY_EPOCH_HEADER: &str = "x-mercury-history-epoch"`; `crates/mercury-api/src/lib.rs:90-93` `x-mercury-trace-id` / `mercury_access|mercury_csrf`.

### 2.2 Env vars — 161 distinct `MERCURY_*` (`grep -rho`)

Full list (sorted, `crates/` + `client/src-tauri`):

```
MERCURY_AI_* (5): AI_API_KEY, AI_BASE_URL, AI_MODEL, AI_PROVIDER, AI_TIMEOUT_SECONDS
MERCURY_ALLOW_PRIVATE_FEDERATION_URLS
MERCURY_AT_REST_* (6): ALLOW_PLAINTEXT_FILE_READS, ENABLED, ENCRYPT_FILES, ENCRYPT_SQLITE, KEY, KEY_ENV, REFUSE_LEGACY_V
MERCURY_AUTH_* (5): ALLOW_USERNAME_LOGIN, CHALLENGE_TOKEN, LOGIN_LEGACY_PARSER, REQUIRE_EMAIL, REQUIRE_EMAIL_VERIFICATION
MERCURY_AUTO_PORT_FORWARD
MERCURY_BACKUP_* (5): AUTO_ENABLED, DIR, INCLUDE_MEDIA, INTERVAL_SECONDS, MAX_BACKUPS
MERCURY_BIND_ADDRESS
MERCURY_COOKIE_SECURE
MERCURY_CORS_ALLOWED_ORIGINS
MERCURY_DATABASE_* (6): ENGINE, IDLE_IN_TRANSACTION_TIMEOUT_SECS, MAINTENANCE_WORK_MEM_MB, MAX_CONNECTIONS, STATEMENT_TIMEOUT_SECS, URL, WORK_MEM_MB
MERCURY_* (core): ENABLE_PUBLIC_METRICS, EPOCH, EVENT_BUS_CAPACITY
MERCURY_FEDERATION_* (10): ALLOW_DISCOVERY, ALLOWED_GUILD_IDS, DOMAIN, ENABLED, FILE_CACHE_*, KEY_ID, MAX_EVENTS_*, MAX_USER_CREATES_*, READ_TOKEN, SIGNING_KEY_HEX/PATH
MERCURY_* (http/ws): HTTP_RATE_LIMIT_* (4), HTTP_REQUEST_TIMEOUT_SECS, HTTP_SLOW_MS, HTTP_STAGE_TRACE, JWT_EXPIRY_SECONDS, JWT_SECRET
MERCURY_LIVEKIT_* (7): API_KEY, API_SECRET, DIRECT_PUBLIC_URL, HTTP_URL, LIVEKIT_LOCAL_CANDIDATE_URL, PUBLIC_URL, URL
MERCURY_* (other): LOG, LOG_ANSI, MALWARE_*, MAX_GUILD_STORAGE_QUOTA, MAX_SESSIONS_PER_USER, MEDIA_STORAGE_PATH, METRICS_TOKEN, NATIVE_MEDIA_LOCAL_CANDIDATE, PERMISSION_CACHE_MAX_ENTRIES, PORT_FORWARD_LEASE_SECONDS, PUBLIC_URL, RECOVERY_DATABASE_URL, REFRESH_SESSION_TTL_DAYS, REGISTRATION_ENABLED, RETENTION_* (7), S*, SCREEN_SIMULCAST
MERCURY_SERVER_NAME, SETUP_CLAIM_TOKEN, SETUP_REQUIRE_CLAIM
MERCURY_S* (smtp/sports/storage): SMTP_*, SPORTS_REPLAY*, STORAGE_PATH, STORAGE_TYPE, TENOR_API_KEY, TEST_POSTGRES_URL, TEST_TOTP_ONLY_MASTER_KEY, TLS_ACME_* (10), TLS_ENABLED, TRUSTED_PROXY_IPS, TRUST_PROXY, VAAPI_DEVICE, VOICE_* (4: AUDIO_BITRATE, E, MAX_PARTICIPANTS_PER_ROOM, NATIVE_MEDIA, PORT), WEB_DIR, WINDOWS_FIREWALL_AUTO_ALLOW, WIRE_TRACE*, WS_* (15)
```

Primary fan-out in `crates/mercury-server/src/config.rs:1133` fan (`std::env::var` per knob, ~40+), plus `crates/mercury-util/src/client_ip.rs:13` `TRUST_PROXY`, `crates/mercury-ws/src/handler.rs:756` `TRUSTED_PROXY_IPS`, `crates/mercury-api/src/lib.rs:83,91-93,1143` etc., and `client/src-tauri/src/lib.rs:1564` (`MERCURY_DISABLE_LINUX_NATIVE_RENDER`, `MERCURY_GST_RANKS`, `MERCURY_SCREEN_SIMULCAST`, …).

### 2.3 Config files — `config/mercury.toml`, `/data/mercury.toml`, `crates/mercury-server/src/config.rs`

- `config/mercury.toml:5` `bind_address = "0.0.0.0:8090"`, `:13` `sqlite://./data/mercury.db`, `:24` example `jwt_secret`, `:32-46` `[setup] require_claim`, `:139` `[tls] enabled=true`.
- `crates/mercury-server/src/config.rs:154` fallback `sqlite://./data/mercury.db`, `:643` `./data/uploads`, `:682` `certs/cert.pem`, `:709` `AT_REST_KEY` default `"MERCURY_AT_REST_KEY"`, `:1086` `Config::load` mints `0600` config with random `jwt_secret`.
- `Dockerfile:62` `ENV MERCURY_DATABASE_URL=sqlite:///data/mercury.db` + `63-65` storage/media/backup Dirs, `61` `MERCURY_BIND_ADDRESS`, `70` `MERCURY_TLS_ENABLED`, `72` `MERCURY_VOICE_NATIVE_MEDIA`, `82` `VOLUME ["/data"]`.
- `docker-compose.yml:14` `image: ghcr.io/algochad/archlast-mercury:latest`, `:25` `127.0.0.1:8090:8090`, `:27` `8443:8443/udp`, `:29` `paracord-data:/data`, `:37` `MERCURY_DATABASE_URL=sqlite:///data/mercury.db`, `:109` `livekit/livekit-server`, plus `140` `postgres:16-alpine` when Postgres plan is applied.

### 2.4 HTTP / federation — headers, cookies, paths

| Kind | Old | Sites | New (with compat) |
|---|---|---|---|
| Cookie | `mercury_access`, `mercury_csrf`, `mercury_refresh` | `crates/mercury-api/src/middleware.rs:17`, `crates/mercury-api/src/lib.rs:91-92`, tests in `middleware.rs:321,376` | `mercury_*` primary, `mercury_*` fallback (`get_cookie` dual-read, set both on login) |
| Header | `x-mercury-trace-id`, `x-mercury-csrf`, `x-mercury-history-epoch` | `lib.rs:90` `TRACE_ID_HEADER`, `lib.rs:93` `CSRF_HEADER_NAME`, `middleware.rs:321` `HISTORY_EPOCH_HEADER`, `client/src/api/client.ts:91, client/src/api/files.ts`, `client/e2e/*.spec.ts` | `x-mercury-*` primary, `x-mercury-*` fallback |
| Route | `/_mercury/federation/v1/*` (8 routes) | `lib.rs:124-200`, `crates/mercury-federation`, `client/src/api/admin.ts:198` | `/_mercury/federation/v1/*` canonical, `/_mercury/` → 308 |
| Well-known | `/.well-known/mercury/server` | `lib.rs` | `/.well-known/mercury/server` + redirect |
| Context | `_paracordContext: ApiRequestContext` | `client/src/api/requestContext.ts:13`, `client/src/api/client.ts:40` | `_mercuryContext` + alias |
| Vite | `navigateFallbackDenylist: [/^\/_paracord\//]` | `client/vite.config.ts:46` | add `/^\/_mercury\//` alongside |
| E2E probe | `__paracordWire`, `__paracordAudioProbe` | `client/e2e/real-server-restore.spec.ts:184`, `real-server.voice-join.spec.ts:80` | `__mercury*` + old alias for one version |

### 2.5 Client — `client/src/` brand strings (139 sites) + `client/src-tauri/`

- `client/src/App.tsx` — `Archlast Mercury` title, `<span>Archlast Mercury</span>` logo text, `"Archlast Mercury could not open …"`, PWA `// Archlast Mercury server` comment.
- `client/src/api/files.ts` `headers['X-Mercury-CSRF']`, `client/src/api/client.ts` `X-Mercury-*`, `client/src/main.tsx` `PWA service workers are disabled in Archlast Mercury desktop`.
- `client/src/components/**` — `GuildSettingsSections`, `InviteModal` ("the Archlast Mercury app"), `GuildSettings` ("Native Archlast Mercury bot"), `CreateGuildModal`, `ChannelManager`, `UserSettings`, `EconomySettingsSection`, `BotStoreSection`, `AutomodSection`, `CustomCSS` (`/* Restyle Archlast Mercury … */`), `StickerPicker`, `OnboardingWizard`, `EmojiPicker`, `UpdateNotification` (`GITHUB_REPO = 'Archlast Mercury'`), `TopBarOverlay`, `Lobby`, `ChannelPin`, `ScreenSharePickerModal`, `ErrorBoundary` (github issues URL `Scoduglas1999/Archlast Mercury`).
- `client/src/lib/tauriAxiosAdapter.ts`, `gateway/dispatch.ts`, `hooks/*` — comments mentioning Archlast Mercury.
- `client/index.html` — `Archlast Mercury.webp` brand mark (`docs/images/brand/mercury.webp`), page title/meta.
- `client/src-tauri/tauri.conf.json:3` `productName: "Archlast Mercury"`, `identifier: "com.mercury.desktop"`, `app.windows[0].title: "Archlast Mercury"`, `plugins.deep-link.schemes: ["mercury"]`, `plugins.updater.endpoints: "https://github.com/algochad/archlast-mercury/…/latest.json"`, `bundle.icon`.
- `client/package.json:2` `"name": "mercury-client"`, `packages/archlast-mercury-bot-sdk`.
- `client/vite.config.ts:46` PWA `manifest: { name: "Archlast Mercury" }`.

### 2.6 CI / scripts — `.github/workflows`, `scripts/`

- `.github/workflows/ci.yml:450` `images: ghcr.io/${{ github.repository_owner }}/mercury`, `ci.yml:458` `file: ./Dockerfile`, `.github/workflows/release.yml` `mercury-server` artifact names, `security-dast-fuzz.yml`.
- `scripts/install.sh`, `scripts/backup-db.sh`, `scripts/restore-db.sh`, `scripts/ci_restore_smoke.py`, `scripts/release_*` — `mercury-server` help text + `--config config/mercury.toml` defaults.
- `docker-entrypoint.sh` — brand-agnostic `/data` layout, but comments say `Archlast Mercury`.

### 2.7 Docs / assets — `README.md`, `AGENTS.md`, `SELF_HOSTING_DEPLOYMENT_GUIDE.md`, `docs/*.md`, `LICENSE`

Every doc under `docs/` carries `Archlast Mercury` in title, prose, code blocks with `MERCURY_*` / `mercury.toml` / `mercury.db` / `mercury://` / `github.com/algochad/archlast-mercury`. Asset `docs/images/brand/mercury.webp` (brand mark).

---

## 3. What Blocks or Complicates the Rebrand

| # | Block | Scope | Mitigation |
|---|---|---|---|
| H1 | Crate/file rename touches every compile | 14 `crates/mercury-*` dirs + `Cargo.lock` + 197 `use mercury_*` sites | Phase 2 lands alone, mechanical, `cargo test` gate — small PR, not mixed with env/docs. |
| H2 | 161 `MERCURY_*` env vars break existing installs if cut | Operators with `MERCURY_PUBLIC_URL`, `MERCURY_DATABASE_URL`, `MERCURY_AT_REST_KEY` etc. on host/Coolify/Compose | Phase 1 dual-read: `MERCURY_*` → `ARCHLAST_MERCURY_*` → `MERCURY_*` (fallback, warn). Deprecation ≥1 minor version. |
| H3 | On-disk files `mercury.toml` / `mercury.db` are auth/identity | Existing `/data/mercury.toml` (JWT + setup) and `mercury.db` (history epoch, users) | Entrypoint fallback probe: `mercury.*` absent + `mercury.*` present → `cp -a` to new path, warn. |
| H4 | Cookies/headers/paths break federation + auth | `mercury_csrf` / `x-mercury-*` / `/_mercury/` peers may be on old deploy | Dual-read cookies, `x-mercury-*` → fallback `x-mercury-*`, `/_mercury/` → 308 to `/_mercury/`. |
| H5 | Deep-link `mercury://invite/…` in the wild | Users shared invite links with `mercury://` | Tauri registers `["mercury", "mercury", "archlast-mercury"]` for 1 version. |
| H6 | Docker volume `paracord-data` orphaned after rename | `docker volume ls` has `paracord-data` with all state | Defer volume rename to Phase 7; helper script migrates. |
| H7 | GHCR `mercury:latest` pulls break | `docker-compose.yml:14` / CI publish old tag | Push both tags (`archlast-mercury:latest` canonical + `mercury:latest` alias) for transition. |
| H8 | Huge 536-file diff is review-hostile | Single-PR rebrand unreviewable | Phase PRs: 1 (dual-read, no renames) → 2 (crate rename) → 3 (Docker/Tauri/CLI) → 4 (HTTP compat) → 5 (UI) → 6 (docs/CI) → 7 (deprecate). See `implementation-steps.md` Phase F. |
| M1 | `grep` misses (comments, generated `dist/`, `target/`) | `client/dist/` is generated, not source | Only sources are renamed; generated (`target/`, `client/dist/`) excluded per `codebase-scan.md` convention. |
| M2 | Postgres/Coolify plans collide on same files | `docker-compose.yml`, `.env.example`, `docs/docker-setup.md` shared with `postgres` + `coolify-deploy` | Shared File Ownership `plan.md:8` — single writer per region, `grep -q "MERCURY_"` gate before second apply. |

---

## 4. References — Absolute Paths & Key Lines

- `Cargo.toml:3-15` `members = ["crates/mercury-*", "client/src-tauri"]` — 14 crates
- `crates/mercury-server/src/config.rs:1133` fan-out `std::env::var("MERCURY_…")` (~40), `:709` `AT_REST_KEY` default `"MERCURY_AT_REST_KEY"`
- `crates/mercury-server/src/main.rs:384,546` — `bind_port` / `provision_instance_setup`
- `crates/mercury-api/src/lib.rs:90-200` — `x-mercury-*` + `/_mercury/federation/v1/*` + `build_cors_layer`
- `crates/mercury-api/src/middleware.rs:17,321` — cookies + `HISTORY_EPOCH_HEADER`
- `crates/mercury-util/src/client_ip.rs:13`, `crates/mercury-ws/src/handler.rs:756` — proxy trust
- `docker-compose.yml:14,25,29,37,112` — `ghcr.io/.../mercury`, `127.0.0.1:8090:8090`, `paracord-data:/data`, `MERCURY_DATABASE_URL`
- `Dockerfile:62,82` — `ENV MERCURY_DATABASE_URL`, `VOLUME ["/data"]` (`69-80` `EXPOSE`/`HEALTHCHECK`)
- `client/src-tauri/tauri.conf.json:3,8,19,29` — `productName`, `identifier`, `title`, `schemes`, `updater.endpoints`
- `client/package.json:2` — `"name": "mercury-client"` (`packages/archlast-mercury-bot-sdk`)
- `.github/workflows/ci.yml:450`, `.github/workflows/release.yml` — image + artifacts
- `docs/plans/postgres/` — data layer (this plan's rebrand targets share its compose surface)
- `docs/plans/coolify-deploy/` — platform layer (shared `docker-compose.yml` + `.env.example` + `AGENTS.md`)
