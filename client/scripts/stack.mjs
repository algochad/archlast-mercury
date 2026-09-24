#!/usr/bin/env node
/**
 * Stack wrapper: one command to run the whole dev stack.
 *
 *   npm run stack:up     # ensure POSTGRES_PASSWORD, build missing images, start postgres + mercury, wait healthy, print URLs
 *   npm run stack:dev    # stack:up, then run the vite HMR container attached (code changes reload instantly)
 *   npm run stack:down   # stop containers (keep volumes + DB data)
 *   npm run stack:reset  # stop, WIPE volumes (fresh DB), start again
 *   npm run stack:logs   # follow mercury + postgres logs
 *   npm run stack:ps     # show container status
 *
 * Why this exists: `docker compose up -d` alone is not enough — the postgres
 * password must exist in .env first, and the prebuilt GHCR image is stale
 * (built before the rebrand; it still serves the old UI and old binary).
 * This script enforces both: it generates .env when missing and defaults to a
 * local source build so the running code always matches the checkout.
 *
 * Live reload: the `vite` service (docker-compose.dev.yml) bind-mounts
 * ./client and runs the real Vite dev server with HMR — React edits refresh
 * instantly. The Rust backend does NOT hot-reload (release binary, UI
 * embedded at build time): backend changes need `npm run stack:up` again.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENV_FILE = join(ROOT, '.env');
const HEALTH_URL = 'http://127.0.0.1:8090/health';
const HEALTH_TIMEOUT_MS = 120_000;

function sh(args, opts = {}) {
  const r = spawnSync('docker', ['compose', ...args], { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function shCapture(args) {
  return spawnSync('docker', ['compose', ...args], { cwd: ROOT, encoding: 'utf8' });
}

/** Ensure .env exists with a POSTGRES_PASSWORD; generate one when missing. */
function ensureEnv() {
  let text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  if (!/^POSTGRES_PASSWORD=.+$/m.test(text)) {
    const pw = randomBytes(24).toString('hex');
    if (!text.endsWith('\n') && text.length > 0) text += '\n';
    text += `POSTGRES_PASSWORD=${pw}\n`;
    writeFileSync(ENV_FILE, text);
    console.log('stack: generated POSTGRES_PASSWORD in .env');
  }
}

async function waitHealthy() {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        console.log(`stack: healthy ${JSON.stringify(body)}`);
        return;
      }
    } catch {
      // not up yet — keep polling
    }
    if (Date.now() - start > HEALTH_TIMEOUT_MS) {
      console.error(`stack: backend not healthy after ${HEALTH_TIMEOUT_MS / 1000}s — run 'npm run stack:logs'`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

const [cmd, ...rest] = process.argv.slice(2);

function composeBase() {
  return cmd === 'dev' || process.env.MERCURY_DEV === '1'
    ? ['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml']
    : [];
}

switch (cmd) {
  case 'up': {
    ensureEnv();
    // Default to a local source build: the GHCR image predates the checkout
    // and would serve stale code. PARACORD_PULL_POLICY=missing opts into it.
    if (!process.env.PARACORD_PULL_POLICY) process.env.PARACORD_PULL_POLICY = 'build';
    sh([...composeBase(), 'up', '-d', '--build', ...rest]);
    await waitHealthy();
    console.log('stack: web  http://127.0.0.1:8090');
    console.log('stack: vite `npm run stack:dev` → http://127.0.0.1:1420 (HMR against this backend)');
    break;
  }
  case 'dev': {
    // Backend stack first (detached), then vite attached so HMR logs stream
    // and Ctrl-C stops the dev server but leaves postgres + mercury running.
    ensureEnv();
    if (!process.env.PARACORD_PULL_POLICY) process.env.PARACORD_PULL_POLICY = 'build';
    sh(['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml', 'up', '-d', '--build', 'postgres', 'mercury', ...rest]);
    await waitHealthy();
    console.log('stack: backend healthy — starting vite (HMR). Ctrl-C stops vite; backend keeps running.');
    sh(['-f', 'docker-compose.yml', '-f', 'docker-compose.dev.yml', 'up', 'vite']);
    break;
  }
  case 'down': {
    sh([...composeBase(), 'down', ...rest]);
    break;
  }
  case 'reset': {
    // Fresh DB: stop, wipe named volumes, start again.
    sh([...composeBase(), 'down', '-v', ...rest]);
    ensureEnv();
    if (!process.env.PARACORD_PULL_POLICY) process.env.PARACORD_PULL_POLICY = 'build';
    sh([...composeBase(), 'up', '-d', '--build']);
    await waitHealthy();
    console.log('stack: reset complete — fresh database, claim at http://127.0.0.1:8090/setup-server');
    break;
  }
  case 'logs': {
    sh([...composeBase(), 'logs', '-f', 'mercury', 'postgres', ...rest]);
    break;
  }
  case 'ps': {
    const r = shCapture([...composeBase(), 'ps']);
    process.stdout.write(r.stdout);
    break;
  }
  default: {
    console.error('usage: stack.mjs <up|down|reset|logs|ps|dev> [compose args...]');
    process.exit(2);
  }
}
