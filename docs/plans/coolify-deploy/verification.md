# Verification — Coolify Deploy + PostgreSQL in Main Compose

> Single-file `docker-compose.yml` with `profiles: ["postgres"]`. Coolify resource: Dockerfile (preferred) or Compose. SQLite stays default.

## 1. Pre-merge gate (must all pass)

### 1.1 `docker compose config` invariants (no running containers needed)

```bash
# 1) No profile → SQLite, loopback HTTP, UDP 8443, no postgres
docker compose config | grep -q 'sqlite:///data/mercury.db'
docker compose config | grep -q '127.0.0.1:8090:8090.*8443:8443/udp'  # or two grep
! docker compose config | grep -q 'postgres:16-alpine'
docker compose config | grep -q 'paracord-data'
! docker compose config | grep -q 'pgdata.*postgres'  # pgdata only consumed with profile
docker compose config | grep -q 'HEALTHCHECK\|healthcheck' || true  # Dockerfile HEALTHCHECK, compose has none for mercury (server liveness is Dockerfile's)

# 2) With postgres profile → PG present, interpolation resolves to postgres URL when .env set
cat > .env <<EOF
POSTGRES_PASSWORD=test-pw-$(openssl rand -hex 8)
MERCURY_DATABASE_URL=postgresql://mercury:\${POSTGRES_PASSWORD}@postgres:5432/mercury
MERCURY_DATABASE_ENGINE=postgres
EOF
docker compose --profile postgres config | grep -q 'postgres:16-alpine'
docker compose --profile postgres config | grep -q 'postgresql://mercury'
docker compose --profile postgres config | grep -q 'pgdata:/var/lib/postgresql/data'
docker compose --profile postgres config | grep -q 'service_healthy.*pg_isready'
# 3) Both profiles → postgres + livekit + mercury
docker compose --profile postgres --profile livekit config | grep -q 'livekit/livekit-server'
docker compose --profile postgres --profile livekit config | grep -q 'postgres:16-alpine'

# 4) Without .env PG vars but no profile → still SQLite, no error
rm .env
docker compose config | grep -q 'sqlite:///data/mercury.db'
```

`docker compose config` **must not** require `POSTGRES_PASSWORD` without `--profile postgres` — SQLite zero-config must survive with no `.env`.

### 1.2 Dockerfile signal for Coolify scan

```bash
grep -q '^FROM ' Dockerfile
grep -q 'EXPOSE 8090' Dockerfile           # Traefik routes to 8090
grep -q 'EXPOSE 8443/udp' Dockerfile      # voice UDP documented
grep -q 'HEALTHCHECK.*\/health' Dockerfile
grep -q 'VOLUME \["/data"\]' Dockerfile
grep -q 'USER mercury' Dockerfile
grep -q 'ENV MERCURY_BIND_ADDRESS=0.0.0.0:8090' Dockerfile
grep -q 'ENV MERCURY_TLS_ENABLED=false' Dockerfile
! grep -q 'coolify' Dockerfile  # no coolify-specific hack in Dockerfile
```

Coolify's detector: Dockerfile at repo root + `EXPOSE` + `HEALTHCHECK` = pass. No `coolify.json` required — confirm `! find . -name "coolify.json"` is empty.

### 1.3 SQLite default smoke (no profile — what Coolify Dockerfile resource sees by default)

```bash
docker compose down -v 2>/dev/null; docker volume rm paracord-data 2>/dev/null || true
# -- Dockerfile resource would do `docker build .`; here we mimic via compose without profile
docker compose up -d --build
docker inspect --format '{{.State.Health.Status}}' mercury | grep -q 'healthy\|starting'
curl -fsS http://127.0.0.1:8090/health | jq -e '.status=="ok"'
curl -fsS http://127.0.0.1:8090/api/v1/health | jq -e '.status=="ok"'
# claim flow (retrieve token the Coolify way)
docker compose logs mercury | grep -q 'setup-server#claim='
docker compose exec -T mercury cat /data/first-owner-claim.txt 2>/dev/null | grep -q '.'
# app smoke: create owner → guild → channel → message → upload → list guilds
docker compose down
```

