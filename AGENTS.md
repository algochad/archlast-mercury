# Repository Guidelines

Archlast Mercury: self-hosted Discord-like chat (servers, text/voice/video, DMs with E2EE, roles, moderation). Source-available license — do not publish forks. Workspace version `3.1.1` (see `Cargo.toml`, `client/package.json`).

## Project Overview

Self-hosted chat for a small community on hardware you own. Rust Axum server + React 19 web app + Tauri v2 desktop + TS bot SDK. No third-party media service: native QUIC/WebTransport voice/video with opt-in LiveKit fallback.

## Architecture & Data Flow

- Server binary (`crates/mercury-server`) wires everything: config → `DbPool` → `AppState` (`mercury-core`) → Axum REST (`mercury-api`) + gateway WS (`mercury-ws`) + native media (`transport`/`relay`/`codec`) on TCP+UDP `8443`.
- Core services live in `mercury-core/src/*.rs` (`guild`, `channel`, `message`, `permissions`, `auth`, `automod`, `presence_manager`, `events`). Routes in `mercury-api/src/routes/*.rs` are thin over core; `mercury-db/src/*.rs` owns SQL (`sqlx`, SQLite + Postgres); `mercury-models` = DB rows; `mercury-contracts` = wire types only.
- Contract pipeline is source of truth, never hand-edit: Rust `schemars` types (`mercury-contracts/src/lib.rs::schemas()`) → `contracts/api-contracts.json` → `client/src/api/generated/` (validators + types) via `client/scripts/generate-api-contracts.mjs`.
- Client flow: `api/restClient.ts` + `api/activeClient.ts` for REST → `gateway/dispatch.ts` fans WS events out to per-domain Zustand stores (`guildStore`, `channelStore`, `messageStore`, `voiceStore`, etc.). Multi-server scoping via `lib/serverScope.ts` (`entityScopeKey`, `accountScopeKey`) and `lib/serverIdentity.ts`.
- Media path: `mercury-transport` (QUIC/WebTransport endpoint) → `mercury-relay` (`room::MediaRoomManager`, `relay::RelayForwarder`, `speaker::SpeakerDetector`) → `mercury-codec` (Opus/VP9/libavcodec FFI). `mercury-media` = storage + `VoiceManager`; `mercury-federation` = cross-server.

## Key Directories

- `crates/mercury-server/src/`: `main.rs`, `config.rs`, `cli.rs`, `tls.rs`, `embedded_ui.rs`, `web_ui.rs`, `portmap.rs` (UPnP/NAT-PMP), `bots.rs`, `file_transfer.rs`, `livekit_proc.rs`.
- `crates/mercury-api/src/`: `lib.rs`, `routes/`, `middleware.rs`, `error.rs`, `tests/` (~60 integration tests, e.g. `srv_api6_account_bot_authz.rs`).
- `crates/mercury-core/src/`: services + `lib.rs::AppState`, `error.rs`, `events.rs`, `permissions.rs`.
- `crates/mercury-db/`: `src/` + `migrations/` (SQLite) + `migrations_pg/` (Postgres) — keep in sync.
- `crates/mercury-ws/src/`: `lib.rs`, `session.rs` (gateway sessions).
- `crates/mercury-{transport,relay,codec,media,federation,util,models,contracts}/`: media + federation + shared types.
- `client/src/`: `api/`, `gateway/dispatch.ts`, `stores/useXStore.ts`, `components/`, `hooks/useX.ts`, `lib/`, `pages/`, `styles/tokens.css`, `workers/dmDecrypt.worker.ts`, `test/*Mock.ts`, colocated `*.test.{ts,tsx}`.
- `client/src-tauri/`: Tauri crate `mercury-desktop` (`src/lib.rs`, `tauri.conf.json`).
- `packages/archlast-mercury-bot-sdk/`: `src/{rest,gateway,botClient,builders}.ts`, `tests/`, `examples/ping-bot.ts`.
- `contracts/api-contracts.json`: generated snapshot, do not edit.
- `config/mercury.toml`, `.env.example`, `docker-compose.yml`, `installer/`, `docs/`, `scripts/release_*.py`, `vendor/` + `third_party/scap/` (bindgen/libclang patches).

## Development Commands

```bash
# dev loop (order matters) — Vite :1420 proxies /api /gateway /health to https://localhost:8443
cd client && npm install && npm run dev
cargo run --bin mercury-server --no-default-features
VITE_DEV_PROXY_TARGET=https://<host>:8443 npm run dev  # remote backend

# release (embeds UI — build client first)
cd client && npm install && npm run build && cd ..
cargo build --release --bin mercury-server
cd client && npx tauri build
```

- Config: `config/mercury.toml` + `MERCURY_*` env (deprecated alias `PARACORD_*` still works). Docker serves plaintext `127.0.0.1:8090` behind reverse proxy; zero-config works with no `.env`.
- Single Rust test: `cargo test -p <crate> <test_name> -- --nocapture`.

## Code Conventions & Common Patterns

