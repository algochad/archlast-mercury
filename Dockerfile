# ============================================================================
# Archlast Mercury — Multi-stage Docker build
# ============================================================================
# Usage:
#   docker build -t archlast-mercury .
#   # Publish the plaintext HTTP port to the host loopback only; front it with a
#   # TLS-terminating reverse proxy (or set MERCURY_TLS_ENABLED=true) before
#   # exposing it to a LAN/WAN, otherwise auth tokens travel in cleartext.
#   docker run -p 127.0.0.1:8090:8090 -v mercury-data:/data archlast-mercury
# ============================================================================

# ---------- Stage 1: Build the client web UI ----------
FROM node:22-bookworm-slim AS client-builder
WORKDIR /src/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---------- Stage 2: Build the Rust server ----------
FROM rust:1.91-bookworm AS server-builder
WORKDIR /src

# Copy workspace manifests first for dependency caching
COPY Cargo.toml Cargo.lock* ./
COPY crates/ crates/
COPY client/src-tauri/ client/src-tauri/
COPY third_party/ third_party/
COPY vendor/ vendor/

# Copy the built client dist into the expected location
COPY --from=client-builder /src/client/dist/ client/dist/

# Build the server with embedded UI
RUN cargo build --release --bin mercury-server

# ---------- Stage 3: Minimal runtime ----------
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libsqlite3-0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN groupadd -r paracord && useradd -r -g paracord -m paracord

WORKDIR /app

COPY --from=server-builder /src/target/release/mercury-server /app/mercury-server
# Compat alias for one version
RUN cp /app/mercury-server /app/paracord-server
COPY docker-entrypoint.sh /app/docker-entrypoint.sh

# Create default data directories
RUN mkdir -p /data/uploads /data/files /data/certs /data/backups \
    && chown -R paracord:paracord /data /app

USER paracord

# Default environment for Docker
ENV MERCURY_BIND_ADDRESS=0.0.0.0:8090
ENV MERCURY_DATABASE_URL=sqlite:///data/mercury.db?mode=rwc
ENV MERCURY_STORAGE_PATH=/data/uploads
ENV MERCURY_MEDIA_STORAGE_PATH=/data/files
ENV MERCURY_BACKUP_DIR=/data/backups
# Compat — PARACORD_* aliases still work via server fallback; remove in deprecation phase.
ENV PARACORD_BIND_ADDRESS=0.0.0.0:8090
ENV PARACORD_DATABASE_URL=sqlite:///data/mercury.db?mode=rwc
ENV PARACORD_STORAGE_PATH=/data/uploads
ENV PARACORD_MEDIA_STORAGE_PATH=/data/files
ENV PARACORD_BACKUP_DIR=/data/backups
# TLS terminates at a reverse proxy by default, so the container itself serves
# plaintext HTTP on 8090. NEVER publish 8090 beyond the host loopback / a
# trusted proxy in this mode (see the docker run example above and
# docker-compose.yml), or set MERCURY_TLS_ENABLED=true to serve HTTPS directly.
ENV MERCURY_TLS_ENABLED=false
ENV PARACORD_TLS_ENABLED=false
# Native QUIC/WebTransport media is the default voice path (no LiveKit needed).
ENV MERCURY_VOICE_NATIVE_MEDIA=true
ENV PARACORD_VOICE_NATIVE_MEDIA=true
LABEL org.opencontainers.image.title="Archlast Mercury"

# TCP HTTP(S) API/gateway and UDP native media (raw QUIC + browser WebTransport).
EXPOSE 8090
EXPOSE 8443/udp

# Report container health from the HTTP /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:8090/health || exit 1

VOLUME ["/data"]

# The entrypoint only ensures /data exists, then execs the CMD. The server owns
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["/app/mercury-server", "--config", "/data/mercury.toml"]
