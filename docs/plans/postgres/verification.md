# Verification — PostgreSQL (Unified)

> Merged from `postgres-enablement` (greenfield/brownfield/backup/CI) + `postgres-docker-compose` (single-file profile + volumes). Single `docker-compose.yml` with `profiles: ["postgres"]`, no `docker-compose.postgres.yml`.

## 1. Pre-merge gate (must all pass)

### 1.1 `docker compose config` invariants (no running containers needed)

```bash
# 1) No profile → SQLite, no postgres, loopback HTTP, UDP 8443, no pgdata consumer
docker compose config | grep -q 'sqlite:///data/paracord.db'
docker compose config | grep -q '127.0.0.1:8090:8090'
docker compose config | grep -q '8443:8443/udp'
! docker compose config | grep -q 'postgres:16-alpine'
docker compose config | grep -q 'paracord-data'
! docker compose config | grep -q 'pgdata.*postgres'  # pgdata only consumed with profile
# port host-bind is interpolable when Coolify plan is also applied
docker compose config | grep -q '8090:8090'

# 2) With postgres profile → PG present, wiring present, healthcheck present
# Need .env for :? guard; create temp one
cat > .env <<EOF
POSTGRES_PASSWORD=test-pw-$(openssl rand -hex 8)
PARACORD_DATABASE_URL=postgresql://paracord:\${POSTGRES_PASSWORD}@postgres:5432/paracord
PARACORD_DATABASE_ENGINE=postgres
EOF
docker compose --profile postgres config | grep -q 'postgres:16-alpine'
docker compose --profile postgres config | grep -q 'postgresql://paracord'
docker compose --profile postgres config | grep -q 'pgdata:/var/lib/postgresql/data'
docker compose --profile postgres config | grep -q 'service_healthy.*pg_isready\|healthcheck.*pg_isready'
# 3) Both profiles → postgres + livekit + paracord
docker compose --profile postgres --profile livekit config | grep -q 'livekit/livekit-server'
docker compose --profile postgres --profile livekit config | grep -q 'postgres:16-alpine'

# 4) Without .env PG vars but no profile → still SQLite, no error
rm .env
docker compose config | grep -q 'sqlite:///data/paracord.db'
```

`docker compose config` **must not** require `POSTGRES_PASSWORD` without `--profile postgres` — SQLite zero-config must survive with no `.env`.

### 1.2 SQLite default smoke (no profile — zero config)

```bash
# ensure no .env PG vars active
docker compose down -v 2>/dev/null; docker volume rm paracord-data 2>/dev/null || true
docker compose up -d --build
docker compose logs paracord | grep -qi 'sqlite\|paracord.db'
curl -fsS http://127.0.0.1:8090/health | jq -e '.status=="ok"'
curl -fsS http://127.0.0.1:8090/api/v1/health | jq -e '.status=="ok"'
# claim flow: open http://localhost:8090/setup-server, paste token from `docker compose logs paracord`, create owner, send message, upload file
docker compose down
```

### 1.3 PostgreSQL greenfield via profile

```bash
cat >> .env <<'EOF'
POSTGRES_PASSWORD=test-pw-$(openssl rand -hex 8)
PARACORD_DATABASE_URL=postgresql://paracord:${POSTGRES_PASSWORD}@postgres:5432/paracord
PARACORD_DATABASE_ENGINE=postgres
PARACORD_DATABASE_MAX_CONNECTIONS=50
EOF

docker compose --profile postgres up -d --build
# wait for PG health
until docker compose --profile postgres exec -T postgres pg_isready -U paracord -d paracord; do sleep 1; done
docker compose --profile postgres logs paracord | grep -qi 'postgres\|DatabaseEngine::Postgres\|run_migrations_for_engine'
curl -fsS http://127.0.0.1:8090/health | jq -e '.status=="ok"'
# verify PG actually has tables (exec into postgres, not host)
docker compose --profile postgres exec -T postgres psql -U paracord -d paracord -c '\dt' | grep -qi 'users\|guilds\|channels'
# same app smoke: claim → guild/channel → message → attachment → guild list
docker compose --profile postgres down -v
sed -i '/^POSTGRES_PASSWORD=/d;/^PARACORD_DATABASE_/d' .env
```

Pass criteria:
- Server log shows `postgres` engine, no SQLite path.
- `\dt` shows migrated tables.
- Invite + `/_paracord/federation/v1/keys` + uploads work.

### 1.4 `--profile postgres` without `POSTGRES_PASSWORD` fails fast

