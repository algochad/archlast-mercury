# Deployment Profiles

This document captures baseline profile values for local development, single-node production, and internet testbed deployment.

## Local Development

- API bind: `0.0.0.0:8080`
- Client dev server: `http://localhost:1420`
- `MERCURY_CORS_ORIGINS=http://localhost:1420`
- LiveKit URL: `ws://localhost:7880`
- Federation: disabled

## Single-Node Production

- API behind reverse proxy with TLS
- Public origins set in `MERCURY_CORS_ORIGINS`
- Strong `MERCURY_JWT_SECRET`
- LiveKit reachable via public WSS endpoint
- Persistent volumes enabled for postgres/uploads/files
- Federation optional (enable after key provisioning)
- PostgreSQL (optional): `MERCURY_DATABASE_ENGINE=postgres`, `MERCURY_DATABASE_URL=postgresql://mercury:<pw>@postgres:5432/mercury`, `MERCURY_DATABASE_MAX_CONNECTIONS=50`, `pgdata` persistent volume (`pgdata:/var/lib/postgresql/data`)

## Internet Testbed

- Same as single-node production plus:
  - dedicated hostnames for API and LiveKit
  - firewall rules for API/LiveKit and UDP media ports
  - TURN relay configuration for strict NAT environments
  - monitoring on `/health` and `/metrics`

> **Note:** Env vars use `MERCURY_*` (deprecated alias `PARACORD_*` still works for one minor version).
