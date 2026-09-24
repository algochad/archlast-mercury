# Verification — Archlast Mercury → Archlast Mercury Rebrand

> Location: `docs/plans/archlast-mercury-rebrand/verification.md` — gates the 7-phase rebrand. Run the relevant section after each phase PR; run all when landing the full rebrand. Also run `docs/plans/postgres/verification.md` + `docs/plans/coolify-deploy/verification.md` when landing together (shared `docker-compose.yml` surface — see `plan.md:8`).

## 1. Pre-merge gate — per phase

### 1.1 Phase 0 — Decision lock

```bash
grep -q "archlast-mercury" docs/plans/archlast-mercury-rebrand/plan.md  # §1.1 table
test -f docs/plans/archlast-mercury-rebrand/plan.md
test -f docs/plans/archlast-mercury-rebrand/codebase-scan.md
# GHCR package archlast-mercury created (private until push), npm scope reserved if publishing
```

### 1.2 Phase 1 — Dual-read env/config (no visible rename)

Additive only — old names must still work, new names must work, warnings on fallback.

```bash
# old env still boots (warn once)
MERCURY_BIND_ADDRESS=0.0.0.0:9999 cargo test -p mercury-server 2>&1 | grep -q "deprecated" || true
# new env boots
MERCURY_BIND_ADDRESS=0.0.0.0:9999 cargo check -p mercury-server  # crate name after Phase 2; before Phase 2, -p mercury-server
ARCHLAST_MERCURY_PUBLIC_URL=https://example.com cargo check -p mercury-server
# both set → MERCURY wins
MERCURY_DATABASE_URL=sqlite:///tmp/a.db MERCURY_DATABASE_URL=sqlite:///tmp/b.db cargo test -p mercury-server -- --nocapture 2>&1 | grep -q "a.db"

# config file fallback
[ -f config/mercury.toml ] || [ -f config/mercury.toml ]  # at least one present
grep -q "MERCURY_" crates/mercury-server/src/config.rs 2>/dev/null || grep -q "MERCURY_" crates/mercury-server/src/config.rs
# Dockerfile and compose still carry both prefixes
grep -q "MERCURY_" Dockerfile
grep -q "MERCURY_" docker-compose.yml
grep -q "MERCURY_" docker-compose.yml  # still present as fallback alias until Phase 7

cargo test --workspace --all-targets
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cd client && npm run typecheck && npm run test 2>&1 | tail -n 20
```

### 1.3 Phase 2 — Crate / filesystem rename

```bash
# no crates/mercury-* dirs left
! ls crates/ | grep -q "^mercury-"

# Cargo members use new names
grep -q 'crates/mercury-' Cargo.toml
! grep -q 'crates/mercury-' Cargo.toml

# crate package names
grep -R --include="Cargo.toml" '"mercury-' crates/ Cargo.toml 2>&1 | wc -l | grep -q "^0"

# imports migrated
grep -R --include="*.rs" '\bmercury_' crates/ client/src-tauri/ 2>&1 | wc -l | grep -q "^0"  # or only compat aliases left
grep -R --include="*.rs" '\bmercury_' crates/ | wc -l  # ~197

# bot SDK
ls packages/ | grep -q archlast-mercury

cargo update -w 2>&1 | tail -n 5
cargo check --workspace
cargo check --workspace --no-default-features
cargo test --workspace --all-targets
cargo clippy --workspace -- -D warnings
# Postgres plan: cargo test with PG must still pass
MERCURY_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/mercury_test \
  cargo test -p mercury-api -- --test-threads=4  # or MERCURY_TEST_POSTGRES_URL after Phase 1
```

### 1.4 Phase 3 — Docker / Tauri / CLI / GHCR