```bash
sed -i '/^POSTGRES_PASSWORD/d' .env 2>/dev/null || true
# with profile active, :? guard must error mentioning POSTGRES_PASSWORD
! docker compose --profile postgres config 2>&1 | grep -qv 'POSTGRES_PASSWORD'  # must mention POSTGRES_PASSWORD
# alternative phrasing:
docker compose --profile postgres config 2>&1 | grep -q 'POSTGRES_PASSWORD.*required\|set POSTGRES_PASSWORD'
```

### 1.5 Brownfield migration (SQLite → PG) into compose Postgres

```bash
# seed SQLite with a dev DB (few guilds/messages)
# start compose PG alone, expose for migrator
docker compose --profile postgres up -d postgres
until docker compose --profile postgres exec -T postgres pg_isready -U paracord; do sleep 1; done

# migrator needs a host-reachable URL — temporarily map port or use host gateway
# Option: add ports: ["127.0.0.1:5432:5432"] temporarily, or use the container IP
paracord-server migrate-to-postgres \
  --source "sqlite://./data/paracord.db" \
  --target "postgresql://paracord:${POSTGRES_PASSWORD}@127.0.0.1:5432/paracord" \
  --dry-run   # must exit 0, report table row counts, keep epoch

paracord-server migrate-to-postgres \
  --source "sqlite://./data/paracord.db" \
  --target "postgresql://paracord:${POSTGRES_PASSWORD}@127.0.0.1:5432/paracord"
# expect: "Migration complete: N tables, M rows copied and verified."

# point server at PG and verify history
PARACORD_DATABASE_ENGINE=postgres \
PARACORD_DATABASE_URL="postgresql://paracord:${POSTGRES_PASSWORD}@127.0.0.1:5432/paracord" \
  cargo run --bin paracord-server --no-default-features &
curl -fsS http://127.0.0.1:8090/health | jq .
# verify old messages/guilds still present
docker compose --profile postgres down -v
```

Pass criteria: no FK violations, `channels.last_message_id` repaired, new `database_history_epoch` issued, clients reconnect cleanly.

### 1.6 No-profile compose unchanged for host `psql` collisions

```bash
# PG must NOT bind host 5432 by default — no `ports: ["5432:5432"]`
! docker compose config | grep -q '5432:5432'
docker compose --profile postgres config | grep -q 'postgres:5432'  # internal only
# host with PG already on 5432 must still be able to run SQLite default without conflict
```

### 1.7 Backup / restore on PG

```bash
# via admin API: POST /api/v1/admin/backup → .tar.gz
# offline restore to isolated DB:
createdb --owner=paracord_recovery paracord_recovery_test
export PARACORD_RECOVERY_DATABASE_URL='postgres://paracord_recovery@127.0.0.1/paracord_recovery_test'
paracord-server --config ./config/paracord.toml restore-backup \
  --archive /tmp/paracord-backup.tar.gz \
  --output-dir /tmp/paracord-recovery-test \
  --postgres-url-env PARACORD_RECOVERY_DATABASE_URL
# must verify attachments, secrets, then publish paracord.toml + activate.sh
rm -rf /tmp/paracord-recovery-test && dropdb paracord_recovery_test
```

Cross-check `scripts/ci_restore_smoke.py` and `docs/backup-recovery.md`.

### 1.8 Unit / integration / lint (unchanged behavior)

```bash
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --workspace --all-targets                          # SQLite default
PARACORD_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/paracord_test \
  cargo test -p paracord-api -- --test-threads=4              # PG parity (if PG available)
cd client && npm run typecheck && npm run test                # unchanged
```

For Coolify proxy-path smoke (`PARACORD_TRUST_PROXY`, `TRUSTED_PROXY_IPS`, `COOKIE_SECURE`, `AUTO_PORT_FORWARD`), see `docs/plans/coolify-deploy/verification.md` §1.6.

## 2. Negative / edge cases

