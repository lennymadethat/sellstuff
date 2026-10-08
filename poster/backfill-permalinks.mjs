// Repair the missing Facebook permalinks (fb_listing_url) on live items.
//
// Facebook sometimes does not land on the new listing after Publish, so a post
// can be recorded with no link. Without the permalink, edit and delete have to
// hunt for the card by title on "Your listings", which is slower and can miss.
//
// Read-only against Facebook: it navigates Your listings, types in the listings
// search box, and reads ids off each card's edit link. It clicks no menus,
// changes no listing, posts nothing.
//
//   node backfill-permalinks.mjs --dry    report what it would link, write nothing
//   node backfill-permalinks.mjs          write the resolved URLs via /items/<slug>/link
//
// Ambiguous titles (two near-identical listings) are deliberately skipped —
// pickBestCard refuses to guess between them, and linking the wrong id would
// point a later delete at the wrong listing.

import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openBrowser, isLoggedIn, findListingIdByTitle } from './fb.mjs';
import { WORKER, KEY, PROFILE_DIR, requireConfig } from './config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(ROOT, 'logs', 'backfill.log');
const DRY = process.argv.includes('--dry');

function log(...p) {
  const line = `[${new Date().toISOString()}] ${p.join(' ')}`;
  console.log(line);
  try { mkdirSync(path.dirname(LOG_FILE), { recursive: true }); appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
}

requireConfig();

async function api(pathname, body) {
  const r = await fetch(`${WORKER}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(`${pathname} -> ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j;
}

const inv = await api('/inventory');
const targets = (inv.items || []).filter((i) => i.status === 'posted' && !i.url);
log(`${targets.length} live listing(s) with no permalink${DRY ? ' (DRY RUN)' : ''}`);
if (!targets.length) process.exit(0);

const ctx = await openBrowser({ profileDir: PROFILE_DIR, headless: false });
let linked = 0; let skipped = 0;
try {
  if (!(await isLoggedIn(ctx))) { log('profile is signed out of Facebook — run: node login.mjs'); process.exit(2); }
  const page = await ctx.newPage();
  for (const it of targets) {
    let id = null;
    try {
      id = await findListingIdByTitle(page, it.title || '', (m) => log(`  [${it.slug}] ${m}`));
    } catch (e) {
      log(`  ${it.slug}: lookup error ${String(e.message || e).slice(0, 160)}`);
    }
    if (!id) { skipped++; log(`SKIP ${it.slug} — no listing id available for "${it.title}"`); continue; }
    const url = `https://www.facebook.com/marketplace/item/${id}/`;
    if (DRY) { linked++; log(`WOULD LINK ${it.slug} -> ${url}`); continue; }
    try {
      await api(`/items/${it.slug}/link`, { fb_listing_url: url, via: 'backfill' });
      linked++;
      log(`LINKED ${it.slug} -> ${url}`);
    } catch (e) {
      skipped++;
      log(`FAILED to record ${it.slug}: ${String(e.message || e).slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2000));
  }
} finally {
  await ctx.close().catch(() => {});
}
log(`done — linked ${linked}, skipped ${skipped}`);
