// Agent Sell Stuff poster — poll loop for the Facebook auto-post lane.
//
//   Telegram Approve  ->  the worker marks the item 'approved'
//   this loop         ->  POST /post-queue/claim   (worker hands out ONE item)
//                     ->  drive your real Chrome (fb.mjs)
//                     ->  POST /items/<slug>/posted   or   /post-failed
//
// Pull, not push: your desk machine has no inbound webhook. The worker owns
// the state machine and the daily cap; this process owns nothing but the
// browser. It authenticates with a shared secret (SELLSTUFF_ADMIN_KEY).
//
// HALT: on any Facebook checkpoint the lane stops itself by writing logs/HALTED
// and refuses to claim again until a human clears it (install.ps1 -Resume).
// We never retry into a platform control. A retry loop
// against a checkpoint is exactly how an account gets flagged.
//
// Run:  node poster.mjs                 foreground
//       node poster.mjs --once          claim + post one item, then exit
//       node poster.mjs --dry           stop at the Publish button (no listing)
//       install.ps1                     register the poster as a logon task

import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openBrowser, isLoggedIn, sessionAlive, postListing, editListing, deleteListing } from './fb.mjs';
import { readInbox, markReported, sendReply } from './inbox.mjs';
import { WORKER, KEY, PROFILE_DIR, IDLE_MS, WATCH, requireConfig } from './config.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'poster.log');
const HALT_FILE = path.join(LOG_DIR, 'HALTED');
const SHOT_DIR = path.join(LOG_DIR, 'shots');
const TMP_DIR = path.join(os.tmpdir(), 'sellstuff-poster');

const ONCE = process.argv.includes('--once');
const DRY = process.argv.includes('--dry');

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch { /* logging must never kill the loop */ }
}

requireConfig((m) => { console.error(m); });

