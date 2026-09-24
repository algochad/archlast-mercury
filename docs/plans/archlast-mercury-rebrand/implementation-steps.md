# Implementation Steps — Archlast Mercury → Archlast Mercury Rebrand

> Companion to `plan.md`. Phased, grep-before-patch, no feature change. Single `docker-compose.yml`, no override file. SQLite stays default; GHCR `archlast-mercury` becomes canonical.

## 0. Pre-conditions & Guardrails

- **Decision lock** (`plan.md:1.1`): `Archlast Mercury` (display) / `archlast-mercury` (repo/image/file/kebab) / `mercury-*` (crate namespace) / `MERCURY_*` primary env with `ARCHLAST_MERCURY_*` fully-qualified alias and `MERCURY_*` fallback for 1 minor version. Confirm before Phase 2; changing it mid-rebrand costs a second sweep.
- **536 files** carry the old brand (`grep -r "mercury"`). 161 distinct `MERCURY_*` env vars (`grep -rho`). 14 crates `mercury-*` under `crates/` + `client/src-tauri` + `packages/archlast-mercury-bot-sdk`.
- **Phase PRs are small:** PR 1 = Phase 1 only (dual-read, no visible rename, tests green). PR 2 = Phase 2 only (crate/file rename, mechanical). Phases 3-6 are similarly scoped. Never mix Phase 2 (crate rename) with compose or client UI in one PR.
- **Idempotence:** every rename below is guarded by `grep -q "mercury"` / `grep -q "MERCURY_"` before patching. Second apply is a no-op. Aligns with `postgres` + `coolify-deploy` contract (`plan.md:8`).
- **Branch:** `feat/archlast-mercury-rebrand` off `main`; or stack `feat/rebrand-phase-1` → `phase-2` → etc. `Cargo.lock` will churn in Phase 2 — keep that PR isolated.

---

## Phase 0 — Lock Names & Announce (no code)

1. **Confirm `plan.md:1.1` table** with design/product: `mercury-*` crates vs `archlast-mercury-*` everywhere. Record decision in this file's header and in `docs/plans/archlast-mercury-rebrand/plan.md:1.1`.
2. **Reserve identifiers:**
   - GHCR: `ghcr.io/<org>/archlast-mercury` (create package, visibility private until first push).
   - npm (if publishing): `archlast-mercury-client` / `archlast-mercury-bot-sdk` (or scoped `@archlast/mercury-*`).
   - Tauri `identifier`: `com.archlast.mercury` (or `com.archlast.mercury.desktop`) — must never change again after first release.
   - Domain / invite scheme: keep `mercury://` as alias, add `mercury://` + `archlast-mercury://`.
3. **Add deprecation note** to `docs/known-limitations.md` and `docs/plans/postgres/plan.md:8` + `docs/plans/coolify-deploy/plan.md:8` cross-refs so the active plans know the rebrand exists.

---

## Phase 1 — Dual-Read Env / Config (no visible rename, lowest risk)

> **Why first:** lets old installs survive every later phase. After this, `MERCURY_*` works, `MERCURY_*` still works, and new code can already use the new names.

### 1.1 Server env helper — `crates/mercury-server/src/config.rs`

- Add helper (near line 700, next to `default_*` helpers):
  ```rust
  fn env_with_fallback(new: &str, old: &str) -> Option<String> {
      if let Ok(v) = std::env::var(new) { return Some(v); }
      if let Ok(v) = std::env::var(old) {
          // also try ARCHLAST_MERCURY_* variant where applicable
          tracing::warn!("{old} is deprecated, use {new} instead");
          return Some(v);
      }
      // third alias for fully-qualified name where it differs from MERCURY_*
      None
  }
  // For the 3-name case (e.g. PUBLIC_URL has MERCURY_/ARCHLAST_MERCURY_/MERCURY_):
  fn env_with_fallback3(new: &str, long: &str, old: &str) -> Option<String>
  ```
  Or inline per site: check `MERCURY_*` → `ARCHLAST_MERCURY_*` → `MERCURY_*` in that order, warn on fallback. Keep `tracing::warn!` so `grep WRN` surfaces stragglers.