### 1.4 PostgreSQL greenfield via profile

```bash
cat >> .env <<'EOF'
POSTGRES_PASSWORD=test-pw-$(openssl rand -hex 8)
MERCURY_DATABASE_URL=postgresql://mercury:${POSTGRES_PASSWORD}@postgres:5432/mercury
MERCURY_DATABASE_ENGINE=postgres
MERCURY_DATABASE_MAX_CONNECTIONS=50
EOF

docker compose --profile postgres up -d --build
until docker compose --profile postgres exec -T postgres pg_isready -U mercury -d mercury; do sleep 1; done
docker compose --profile postgres logs mercury | grep -qi 'postgres\|DatabaseEngine::Postgres\|run_migrations_for_engine'
curl -fsS http://127.0.0.1:8090/health | jq -e '.status=="ok"'
docker compose --profile postgres exec -T postgres psql -U mercury -d mercury -c '\dt' | grep -qi 'users\|guilds\|channels'
# app smoke: same claim → guild/channel/message/attachment
docker compose --profile postgres down -v
sed -i '/^POSTGRES_PASSWORD=/d;/^MERCURY_DATABASE_/d' .env
```

### 1.5 `--profile postgres` without `POSTGRES_PASSWORD` fails fast

```bash
sed -i '/^POSTGRES_PASSWORD/d' .env 2>/dev/null || true
! docker compose --profile postgres config 2>&1 | grep -qv 'POSTGRES_PASSWORD'  # must error mentioning POSTGRES_PASSWORD
# or: docker compose --profile postgres up -d 2>&1 | grep -qi 'POSTGRES_PASSWORD.*required\|set POSTGRES_PASSWORD'
```

### 1.6 Coolify proxy-path smoke (Traefik-like)

Mimic `MERCURY_TRUST_PROXY` wiring without full Traefik — prove the `client_ip.rs` gate works (all clients otherwise appear as 127.0.0.1):

```bash
# Without trust proxy: two requests from different X-Forwarded-For should still be treated as the proxy IP (rate-limit as one)
# With trust proxy: they resolve to distinct client IPs (handler.rs:755 bucketed correctly)
# Manual check: start with TRUST_PROXY=true + TRUSTED_PROXY_IPS=172.18.0.0/16 (Coolify default bridge)
MERCURY_TRUST_PROXY=true MERCURY_TRUSTED_PROXY_IPS=172.18.0.0/16 \
  curl -fsS -H 'X-Forwarded-For: 203.0.113.10' http://127.0.0.1:8090/health | jq .
# Server must not crash and must echo healthy; deeper check is in `crates/mercury-util/src/client_ip.rs` tests
cargo test -p mercury-util --lib -- client_ip
```

Separately, confirm cookie/secure and public URL propagation (compose env interpolation):

```bash
grep -q 'MERCURY_PUBLIC_URL' .env.example
grep -q 'MERCURY_TRUST_PROXY' .env.example
grep -q 'MERCURY_COOKIE_SECURE' .env.example
grep -q 'MERCURY_AUTO_PORT_FORWARD' .env.example
```

### 1.7 Gains from `docs/coolify.md`

```bash
test -f docs/coolify.md
grep -q 'MERCURY_PUBLIC_URL' docs/coolify.md
grep -q 'MERCURY_TRUST_PROXY' docs/coolify.md
grep -q 'MERCURY_TRUSTED_PROXY_IPS' docs/coolify.md
grep -q 'MERCURY_COOKIE_SECURE' docs/coolify.md
grep -q 'MERCURY_AUTO_PORT_FORWARD=false' docs/coolify.md
grep -q '8443/udp' docs/coolify.md          # voice caveat
grep -q '/data' docs/coolify.md             # persistent volume
grep -q '/health' docs/coolify.md           # healthcheck path
grep -q 'ghcr.io' docs/coolify.md           # GHCR image option
grep -q 'postgres.*postgres.*5432\|Coolify.*Postgres.*resource' docs/coolify.md
grep -q 'first-owner-claim' docs/coolify.md
```