// Node's fetch has NO default timeout, so a half-open connection would wedge
// the whole loop forever with nothing in the log. It also buries the real
// network error in err.cause and surfaces a bare "fetch failed", which is what
// eight entries in poster.log said and none of them said why.
async function api(p, body, { tries = 3, timeoutMs = 20000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fetch(`${WORKER}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body || {}),
        signal: ac.signal,
      });
    } catch (e) {
      // e.cause carries the real reason (ECONNRESET / ENOTFOUND / UND_ERR_*).
      const why = e.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (e.cause && (e.cause.code || e.cause.message)) || e.message;
      last = new Error(`${p} -> ${why}`);
      if (i < tries - 1) await sleep(1500 * (i + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function downloadPhotos(item) {
  const dir = path.join(TMP_DIR, item.slug);
  mkdirSync(dir, { recursive: true });
  const out = [];
  for (const p of item.photos || []) {
    const r = await fetch(p.url);
    if (!r.ok) throw new Error(`photo fetch ${p.r2_key} -> HTTP ${r.status}`);
    const file = path.join(dir, `${String(p.ord).padStart(2, '0')}.jpg`);
    await writeFile(file, Buffer.from(await r.arrayBuffer()));
    out.push(file);
  }
  if (!out.length) throw new Error('item has no photos');
  return out;
}

function halt(reason) {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(HALT_FILE, `${new Date().toISOString()}\n${reason}\n`, 'utf8');
  log(`HALTED — ${reason}`);
}

// Check the profile's Facebook session BEFORE claiming anything.
//
// Without this the loop claims an item, opens Chrome, discovers the profile was
// never signed in, bounces the item back and alerts you — once every 60
// seconds, forever. A precondition we control is not something to discover by
// failing a real listing. Cached once confirmed: if the session later dies
// mid-run, postListing fails loudly and the item bounces ONCE, which is right.
let sessionOk = false;
async function sessionReady() {
  if (sessionOk) return true;
  let ctx = null;
  try {
    ctx = await openBrowser({ profileDir: PROFILE_DIR, watch: false });
    sessionOk = await sessionAlive(ctx);
    if (!sessionOk) await tellSignedOut();
    return sessionOk;
  } catch (err) {
    log(`session check failed: ${String(err.message || err).slice(0, 200)}`);
    return false;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

async function runOne() {
  if (!await sessionReady()) {
    log(`Chrome profile at ${PROFILE_DIR} is not signed into Facebook — idling. Fix with: node login.mjs`);
    await sleep(10 * 60 * 1000);
    return false;
  }

  const claimRes = await api('/post-queue/claim', { by: `poster:${os.hostname()}` });
  if (!claimRes.ok) { log(`claim HTTP ${claimRes.status}`); return false; }
  const claim = await claimRes.json();
  if (!claim.item) {
    if (claim.reason && claim.reason !== 'empty') log(`nothing to do (${claim.reason})`);
    return false;
  }

  const item = claim.item;
  const isDelete = claim.action === 'delete';
  const isEdit = claim.action === 'edit';

  if (isDelete) {
    log(`claimed delete for ${item.slug} — "${item.title}"`);
    let ctx = null;
    let success = false;
    try {
      ctx = await openBrowser({ profileDir: PROFILE_DIR, watch: WATCH });
      if (!await isLoggedIn(ctx)) {
        sessionOk = false;
        throw new Error('Chrome profile is not logged into Facebook — run: node login.mjs');
      }
      const res = await deleteListing(ctx, item, {
        shotDir: SHOT_DIR,
        log: (m) => log(`  [delete] ${item.slug}: ${m}`),
      });
      success = !!(res && res.success);

      // "I couldn't find it, so it must already be gone" is a guess, and acting
      // on it archives one of your items. Ask instead.
      if (res && res.already && !res.success) {
        log(`could not find ${item.slug} on Facebook — asking before archiving it`);
        const asked = await ask(item, {
          kind: 'looks_gone',
          question: `🔍 I can't find "${item.title}" on your listings any more. Has it already gone?`,
          body: 'If it is still up, I will leave it alone. If it is gone, I will archive it here so the desk matches Facebook.',
          choices: [
            { key: 'archive', text: '✅ It’s gone — archive it' },
            { key: 'keep', text: '✋ It’s still up — leave it' },
          ],
        });
        if (asked) {
          await api(`/items/${item.slug}/remove-failed`, { reason: 'listing not found — asked the seller', asked: true })
            .catch((e) => log(`  (could not clear the delete lock: ${String(e.message || e).slice(0, 160)})`));
          return true;
        }
      }
      if (res && res.already) log(`already gone on Facebook — dropping ${item.slug} from the desk`);

      try {
        await api(`/items/${item.slug}/removed`, { via: 'auto' }, { tries: 6, timeoutMs: 20000 });
        log(`REMOVED ${item.slug}`);
      } catch (e) {
        log(`⚠️ REMOVED ${item.slug} ON FACEBOOK BUT COULD NOT RECORD IT: ${String(e.message || e).slice(0, 300)}`);
        halt(`deleted ${item.slug} but /removed never confirmed: ${String(e.message || e).slice(0, 200)}`);
      }
      return true;
    } catch (err) {
      const checkpoint = !!err.checkpoint;
      const reason = String(err.message || err).slice(0, 400);
      if (success) {
        log(`⚠️ ${item.slug} deleted, then errored during cleanup: ${reason}`);
        return true;
      }
      log(`DELETE FAILED ${item.slug}: ${reason}`);
      await api(`/items/${item.slug}/remove-failed`, { reason, checkpoint }).catch((e) => log(`  (also failed to report delete failure: ${String(e.message || e).slice(0, 160)})`));
      if (checkpoint) halt(reason);
      return true;
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  }

  if (isEdit) {
    log(`claimed edit for ${item.slug} — "${item.title}" $${item.price_ask}`);
    let ctx = null;
    let success = false;
    try {
      ctx = await openBrowser({ profileDir: PROFILE_DIR, watch: WATCH });
      if (!await isLoggedIn(ctx)) {
        sessionOk = false;
        throw new Error('Chrome profile is not logged into Facebook — run: node login.mjs');
      }
      const persistLink = async (idOrUrl) => {
        const url = /marketplace\/item\/\d+/.test(String(idOrUrl))
          ? String(idOrUrl)
          : `https://www.facebook.com/marketplace/item/${idOrUrl}/`;
        await api(`/items/${item.slug}/link`, { fb_listing_url: url, via: 'auto' });
        log(`  persisted permalink for ${item.slug}`);
      };
      const res = await editListing(ctx, item, {
        shotDir: SHOT_DIR,
        log: (m) => log(`  [edit] ${item.slug}: ${m}`),
        onListingId: persistLink,
      });
      success = res.success;
      if (res && res.url) {
        await persistLink(res.url).catch((e) =>
          log(`  (could not persist permalink: ${String(e.message || e).slice(0, 120)})`));
      }

      try {
        await api(`/items/${item.slug}/edited`, {}, { tries: 6, timeoutMs: 20000 });
        log(`EDITED ${item.slug}`);
      } catch (e) {
        log(`⚠️ EDITED ${item.slug} BUT COULD NOT RECORD IT: ${String(e.message || e).slice(0, 300)}`);
        halt(`edited ${item.slug} but /edited never confirmed: ${String(e.message || e).slice(0, 200)}`);
      }
      return true;
    } catch (err) {
      const checkpoint = !!err.checkpoint;
      const reason = String(err.message || err).slice(0, 400);
      if (success) {
        log(`⚠️ ${item.slug} edited, then errored during cleanup: ${reason}`);
        return true;
      }
      log(`EDIT FAILED ${item.slug}: ${reason}`);
      // Could not tell which listing this is. That is a question, not a
      // failure — offer the seller the cards that plausibly match and let them point.
      if (Array.isArray(err.candidates) && err.candidates.length) {
        const asked = await ask(item, {
          kind: 'which_listing',
          question: `🤔 Which of these is "${item.title}"? I couldn't tell, so I haven't touched anything.`,
          body: err.candidates.map((c) => `• ${c.title}`).join(String.fromCharCode(10)),
          choices: [
            ...err.candidates.map((c) => ({ key: c.key, text: c.title.slice(0, 60) })),
            { key: 'none', text: '🚫 None of these' },
          ],
          payload: { candidates: err.candidates },
        });
        if (asked) {
          // Reported as a question, not a strike — a fork you have not answered
          // is not the item failing three times.
          await api(`/items/${item.slug}/edit-failed`, { reason, checkpoint, asked: true })
            .catch((e) => log(`  (could not clear the edit lock: ${String(e.message || e).slice(0, 160)})`));
          return true;
        }
      }
      if (err.listingId) {
        await api(`/items/${item.slug}/link`, {
          fb_listing_url: `https://www.facebook.com/marketplace/item/${err.listingId}/`,
          via: 'auto',
        }).catch((e) => log(`  (could not persist discovered permalink: ${String(e.message || e).slice(0, 120)})`));
      }
      await api(`/items/${item.slug}/edit-failed`, { reason, checkpoint }).catch((e) => log(`  (also failed to report edit failure: ${String(e.message || e).slice(0, 160)})`));
      if (checkpoint) halt(reason);
      return true;
    } finally {
      if (ctx) await ctx.close().catch(() => {});
    }
  }

  // Standard Post logic:
  log(`claimed ${item.slug} — "${item.title}" $${item.price_ask} (${claim.posted_today}/${claim.cap} today)`);

  let ctx = null;
  // Latched the moment Facebook confirms the publish. Once true, nothing may
  // report this item as failed — that is the duplicate-listing path.
  let published = false;
  try {
    const photos = await downloadPhotos(item);
    ctx = await openBrowser({ profileDir: PROFILE_DIR, watch: WATCH });
    if (!await isLoggedIn(ctx)) {
      // Session died between the precheck and now — stop trusting the cache.
      sessionOk = false;
      throw new Error('Chrome profile is not logged into Facebook — run: node login.mjs');
    }
    const res = await postListing(ctx, item, photos, {
      shotDir: SHOT_DIR,
      log: (m) => log(`  ${item.slug}: ${m}`),
      dryRun: DRY,
    });

    if (res.dryRun) {
      // A dry run must not leave the item claimed — put it back so a real run
      // can take it.
      await api(`/items/${item.slug}/status`, { status: 'approved', note: 'dry run' });
      log(`DRY RUN complete for ${item.slug}. Step-2 buttons: ${(res.step2Buttons || []).join(' | ')}`);
      return true;
    }

    // PAST THIS LINE THE LISTING IS LIVE ON FACEBOOK. Everything after it is
    // bookkeeping, and a failure in bookkeeping must never be reported as a
    // failure to post — that would send the item back to 'approved' to be
    // claimed and published a SECOND time. (allow_no_url above exists for the
    // same reason: a publish whose permalink couldn't be scraped is still a
    // publish.) So confirm hard, and if the worker is genuinely unreachable,
    // stop the lane rather than risk a duplicate.
    published = true;
    try {
      await api(`/items/${item.slug}/posted`, {
        fb_listing_url: res.url || null,
        allow_no_url: true,
        via: 'auto',
      }, { tries: 6, timeoutMs: 20000 });
      log(`POSTED ${item.slug}${res.url ? ` -> ${res.url}` : ' (no permalink captured)'}`);

      // The listing is up either way — this asks AFTER the fact, so it never
      // holds up a post (one approval is enough). Answering
      // queues a live edit to move it onto the right shelf.
      const cf = res.categoryFallback;
      if (cf && Array.isArray(cf.offered) && cf.offered.length) {
        await ask(item, {
          kind: 'category',
          question: `🏷 Facebook had no "${cf.wanted}" shelf, so "${item.title}" went up under ${cf.used}. Where should it live?`,
          body: 'A generic shelf gets far less traffic. Pick one and I will move it.',
          choices: [
            ...cf.offered.map((c, i) => ({ key: `g${i}`, text: c.slice(0, 60) })),
            { key: 'keep', text: `✋ Leave it in ${cf.used}` },
          ],
          payload: { options: cf.offered.map((c, i) => ({ key: `g${i}`, category: c })) },
        });
      }
    } catch (e) {
      log(`⚠️ PUBLISHED ${item.slug} BUT COULD NOT RECORD IT: ${String(e.message || e).slice(0, 300)}`);
      log(`   The listing IS live. Halting so it cannot be posted twice — clear logs/HALTED once the item shows as posted.`);
      halt(`published ${item.slug} but /posted never confirmed: ${String(e.message || e).slice(0, 200)}`);
    }
    return true;
  } catch (err) {
    const checkpoint = !!err.checkpoint;
    const reason = String(err.message || err).slice(0, 400);
    if (published) {
      // Threw after the publish landed — same rule: never report post-failed.
      log(`⚠️ ${item.slug} published, then errored during cleanup: ${reason}`);
      return true;
    }
    log(`${checkpoint ? 'CHECKPOINT' : 'FAILED'} ${item.slug}: ${reason}`);
    await api(`/items/${item.slug}/post-failed`, { reason, checkpoint }).catch((e) => log(`  (also failed to report the failure: ${String(e.message || e).slice(0, 160)})`));
    if (checkpoint) halt(reason);
    return true;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    rmSync(path.join(TMP_DIR, item.slug), { recursive: true, force: true });
  }
}