```bash
# Dockerfile
grep -q 'ORG.*archlast-mercury\|MERCURY_' Dockerfile
grep -q 'EXPOSE 8090' Dockerfile
grep -q 'HEALTHCHECK.*\/health' Dockerfile
grep -q 'VOLUME \["/data"\]' Dockerfile

# compose
grep -q 'archlast-mercury' docker-compose.yml  # GHCR image
grep -q 'mercury-data\|paracord-data' docker-compose.yml  # volume (may still be old name in early Phase 3)
grep -q 'MERCURY_' docker-compose.yml
# single-file invariant still holds (with postgres plan)
docker compose config | grep -q "8090:8090"
docker compose --profile postgres config 2>&1 | grep -q "postgres:16-alpine" || true  # if postgres plan landed
! test -f docker-compose.postgres.yml  # must never appear
! test -f docker-compose.override.yml

# .env.example
grep -q 'MERCURY_' .env.example
grep -q 'MERCURY_' .env.example  # still documented as alias until Phase 7

# Tauri
grep -q '"productName": "Archlast Mercury"' client/src-tauri/tauri.conf.json
grep -q '"identifier": "com.archlast.mercury' client/src-tauri/tauri.conf.json
grep -q '"title": "Archlast Mercury"' client/src-tauri/tauri.conf.json
grep -q '"mercury"' client/src-tauri/tauri.conf.json  # schemes includes mercury
grep -q '"mercury"' client/src-tauri/tauri.conf.json  # still as compat scheme until Phase 7

# npm
grep -q archlast-mercury client/package.json

# GHCR — until push, at least ci.yml references the new image
grep -q archlast-mercury .github/workflows/ci.yml
grep -q "ghcr.io.*archlast-mercury" docker-compose.yml Dockerfile 2>&1 | head -n 5

# CI still green
cargo fmt --all -- --check
```

### 1.5 Phase 4 — HTTP compat (cookies, headers, federation)

```bash
# cookies: mercury_* primary, mercury_* fallback — auth still works with old client
grep -q "mercury_access\|mercury_csrf" crates/mercury-api/src/middleware.rs 2>/dev/null || grep -q "mercury_access" crates/mercury-api/src/middleware.rs
# headers
grep -q "x-mercury-" crates/mercury-api/src/lib.rs 2>/dev/null || grep -q "x-mercury-" crates/mercury-api/src/lib.rs
# federation
grep -q "/_mercury/federation" crates/mercury-api/src/lib.rs 2>/dev/null || grep -q "/_mercury/federation" crates/mercury-api/src/lib.rs
# vite denylist
grep -q "_mercury" client/vite.config.ts

# smoke: old cookie still authenticates (one request with mercury_access should succeed, 200)
# (run with server up; omitted here — exercised by smoke.spec.ts)
```

### 1.6 Phase 5 — Client UI rebrand

```bash
# no visible Archlast Mercury left except compat/deprecation comments
! grep -R --include="*.tsx" --include="*.ts" '"Archlast Mercury' client/src/ | grep -v "deprecated\|formerly\|compat"
grep -R --include="*.tsx" --include="*.ts" "Archlast Mercury" client/src/ | wc -l | grep -qv "^0"
grep -q "Archlast Mercury" client/index.html
test -f docs/images/brand/mercury.webp  # or archlast-mercury.webp
! grep -R "github.com/algochad/archlast-mercury" client/src/ --include="*.ts" --include="*.tsx" | grep -vq "warn\|compat"  # old URL gone or only in deprecation note
cd client && npm run typecheck && npm run test 2>&1 | tail -n 20
```

### 1.7 Phase 6 — Docs / CI / scripts

```bash
grep -q "Archlast Mercury" README.md
grep -q "archlast-mercury" README.md
! grep -R "Archlast Mercury docs" docs/ --include="*.md" | grep -v "formerly\|rebrand"  # old phrase gone or qualified
grep -q "archlast-mercury" .github/workflows/ci.yml
grep -q "archlast-mercury\|mercury-server" scripts/install.sh 2>&1 | head -n 3
# sibling plans' docs still cohesive
grep -q "archlast-mercury-rebrand" docs/plans/postgres/plan.md
grep -q "archlast-mercury-rebrand" docs/plans/coolify-deploy/plan.md
```

### 1.8 Phase 7 — Deprecation removal (follow-up)

```bash
# after window, old prefixes gone (except where 410 is kept)
! grep -R --include="*.rs" '"MERCURY_' crates/ 2>&1 | grep -q .  # no env fallback left
! grep -R --include="*.rs" 'mercury_access' crates/ 2>&1 | grep -q .
! grep -R --include="*.rs" 'x-mercury-' crates/ 2>&1 | grep -q .
# GHCR old tag no longer pushed
! grep -q "ghcr.io.*mercury:latest" .github/workflows/ci.yml
```

## 2. Full-rebrand smoke (after all phases, with server up)