### 1.8 Lint / unit / integration (unchanged behavior)

```bash
cargo fmt --all -- --check
cargo clippy --workspace -- -D warnings
cargo test --workspace --all-targets                          # SQLite default
MERCURY_TEST_POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:5432/mercury_test \
  cargo test -p mercury-api -- --test-threads=4              # PG parity (if PG available)
cd client && npm run typecheck && npm run test                # unchanged
```

### 1.9 Docs cross-links

```bash
grep -q 'coolify' README.md
grep -q 'coolify\|postgres.*profile' docs/docker-setup.md
grep -q 'postgres.*16-alpine\|profiles.*postgres' docker-compose.yml
grep -q 'POSTGRES_PASSWORD' .env.example
# no override file should exist
! test -f docker-compose.postgres.yml
! test -f docker-compose.override.yml  # unless intentionally added
```

## 2. Coolify visual scan checklist (what an operator sees in the Coolify UI)

| Coolify step | Expected UI state |
|---|---|
| **New Resource → Application → Public Repository → `algochad/archlast-mercury` → Dockerfile** | Detected: `Dockerfile` at root, `EXPOSE 8090` shown as port, `HEALTHCHECK /health` shown. No "Dockerfile not found" warning. |
| **Environment Variables** | `.env.example` vars appear as suggestions; operator adds `MERCURY_PUBLIC_URL`, `MERCURY_TRUST_PROXY`, `TRUSTED_PROXY_IPS`, `COOKIE_SECURE`, `AUTO_PORT_FORWARD`, optionally `MERCURY_DATABASE_*` + `POSTGRES_PASSWORD`. No red "required variable missing" without profile. |
| **Persistent Storage** | Add mount: Source = volume `paracord-data`, Destination = `/data`. Without it, warning in `docs/coolify.md` says JWT + DB will reset. |
| **Domains** | Traefik auto-creates `https://chat.example.com`; `MERCURY_PUBLIC_URL` must match it, `MERCURY_TLS_ENABLED=false` (Traefik owns TLS). |
| **Health Check** | Path `/health`, port `8090`, expects 200. Dockerfile already defines `HEALTHCHECK`, Coolify respects it. |
| **Deploy → Logs** | Line `Finish setting up — open this link: https://…/setup-server#claim=…` appears; also `cat /data/first-owner-claim.txt` via Terminal works. |

## 3. Negative / edge cases

| Case | Expected |
|---|---|
| `docker compose --profile postgres up -d` without `POSTGRES_PASSWORD` | Compose errors: `required variable POSTGRES_PASSWORD is missing…` (`:?...` guard) — not a silent empty password |
| `MERCURY_DATABASE_ENGINE=postgres` but `postgres` profile not active and no external PG | Server fails to connect: `Failed to connect to PostgreSQL at '***': …` (`main.rs:526`) — operator must add `--profile postgres` or point at external PG |
| `docker compose down` vs `down -v` with `--profile postgres` | `down` keeps `pgdata` (persistent). `down -v` wipes it — document. |
| Host already has PG on 5432 | No conflict by default (no host `ports: 5432:5432`). Access via `docker compose --profile postgres exec postgres psql …` |
| Managed PG (not compose) without `CREATE EXTENSION` privilege | Migration fails on `pg_trgm`; follow `docs/postgres-pg-trgm.md` (pre-create as superuser). Compose PG is superuser, no issue locally. |
| Coolify Dockerfile resource + `127.0.0.1:8090:8090` | Ignored — Coolify routes via Docker network to container port 8090, not via published host port. Compose resource on Coolify needs `MERCURY_HOST_BIND=0.0.0.0` if Traefik reaches via host. Document both. |
| 2 GB Coolify VPS building from source | OOM during `cargo build --release`. Use GHCR `ghcr.io/algochad/archlast-mercury:latest` (`MERCURY_PULL_POLICY=missing`). |
| ARM (Ampere) Coolify host | Image is `linux/amd64` only (`.github/workflows/ci.yml:458`). Must self-build or cross-build; document. |
| UDP 8443 not opened | Chat/DMs/uploads work; browser voice fails with "UDP unreachable" / connection check step reports `8443/udp not reachable`. Desktop raw-QUIC also fails. Document as top caveat. |

