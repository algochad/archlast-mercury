# Codebase Scan — Coolify Deployability Audit

> Location: `docs/plans/coolify-deploy/codebase-scan.md`
> Date: 2026-09-24 — `main` @ `9530f5c`
> Auditor: `meta-muse-spark-1.2` — files read directly, line numbers verified (see `a1e454f1de31f625a` hand-back)
> Detector model: Coolify probes `Dockerfile` → `docker-compose.yml` → Nixpacks → static; requires `Dockerfile` + `HEALTHCHECK` + `EXPOSE` + persistent `VOLUME` + env-var injection + no host-locked binds + healthy startup without secrets pre-provisioned.
> Safety note: `meta-muse-spark-1.3` was unavailable during subagent review (timeout) — findings below were human-verified before planning.

This is the exhaustive file-level audit behind `plan.md` §1. It is the single reference for "what Coolify's scan sees." Implementation details live in `implementation-steps.md`; the gate lives in `verification.md`.

---

## 1. Executive Summary

| Signal | Status | Note |
|---|---|---|
| `Dockerfile` detection | **PASS** | Multi-stage, valid, `EXPOSE` + `HEALTHCHECK` present |
| `docker-compose.yml` detection | **PASS but BLOCKER inside** | Valid YAML; host-only `127.0.0.1:` bind makes it unreachable behind Traefik |
| Nixpacks detection | **Absent — would fail today** | No `nixpacks.toml`; Rust+Node build order (`client/dist` before `cargo`) not expressed |
| `coolify.json` / `app.json` / `Procfile` / `fly.toml` / `render.yaml` | **None found** | `find -maxdepth 3 -name "coolify*\|nixpacks*\|app.json"` → empty |
| GHCR image for "import existing image" | **PASS (rolling)** | `ci.yml` pushes `ghcr.io/scdouglas1999/paracord:latest` + `sha-short` on every `main` push |
| Versioned image pin (`v3.1.1`) | **MISSING** | `release.yml` publishes zips/dmgs only; no semver Docker tag → cannot pin `v3.1.1` |

**Three blockers to fix before a clean one-click:** (1) `docker-compose.yml:25` host-only bind, (2) no generic `PORT` handling (`config.rs`/`main.rs` only read `PARACORD_BIND_ADDRESS`), (3) persistent `/data` volume must be explicitly added in Coolify UI or SQLite/JWT/claim reset every deploy. Remainder is docs + small config tweaks.

---

## 2. What Already Works (Keep As-Is)

### 2.1 `Dockerfile` — repo root `Dockerfile`

- **L13-18** Stage 1 `node:22-bookworm-slim`: `COPY client/package.json*` → `npm ci` → `COPY client/` → `npm run build` → `client/dist`. Correct cache layering.
- **L21-34** Stage 2 `rust:1.91-bookworm`: `COPY Cargo.toml` / `Cargo.lock*` / `crates/` / `third_party/` + `COPY --from=client-builder …/dist/` (L31) + `RUN cargo build --release --bin paracord-server` (L34). No `--features` flag needed — `crates/paracord-server/Cargo.toml:54` `default = ["embed-ui"]` brings `rust-embed`.
- **L37-43** Stage 3 `debian:bookworm-slim`: `ca-certificates` (TLS roots), `libsqlite3-0` (SQLite runtime), `wget` (healthcheck). No build tools remain.
- **L46-56** `groupadd -r paracord` + `useradd -r -g paracord -m paracord`, `WORKDIR /app`, `mkdir -p /data/uploads /data/files /data/certs /data/backups` + `chown -R paracord:paracord /data /app`.
- **L60-72** `ENV PARACORD_BIND_ADDRESS=0.0.0.0:8090` (L61, PaaS-correct `0.0.0.0`), `PARACORD_DATABASE_URL=sqlite:///data/paracord.db?mode=rwc` (L62 absolute `/data`), `PARACORD_STORAGE_PATH=/data/uploads` (L63), `PARACORD_MEDIA_STORAGE_PATH=/data/files` (L64), `PARACORD_BACKUP_DIR=/data/backups` (L65), `PARACORD_TLS_ENABLED=false` (L70 proxy mode), `PARACORD_VOICE_NATIVE_MEDIA=true` (L72).
- **L75-76** `EXPOSE 8090` (TCP) + `EXPOSE 8443/udp` (QUIC/WebTransport). Coolify reads first TCP expose → `8090` correct.
- **L79-80** `HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://localhost:8090/health || exit 1` — hits unauthenticated route (see §2.5). Present and valid.
- **L82** `VOLUME ["/data"]` — persistence boundary for DB + JWT + certs + uploads.
- **L86-87** `ENTRYPOINT ["/app/docker-entrypoint.sh"]` `CMD ["/app/paracord-server","--config","/data/paracord.toml"]` — config lives inside volume, survives redeploys.