// Ask the seller instead of guessing. Everything the agent cannot decide for
// itself goes out as a Telegram card with buttons — the worker parks the item
// so this loop stops picking it up until you tap.
async function ask(item, payload) {
  try {
    const r = await api(`/items/${item.slug}/ask`, payload);
    const j = await r.json().catch(() => ({}));
    if (j && j.ok) {
      log(`  asked you (${payload.kind}) about ${item.slug}${j.already_open ? ' — already open' : ''}`);
      return true;
    }
    log(`  could not ask about ${item.slug}: ${JSON.stringify(j).slice(0, 200)}`);
  } catch (e) {
    log(`  could not ask about ${item.slug}: ${String(e.message || e).slice(0, 200)}`);
  }
  return false;
}

// Signed out is a human job (you sign in yourself), so say it once
// per signed-out spell rather than every ten minutes.
let toldSignedOut = false;
async function tellSignedOut() {
  if (toldSignedOut) return;
  toldSignedOut = true;
  await api('/notify', { text: '🔑 The poster\'s Chrome is signed out of Facebook, so nothing can post or answer buyers. On the poster computer run node login.mjs in the poster folder and sign in.' })
    .catch((e) => log(`  (could not send the signed-out notice: ${String(e.message || e).slice(0, 120)})`));
}