- Replace every `std::env::var("MERCURY_…")` site (≈40+ in `config.rs:1133` fan-out, plus `crates/mercury-util/src/client_ip.rs:13` `TRUST_PROXY`, `mercury-ws/src/handler.rs:756`, `mercury-api/src/lib.rs:1143,1177,1201` etc.) with the helper. **Do not delete the old strings** — they become the fallback argument.
- Affected envs (full list from `grep -rho` — 161 vars, excerpt): `MERCURY_BIND_ADDRESS`, `DATABASE_URL/ENGINE/MAX_CONNECTIONS/WORK_MEM`, `STORAGE_PATH`, `MEDIA_STORAGE_PATH`, `BACKUP_*`, `JWT_SECRET`, `PUBLIC_URL`, `TRUST_PROXY`, `TRUSTED_PROXY_IPS`, `COOKIE_SECURE`, `AUTO_PORT_FORWARD`, `TLS_*`, `VOICE_*`, `LIVEKIT_*`, `FEDERATION_*`, `AT_REST_*`, `RETENTION_*`, `AI_*`, `TENOR_*`, `SPORTS_REPLAY`, `WS_*`, etc. See `codebase-scan.md` §3.1 for the exhaustive list.

- **Config file fallback:**
  ```rust
  // in Config::load — try new path first
  let candidates = ["/data/mercury.toml", "/data/mercury.toml", "config/mercury.toml", "config/mercury.toml"];
  // also keep the CLI --config default: change from "config/mercury.toml" to "config/mercury.toml"
  // but accept both. If loaded from old path, log: "loaded deprecated config path …"
  ```

### 1.2 Desktop env — `client/src-tauri/src/lib.rs:1564` (+ `video_pipeline.rs`)

- Same helper in Rust for Tauri process (`MERCURY_DISABLE_LINUX_NATIVE_RENDER`, `MERCURY_GST_RANKS`, etc.) → `MERCURY_*` with `MERCURY_*` fallback.

### 1.3 `Dockerfile` + `docker-compose.yml` defaults (still readable as both)

- `Dockerfile:61-72` `ENV MERCURY_*` → `ENV MERCURY_*` as primary, **keep `ENV MERCURY_*` lines as aliases** (or `ARG MERCURY_*` that sets `MERCURY_*`):
  ```dockerfile
  ENV MERCURY_BIND_ADDRESS=0.0.0.0:8090
  ENV MERCURY_DATABASE_URL=sqlite:///data/mercury.db?mode=rwc
  # compat — remove in next minor
  ENV MERCURY_BIND_ADDRESS=${MERCURY_BIND_ADDRESS}
  ENV MERCURY_DATABASE_URL=${MERCURY_DATABASE_URL}
  ```
  Simpler: just set both `MERCURY_*` and `MERCURY_*` to the same value in the Dockerfile; the helper prefers `MERCURY_*`.

- `docker-compose.yml:32-90` — same: env list becomes `MERCURY_*` primary with `MERCURY_*` alias entries. Keep both until Phase 7. Example:
  ```yaml
  - MERCURY_DATABASE_URL=${MERCURY_DATABASE_URL:-${MERCURY_DATABASE_URL:-sqlite:///data/mercury.db?mode=rwc}}
  - MERCURY_DATABASE_ENGINE=${MERCURY_DATABASE_ENGINE:-${MERCURY_DATABASE_ENGINE:-sqlite}}
  ```
  Guard with `grep -q "MERCURY_" docker-compose.yml` before second apply.

### 1.4 `.env.example`, `config/mercury.toml` template, `docker-entrypoint.sh`

- Add `config/mercury.toml` as the new template (copy of `config/mercury.toml` with header `Archlast Mercury Server Configuration` + `[server] server_name = "mercury"` default). Keep `config/mercury.toml` as a symlink or fallback copy for 1 version, with a deprecation comment at top.
- `.env.example` — add `MERCURY_*` lines with `# deprecated alias: MERCURY_* still works` notes. Keep old `MERCURY_*` comments alongside (dual-doc) until Phase 7.
- `docker-entrypoint.sh` — `/data` layout is already brand-agnostic; add probe:
  ```sh
  # compat: if old config/db exists and new does not, copy to new path
  [ -f /data/mercury.toml ] || [ ! -f /data/mercury.toml ] || cp -a /data/mercury.toml /data/mercury.toml
  [ -f /data/mercury.db   ] || [ ! -f /data/mercury.db   ] || cp -a /data/mercury.db   /data/mercury.db
  ```
  Copy, not move, until verified.