### 2.2 `docker-entrypoint.sh` — `docker-entrypoint.sh`

- **L1-10** Header explicitly says server owns secret generation — entrypoint must not rotate secrets.
- **L15-17** `for dir in /data /data/uploads /data/files /data/certs /data/backups; do [ -d "$dir" ] || mkdir -p "$dir"; done` — idempotent, handles ephemeral bind-mounts; duplicates `main.rs:1432 ensure_data_dirs` but harmless.
- **L22** `exec "$@"` preserves `SIGTERM` to Rust.

### 2.3 `.env.example` — `.env.example`

- **L1-12** Zero-config narrative (`docker compose up -d` without `.env` works because server mints JWT/certs). Ideal for Coolify — no required env file.
- **L14-31** Only commented overrides (`PARACORD_PUBLIC_URL`, `PARACORD_TLS_ENABLED`, `PARACORD_LIVEKIT_API_SECRET`) — nothing secret shipped.

**Gap here (see §3.3):** Missing proxy trio + Postgres vars that Coolify needs to surface.

### 2.4 `config/paracord.toml` — `config/paracord.toml`

- **L5** `bind_address = "0.0.0.0:8090"` matches Docker. **L13** `url = "sqlite://./data/paracord.db?mode=rwc"` relative (Docker overrides to `/data` absolute via ENV). **L24** example `jwt_secret` is a placeholder — not live in Docker because `/data/paracord.toml` is templated fresh. **L32-46** `[setup] require_claim = true`.

### 2.5 `crates/paracord-server/src/config.rs` — `crates/paracord-server/src/config.rs`

- **L91-114** `ServerConfig::default` `bind_address 0.0.0.0:8090`. **L136-162** `DatabaseConfig` `engine=sqlite`, `url=sqlite://./data/paracord.db`, `max_connections=20`. **L226-259** `VoiceConfig` `native_media=true, port=8443`.
- **L1077-1131** `Config::load(path)` — checks `!Path::exists` → `generate_config_template` + `0o600` via `OpenOptionsExt::mode(0o600)` (L1114-1119) avoids TOCTOU on multi-tenant. Sets `first_run` (L1129).
- **L1132-1634** 40+ env overrides: `PARACORD_BIND_ADDRESS` (L1133), `DATABASE_*` (L1150-1190), `STORAGE_*`/`S3_*` (L1219-1255), `VOICE_*` (L1260-1283), `LIVEKIT_*` (L1285-1298), `TLS/ACME` (L1315-1396), `SETUP_*` (L1397-1408), federation/retention/at-rest/backup/AI. Env wins over file — correct for Coolify.
- **L742-788** `looks_like_placeholder_secret` + `validate_secret_configuration` rejects `<32` or `change_me`/`devkey`/`paracord-local-dev` etc. LiveKit validation skipped when `native_media==true` (L777) so empty `${:-}` passes.

### 2.6 `crates/paracord-server/src/main.rs` — `crates/paracord-server/src/main.rs`