// ---------------------------------------------------------------------------
// Buyer messages. Between listings, the same single browser reads the
// Marketplace inbox and sends the replies you approved on Telegram.
// ---------------------------------------------------------------------------
const INBOX_CACHE = path.join(LOG_DIR, 'inbox-cache.json');
const INBOX_EVERY_MS = Number(process.env.INBOX_EVERY_MS || 8 * 60 * 1000);
let nextInboxScan = 0;

async function inboxPass() {
  // 1. An approved reply goes out first — a buyer is waiting on it.
  const claimRes = await api('/inbox/claim', {});
  const claim = claimRes.ok ? await claimRes.json() : { reply: null };
  const due = Date.now() >= nextInboxScan;
  if (!claim.reply && !due) return false;

  let ctx = null;
  try {
    ctx = await openBrowser({ profileDir: PROFILE_DIR, watch: WATCH });
    if (claim.reply) {
      const r = claim.reply;
      log(`sending approved reply #${r.id} to ${r.buyer_name || r.thread_key}`);
      try {
        await sendReply(ctx, r, { log: (m) => log(`  [reply] ${m}`) });
        await api(`/inbox/${r.id}/sent`, {}, { tries: 6 });
      } catch (err) {
        const reason = String(err.message || err).slice(0, 300);
        log(`REPLY FAILED #${r.id}: ${reason}`);
        await api(`/inbox/${r.id}/failed`, { reason, checkpoint: !!err.checkpoint, definitely_not_sent: !!err.definitelyNotSent })
          .catch((e) => log(`  (could not report reply failure: ${String(e.message || e).slice(0, 120)})`));
        if (err.checkpoint) { halt(reason); return true; }
      }
    }
    if (due) {
      nextInboxScan = Date.now() + INBOX_EVERY_MS + Math.floor(Math.random() * 4 * 60 * 1000);
      const threads = await readInbox(ctx, { cacheFile: INBOX_CACHE, log: (m) => log(`  ${m}`) });
      if (threads.length) {
        const res = await api('/inbox/report', { threads: threads.map(({ _snippet, ...t }) => t) }, { timeoutMs: 180000 });
        const j = await res.json().catch(() => ({}));
        const ok = (j.results || []).filter((x) => !x.error).map((x) => x.thread_key);
        markReported(INBOX_CACHE, threads.filter((t) => ok.includes(t.thread_key)));
        log(`inbox: reported ${threads.length}, ${(j.results || []).filter((x) => x.reply_id).length} new draft(s) sent to Telegram`);
      }
    }
    return true;
  } catch (err) {
    const reason = String(err.message || err).slice(0, 300);
    log(`inbox pass error: ${reason}`);
    if (err.checkpoint) halt(reason);
    return true;
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }
}