### 1.5 Verify Phase 1 before proceeding

```bash
grep -q 'MERCURY_' crates/mercury-server/src/config.rs
MERCURY_BIND_ADDRESS=0.0.0.0:9999 cargo check -p mercury-server  # old env still works (warn)
MERCURY_BIND_ADDRESS=0.0.0.0:9999  cargo check -p mercury-server  # new env works
cargo test --workspace --all-targets
cargo fmt --all -- --check
```

---

## Phase 2 — Crate / Filesystem Rename (largest mechanical diff)

> **Must land alone.** `Cargo.lock` + crate paths + every `use mercury::*` churn in one PR.

### 2.1 Rename crate directories

```bash
for d in crates/mercury-*; do
  new=$(echo "$d" | sed 's/mercury/mercury/')
  git mv "$d" "$new"
done
# e.g. crates/mercury-api → crates/mercury-api
# Keep archlast-mercury as the product crate for the binary if you chose the long form:
# crates/mercury-server → package.name = "archlast-mercury-server" (see next)
mv packages/archlast-mercury-bot-sdk packages/archlast-mercury-bot-sdk
```

### 2.2 Update `Cargo.toml` workspace

- `Cargo.toml:5-15` `members = ["crates/mercury-*", "client/src-tauri"]` → `["crates/mercury-*", …]`
- `Cargo.toml:17` `[workspace.dependencies]` `mercury-* = { path = "crates/mercury-*" }` → `mercury-*`
- Every `crates/mercury-*/Cargo.toml`:
  - `name = "mercury-…"` → `name = "mercury-…"` (or `"archlast-mercury-…"` if you chose long form)
  - `[dependencies]` `mercury-* = { path = "../mercury-*" }` → `mercury-*`
- `client/src-tauri/Cargo.toml` `name = "mercury-desktop"` → `name = "mercury-desktop"` (or `archlast-mercury-desktop`)
- `packages/archlast-mercury-bot-sdk/package.json` `name` field.

### 2.3 Update imports

```bash
# dry-run first
grep -R --include="*.rs" '\bmercury_' crates/ client/src-tauri/ | wc -l   # ~197 files expected
sed -i 's/\bmercury_/mercury_/g' crates/**/*.rs client/src-tauri/**/*.rs
sed -i 's/"mercury-/"mercury-/g' Cargo.toml crates/*/Cargo.toml client/src-tauri/Cargo.toml
# also fix doc comments that mention crate names
```

### 2.4 Lock file + build check

```bash
cargo update -w
cargo check --workspace
cargo check --workspace --no-default-features   # for embed-ui gate
cargo test --workspace --all-targets
cargo clippy --workspace -- -D warnings
```

### 2.5 Guard

```bash
! grep -R --include="Cargo.toml" '"mercury-' crates/ Cargo.toml  # must be zero (except compat alias if any)
grep -R --include="*.rs" '\bmercury_' crates/ | wc -l  # should be ~197, now on new prefix
```

---

## Phase 3 — Docker / Tauri / CLI / GHCR Rename (visible to operators)

### 3.1 `Dockerfile`

- `ENV MERCURY_*` already done in Phase 1 — here delete the `ENV MERCURY_*` compat duplicates if you had them, or keep until Phase 7 per plan. Update comments:
  ```dockerfile
  # Archlast Mercury — Multi-stage build
  LABEL org.opencontainers.image.title="Archlast Mercury"
  ```

### 3.2 `docker-compose.yml` — service, volume, image, host-bind