- **L237-241** `rustls::crypto::ring::default_provider().install_default()` before TLS.
- **L384-409** `bind_port`/`tls_port`/`livekit_port`/`public_signal_port` + `bind_is_loopback` (`"127.0.0.1:"` etc.). Single port-logic site.
- **L412-437** `portmap::PortRequest {tcp:server_public_port, udp:voice.port}` spawned with `DISCOVERY_BUDGET 8s` concurrent with migrations; skips when `auto_port_forward=false` (L423) or `bind_is_loopback` (L425). Safe on VPS.
- **L517-540** `create_pool_full` + `run_migrations_for_engine` — auto-migrates; PG `?sslmode=require` hint (L527-531). No manual step.
- **L466-508** `livekit_opt_in = !native_media || !livekit_url_is_local || public_url.is_some()` (L470) — no probing on native default.
- **L1002-1014** `TcpListener::bind(&config.server.bind_address)` + `describe_http_bind_error` (L1766) + `CountingListener`. **L1052-1073** loud WARN when `!bind_is_loopback && tls_rustls_config.is_none()` (plaintext on public bind) — expected behind Traefik, intentionally noisy.
- **L1291-1335** Dual `HTTP→HTTPS` redirect + `bind_rustls` only when `tls.enabled` — inert on Coolify with `PARACORD_TLS_ENABLED=false`.

### 2.7 `crates/paracord-api/src/lib.rs` — `crates/paracord-api/src/lib.rs`

- **L99-101** `GET /health` + `GET /api/v1/health` → `health()` **L1193-1197** `200 {"status":"ok","service":"paracord"}` unauthenticated, no DB hit — ideal for Coolify liveness.
- **L1129-1191** `build_cors_layer` seeds from `PARACORD_PUBLIC_URL` + `PARACORD_CORS_ALLOWED_ORIGINS` + `tauri://`/`localhost:1420|5173`. Without `PUBLIC_URL`, Coolify FQDN is CORS-blocked.

### 2.8 TLS — `crates/paracord-server/src/tls.rs`

- **L65-109** `ensure_certs` handles `acme.enabled` → `run_acme_automation_cycle` else self-signed via `rcgen` (L425). On Coolify `tls.enabled=false` path `acme` HTTP-01 listener (L112-158, `main.rs:1307`) needs port 80 — Coolify uses own Let's Encrypt, not this.
- **Note:** `config/paracord.toml:139` defaults `tls.enabled=true` while `Dockerfile:70`/`docker-compose.yml` override to `false`. A persistent `/data/paracord.toml` generated from non-Docker template would enable dual-listener (`8090` redirect + `8443` TLS) — see §3.7.

### 2.9 Client embedding — `crates/paracord-server/Cargo.toml:54` + `src/embedded_ui.rs`

- `default = ["embed-ui"]` brings `rust-embed` folder `../../client/dist` (`embedded_ui.rs:8`). Dockerfile Stage 1→2 copy (L31) satisfies compile; CI mirrors (`ci.yml:122-124,184-189`). Runtime `main.rs:984-994` prefers `--web-dir`, else `embed-ui::router()` SPA fallback (`embedded_ui.rs:11-51`, hashed assets `immutable`).

### 2.10 CI / image publishing — `.github/workflows/ci.yml` + `release.yml`

- **`ci.yml:423-463`** `docker-image` job: `setup-qemu`/`setup-buildx`/`metadata-action` `ghcr.io/${owner}/paracord` `tags: latest + sha` (L450-452), `docker/build-push-action` `file: ./Dockerfile` `platforms: linux/amd64` (L458) pushes only on `main/master`. Coolify "use existing image" with `ghcr.io/scdouglas1999/paracord:latest` works.
- **`release.yml`** publishes Windows/Linux/macOS zips/dmgs but **no Docker semver tag** — cannot pin `ghcr.io/…:v3.1.1`.

---

## 3. What Blocks or Complicates Coolify

### 3.1 BLOCKER — Host-Only Port Bind in `docker-compose.yml`

| File | Line | Value | Effect on Coolify |
|---|---|---|---|
| `docker-compose.yml` | **25** | `- "127.0.0.1:8090:8090"` | Binds to host loopback, not bridge. Coolify's Traefik (`coolify-proxy`) lives in different netns → `502 Bad Gateway`. |
| `docker-compose.yml` | **106-108** | LiveKit `127.0.0.1:7880/7881/7882/udp` | Same; only matters with `--profile livekit`. |
| `Dockerfile` | **61,75** | `ENV BIND 0.0.0.0:8090` + `EXPOSE 8090` | Dockerfile side is **correct** (`0.0.0.0` listen). Blocker is Compose **publish** side. Coolify's Compose parser expects `"8090:8090"` or null host IP. |

If `docker-compose.yml` is present Coolify offers "Docker Compose" deployment — many operators will pick it and hit this.