async function main() {
  log(`sellstuff-poster up — worker=${WORKER} profile=${PROFILE_DIR} idle=${IDLE_MS}ms${DRY ? ' DRY' : ''}${WATCH ? ' WATCH' : ''}${ONCE ? ' ONCE' : ''}`);
  for (;;) {
    if (existsSync(HALT_FILE)) {
      log('halted — clear logs/HALTED (install.ps1 -Resume) once Facebook is happy again');
      if (ONCE) return;
      await sleep(15 * 60 * 1000);
      continue;
    }
    let did = false;
    try {
      did = await runOne();
      // Buyers only when no listing work happened this turn, and only while
      // the session is good -- one browser, one job at a time.
      if (!did && sessionOk && !existsSync(HALT_FILE)) did = await inboxPass();
    } catch (err) {
      // api() now names the endpoint and the real cause, so this stops being
      // eight identical "fetch failed" lines that say nothing.
      log(`loop error: ${String(err.message || err).slice(0, 300)}`);
    }
    if (ONCE) return;
    // Back-to-back listings are the pattern that reads as a bot. Even with work
    // waiting, take a real break between them.
    await sleep(did ? 4 * 60 * 1000 + Math.floor(Math.random() * 3 * 60 * 1000) : IDLE_MS);
  }
}

main().catch((e) => { log(`fatal: ${e.stack || e}`); process.exit(1); });