## 4. Continuous verification (post-merge)

- CI keeps `linux/amd64` GHCR build (`.github/workflows/ci.yml:docker-image`).
- Add a compose smoke job with `--profile postgres` (or keep existing `services: postgres:16` + `MERCURY_TEST_POSTGRES_URL` for unit tests).
- No `docker-compose.postgres.yml` should appear — CI can assert `! test -f docker-compose.postgres.yml`.


## Cohesion — Run This When Landing Together

Both plans share one `docker-compose.yml` surface. When landing as one PR or two sequential PRs, run the **combined idempotence check** after each commit:

```bash
# 1) Idempotence — applying either Phase C a second time must be a no-op
grep -q 'postgres:16-alpine' docker-compose.yml && echo "postgres service: present"
grep -q 'pgdata:' docker-compose.yml && echo "pgdata volume: present"
grep -q 'MERCURY_DATABASE_URL.*:-sqlite' docker-compose.yml && echo "DB interpolation: present"
grep -q 'MERCURY_HOST_BIND' docker-compose.yml && echo "host-bind: present" || echo "host-bind: not yet (coolify-deploy delta)"
grep -q 'MERCURY_PUBLIC_URL' .env.example && echo "proxy block: present" || echo "proxy block: not yet"
grep -q 'POSTGRES_PASSWORD' .env.example && echo "postgres block: present" || echo "postgres block: not yet"

# 2) Invariants — SQLite default must never break
docker compose config | grep -q 'sqlite:///data/mercury.db'
! docker compose config | grep -q 'required variable.*POSTGRES_PASSWORD'  # no :? error without profile
docker compose --profile postgres config | grep -q 'postgres:16-alpine'

# 3) Run the sibling plan's gate too
#    - If you landed postgres: also run coolify-deploy/verification.md §1.1-§1.2 (scan + /health)
#    - If you landed coolify: also run postgres/verification.md §1.1-§1.4 (PG greenfield + :? guard)
```

## 5. Manual QA checklist (one page, for the person clicking Deploy in Coolify)

- [ ] Repo URL imported into Coolify → **Dockerfile detected**, port **8090**, health **/health**
- [ ] Persistent volume at **`/data`** added
- [ ] Env set: `MERCURY_PUBLIC_URL`, `MERCURY_TRUST_PROXY=true`, `MERCURY_TRUSTED_PROXY_IPS=<traefik CIDR>`, `MERCURY_COOKIE_SECURE=true`, `MERCURY_AUTO_PORT_FORWARD=false`, `MERCURY_TLS_ENABLED=false`
- [ ] (Optional PG) Coolify Postgres resource created → `MERCURY_DATABASE_ENGINE=postgres` + `MERCURY_DATABASE_URL` pointed at it —OR— local `POSTGRES_PASSWORD` + `--profile postgres` via compose
- [ ] Deploy → Logs show `setup-server#claim=…` → open in browser → owner created
- [ ] Health `GET https://<domain>/health` → 200 (via Traefik)
- [ ] Invite link uses `https://<domain>`, not `http://localhost`
- [ ] Multiple users not rate-limited as one IP (WS handler respects `X-Forwarded-For` behind trusted proxy)
- [ ] (Optional) Host `8443/udp` open → browser **Settings → Voice & Video → Run connection check** passes for voice
