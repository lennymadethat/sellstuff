// Agent Sell Stuff poster — the Marketplace inbox.
//
//   readInbox  — opens the Marketplace conversations that have something new,
//                reads the last messages of each, and hands them to the worker.
//                It never types anything.
//   sendReply  — types ONE reply you approved on Telegram into the
//                exact thread it was drafted for, then checks it landed.
//
// Same browser, same profile, same one-at-a-time loop as posting; same friction
// scan after every page. Selectors are structural (roles, links, geometry),
// never Facebook's rotating class names.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = (a = 600, b = 1600) => sleep(rnd(a, b));

const FRICTION = [
  /confirm your identity/i, /unusual activity/i, /temporarily (blocked|restricted|unavailable)/i,
  /you'?re temporarily/i, /security check/i, /captcha/i, /we limit how often/i,
  /verify (it'?s )?you/i, /account has been (restricted|disabled)/i,
  /enter (your )?pin/i, /restore (your )?chat history/i, /end-to-end encrypted chats/i,
];

class Friction extends Error { constructor(m) { super(m); this.checkpoint = true; } }

async function assertNoFriction(page, where) {
  if (/\/checkpoint\/|\/login/.test(page.url())) throw new Friction(`Facebook checkpoint/login URL at ${where}: ${page.url()}`);
  const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 6000)).catch(() => '');
  for (const re of FRICTION) if (re.test(txt)) throw new Friction(`Facebook friction at ${where}: matched ${re}`);
}

// Where Marketplace conversations live. Facebook moves this around, so the
// first URL that actually lists /messages/t/ threads wins and is remembered.
const INBOX_URLS = [
  'https://www.facebook.com/marketplace/inbox/',
  'https://www.facebook.com/messages/marketplace/',
  'https://www.facebook.com/messages/t/',
];

// Thread rows: every link to /messages/t/<id> (or /marketplace/t/<id>) with its
// visible text. A Marketplace row reads "Buyer · Listing title" then the latest
// snippet. "Unread" is read from the accessible text Facebook adds for screen
// readers, and from a bold snippet as a fallback.
async function listThreads(page) {
  return page.evaluate(() => {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/(?:messages|marketplace)\/t\/(\d+)/);
      if (!m) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 40 || r.height < 20) continue;
      const text = (a.innerText || '').trim();
      if (!text) continue;
      const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
      const bold = [...a.querySelectorAll('span')].some((s) => {
        const w = Number(getComputedStyle(s).fontWeight);
        return w >= 600 && (s.innerText || '').length > 3 && s !== a.querySelector('span');
      });
      const unread = /unread/i.test(a.getAttribute('aria-label') || '') || /unread message/i.test(text) || bold;
      if (!seen.has(m[1])) {
        seen.set(m[1], { key: m[1], href: new URL(href, location.origin).href, head: lines[0] || '', snippet: lines.slice(1).join(' ').slice(0, 200), unread });
      }
    }
    return [...seen.values()];
  });
}

function splitHead(head) {
  // "Jane Doe · Zebra ZSB Label Printer" — the separator is a middle dot.
  const parts = String(head).split(/\s+[·•]\s+/);
  return parts.length >= 2
    ? { buyer_name: parts[0].trim(), listing_title: parts.slice(1).join(' · ').trim() }
    : { buyer_name: String(head).trim(), listing_title: null };
}

// Read the open conversation. Direction comes from geometry: your own
// bubbles sit on the right half of the conversation pane, the buyer's on the
// left. Facebook's own "You sent" labels are used when present.
async function readConversation(page) {
  return page.evaluate(() => {
    const main = document.querySelector('[role=main]') || document.body;
    const pane = main.getBoundingClientRect();
    const mid = pane.left + pane.width / 2;
    const rows = [...main.querySelectorAll('[role=row]')];
    const out = [];
    for (const row of rows) {
      const texts = [...row.querySelectorAll('div[dir=auto], span[dir=auto]')]
        .filter((el) => !el.querySelector('div[dir=auto], span[dir=auto]'))
        .map((el) => ({ el, t: (el.innerText || '').trim() }))
        .filter((x) => x.t && x.t.length < 2000);
      if (!texts.length) continue;
      // The longest leaf is the message body; short ones are names/timestamps.
      const body = texts.sort((a, b) => b.t.length - a.t.length)[0];
      const r = body.el.getBoundingClientRect();
      if (r.width < 4) continue;
      const label = (row.innerText || '');
      let dir = (r.left + r.width / 2) > mid ? 'out' : 'in';
      if (/^you sent/i.test(label)) dir = 'out';
      // System lines ("You started this chat", "Today at 4:12 PM") are centred
      // and span both halves — skip them.
      if (r.left < mid && r.right > mid && r.width > pane.width * 0.5) continue;
      out.push({ dir, body: body.t });
    }
    // Collapse consecutive duplicates (a bubble and its reply-preview).
    return out.filter((m, i) => !(i && out[i - 1].body === m.body && out[i - 1].dir === m.dir));
  });
}