**Fix:** `implementation-steps.md §1.2` — change to `"${PARACORD_HOST_BIND:-127.0.0.1}:8090:8090"` (default preserves bare-metal safety; Coolify Compose resource sets `PARACORD_HOST_BIND=0.0.0.0`). Dockerfile resource is unaffected (Coolify reads `EXPOSE`, not `ports:`).

### 3.2 BLOCKER — Generic `PORT` Not Honored

Coolify injects `PORT` (Traefik target); Railway/Render inject dynamic `PORT`. No code reads `PORT` — only `PARACORD_BIND_ADDRESS` (`config.rs:1133`, `main.rs:384`). `PORT=3000` → container still binds `8090`, probe on assigned port times out.

- `Dockerfile:79` `HEALTHCHECK wget -qO- http://localhost:8090/health` is pinned to 8090; if bind is overridden to honor `PORT`, healthcheck desyncs.

**Fix (optional small code, §3.7):** `config.rs` after `PARACORD_BIND_ADDRESS` block — if unset, read `PORT` as fallback:

```rust
if std::env::var("PARACORD_BIND_ADDRESS").is_err() {
    if let Ok(port) = std::env::var("PORT") {
        if let Ok(p) = port.trim().parse::<u16>() { if p != 0 {
            config.server.bind_address = format!("0.0.0.0:{p}");
        }}
    }
}
```