```bash
# build + health + DB
cargo build --release --bin mercury-server 2>&1 | tail -n 5  # or archlast-mercury-server
docker compose build 2>&1 | tail -n 5
docker compose up -d --build  # SQLite default — zero .env
curl -fsS http://127.0.0.1:8090/health | jq -e '.status=="ok"'
curl -fsS http://127.0.0.1:8090/api/v1/health | jq -e '.status=="ok"'

# PG via unified compose (if postgres plan landed)
MERCURY_DATABASE_URL=postgresql://mercury:${POSTGRES_PASSWORD}@postgres:5432/mercury \
  docker compose --profile postgres up -d --build --quiet 2>&1 | tail -n 5
until docker compose --profile postgres exec -T postgres pg_isready -U mercury -d mercury 2>/dev/null; do sleep 1; done
curl -fsS http://127.0.0.1:8090/health | jq .

# upgrade from old install — compat copy shim
[ -f /data/mercury.toml ] || [ ! -f /data/mercury.toml ] || cp -a /data/mercury.toml /data/mercury.toml
[ -f /data/mercury.db   ] || [ ! -f /data/mercury.db   ] || cp -a /data/mercury.db   /data/mercury.db

# claim + app smoke
docker compose logs mercury 2>&1 | grep -q "setup-server#claim="  # or mercury until Phase 3
docker compose down

# sibling gates (run when landing together)
MERCURY_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/mercury_test \
  cargo test -p mercury-api -- --test-threads=4 2>&1 | tail -n 10
cd client && npm run typecheck && npm run lint --silent 2>&1 | tail -n 10
```

## 3. Negative / edge cases

| Case | Expected |
|---|---|
| Old `MERCURY_PUBLIC_URL=https://old.example.com` with no `MERCURY_*` | Server boots, warns `MERCURY_PUBLIC_URL is deprecated, use MERCURY_PUBLIC_URL`, uses the URL. |
| Both `MERCURY_DATABASE_URL` and `MERCURY_DATABASE_URL` set to different DBs | New wins; warning: `both MERCURY_DATABASE_URL and MERCURY_DATABASE_URL set — using MERCURY`. |
| `/_mercury/federation/v1/keys` hit by old peer after new server | 308 to `/_mercury/federation/v1/keys`; old peer follows redirect; log when hit. |
| `mercury://invite/<code>` link after new Tauri build | Opens via `mercury` scheme fallback; new links use `mercury://`. |
| `/data/mercury.toml` only, no `/data/mercury.toml` on first boot of new image | Entrypoint copies to `/data/mercury.toml`; server loads new path on next start. |
| `ghcr.io/.../mercury:latest` pull after GHCR rename | Alias tag still serves for 1 version; `latest` on new name is canonical. |
| `docs/coolify.md` still says `MERCURY_TRUST_PROXY` | Updated to `MERCURY_TRUST_PROXY` with "alias `MERCURY_*` still works" note. |

## 4. Continuous verification (post-merge)

- CI asserts: `grep -q archlast-mercury .github/workflows/ci.yml` + `grep -q '"productName": "Archlast Mercury"' client/src-tauri/tauri.conf.json` + `! test -f docker-compose.postgres.yml`.
- No `docker-compose.postgres.yml` / `docker-compose.override.yml` ever appears — both `postgres` + `coolify-deploy` reject it.
- Nightly: `cargo clippy --workspace -- -D warnings`, `cargo fmt --all -- --check`, `cd client && npm run typecheck`.
- Grep watch: `grep -r "mercury" --include="*.rs" --include="*.ts" crates/ client/src/ | grep -v "deprecated\|compat\|fallback\|formerly" | wc -l` should trend to 0 after Phase 6.

## 5. Manual QA checklist (one page)

- [ ] `grep -R "Archlast Mercury" client/src --include="*.ts" --include="*.tsx"` → 0 (except comments `formerly Archlast Mercury`)
- [ ] Desktop window title shows **Archlast Mercury**; `mercury://` and `mercury://` invites both open
- [ ] `docker compose build` → `ghcr.io/<org>/archlast-mercury:latest` image; old tag `mercury:latest` still pulls (alias)
- [ ] `MERCURY_PUBLIC_URL=https://chat.example.com` works; old `MERCURY_PUBLIC_URL` still works with warn
- [ ] `docker compose --profile postgres up -d` still works (Postgres plan unified with this rebrand — `mercury-postgres` service + `mercury-data` volume)
- [ ] `/_mercury/federation/v1/keys` → 308 to `/_mercury/federation/v1/keys`
- [ ] `curl http://127.0.0.1:8090/health` 200, `x-mercury-trace-id` header present, `x-mercury-trace-id` still accepted
- [ ] Fresh install (no `/data`) → `mercury.toml` + `mercury.db` created; upgrade from `mercury.*` → copied to `mercury.*`
- [ ] `docs/coolify.md` + `docs/docker-setup.md` show `MERCURY_*` with "deprecated `MERCURY_*` still works"