function loadCache(file) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}; } catch { return {}; }
}

/**
 * Open the inbox, then each thread that has something new (unread, or a
 * snippet we have not reported yet). Returns [{thread_key, thread_url,
 * buyer_name, listing_title, messages, _snippet}] — never types a character.
 */
export async function readInbox(ctx, { cacheFile, maxThreads = 5, log = () => {} } = {}) {
  const page = ctx.pages()[0] || await ctx.newPage();
  const cache = loadCache(cacheFile);
  let threads = [];
  const urls = cache.__inbox_url ? [cache.__inbox_url, ...INBOX_URLS.filter((u) => u !== cache.__inbox_url)] : INBOX_URLS;
  for (const url of urls) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(rnd(5000, 8000));
    await assertNoFriction(page, `inbox ${url}`);
    threads = await listThreads(page);
    if (threads.length) { cache.__inbox_url = url; break; }
  }
  log(`inbox: ${threads.length} conversation(s) listed`);
  const fresh = threads.filter((t) => t.unread || cache[t.key] !== t.snippet).slice(0, maxThreads);
  const out = [];
  for (const t of fresh) {
    await pause(1500, 4000);
    await page.goto(t.href, { waitUntil: 'domcontentloaded' });
    await sleep(rnd(4000, 6500));
    await assertNoFriction(page, `thread ${t.key}`);
    const messages = await readConversation(page);
    const head = splitHead(t.head);
    log(`  thread ${t.key} ${head.buyer_name} · ${head.listing_title || '?'}: ${messages.length} message(s), last ${messages.length ? messages[messages.length - 1].dir : '-'}`);
    out.push({ thread_key: t.key, thread_url: t.href, ...head, messages: messages.slice(-20), _snippet: t.snippet });
  }
  writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  return out;
}

// Mark threads as reported so the next scan only opens what changed. Called
// only after the worker accepted them, so a failed report is retried next time.
export function markReported(cacheFile, threads) {
  const cache = loadCache(cacheFile);
  for (const t of threads) cache[t.thread_key] = t._snippet;
  writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
}

function sendFail(msg, definitelyNotSent) {
  const e = new Error(msg);
  e.definitelyNotSent = definitelyNotSent;
  return e;
}

/**
 * Type one approved reply into its thread and confirm it landed.
 * Throws Friction on any checkpoint; throws with definitelyNotSent=true when it
 * never got as far as typing.
 */
export async function sendReply(ctx, reply, { log = () => {} } = {}) {
  const page = ctx.pages()[0] || await ctx.newPage();
  const url = reply.thread_url || `https://www.facebook.com/messages/t/${reply.thread_key}/`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sleep(rnd(4500, 7000));
  await assertNoFriction(page, `send ${reply.thread_key}`);
  // Never type into the wrong conversation: the page must still be this thread.
  if (!page.url().includes(String(reply.thread_key))) {
    throw sendFail(`landed on ${page.url()}, not thread ${reply.thread_key}`, true);
  }
  const box = page.locator('[role=main] [role=textbox][contenteditable=true]').last();
  if (!(await box.count().catch(() => 0)) || !(await box.isVisible().catch(() => false))) {
    throw sendFail('no message box in the thread (closed chat, or blocked buyer?)', true);
  }
  await box.click();
  await pause(400, 900);
  // Line breaks would send early on Enter — type them as Shift+Enter.
  const parts = String(reply.text).split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (i) { await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift'); }
    await page.keyboard.type(parts[i], { delay: parts[i].length > 200 ? rnd(12, 25) : rnd(35, 80) });
  }
  await pause(700, 1500);
  await assertNoFriction(page, `before send ${reply.thread_key}`);
  await page.keyboard.press('Enter');
  await sleep(rnd(3000, 4500));
  await assertNoFriction(page, `after send ${reply.thread_key}`);
  const msgs = await readConversation(page);
  const want = String(reply.text).replace(/\s+/g, ' ').trim().slice(0, 60);
  const landed = msgs.slice(-4).some((m) => m.dir === 'out' && m.body.replace(/\s+/g, ' ').includes(want));
  if (!landed) {
    // It was typed and Enter was pressed; it may well be there. Not safe to retype.
    throw sendFail('typed and pressed Enter, but could not see the message in the thread afterwards', false);
  }
  log(`sent reply #${reply.id} to ${reply.buyer_name || reply.thread_key}`);
  return { sent: true };
}