- Format/lint: `cargo fmt`, `cargo clippy -- -D warnings` (Rust); `tsc --noEmit` + ESLint `react-hooks/exhaustive-deps` + `jsx-a11y` (client, no type-aware lint). Keep `jsx-a11y/label-has-associated-control` depth 4 for settings wrappers.
- Rust naming: `snake_case` modules per domain (`crates/mercury-core/src/message.rs`, `automod.rs`); errors via `thiserror`:
  ```rust
  // crates/mercury-api/src/error.rs, crates/mercury-core/src/error.rs
  pub enum ApiError { NotFound, Unauthorized, BadRequest(String), RateLimited(i64), /* ... */ }
  // ApiError::error_code() -> "NOT_FOUND" | "RATE_LIMITED" + status_code() -> StatusCode
  ```
  `anyhow::Error` only for `Internal`; never `unwrap()` in handlers.
- Async/shared state: `tokio` full runtime; `AppState` holds `Arc<DashMap/DashSet>`, `RwLock`, `moka` cache, `arc-swap`. Permission cache key is `(user_id, channel_id)` (`DEFAULT_PERMISSION_CACHE_MAX_ENTRIES = 10_000`, `config/mercury.toml:permission_cache_max_entries`). Handlers hold one `DbPool` connection; pool `max_connections = 20`, 5s wait.
- Client state: one Zustand store per domain, `create<State>()((set, get) => …)`, e.g. `client/src/stores/toastStore.ts::useToastStore`; cross-store access via `useXStore.getState()`. Gateway events switch in `gateway/dispatch.ts` and write stores + `shouldNotifyForMessage`. Styles: design tokens in `styles/tokens.css` — never literal colours (enforced by `scripts/literal-colour-audit.mjs`); version from `package.json` via `__APP_VERSION__` in `vite.config.ts`.
- Contracts: add Rust type in `mercury-contracts/src/{guild,user,invite,…}.rs`, register in `schemas()`, then `cd client && npm run contracts:generate`; verify with `contracts:check`.

## Important Files

- Entry: `crates/mercury-server/src/main.rs`, `crates/mercury-server/src/config.rs`, `client/src/main.tsx`, `client/src/App.tsx`, `client/src-tauri/src/lib.rs`.
- Wire: `crates/mercury-contracts/src/lib.rs`, `contracts/api-contracts.json`, `client/src/api/generated/`, `docs/shared-api-contracts.md`, `docs/api-contracts.md`.
- Config: `config/mercury.toml`, `config/mercury.example.toml`, `.env.example`, `client/src-tauri/tauri.conf.json` (CSP, `mercury://` deep-link, updater), `client/vite.config.ts` (proxy, `worker.format: "es"` for DM decrypt worker), `client/vitest.config.ts`.
- DB: `crates/mercury-db/migrations/`, `crates/mercury-db/migrations_pg/`.
- Version sync: workspace `Cargo.toml`, `client/package.json`, `client/src-tauri/tauri.conf.json`, `vX.Y.Z` in `README.md` + `RELEASE_NOTES.md` — check with `python3 scripts/check_release_version.py`.

## Runtime/Tooling Preferences

- Rust `1.88` (`.mise.toml`; CI pins `1.91`), Node `22` + `npm ci` (never Bun/pnpm), Vite 6, TS `5.7`, Tailwind v4, Tauri v2. `SQLX_OFFLINE=true` for offline builds.
- Linux native deps required (see `.github/workflows/ci.yml`): `libvpx-dev libav*-dev libpipewire-0.3-dev libwebkit2gtk-4.1-dev libgtk-3-dev libspeexdsp-dev …`; macOS: `brew install libvpx ffmpeg pkg-config speexdsp`. Do not disable `vpx` feature to fix a build — video breaks silently. AppImage needs `NO_STRIP=1`.
- Default Cargo features embed UI (`embed-ui` → `rust-embed` + `client/dist`); pure-Rust checks need `cargo check --workspace --no-default-features` or `npm run build` first. Dev media crates force `opt-level = 3` in `[profile.dev]` for realtime rates.

## Testing & QA

```bash
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo clippy -p mercury-desktop --all-targets -- -D warnings  # separate pass, native test targets
cargo test --workspace --all-targets                            # default sqlite::memory:
MERCURY_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/mercury_test cargo test -p mercury-api --tests --no-fail-fast -- --test-threads=4

cd client
npm run typecheck && npm run lint
npm test              # typecheck + vitest + token/literal-colour audit
npm run test:unit:coverage  # v8, ratchet floors stmts38/branches30/funcs37/lines40 — raise, never lower
npm run test:e2e      # mocked Playwright; real server: MERCURY_E2E_REAL=1 npx playwright test
npm run test:a11y:static && npm run test:contrast
cd ../packages/archlast-mercury-bot-sdk && npm test
```

- CI gates: `cargo audit` + `npm audit --audit-level=moderate`, `security_gate_check.py`, migration sanity (`ci_migration_sanity.py`, `check_migration_line_endings.py`), contract checks (`export-contracts -- --check` + `npm run contracts:check`), `release_postgres_upgrade_from_tag_smoke.py v0.9.0`. Release smokes in `scripts/release_*_smoke.py` need full git history (`fetch-depth: 0`).