- Service: `mercury:` → `mercury:` (new primary). Keep old service name as **alias via container_name if needed**, but Compose service rename does not need compat — it's a user edit. Document: `docker compose up -d` still works; `docker volume ls` will show `mercury-data` going forward.
- Volume: `paracord-data:/data` → `mercury-data:/data` — **keep alias** so old installs don't orphan data:
  ```yaml
  volumes:
    mercury-data:
    # compat — existing installs have paracord-data; Docker will create mercury-data fresh
    # so document a one-time migration: docker volume create mercury-data && docker run --rm -v paracord-data:/old -v mercury-data:/new …
  ```
  Simpler for this phase: keep `paracord-data` as the volume name (brand-agnostic enough) and only rename the service and image. **Recommended:** do not rename the volume yet — rename service + image only, defer volume rename to Phase 7 with a helper script. This avoids data loss in the initial rebrand PR.

- Image: `image: ghcr.io/algochad/archlast-mercury:latest` → `ghcr.io/<org>/archlast-mercury:latest` (and keep `:mercury` alias tag via `docker tag`/`build-push-action` `tags:`).
- Env entries already dual-read from Phase 1 — here switch primary lines from `MERCURY_*` to `MERCURY_*` (see `postgres` C1.2 contract — grep before patching).
- Host-bind: `"${MERCURY_HOST_BIND:-127.0.0.1}:8090:8090"` → add `${MERCURY_HOST_BIND:-${MERCURY_HOST_BIND:-127.0.0.1}}:8090:8090` fallback.
- Comments: `mercury` in comments → `Archlast Mercury`.

### 3.3 `client/src-tauri/tauri.conf.json` + `client/package.json`

```json
// tauri.conf.json
{ "productName": "Archlast Mercury",
  "identifier": "com.archlast.mercury",
  "app": { "windows": [{ "title": "Archlast Mercury" }] },
  "plugins": { "deep-link": { "desktop": { "schemes": ["mercury", "archlast-mercury", "mercury"] } } },
  "bundle": { "icon": ["icons/mercury-icon.ico", …] },
  "plugins": { "updater": { "endpoints": ["https://github.com/<org>/archlast-mercury/releases/latest/download/latest.json"],
                            "pubkey": "…keep existing…" } }
}
```
- Keep `"mercury"` in `schemes` for 1 version so `mercury://invite/...` still opens.
- `client/package.json:2` `"name": "mercury-client"` → `"name": "archlast-mercury-client"` (or `"mercury-client"`). Keep old name as `deprecated` only if published to npm.

### 3.4 CLI binary

- `crates/mercury-server/Cargo.toml` `[[bin]] name = "mercury-server"` → `name = "mercury-server"` with `[[bin]] name = "mercury-server"` kept as alias binary (Cargo allows two `[[bin]]` entries pointing at same `path = "src/main.rs"`). Help text: `about = "Archlast Mercury chat server"`.
- `scripts/install.sh` / `install.ps1` — strings `mercury-server` → `mercury-server` with fallback `which mercury-server || which mercury-server`.

### 3.5 GHCR + CI

- `.github/workflows/ci.yml:450` `images: ghcr.io/${{ github.repository_owner }}/mercury` → `archlast-mercury` (keep old as second `images:` entry for transition).
- `.github/workflows/release.yml` — artifact names `mercury-server-*` → `mercury-server-*` / `archlast-mercury-server-*`.

---

## Phase 4 — HTTP Compat Layer (headers, cookies, federation paths)

### 4.1 Cookies — `crates/mercury-api/src/` + `crates/mercury-api/src/` after Phase 2

- Constants: `mercury_access` → `mercury_access` (same for `mercury_csrf`, `mercury_refresh`). Update `ACCESS_COOKIE_NAME`, `CSRF_COOKIE_NAME`, `REFRESH_COOKIE_NAME` to `mercury_*` + add fallback check:
  ```rust
  fn get_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
      cookie_value_from_headers(headers, &format!("mercury_{name}"))
          .or_else(|| cookie_value_from_headers(headers, &format!("mercury_{name}")))
  }
  ```
- After login, set **both** cookies (`Set-Cookie: mercury_access=…` and `mercury_access=…`) for 1 version.

### 4.2 Headers — `x-mercury-*` → `x-mercury-*`

- `x-mercury-trace-id` (`crates/mercury-api/src/lib.rs`, `client/src/api/client.ts:91`), `x-mercury-csrf` (`client/e2e/…`), `x-mercury-history-epoch` (`client/e2e/messaging-runtime.spec.ts`), `HISTORY_EPOCH_HEADER` in `mercury-api/src/middleware.rs`
  → `x-mercury-*` primary; middleware reads `x-mercury-*` first, falls back to `x-mercury-*` with `tracing::debug!` when old is seen.