And `Dockerfile:79` → `CMD wget -qO- http://localhost:${PORT:-8090}/health || exit 1` (shell form). **This plan ships docs-only; `PORT` fix is listed as optional follow-up** to keep "no Rust change" promise honest but not required for Coolify (Coolify's Port field can be set to `8090`).

### 3.3 HARD — Persistent `/data` Without Coolify Volume Loses All State

State under `/data`: SQLite (`Dockerfile:62, compose:37, config.rs:154`), `jwt_secret` + `instance_setup` + `/data/first-owner-claim.txt` (0600), uploads `/data/uploads`, media `/data/files`, certs `/data/certs`, backups `/data/backups`, federation key. `Dockerfile:82 VOLUME ["/data"]`, `compose:29 paracord-data:/data`.

Coolify volumes are **not automatic** — operator must add **Resource → Volumes → `/data`**. Without it redeploy mints new `jwt_secret` (`config.rs:1096`) + fresh SQLite + new `claim_token_hash` → sessions invalid, `setup_required=true`, uploads lost.

**Fix:** `docs/coolify.md §3.3` — volume at `/data` is step 1.

### 3.4 HARD — First-Owner Claim Gates Every Registration

Fresh DB: `instance_setup.is_pending()==true`. `crates/paracord-api/src/routes/setup.rs:104` `claim_instance` requires token matching hash (L149); `GET /api/v1/setup/status` (L47-58) is public; `POST /setup/claim` single-use. `POST /auth/register` refuses while pending.

`main.rs:546` `provision_instance_setup(&db,…)` writes token to stdout + `/data/first-owner-claim.txt` (0600) + banner (`main.rs:1157-1177`).

Coolify: health passes but UI shows Setup wizard forever.

Bypass envs (`config.rs:1397-1408`): `PARACORD_SETUP_REQUIRE_CLAIM=false` (first registrant owns, logged) or `PARACORD_SETUP_CLAIM_TOKEN=<≥32 chars>` (pinned hashed). Only effective at **first provisioning** — after `instance_setup` row exists they do not rotate. Compose comments them out (L51-58) so Coolify env panel hides them.

**Fix:** `docs/coolify.md §3.5` — three paths (manual `/setup-server`, unattended `REQUIRE_CLAIM=false`, pinned `CLAIM_TOKEN`); token via `docker logs` / `cat /data/first-owner-claim.txt`.

### 3.5 MEDIUM — No Nixpacks Build Ordering (Dockerfile Path Fine, Nixpacks Path Broken)

Requires `client/dist` before `cargo build --release` (CI `ci.yml:122-124,184-189`). No `nixpacks.toml` committed. Auto-detection sees `Cargo.toml` + `client/package-lock.json` but has no "Node before Cargo" ordering → `cargo build` fails on `rust-embed` missing folder (`embedded_ui.rs:8`). Dockerfile multi-stage is correct; Nixpacks path broken.

**Fix:** Publish no `nixpacks.toml`; document **Coolify → Build Pack → Dockerfile** (recommended) and optionally ship `nixpacks.toml` as follow-up (see `implementation-steps.md §3.7 optional`).

### 3.6 MEDIUM — UDP Media Port Invisible to Traefik

Voice `config.toml:142` `port=8443`, `config.rs:670` `default_voice_port 8443`, `Dockerfile:76` `EXPOSE 8443/udp`, `compose:27` `8443:8443/udp`, `main.rs:790-821` `MediaEndpoint::bind_unified` on `0.0.0.0:8443` ALPN `h3` vs `paracord-media`. Coolify proxy HTTP/TCP only — UDP not proxied. Voice appears "connected but silent."

**Fix:** `docs/coolify.md §3.7` — manual host publish + `ufw allow 8443/udp`; "deploy without voice first" path.

### 3.7 MEDIUM — TLS Dual-Listener Confusion on PaaS

`config.rs:339-365` `TlsConfig` defaults `enabled=true, port=8443, auto_generate=true`. `Dockerfile:70`/`compose:90` override to `false` for proxy. But a `/data/paracord.toml` generated from `config/paracord.toml:139` template would enable **dual listener**: `8090` redirect + `8443` TLS (`main.rs:1291-1335`). Coolify maps one expose; browsers hitting `https://<fqdn>` (Traefik-terminated) get internal redirect to `https://…:8443` self-signed → loop.

`PARACORD_TLS_ENABLED` is env-overridable (`config.rs:1315`) so `false` in Coolify fixes it, but invariant should be documented.

**Fix:** Env `PARACORD_TLS_ENABLED=false` on Coolify is required; `docs/coolify.md §3.2` marks it as mandatory. No file change needed because `Dockerfile:70` already sets it and env wins over file.

### 3.8 MEDIUM — Compose Ergonomics vs Coolify

- **L17, L98** `container_name: paracord` / `paracord-livekit` — Coolify generates `<resource>-xxxxx`; hardcoded name blocks multi-instance / redeploy "name already in use".
- **L91, L120** `restart: unless-stopped` — ignored by Coolify (it manages restarts), lint warning.
- **L99** `profiles: ["livekit"]` — Coolify historically lacked profile support; mitigated by `PARACORD_VOICE_NATIVE_MEDIA=true` (native default) so profile is inert. Postgres profile in this plan uses same idiom.
- **L15-16** `pull_policy: ${PARACORD_PULL_POLICY:-build}` `build: ${PARACORD_BUILD_CONTEXT:-.}` — clever for curl-without-clone (L10-13) but Coolify builder expects plain `build: .`; variable indirection can surprise. This plan keeps it.

**Fix:** `implementation-steps.md §1.2` notes `container_name` is best removed or left as comment for Coolify Compose resource (Coolify can override, but removing avoids collision). Not patched in default compose to preserve bare-metal `docker compose` UX.

### 3.9 Hardcoded Localhost / SQLite Path Notes

Hardcoded `localhost` / `127.0.0.1` defaults are intentional for local dev (`config.rs:616,664`, healthcheck `localhost:8090`). Not blockers when `PARACORD_PUBLIC_URL` + `PARACORD_BIND_ADDRESS` are set; but `PARACORD_PUBLIC_URL=https://<coolify-fqdn>` is required or CORS (`lib.rs:1143`) blocks and invites render `localhost`.

SQLite path: `sqlite:///data/paracord.db` in container, `sqlite://./data/paracord.db` relative fallback in `config.rs:154`. Issue is persistence, not string — `SELF_HOSTING_DEPLOYMENT_GUIDE.md:18` already says use `ENGINE=postgres` + `DATABASE_URL=postgresql://…` for multi-user. Default compose ships no `postgres` service — this plan adds it under `profiles: ["postgres"]`.

### 3.10 LOW — `.dockerignore` & Other Nits

- `.dockerignore` lists `docker-compose.yml`, `Dockerfile.*`, `.dockerignore` itself — local `docker compose build` with `build: .` + ignored `Dockerfile` contradicts `build:` but Coolify builds via `Dockerfile` directive, not `build: .`, so unaffected.
- `postgres` missing from default Compose — plan adds `profiles: ["postgres"]` mirroring `SELF_HOSTING_DEPLOYMENT_GUIDE.md:57-65`.
- `.mise.toml` irrelevant to Docker; `PARACORD_CORS_ALLOWED_ORIGINS=*` warns and disables creds (`lib.rs:1177`) — correct.

---

## 4. Checklist — Deploy Today Without the Plan (No-Code Path)

- [ ] Build Pack = **Dockerfile** (not Nixpacks, not unpatched Compose)
- [ ] Port = `8090`; or set `PARACORD_BIND_ADDRESS=0.0.0.0:<Port>` to match Port field
- [ ] Volume at `/data` (persistent)
- [ ] `PARACORD_PUBLIC_URL=https://<Coolify Domain>` (CORS + invites)
- [ ] `PARACORD_AUTO_PORT_FORWARD=false`, `PARACORD_TLS_ENABLED=false`
- [ ] Claim: `PARACORD_SETUP_REQUIRE_CLAIM=false` / `PARACORD_SETUP_CLAIM_TOKEN=<≥32>` pre-set, or manual `/setup-server` via logs / `cat /data/first-owner-claim.txt`
- [ ] Health = `GET /health` on `8090` (Dockerfile `HEALTHCHECK` already does)
- [ ] DB = SQLite on `/data` (small) or Coolify Postgres (`ENGINE=postgres` + `DATABASE_URL`)
- [ ] LiveKit = ignore — native QUIC default (`Dockerfile:72` `PARACORD_VOICE_NATIVE_MEDIA=true`)
- [ ] Image = `ghcr.io/scdouglas1999/paracord:latest` (track) or `sha-short` (pin) — note no `v3.1.1` semver tag yet

---


## Cohesion Note — Relationship to `postgres` Plan

This scan is the **platform-layer** input to the unified Postgres compose change. The **data-layer** plan `docs/plans/postgres/` owns the `postgres:16-alpine` service, `pgdata` volume, DB env interpolation, migration, and backup semantics. Blockers §3.1 (host-only `127.0.0.1:8090`), §3.3 (`/data` persistence), §3.9 (SQLite vs managed PG), and §3.10 (postgres missing from default compose) are fixed by that plan's Phase C — this scan's §4 remediation reuses the same spec and must not diverge. File-ownership contract: `coolify-deploy/plan.md:8` ↔ `postgres/plan.md:8`.

## 5. References — Absolute Paths & Key Lines

- `Dockerfile:61` `ENV PARACORD_BIND_ADDRESS=0.0.0.0:8090`, `:75` `EXPOSE 8090`, `:76` `EXPOSE 8443/udp`, `:79-80` `HEALTHCHECK`, `:82` `VOLUME ["/data"]`
- `docker-compose.yml:25` `127.0.0.1:8090:8090` **BLOCKER**, `:106-108` LiveKit host-only, `:51-58` claim env, `:122` `paracord-data` volume
- `docker-entrypoint.sh:15-17` `mkdir -p`, `:22` `exec`
- `.env.example:14-31` commented overrides; `config/paracord.toml:5` `bind_address`, `:13` SQLite path, `:139` `tls.enabled=true`
- `crates/paracord-server/src/config.rs:91` `ServerConfig`, `:1133` `PARACORD_BIND_ADDRESS`, `:742-788` placeholder reject, `:1397-1408` claim envs, no `PORT`
- `crates/paracord-server/src/main.rs:384-409` port/loopback, `:412` portmap, `:517` `create_pool_full`, `:546` `provision_instance_setup`, `:1002` `TcpListener::bind`, `:1052` plaintext WARN, `:1291` dual HTTP/HTTPS
- `crates/paracord-api/src/lib.rs:99` `/health`, `:1193` `health()` impl, `:1129` `build_cors_layer`
- `crates/paracord-server/src/tls.rs:65` `ensure_certs`, `:395` self-signed, `:112` ACME
- `.github/workflows/ci.yml:423` `docker-image`, `:458` `file: ./Dockerfile`, `:450` `metadata-action`
- `.github/workflows/release.yml` — no Docker semver tag
- Absent: `coolify.json`, `app.json`, `nixpacks.toml`
