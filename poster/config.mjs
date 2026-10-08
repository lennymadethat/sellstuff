// Shared config for the poster scripts. Reads poster/.env (if present) into
// process.env without overriding anything already set, then exports the values.
//
//   SELLSTUFF_WORKER_URL   your deployed worker, e.g. https://YOUR_WORKER_URL
//   SELLSTUFF_ADMIN_KEY    the same value you set as the worker's ADMIN_KEY secret
//   SELLSTUFF_PROFILE_DIR  Chrome profile folder (default ~/.sellstuff-chrome)
//   SELLSTUFF_IDLE_MS      wait between polls when idle (default 60000)
//   SELLSTUFF_WATCH=1      show the Chrome window instead of parking it off-screen

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

export const WORKER = String(process.env.SELLSTUFF_WORKER_URL || '').replace(/\/$/, '');
export const KEY = String(process.env.SELLSTUFF_ADMIN_KEY || '').trim();
export const PROFILE_DIR = process.env.SELLSTUFF_PROFILE_DIR || path.join(os.homedir(), '.sellstuff-chrome');
export const IDLE_MS = Number(process.env.SELLSTUFF_IDLE_MS || 60000);
export const WATCH = process.env.SELLSTUFF_WATCH === '1';

export function requireConfig(log = console.error) {
  const missing = [];
  if (!WORKER) missing.push('SELLSTUFF_WORKER_URL');
  if (!KEY) missing.push('SELLSTUFF_ADMIN_KEY');
  if (missing.length) {
    log(`Missing ${missing.join(' and ')}. Copy poster/.env.example to poster/.env and fill it in.`);
    process.exit(1);
  }
}