- `vite.config.ts:46` `navigateFallbackDenylist` — add `/^\/_mercury\//` alongside `/^\/_paracord\//`.

### 4.3 Federation / well-known

- `crates/mercury-federation` + `crates/mercury-api/src/lib.rs` routes:
  - New route `/_mercury/federation/v1/*` (canonical).
  - Keep `/_mercury/federation/v1/*` as 308 → `/_mercury/…` (log when hit).
  - `/.well-known/mercury/server` canonical; `/.well-known/mercury/server` → 308.
  - Federation signing key path: `federation_signing_key.hex` is fine (brand-agnostic); if it embeds `mercury` in the filename, keep old path as fallback probe (same pattern as `mercury.toml`).

### 4.4 Client wiring

- `client/src/api/admin.ts:198` `/_mercury/federation/v1/servers` → `/_mercury/…` with fallback.
- `client/src/api/client.ts:40` `_paracordContext` → `_mercuryContext` + alias for compat.
- `client/e2e/real-server-restore.spec.ts:184` `__paracordWire` → `__mercuryWire` (keep old global as alias for one version if e2e probes check it).
- Tests: `client/src/api/files.tokenOrigin.test.ts:101` cookie seeding → both cookie names.

---

## Phase 5 — Client UI Rebrand (visible to users)

- **Brand strings — `grep -R "Archlast Mercury" client/src/`** (~80+ sites): `client/src/App.tsx`, `main.tsx`, `components/**` (`GuildSettingsSections`, `InviteModal`, `CreateGuildModal`, `UserSettings`, `EconomySettingsSection`, `CustomCSS`, `BotStoreSection`, `EmojiPicker`, `UpdateNotification`, `TopBarOverlay`, `ChannelPin`, `ScreenSharePickerModal`, `Lobby`, etc.) → `"Archlast Mercury"`. Keep one place (`client/src/lib/brand.ts`) as the canonical string and import it where feasible; for a first pass a sed sweep is fine.
- **HTML / meta:** `client/index.html` `<title>Archlast Mercury</title>` → `Archlast Mercury`, meta `og:site_name`, `theme-color`, `manifest: { name: "Archlast Mercury", short_name: "Mercury" }` (`vite.config.ts:46` PWA manifest `name`).
- **Assets:** `docs/images/brand/mercury.webp` → `docs/images/brand/mercury.webp` (or `archlast-mercury.webp`) + update `README.md` image `src`; keep old file as redirect/copy for 1 version if already shipped in GHCR assets.
- **Error / empty states:** `ErrorBoundary.tsx` brand copy, `OnboardingWizard`, `HomePickUp`, `useComingUp`, etc. — functional copy that says "Archlast Mercury" → Archlast Mercury.
- **Probe / harness:** `client/.probe-*.mjs` files reference `mercury` only in `__paracord*` probes — rename to `__mercury*` with alias for e2e compat until probes stabilize.

---

## Phase 6 — Docs / CI / Scripts Sweep (low risk, high visibility)

### 6.1 Docs

- `README.md`, `SELF_HOSTING_DEPLOYMENT_GUIDE.md`, `AGENTS.md`, `LICENSE` header, `docs/**` (`deployment.md`, `docker-setup.md`, `backup-recovery.md`, `federation-protocol.md`, `message-recovery.md`, `postgres-pg-trgm.md`, `release-validation*`, `security-audit*`, `layout-spec.md`, `design-spec.md`, `api-contracts.md`, `shared-api-contracts.md`, `coolify.md` if already shipped) — `Archlast Mercury` → `Archlast Mercury`, `mercury` → `mercury`/`archlast-mercury` (kebab where path/image), URLs `github.com/algochad/archlast-mercury` → `github.com/<org>/archlast-mercury`, `MERCURY_*` in prose → `MERCURY_*` with "deprecated alias `MERCURY_*` still works" note.
- `docs/plans/**` — add history note: "originally Archlast Mercury; rebranded to Archlast Mercury 2026-09."
- `CLAUDE.md` + `docs/plans/postgres/plan.md:8` + `docs/plans/coolify-deploy/plan.md:8` cohesion notes — update to mention `archlast-mercury-rebrand` as sibling.