| Case | Expected |
|---|---|
| `docker compose --profile postgres up -d` without `POSTGRES_PASSWORD` | Compose errors: `required variable POSTGRES_PASSWORD is missing…` (`:?` guard) |
| `PARACORD_DATABASE_ENGINE=postgres` but `postgres` profile not active (no PG) | Server fails to connect: `Failed to connect to PostgreSQL at '***': …` (`main.rs:526`) |
| `migrate-to-postgres` with non-empty target | Upserts succeed but target-only rows remain — docs warn; prefer fresh DB |
| Managed PG without `CREATE EXTENSION pg_trgm` | Migration fails on `pg_trgm`; follow `docs/postgres-pg-trgm.md` (pre-create as superuser) |
| SQLCipher-encrypted SQLite source | Migrator refuses / requires plaintext export first |
| SQLite source with missing tables/columns | Migrator aborts before copying any rows (planning phase) |
| Empty `POSTGRES_PASSWORD` with PG profile | Compose `:?` guard fails fast — not silent empty |
| `docker compose down` vs `down -v` with PG | `down` keeps `pgdata`; `down -v` wipes it — document |
| Host already has PG on 5432 | No conflict by default (no host `5432:5432`); `exec psql` access |
| `--profile postgres --profile livekit` | All three services start; PG + LiveKit + Paracord |

## 3. Continuous verification (post-merge)

- Keep SQLite `docker compose up -d` as primary CI smoke (no profile).
- Add a PG smoke job with `services: postgres:16` or `docker compose --profile postgres up -d` + `PARACORD_TEST_POSTGRES_URL` for `cargo test -p paracord-api -- --test-threads=4`.
- No `docker-compose.postgres.yml` must appear — CI can assert `! test -f docker-compose.postgres.yml`.
- Docs invariants: `docs/docker-setup.md` shows both `up -d` and `--profile postgres up -d`; `.env.example` has commented PG (+ proxy) block; `docker-compose.yml` has `pgdata` volume.
- Nightly: `scripts/release_sqlite_query_plan_smoke.py` + `scripts/release_postgres_upgrade_from_tag_smoke.py` where applicable.


## Cohesion — Run This When Landing Together

Both plans share one `docker-compose.yml` surface. When landing as one PR or two sequential PRs, run the **combined idempotence check** after each commit:

```bash
# 1) Idempotence — applying either Phase C a second time must be a no-op
grep -q 'postgres:16-alpine' docker-compose.yml && echo "postgres service: present"
grep -q 'pgdata:' docker-compose.yml && echo "pgdata volume: present"
grep -q 'PARACORD_DATABASE_URL.*:-sqlite' docker-compose.yml && echo "DB interpolation: present"
grep -q 'PARACORD_HOST_BIND' docker-compose.yml && echo "host-bind: present" || echo "host-bind: not yet (coolify-deploy delta)"
grep -q 'PARACORD_PUBLIC_URL' .env.example && echo "proxy block: present" || echo "proxy block: not yet"
grep -q 'POSTGRES_PASSWORD' .env.example && echo "postgres block: present" || echo "postgres block: not yet"

# 2) Invariants — SQLite default must never break
docker compose config | grep -q 'sqlite:///data/paracord.db'
! docker compose config | grep -q 'required variable.*POSTGRES_PASSWORD'  # no :? error without profile
docker compose --profile postgres config | grep -q 'postgres:16-alpine'

# 3) Run the sibling plan's gate too
#    - If you landed postgres: also run coolify-deploy/verification.md §1.1-§1.2 (scan + /health)
#    - If you landed coolify: also run postgres/verification.md §1.1-§1.4 (PG greenfield + :? guard)
```

## 4. Manual QA checklist (one page)

- [ ] Fresh clone → `docker compose up -d` → SQLite smoke passes (`/health` 200, claim → guild/channel/message/attachment)
- [ ] `docker compose config` (no profile) → `sqlite:///…`, no `postgres:16-alpine`
- [ ] `docker compose --profile postgres config` → `postgres:16-alpine` + PG URL + `pgdata` + `healthcheck: pg_isready`
- [ ] `docker compose --profile postgres up -d` (with `.env`) → PG boots, migrates, serves, same smoke green
- [ ] `docker compose --profile postgres up -d` without `POSTGRES_PASSWORD` → fails fast (`:?` error)
- [ ] `migrate-to-postgres --dry-run` + live copy from seeded dev DB into compose PG → PG serves correctly
- [ ] Admin backup on PG → offline restore to isolated DB (`--postgres-url-env`) → data intact
- [ ] `PARACORD_TEST_POSTGRES_URL=… cargo test -p paracord-api` green (if PG available)
- [ ] `cargo clippy` / `cargo fmt` / `client typecheck` green
- [ ] No host `5432:5432` mapping by default; `docker compose --profile postgres exec postgres psql …` works
- [ ] Docs: `docs/docker-setup.md`, `.env.example`, `docker-compose.yml` all mention PG path; `docs/coolify.md` linked