### 6.2 CI / release

- `.github/workflows/ci.yml:423` Docker image `ghcr.io/.../mercury` → `archlast-mercury` (+ alias tag); `platforms: linux/amd64` stays.
- `.github/workflows/release.yml` + `scripts/install.sh`, `scripts/backup-db.sh`, `scripts/restore-db.sh`, `scripts/ci_restore_smoke.py`, etc. — `mercury-server` / `mercury.toml` strings updated with fallback mention.

### 6.3 Scripts / e2e

- `scripts/*.sh` help text + `--config` default (`config/mercury.toml` → `config/mercury.toml` fallback).
- `client/e2e/*.spec.ts` display-name assertions that expect `"Archlast Mercury"` titles — update.

---

## Phase 7 — Deprecation & Removal (follow-up release, ≥1 minor version later)

- Emit `tracing::warn!` whenever `MERCURY_*`, `mercury_*` cookie, `x-mercury-*` header, `/_mercury/` route, or `/data/mercury.*` fallback is used.
- After deprecation window:
  - Remove fallback branches and compat routes (keep 410 for old paths if you want).
  - Drop `ENV MERCURY_*` aliases from `Dockerfile` / `docker-compose.yml` / `.env.example`.
  - Stop pushing `ghcr.io/.../mercury:*` alias tags.
  - Delete `config/mercury.toml` symlink/fallback and `/data/mercury.*` copy shim.
  - Remove `schemes: ["mercury"]` fallback (keep `mercury` + `archlast-mercury`).
- Provide `scripts/migrate-mercury-to-mercury.sh` that does: stop server → copy `/data/mercury.*` → `/data/mercury.*` → rename `paracord-data` volume alias → start; and for npm, a `postinstall` note.

---

## Appendix — Phasing Table (when to land, who owns the file)

| File / Region | Phase | Owner (this plan) | Sibling Overlap | Guard |
|---|---|---|---|---|
| `crates/mercury-server/src/config.rs` (~40 env sites) + `client_ip.rs` + `handler.rs` + `lib.rs` | **1** | this plan (dual-read) | `postgres` C1.2 & `coolify-deploy` §1.2 also touch DB/proxy env — **land Phase 1 before or together with their Phase C**; all three use `grep MERCURY_` guard | `grep -q "MERCURY_" config.rs` before second apply |
| `Dockerfile` `ENV` + `docker-compose.yml` `environment:` | **1** (alias) then **3** (primary switch) | 1=add alias, 3=flip primary | `postgres` C1.1-C1.3 owns `postgres:16-alpine` + `pgdata`; rebrand only renames prefix — never re-adds `postgres:16-alpine` | `grep -q "postgres:16-alpine" docker-compose.yml` before adding |
| `crates/mercury-*/` dirs + `Cargo.toml` | **2** | this plan alone | No sibling — exclusive | `cargo check --workspace` |
| `client/src-tauri/tauri.conf.json` + `client/package.json` | **3** | this plan alone | No sibling | — |
| Cookies/headers/federation routes | **4** | this plan alone | No sibling | — |
| `client/src/**` brand strings | **5** | this plan alone | No sibling | `grep -R "Archlast Mercury" client/src` → 0 (except fallback alias if kept) |
| Docs/CI/scripts | **6** | this plan + `postgres` + `coolify-deploy` share `docs/docker-setup.md` etc. | **Disjoint paragraphs** — PG owns PG-vs-SQLite, Coolify owns proxy/GHCR, rebrand owns name sweeps | Never rewrite same hunk; link to `docs/coolify.md` via new name |
| Deprecation | **7** | this plan alone (follow-up) | No sibling | — |

**Recommended landing order:** `postgres` (data layer, largest compose diff) → `coolify-deploy` (platform: host-bind + proxy + `docs/coolify.md`) → `archlast-mercury-rebrand` Phase 1 → Phase 2 → Phases 3-6. Order is advisory — every phase is grep-idempotent so a different order is still safe, just noisier.

