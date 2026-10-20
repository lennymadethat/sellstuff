// Flip Poster — the Facebook Marketplace browser driver (Option B).
//
// Facebook Marketplace has NO listing API. Every crosslisting product on the
// market puppets a browser for this reason, and so do we. What keeps this
// inside the kit's safety rules (see docs/SAFETY.md):
//
//   1. real account only  — this drives your own logged-in Chrome profile.
//                           No burner, no second account.
//   2. human tap          — an item only reaches this file AFTER you tapped
//                           Approve on the Telegram card. Nothing self-approves.
//   3. human speed        — one listing at a time, randomised pauses between
//                           fields, per-character typing. The daily cap is
//                           enforced worker-side in /post-queue/claim.
//   4. stop on friction   — any checkpoint / captcha / identity prompt aborts
//                           the run untouched and halts the whole lane.
//
// Selectors were read off the LIVE create-listing form rather
// than guessed. Facebook ships obfuscated class names (x1s85apg etc.) that
// rotate, so nothing here matches on class — only on structure and on the
// label text a human sees.
//
// Field map as verified:
//   photos      input[type=file][accept*=image][multiple]   (setInputFiles)
//   Title       <label>Title</label> wrapping input[type=text]
//   Price       <label>Price</label> wrapping input[type=text]
//   Description <label>Description</label> wrapping textarea
//   Category    <label role=combobox>Category</label> -> [role=dialog] of
//               [role=button] rows (26 of them, flat list)
//   Condition   <label role=combobox aria-haspopup=listbox>Condition</label>
//               -> [role=option] x4
//
// GOTCHA that would have failed silently: Facebook's condition labels use an
// EN DASH ("Used – good"), not a hyphen. All text matching here is normalised
// so a hyphen in our data still finds the right option.

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { pickBestCard, sellingSearchQueries, scoreTitleMatch } from './match.mjs';

// Facebook's own 26 category labels, in the order the picker lists them.
// Facebook renders different spellings by locale ("Jewellery" vs "Jewelry") —
// match what the DOM actually says. The poster also reads the live picker.
export const FB_CATEGORIES = [
  'Tools', 'Furniture', 'Household', 'Garden', 'Appliances', 'Video Games',
  'Books, films & music', 'Bags & luggage', "Women's clothing & shoes",
  "Men's clothing & shoes", 'Jewellery and accessories', 'Health & beauty',
  'Pet supplies', 'Baby & children', 'Toys and games', 'Electronics & computers',
  'Mobile phones', 'Bicycles', 'Arts & crafts', 'Sport and outdoors', 'Car parts',
  'Musical Instruments', 'Antiques and collectibles', 'Garage sale',
  'Miscellaneous', 'Vehicles',
];

const CONDITIONS = ['New', 'Used – like new', 'Used – good', 'Used – fair'];

// Anything on this list means Facebook is asking a human a question. We never
// answer it. Deliberately biased toward false positives:
// bouncing a listing back to the desk costs a minute, working around a platform
// control costs the account.
const FRICTION = [
  /confirm your identity/i,
  /unusual activity/i,
  /temporarily (blocked|restricted|unavailable)/i,
  /you'?re temporarily/i,
  /security check/i,
  /captcha/i,
  /we limit how often/i,
  /verify (it'?s )?you/i,
  /account has been (restricted|disabled)/i,
];

const rnd = (a, b) => a + Math.floor(Math.random() * (b - a));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Human pacing between actions. Not decoration — a form filled in 300ms flat is
// the single loudest automation signal there is.
const pause = (a = 500, b = 1500) => sleep(rnd(a, b));

const norm = (s) => String(s || '')
  .replace(/[‐-―]/g, '-')      // en/em dashes -> hyphen
  .replace(/[‘’]/g, "'")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

class Friction extends Error {
  constructor(msg) { super(msg); this.checkpoint = true; }
}

// ---------------------------------------------------------------------------
// Data shaping
// ---------------------------------------------------------------------------

// The approval card's description carries internal commentary for the seller —
// "💡 <pricing reasoning>" and "⚠️ <confidence>" lines appended by
// researchAndPropose. Buyers must never see us explaining our own floor price.
export function cleanDescription(d) {
  return String(d || '')
    .split('\n')
    .filter((l) => !/^\s*(💡|⚠️|⚠)/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Our research step asks the model for one of FB_CATEGORIES, but older items
// (and any model drift) carry free text like "Tools & Equipment / Tanks".
// Words that mean the same shelf but aren't spelled the same. Facebook renders
// different label sets by locale and keeps changing them (an early
// harvest came back with UK spellings — "Jewellery", "films" — on a US
// account), so matching has to survive the wording moving underneath us.
const CATEGORY_SYNONYMS = {
  electronics: ['electronic', 'computer', 'computers', 'tech', 'monitor', 'monitors', 'tv', 'television', 'audio', 'camera', 'console', 'laptop', 'pc'],
  tools: ['tool', 'equipment', 'hardware', 'machinery', 'tank', 'tanks', 'compressor'],
  furniture: ['furnishing', 'furnishings', 'chair', 'table', 'desk', 'sofa', 'couch', 'bed', 'dresser'],
  appliances: ['appliance', 'washer', 'dryer', 'fridge', 'refrigerator', 'microwave', 'oven'],
  household: ['home', 'house', 'kitchen', 'decor', 'homeware'],
  garden: ['yard', 'outdoor', 'lawn', 'patio', 'plant', 'plants'],
  'sport and outdoors': ['sports', 'sporting', 'fitness', 'gym', 'exercise', 'camping', 'bike'],
  'car parts': ['auto', 'automotive', 'vehicle', 'truck', 'tire', 'tires', 'wheel', 'wheels'],
  'toys and games': ['toy', 'game', 'games', 'puzzle', 'lego'],
  'musical instruments': ['music', 'guitar', 'piano', 'drum', 'drums', 'amp'],
  'antiques and collectibles': ['antique', 'collectible', 'collectibles', 'vintage', 'rare'],
  'baby & children': ['baby', 'kids', 'child', 'children', 'toddler', 'infant'],
  'pet supplies': ['pet', 'pets', 'dog', 'cat', 'aquarium'],
  'health & beauty': ['health', 'beauty', 'cosmetic', 'cosmetics', 'skincare'],
  'arts & crafts': ['art', 'arts', 'craft', 'crafts', 'sewing', 'yarn'],
  'books, films & music': ['book', 'books', 'film', 'films', 'movie', 'movies', 'dvd', 'cd', 'vinyl'],
  'bags & luggage': ['bag', 'bags', 'luggage', 'suitcase', 'backpack'],
  'mobile phones': ['phone', 'phones', 'mobile', 'cell', 'iphone', 'android', 'smartphone'],
  'video games': ['videogame', 'videogames', 'xbox', 'playstation', 'nintendo', 'switch'],
  bicycles: ['bicycle', 'bike', 'bikes', 'cycling'],
  'jewelry & accessories': ['jewellery', 'jewelry', 'accessory', 'accessories', 'watch', 'watches', 'ring', 'necklace'],
  'sporting goods': ['sport', 'sports', 'sporting', 'outdoors', 'fitness', 'gym', 'exercise', 'camping'],
  "women's clothing & shoes": ['womens', 'women', 'ladies', 'dress', 'dresses'],
  "men's clothing & shoes": ['mens', 'men', 'shirt', 'shirts', 'suit'],
};

// Joining words carry no meaning but appear in half the category labels
// ("Antiques AND collectibles", "Sport AND outdoors"), so an unfiltered token
// match on "and" scored a synonym hit and sent jewellery to the antiques
// shelf. Everything below is stripped before matching.
const STOP_WORDS = new Set(['and', 'or', 'the', 'a', 'of', 'for', 'with', 'amp', 'goods', 'supplies', 'other', 'misc']);
const meaningful = (s) => norm(s).split(' ').filter((t) => t && !STOP_WORDS.has(t));

// The last-resort labels, best first. Whichever of these the picker is actually
// showing wins. Facebook has always offered at least one of them.
const GENERIC_FALLBACKS = ['Miscellaneous', 'Other', 'Garage sale', 'Everything else', 'General'];

// Choose a category from the labels the picker is showing RIGHT NOW.
//
// `offered` is read off the live dialog, so every return value is guaranteed
// clickable. Order: exact match → synonym hit → token overlap → generic that
// is present → first row in the dialog. It never returns null and never
// throws: a wrong-ish category costs some reach, a hard failure costs the
// entire listing and (before the strike counter) looped the poster all night.
export function chooseCategory(raw, offered) {
  const list = (offered || []).filter(Boolean);
  if (!list.length) return 'Miscellaneous';
  const r = norm(raw);
  if (!r) return genericFrom(list);

  const exact = list.find((c) => norm(c) === r);
  if (exact) return exact;

  // Our words, and the words the seller/AI actually used, both count —
  // joining words excluded, or "and" alone scores a match on half the menu.
  const tokens = new Set(meaningful(raw));
  if (!tokens.size) return genericFrom(list);

  // Synonym pass — "monitor" or "computers" should find whatever the picker
  // calls the electronics shelf this week, whichever way it's worded.
  let synBest = null;
  let synScore = 0;
  for (const c of list) {
    const cTokens = new Set(meaningful(c));
    let hits = 0;
    for (const [key, syns] of Object.entries(CATEGORY_SYNONYMS)) {
      const keyTokens = meaningful(key);
      const catMatchesKey = keyTokens.some((t) => cTokens.has(t)) || syns.some((s) => cTokens.has(s));
      if (!catMatchesKey) continue;
      const wantMatchesKey = keyTokens.some((t) => tokens.has(t)) || syns.some((s) => tokens.has(s));
      if (wantMatchesKey) hits += 1;
    }
    if (hits > synScore) { synScore = hits; synBest = c; }
  }
  if (synBest) return synBest;

  // Plain token overlap, scored against the offered label.
  let best = null;
  let bestScore = 0;
  for (const c of list) {
    const ct = meaningful(c);
    if (!ct.length) continue;
    const score = ct.filter((t) => tokens.has(t)).length / ct.length;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  if (best && bestScore >= 0.5) return best;

  return genericFrom(list);
}

function genericFrom(list) {
  for (const g of GENERIC_FALLBACKS) {
    const hit = list.find((c) => norm(c) === norm(g));
    if (hit) return hit;
  }
  // Nothing generic on offer — take the first row rather than fail. Publish is
  // blocked without a category, so any valid pick beats no pick.
  return list[0];
}

// Legacy: maps free text onto our hardcoded FB_CATEGORIES guess-list. Kept only
// so the research prompt has a vocabulary to aim at; the poster no longer
// trusts it, because the live picker is the only real authority.
export function pickCategory(raw) {
  if (!raw) return 'Miscellaneous';
  const r = norm(raw);
  const exact = FB_CATEGORIES.find((c) => norm(c) === r);
  if (exact) return exact;
  const tokens = new Set(r.split(' ').filter(Boolean));
  let best = 'Miscellaneous';
  let bestScore = 0;
  for (const c of FB_CATEGORIES) {
    const ct = norm(c).split(' ').filter(Boolean);
    const score = ct.filter((t) => tokens.has(t)).length / ct.length;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.5 ? best : 'Miscellaneous';
}

// Our vocabulary is New|Like New|Good|Fair|Salvage; Facebook's is four options.
// Salvage has no Facebook equivalent — "Used – fair" is the honest floor, and
// the description carries the real story (be honest in listings).
export function pickCondition(raw) {
  const r = norm(raw);
  if (!r) return 'Used – good';
  if (r === 'new' || r.startsWith('new ')) return 'New';
  if (r.includes('like new') || r.includes('excellent') || r.includes('mint')) return 'Used – like new';
  if (r.includes('fair') || r.includes('salvage') || r.includes('poor') || r.includes('parts')) return 'Used – fair';
  return 'Used – good';
}

// ---------------------------------------------------------------------------
// Page helpers — all structural, none class-based
// ---------------------------------------------------------------------------

async function handleOrNull(page, fn, arg) {
  const h = await page.evaluateHandle(fn, arg);
  const el = h.asElement();
  if (!el) { await h.dispose(); return null; }
  return el;
}

// A field whose <label> wraps its own control (Title, Price, Description).
const labelled = (page, name, sel) => handleOrNull(page, ({ name, sel }) => {
  const l = [...document.querySelectorAll('label')]
    .find((x) => (x.innerText || '').trim().split('\n')[0] === name);
  return l ? l.querySelector(sel) : null;
}, { name, sel });

// Category / Condition are labels that ARE the combobox.
const combo = (page, name) => handleOrNull(page, (name) => (
  [...document.querySelectorAll('label[role=combobox]')]
    .find((l) => (l.innerText || '').includes(name)) || null
), name);

const buttonByText = (page, text) => handleOrNull(page, (text) => {
  const want = String(text).toLowerCase();
  const els = [...document.querySelectorAll('[role=button]')];
  return els.find((b) => (b.innerText || '').trim().toLowerCase() === want
    && b.getAttribute('aria-disabled') !== 'true'
    && b.offsetParent !== null) || null;
}, text);

// Facebook menus and the edit-form Next/Update strip are often position:fixed.
// offsetParent is null on those — early delete and edit runs died on that.
// Rect size is the test.
const findVisibleRoleButton = (page, names) => handleOrNull(page, (names) => {
  const want = names.map((n) => String(n).toLowerCase());
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  return [...document.querySelectorAll('[role=button],button')].find((b) => {
    const t = (b.innerText || '').trim().split('\n')[0].toLowerCase();
    return want.includes(t)
      && b.getAttribute('aria-disabled') !== 'true'
      && shown(b);
  }) || null;
}, names);

async function roleButton(page, names) {
  for (const name of names) {
    const loc = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') });
    const n = await loc.count().catch(() => 0);
    if (!n) continue;
    const first = loc.first();
    if (await first.isVisible().catch(() => false) && await first.isEnabled().catch(() => true)) {
      return first;
    }
  }
  return findVisibleRoleButton(page, names);
}

async function visibleButtonNames(page) {
  return page.evaluate(() => [...new Set([...document.querySelectorAll('[role=button],button')]
    .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 4 && r.height > 4; })
    .map((b) => (b.innerText || '').trim().split('\n')[0])
    .filter((t) => t && t.length < 40))]);
}

async function assertNoFriction(page, where) {
  if (/\/checkpoint\//.test(page.url())) throw new Friction(`Facebook checkpoint URL at ${where}`);
  const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 6000)).catch(() => '');
  for (const re of FRICTION) {
    if (re.test(txt)) throw new Friction(`Facebook friction at ${where}: matched ${re}`);
  }
}

async function typeInto(page, el, text) {
  await el.click();
  await pause(180, 450);
  // Long descriptions get a faster cadence — nobody hunts-and-pecks 400
  // characters, and a 40-second type is its own kind of anomaly.
  await page.keyboard.type(String(text), { delay: text.length > 300 ? rnd(8, 20) : rnd(35, 85) });
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

// A dedicated persistent profile — NOT a fresh context. Cookies, history and
// local storage accumulate across runs, which is what a real browser looks
// like; a clean context every time is a fingerprint. channel:'chrome' uses the
// real installed Google Chrome, not Playwright's bundled Chromium.
export async function openBrowser({ profileDir, watch = false }) {
  mkdirSync(profileDir, { recursive: true });
  const args = ['--disable-blink-features=AutomationControlled'];
  // Unattended runs park the window off-screen so it never steals focus while
  // you are using the machine. FLIP_WATCH=1 brings it on-screen to watch a run.
  args.push(watch ? '--window-position=40,40' : '--window-position=-2400,80');
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,           // headless Chrome is trivially detected
    viewport: { width: 1440, height: 900 },
    args,
    ignoreDefaultArgs: ['--enable-automation'],
  });
}

export async function isLoggedIn(ctx) {
  const cookies = await ctx.cookies('https://www.facebook.com');
  return cookies.some((c) => c.name === 'c_user' && c.value);
}

// The cookie check above is not enough on its own: a profile can keep its
// c_user cookie while every page shows the Log In box. This loads a page and
// looks.
export async function sessionAlive(ctx) {
  if (!await isLoggedIn(ctx)) return false;
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://www.facebook.com/marketplace/you/selling', { waitUntil: 'domcontentloaded' });
  await sleep(rnd(4000, 6000));
  if (/\/login|\/checkpoint\//.test(page.url())) return false;
  const loginBox = await page.locator('input[name="pass"]').first().isVisible().catch(() => false);
  return !loginBox;
}

// ---------------------------------------------------------------------------
// The post
// ---------------------------------------------------------------------------

/**
 * Create one Marketplace listing.
 * @returns {{url: string|null, dryRun?: true, step2Buttons?: string[]}}
 * Throws Friction (checkpoint===true) if Facebook asks a human anything.
 */
export async function postListing(ctx, item, photoPaths, opts = {}) {
  // Default OFF — Meta's AI should not answer buyers in your name.
  const { shotDir, log = () => {}, dryRun = false, metaAiReply = false } = opts;
  const page = await ctx.newPage();
  let categoryFallback = null;
  const shot = async (tag) => {
    if (!shotDir) return null;
    mkdirSync(shotDir, { recursive: true });
    const p = path.join(shotDir, `${item.slug}-${tag}.png`);
    await page.screenshot({ path: p, fullPage: false }).catch(() => {});
    return p;
  };

  try {
    await page.goto('https://www.facebook.com/marketplace/create/item', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await assertNoFriction(page, 'load');

    // The form hydrates well after domcontentloaded — wait for the real file
    // input, not for a timer.
    const fileSel = 'input[type=file][accept*="image"]';
    // state:'attached', NOT the default 'visible' — Facebook's file input is
    // permanently hidden behind the styled "Add photos" tile and never becomes
    // visible. setInputFiles drives a hidden input just fine; waiting for
    // visibility here times out on every single listing.
    await page.waitForSelector(fileSel, { state: 'attached', timeout: 45000 });
    await pause(800, 1800);
    await assertNoFriction(page, 'form-ready');

    log(`uploading ${photoPaths.length} photo(s)`);
    await page.setInputFiles(fileSel, photoPaths);
    // Uploads must finish before Publish is allowed; the counter in the header
    // ("Photos · 3/10") is the honest signal that Facebook accepted them.
    await page.waitForFunction(
      (n) => /Photos\s*[·-]\s*(\d+)\s*\/\s*10/.test(document.body.innerText)
        && Number(document.body.innerText.match(/Photos\s*[·-]\s*(\d+)\s*\/\s*10/)[1]) >= n,
      photoPaths.length,
      { timeout: 120000 },
    ).catch(() => log('WARN: photo counter never confirmed — continuing, Publish will block if they really failed'));
    await pause(900, 2000);

    const title = String(item.title || '').slice(0, 100);
    const titleEl = await labelled(page, 'Title', 'input[type=text]');
    if (!titleEl) throw new Error('Title field not found (Facebook changed the create form)');
    await typeInto(page, titleEl, title);
    await pause();

    const priceEl = await labelled(page, 'Price', 'input[type=text]');
    if (!priceEl) throw new Error('Price field not found');
    await typeInto(page, priceEl, String(Math.round(Number(item.price_ask) || 0)));
    await pause();

    // Category — click the combobox, then the row in the dialog it opens.
    //
    // An early version looped twenty times with
    //   Category "Electronics & computers" not offered by the picker
    // which reads like a stale-label problem and is NOT. FB_CATEGORIES was
    // accurate the whole time. The lookup was searching the WRONG DIALOG. See pickDialog
    // below for the actual fault.
    //
    // Reading the live picker instead of trusting the hardcoded list is kept
    // anyway: it makes the list self-correcting, it logs what Facebook is
    // really showing, and it means a category can never hard-fail again — an
    // unrecognised one lands on a generic that is definitely present, because
    // a slightly-wrong category costs some reach while a hard failure cost the
    // whole listing and, before the strike counter, the whole night.
    const catEl = await combo(page, 'Category');
    if (!catEl) throw new Error('Category combobox not found');
    await catEl.click();
    await pause(700, 1400);

    // Picking the dialog is the hard part, not picking the row.
    //
    // "first [role=dialog] with more than 20 characters of text" matched
    // Facebook's NOTIFICATIONS flyout, which is also mounted in the DOM. A
    // dry run proved it: the picker reported exactly three options —
    // "All | Unread | See previous notifications". Every category lookup was
    // searching the wrong panel, then timing out clicking an invisible row. The
    // stale-label theory was a red herring; this was always the bug.
    //
    // So: score the candidates and take the best. The category picker is
    // visible and carries ~26 rows; the notifications flyout carries 3. Both
    // reads use the SAME dialog by index, so the row we click is guaranteed to
    // come from the list we scored.
    const pickDialog = () => {
      const scored = [...document.querySelectorAll('[role=dialog]')].map((d, i) => {
        // getBoundingClientRect, NOT offsetParent — offsetParent is null for
        // position:fixed elements, which reports a visible modal as hidden.
        const r = d.getBoundingClientRect();
        const rows = [...d.querySelectorAll('[role=button]')]
          .map((b) => (b.innerText || '').split('\n')[0].trim())
          .filter(Boolean);
        return { i, rows, visible: r.width > 0 && r.height > 0 };
      });
      const usable = scored.filter((s) => s.visible && s.rows.length);
      if (!usable.length) return null;
      usable.sort((a, b) => b.rows.length - a.rows.length);
      return usable[0];
    };

    const picked = await page.evaluate(`(${pickDialog.toString()})()`);
    if (!picked || !picked.rows.length) throw new Error('Category picker opened but no dialog listed anything (Facebook changed the create form)');
    const offered = picked.rows;
    log(`category picker (dialog #${picked.i}) offers ${offered.length}: ${offered.join(' | ')}`);
    // A category picker has dozens of rows. If we only found a handful we are
    // almost certainly in the wrong panel again — fail loudly with what we saw
    // rather than silently filing the listing under a notifications entry.
    if (offered.length < 8) throw new Error(`Category picker looks wrong — only ${offered.length} options: ${offered.join(' | ')}`);

    const wantCat = chooseCategory(item.category, offered);
    const catRow = await handleOrNull(page, ({ want, idx }) => {
      const n = (s) => String(s || '').replace(/[‐-―]/g, '-').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const dlg = document.querySelectorAll('[role=dialog]')[idx];
      if (!dlg) return null;
      return [...dlg.querySelectorAll('[role=button]')]
        .find((b) => n((b.innerText || '').split('\n')[0]) === n(want)) || null;
    }, { want: wantCat, idx: picked.i });
    // chooseCategory only ever returns a label read off this very dialog, so
    // this can now only fire if the DOM changed between the two reads.
    if (!catRow) throw new Error(`Category "${wantCat}" vanished from the picker mid-selection`);
    await catRow.click();
    log(`category: ${wantCat}${norm(wantCat) === norm(item.category) ? '' : ` (mapped from "${item.category}")`}`);
    if (GENERIC_FALLBACKS.some((g) => norm(g) === norm(wantCat)) && !GENERIC_FALLBACKS.some((g) => norm(g) === norm(item.category))) {
      // Offer the seller the shelves the picker actually had, not our guess-list.
      categoryFallback = {
        wanted: item.category || null,
        used: wantCat,
        offered: offered.filter((c) => !GENERIC_FALLBACKS.some((g) => norm(g) === norm(c))).slice(0, 4),
      };
      log(`category fell back to "${wantCat}" — will ask which shelf it belongs on`);
    }
    await pause();

    // Condition — a listbox, not a dialog. Dash-normalised match.
    const wantCond = pickCondition(item.condition);
    const condEl = await combo(page, 'Condition');
    if (!condEl) throw new Error('Condition combobox not found');
    await condEl.click();
    await pause(600, 1200);
    const condOpt = await handleOrNull(page, (want) => {
      const n = (s) => String(s || '').replace(/[‐-―]/g, '-').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      return [...document.querySelectorAll('[role=option]')]
        .find((o) => n((o.innerText || '').split('\n')[0]) === n(want)) || null;
    }, wantCond);
    if (!condOpt) throw new Error(`Condition "${wantCond}" not offered (options are ${CONDITIONS.join(' / ')})`);
    await condOpt.click();
    log(`condition: ${wantCond}`);
    await pause();

    const descEl = await labelled(page, 'Description', 'textarea');
    if (!descEl) throw new Error('Description textarea not found');
    await typeInto(page, descEl, cleanDescription(item.description));
    await pause(800, 1600);

    await assertNoFriction(page, 'form-filled');
    await shot('1-filled');

    // Walk the wizard rather than assuming a step count. Facebook grew this
    // flow from two steps to three (details -> delivery method -> publish) at
    // some point, and will grow it again. Its intermediate
    // defaults are already what we want — a Facebook item is local pickup, and
    // "Local pick-up only" is preselected — so we accept them and move on.
    let publish = await buttonByText(page, 'Publish');
    for (let step = 0; step < 5 && !publish; step++) {
      const next = await buttonByText(page, 'Next');
      if (!next) {
        const names = await visibleButtonNames(page);
        await shot(`2-stuck-step${step + 1}`);
        throw new Error(step === 0
          ? `"Next" not clickable on the details step — a required field is probably empty. Visible buttons: ${names.join(' | ')}`
          : `neither "Next" nor "Publish" on step ${step + 1}. Visible buttons: ${names.join(' | ')}`);
      }
      await next.click();
      await pause(1800, 3000);
      await assertNoFriction(page, `step-${step + 2}`);
      // Meta's own auto-reply is a per-listing toggle somewhere in this flow,
      // not a settings page. We drive it to an explicit state (default OFF).
      // Best-effort on every step; never fail a listing over it.
      await setMetaAiReply(page, metaAiReply, log);
      publish = await buttonByText(page, 'Publish');
    }
    if (!publish) {
      const names = await visibleButtonNames(page);
      await shot('2-nopublish');
      throw new Error(`"Publish" never appeared after 5 steps. Visible buttons: ${names.join(' | ')}`);
    }

    if (dryRun) {
      const names = await visibleButtonNames(page);
      await shot('2-dryrun');
      log('DRY RUN — stopping at the Publish button, nothing posted');
      return { url: null, dryRun: true, step2Buttons: names, categoryFallback };
    }

    await shot('2-prepublish');
    await publish.click();
    log('published — waiting for Facebook to confirm');

    // Success = we leave the create flow. Facebook sometimes lands on the
    // listing, sometimes on "Your listings"; only the first gives a permalink.
    await page.waitForFunction(
      () => !/\/marketplace\/create\//.test(location.pathname),
      null,
      { timeout: 60000 },
    ).catch(() => {});
    await pause(2000, 3500);
    await assertNoFriction(page, 'post-publish');

    if (/\/marketplace\/create\//.test(page.url())) {
      await shot('3-stuck');
      throw new Error('still on the create form after Publish — listing not confirmed');
    }

    const m = page.url().match(/\/marketplace\/item\/(\d+)/);
    let listingId = m ? m[1] : null;

    // Facebook sometimes does not land on the new listing after Publish — it
    // drops you on "Your listings" instead, so this scrape can return null
    // (and later edit/delete then have to hunt for the card by title).
    // Fall back to reading the id off the card we just created.
    if (!listingId) {
      log('no permalink in the URL after publish — resolving it from Your listings');
      try {
        listingId = await findListingIdByTitle(page, item.title || '', (m2) => log(`  [permalink] ${m2}`));
      } catch (e) {
        log(`  permalink lookup failed (listing is still live): ${String(e.message || e).slice(0, 160)}`);
      }
      if (listingId) log(`resolved permalink listing id ${listingId}`);
    }

    const url = listingId ? `https://www.facebook.com/marketplace/item/${listingId}/` : null;
    await shot('3-done');
    return { url, listingId, categoryFallback };
  } finally {
    await page.close().catch(() => {});
  }
}

async function clearAndTypeInto(page, el, text) {
  await el.click();
  await pause(180, 450);
  await page.keyboard.press('Control+a');
  await pause(80, 200);
  await page.keyboard.press('Backspace');
  await pause(150, 350);
  await page.keyboard.type(String(text), { delay: text.length > 300 ? rnd(8, 20) : rnd(35, 85) });
}

function editFail(msg, listingId) {
  const err = new Error(msg);
  if (listingId) err.listingId = String(listingId);
  return err;
}

/**
 * Edit one Marketplace listing online.
 *
 * Facebook's edit form is the same multi-step wizard as create (details →
 * delivery → commit). Early live edits filled Price/Description then died looking for Save/Update while
 * a blue Next sat at the bottom of the column. Walk Next until Update/Save
 * /Publish appears — same loop postListing already uses.
 */
export async function editListing(ctx, item, opts = {}) {
  const { shotDir, log = () => {}, onListingId = null } = opts;
  const page = await ctx.newPage();
  const shot = async (tag) => {
    if (!shotDir) return null;
    mkdirSync(shotDir, { recursive: true });
    const p = path.join(shotDir, `edit-${item.slug}-${tag}.png`);
    await page.screenshot({ path: p, fullPage: false }).catch(() => {});
    return p;
  };

  const parsed = String(item.fb_listing_url || item.listing_url || '').match(/\/marketplace\/item\/(\d+)/);
  let listingId = parsed ? parsed[1] : null;

  const remember = async (id) => {
    if (!id) return;
    listingId = String(id);
    if (!onListingId) return;
    try { await onListingId(listingId); }
    catch (e) { log(`could not persist listing id ${listingId}: ${String(e.message || e).slice(0, 120)}`); }
  };

  try {
    // Most live rows never captured a permalink. Find the card on Your selling
    // the same way delete does, then use Facebook's edit URL.
    if (!listingId) {
      log('no permalink — searching Your selling');
      await page.goto('https://www.facebook.com/marketplace/you/selling', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await assertNoFriction(page, 'edit-selling-load');
      await pause(2000, 3500);
      await filterSellingList(page, item.title, log, item.fb_card_title);
      await shot('search');
      await remember(await findSellingListingId(page, { title: item.title || '', confirmed: item.fb_card_title }, log));
      if (!listingId) {
        const opened = await openSellingCardMenu(page, { listingId: null, title: item.title || '', confirmed: item.fb_card_title }, log);
        if (opened.ok) {
          if (opened.listingId) await remember(opened.listingId);
          const clicked = await clickNamed(page, [
            { role: 'menuitem', name: /^edit listing$/i, fallback: 'Edit listing' },
            { role: 'menuitem', name: /^edit$/i, fallback: 'Edit' },
            { role: 'button', name: /^edit listing$/i, fallback: 'Edit listing' },
          ]);
          if (clicked) {
            log(`opened edit form from card menu (${clicked})`);
            await pause(1500, 2800);
            const fromUrl = String(page.url() || '').match(/listing_id=(\d+)/);
            if (fromUrl) await remember(fromUrl[1]);
          }
        }
      }
      if (!listingId && !/\/marketplace\/edit\//.test(page.url())) {
        log('search missed — scrolling Your listings');
        await clearSellingSearch(page);
        for (let i = 0; i < 10 && !listingId && !/\/marketplace\/edit\//.test(page.url()); i++) {
          await remember(await findSellingListingId(page, { title: item.title || '', confirmed: item.fb_card_title }, log));
          if (listingId) break;
          const opened = await openSellingCardMenu(page, { listingId: null, title: item.title || '', confirmed: item.fb_card_title }, log);
          if (opened.ok) {
            if (opened.listingId) await remember(opened.listingId);
            const clicked = await clickNamed(page, [
              { role: 'menuitem', name: /^edit listing$/i, fallback: 'Edit listing' },
              { role: 'menuitem', name: /^edit$/i, fallback: 'Edit' },
              { role: 'button', name: /^edit listing$/i, fallback: 'Edit listing' },
            ]);
            if (clicked) {
              log(`opened edit form from card menu after scroll (${clicked})`);
              await pause(1500, 2800);
              const fromUrl = String(page.url() || '').match(/listing_id=(\d+)/);
              if (fromUrl) await remember(fromUrl[1]);
            }
            break;
          }
          await page.mouse.wheel(0, 1100);
          await pause(500, 900);
        }
      }
      if (!listingId && !/\/marketplace\/edit\//.test(page.url())) {
        await shot('no-card');
        const cands = await sellingCandidates(page, item.title || '').catch(() => []);
        const err = editFail('Cannot find listing on Your selling to edit (no permalink, title did not match a card)', listingId);
        err.candidates = cands;
        throw err;
      }
      if (listingId) log(`discovered listing id ${listingId}`);
    }

    const alreadyOnEdit = /\/marketplace\/edit\//.test(page.url());
    const editUrl = listingId
      ? `https://www.facebook.com/marketplace/edit/?listing_id=${listingId}`
      : page.url();

    if (!alreadyOnEdit) {
      log(`navigating to edit page: ${editUrl}`);
      await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } else {
      log('already on the edit form from Your selling');
    }
    await assertNoFriction(page, 'edit-load');
    await pause(1500, 3000);

    const fromUrl = String(page.url() || '').match(/listing_id=(\d+)/);
    if (fromUrl) await remember(fromUrl[1]);
    await assertNoFriction(page, 'edit-form-ready');

    // Title is often missing on the current first step (Price / Category /
    // Condition / Description / Next). Don't fail the whole edit over it.
    const titleEl = await labelled(page, 'Title', 'input[type=text]');
    if (titleEl) {
      log(`updating title to: "${item.title}"`);
      await clearAndTypeInto(page, titleEl, item.title);
      await pause();
    } else {
      log('no Title field on this step — skipping');
    }

    const priceEl = await labelled(page, 'Price', 'input[type=text]');
    if (priceEl) {
      log(`updating price to: $${item.price_ask}`);
      await clearAndTypeInto(page, priceEl, String(Math.round(Number(item.price_ask) || 0)));
      await pause();
    } else {
      throw editFail('Price field not found on edit form (Facebook changed the form)', listingId);
    }

    const descEl = await labelled(page, 'Description', 'textarea');
    if (descEl) {
      log(`updating description`);
      await clearAndTypeInto(page, descEl, cleanDescription(item.description));
      await pause();
    }

    await assertNoFriction(page, 'edit-form-filled');
    await shot('1-filled');

    let saveBtn = await roleButton(page, ['Update', 'Save', 'Publish']);
    for (let step = 0; step < 6 && !saveBtn; step++) {
      const next = await roleButton(page, ['Next']);
      if (!next) {
        const names = await visibleButtonNames(page);
        await shot(`stuck-step${step + 1}`);
        throw editFail(`neither Next nor Update on edit step ${step + 1}. Visible buttons: ${names.join(' | ')}`, listingId);
      }
      log(`edit wizard step ${step + 1}: Next`);
      await next.click();
      await pause(1800, 3000);
      await assertNoFriction(page, `edit-step-${step + 2}`);
      saveBtn = await roleButton(page, ['Update', 'Save', 'Publish']);
    }
    if (!saveBtn) {
      const names = await visibleButtonNames(page);
      await shot('stuck-save');
      throw editFail(`Save/Update button not found. Visible buttons: ${names.join(' | ')}`, listingId);
    }

    await shot('pre-save');
    await saveBtn.click();
    log('clicked update — waiting for confirmation');
    await pause(1500, 2800);

    // Confirm dialog if Facebook asks. Never click Update a second time on
    // the same form — only a [role=dialog] Confirm/Update/Done.
    if (/\/marketplace\/edit\//.test(page.url())) {
      const hasDialog = await page.evaluate(() => !!document.querySelector('[role=dialog]')).catch(() => false);
      if (hasDialog) {
        const dlg = await clickNamed(page, [
          { role: 'button', name: /^(update|save|publish|confirm|done)$/i, fallback: 'confirm' },
        ]);
        if (dlg) {
          log(`clicked confirm dialog (${dlg})`);
          await pause(1500, 2500);
        }
      }
    }

    await page.waitForFunction(
      () => !/\/marketplace\/edit\//.test(location.pathname),
      null,
      { timeout: 60000 },
    ).catch(() => {});
    await pause(2000, 3500);
    await assertNoFriction(page, 'post-save');

    if (/\/marketplace\/edit\//.test(page.url())) {
      await shot('save-stuck');
      throw editFail('still on the edit form after click — update not confirmed', listingId);
    }

    await shot('done');
    return {
      success: true,
      url: listingId ? `https://www.facebook.com/marketplace/item/${listingId}/` : null,
    };
  } catch (err) {
    if (listingId && !err.listingId) err.listingId = listingId;
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

const SOLD_REASON = /this item sold|^sold$|mark as sold|item sold/i;
const GONE_TEXT = /no longer available|isn'?t available|listing (was |has been )?deleted|this listing has been removed|content isn'?t available|this listing is no longer/i;

// Facebook menus/dialogs are position:fixed. offsetParent is null on those,
// which is why an early delete run saw Mark as sold + Share and never Delete
// listing. Rect size is the visibility test.

const menuitemByText = (page, text) => handleOrNull(page, (text) => {
  const want = String(text).toLowerCase();
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const els = [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=button]')];
  return els.find((b) => (b.innerText || '').trim().toLowerCase() === want
    && b.getAttribute('aria-disabled') !== 'true'
    && shown(b)) || null;
}, text);

const buttonMatching = (page, reSrc) => handleOrNull(page, (reSrc) => {
  const re = new RegExp(reSrc, 'i');
  const sold = /this item sold|^sold$|mark as sold|item sold/i;
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const els = [...document.querySelectorAll('[role=button],[role=menuitem],button')];
  return els.find((b) => {
    const t = (b.innerText || '').trim().split('\n')[0];
    const al = b.getAttribute('aria-label') || '';
    return (re.test(t) || re.test(al))
      && b.getAttribute('aria-disabled') !== 'true'
      && shown(b)
      && !sold.test(t)
      && !sold.test(al);
  }) || null;
}, reSrc);

async function clickNamed(page, specs) {
  for (const spec of specs) {
    const loc = spec.role
      ? page.getByRole(spec.role, { name: spec.name })
      : page.getByText(spec.name);
    const n = await loc.count().catch(() => 0);
    if (!n) continue;
    const first = loc.first();
    if (!(await first.isVisible().catch(() => false))) continue;
    const label = (await first.innerText().catch(() => '')).trim().split('\n')[0];
    if (label && SOLD_REASON.test(label)) continue;
    await first.click();
    return label || spec.fallback || 'control';
  }
  return null;
}

async function pickNonSoldDeleteReason(page, log) {
  const texts = await page.evaluate(() =>
    [...document.querySelectorAll('[role=radio],[role=option],label')]
      .map((el) => (el.innerText || '').trim().split('\n')[0])
      .filter((t) => t && t.length < 80)
  ).catch(() => []);
  const prefer = [
    /no longer want to sell/i,
    /listed this (item )?by accident/i,
    /changed my mind/i,
    /unavailable/i,
    /^other$/i,
  ];
  let choice = null;
  for (const re of prefer) {
    choice = texts.find((t) => re.test(t) && !SOLD_REASON.test(t));
    if (choice) break;
  }
  if (!choice) return false;
  const el = await handleOrNull(page, (want) => {
    const w = String(want).toLowerCase();
    return [...document.querySelectorAll('[role=radio],[role=option],label')]
      .find((x) => (x.innerText || '').trim().split('\n')[0].toLowerCase() === w) || null;
  }, choice);
  if (!el) return false;
  await el.click();
  log(`picked delete reason: ${choice}`);
  await pause(400, 900);
  return true;
}

async function confirmDeleteDialog(page, log) {
  await pickNonSoldDeleteReason(page, log);
  const clicked = await clickNamed(page, [
    { role: 'button', name: /^delete$/i, fallback: 'Delete' },
    { role: 'button', name: /^(confirm|done)$/i, fallback: 'Confirm' },
  ]);
  if (clicked) {
    log('clicked delete confirm');
    await pause(1500, 2800);
    return true;
  }
  let confirm = await buttonMatching(page, '^(delete|confirm|done)$');
  if (!confirm) return false;
  await confirm.click();
  log('clicked delete confirm');
  await pause(1500, 2800);
  return true;
}

async function clickDeleteListingControl(page, log) {
  // Playwright roles first — they see position:fixed menus. Never Mark as sold.
  const clicked = await clickNamed(page, [
    { role: 'menuitem', name: /^delete listing$/i, fallback: 'Delete listing' },
    { role: 'menuitem', name: /^delete$/i, fallback: 'Delete' },
    { role: 'button', name: /^delete listing$/i, fallback: 'Delete listing' },
    { name: /^delete listing$/i, fallback: 'Delete listing' },
  ]);
  if (clicked) {
    log(`clicked ${clicked}`);
    await pause(700, 1400);
    await confirmDeleteDialog(page, log);
    return true;
  }
  let del = await menuitemByText(page, 'Delete listing');
  if (!del) del = await buttonMatching(page, 'delete(\\s+this)?(\\s+listing)?$');
  if (!del) return false;
  await del.click();
  log('clicked Delete listing');
  await pause(700, 1400);
  await confirmDeleteDialog(page, log);
  return true;
}

async function openMoreMenu(page) {
  const more = await handleOrNull(page, () => {
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const buttons = [...document.querySelectorAll('[role=button],button')];
    return buttons.find((b) => {
      if (b.getAttribute('aria-disabled') === 'true' || !shown(b)) return false;
      const al = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.innerText || '').trim();
      return /^more|more options|options menu|see more|more actions/.test(al)
        || t === '...' || t === '…' || /^[·•.]{2,3}$/.test(t);
    }) || null;
  });
  if (!more) return false;
  await more.click();
  await pause(400, 900);
  return true;
}

async function listingLooksGone(page, listingId) {
  const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 8000)).catch(() => '');
  if (GONE_TEXT.test(txt)) return true;
  if (listingId && /\/marketplace\/you\/selling/.test(page.url())) {
    const still = await page.evaluate(
      (id) => !!document.querySelector(`a[href*="/marketplace/item/${id}"], a[href*="listing_id=${id}"]`),
      listingId,
    );
    if (!still) return true;
  }
  return false;
}

// Live cards: "Mark as sold". Sold cards: "Mark as available" / "Relist".
// Delete has to see both — a sold or already-gone listing used to look
// like a matcher miss.
const CARD_ACTION_RE_SRC = '^(mark as sold|mark as available|relist this item|relist)$';

// Chrome that Facebook renders inside every card. The title is the first line
// that is NOT one of these — reading line 0 blindly returns "Mark as sold",
// which is how every title match failed once.
const CARD_CHROME_RE_SRC = '^(mark as sold|mark as available|relist this item|relist|offer delivery|boost listing|boost|listed on marketplace|active|sold|pending|out of stock|share|edit listing|edit|insights|view insights|message|messages|renew|delete listing)$';

async function extractSellingCards(page) {
  return page.evaluate(({ actionSrc, chromeSrc }) => {
    const actionRe = new RegExp(actionSrc, 'i');
    const chromeRe = new RegExp(chromeSrc, 'i');
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    // A card line is "real" if it is not Facebook chrome, not a bare price, and
    // not the " · Listed on 18/08" byline.
    const realLines = (txt) => String(txt || '').split('\n')
      .map((l) => l.replace(/[   ]/g, ' ').trim())
      .filter((l) => l.length > 3
        && !chromeRe.test(l)
        && !/^\$[\d,.]+$/.test(l)
        && !/^[·•]?\s*listed on\b/i.test(l));

    const actionBtns = [...document.querySelectorAll('[role=button],button')]
      .filter((b) => shown(b) && actionRe.test((b.innerText || '').trim().split('\n')[0]));

    const cards = [];
    const seen = new Set();
    for (const action of actionBtns) {
      // Walk up to the first ancestor that is a whole card: it carries a price
      // AND a real (non-chrome) line. The old stop condition matched the button
      // row itself, because "Mark as sold" contains the word "sold".
      let node = action;
      let card = null;
      for (let i = 0; i < 16 && node; i++) {
        const txt = node.innerText || '';
        if (/\$\s?[\d,]/.test(txt) && txt.length > 60 && realLines(txt).length) {
          card = node;
          break;
        }
        node = node.parentElement;
      }
      if (!card) continue;

      // Every live card links to its own edit form; that listing_id is also the
      // public /marketplace/item/<id> permalink. Prefer the anchor, fall back
      // to any id in the card HTML.
      const a = card.querySelector('a[href*="listing_id="], a[href*="/marketplace/item/"]');
      const href = a ? (a.getAttribute('href') || '') : '';
      const html = card.innerHTML || '';
      const m = href.match(/listing_id=(\d+)/)
        || href.match(/\/marketplace\/item\/(\d+)/)
        || html.match(/listing_id=(\d+)/)
        || html.match(/\/marketplace\/item\/(\d+)/);
      const id = m ? (m[1] || '') : '';

      const text = card.innerText || '';
      const lines = realLines(text);
      const key = id || lines[0] || text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({ id, text, title: lines[0] || '' });
    }
    return cards;
  }, { actionSrc: CARD_ACTION_RE_SRC, chromeSrc: CARD_CHROME_RE_SRC });
}

/**
 * Resolve a listing id from Your listings by title alone. Used for permalink
 * capture right after a publish (Facebook does not always land on the listing page) and by the
 * backfill script. Read-only apart from typing in the listings search box.
 */
// Read-only accessor so a test script can prove the fixed card
// boundary against the live page without duplicating the selector logic.
export async function debugExtractSellingCards(page) {
  return extractSellingCards(page);
}

export async function findListingIdByTitle(page, title, log = () => {}) {
  if (!/\/marketplace\/you\/selling/.test(page.url())) {
    await page.goto('https://www.facebook.com/marketplace/you/selling', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pause(2500, 4000);
  }
  // Two different outcomes that must not be reported as the same thing:
  //   - no card scored high enough  -> we genuinely could not identify it
  //   - a card matched but has no id -> Facebook only renders the edit link on
  //     recent cards; older ones show "Renew Listing / Share" and carry no id
  //     anywhere in their DOM. The card-menu path still reaches those.
  let matchedNoId = null;
  const consider = (best) => {
    if (!best) return null;
    if (best.id) return String(best.id);
    matchedNoId = best.title || title;
    return null;
  };

  await filterSellingList(page, title, log);
  let id = consider(pickBestCard(await extractSellingCards(page), title));
  if (id) return id;

  await clearSellingSearch(page);
  await pause(800, 1400);
  for (let i = 0; i < 10; i++) {
    id = consider(pickBestCard(await extractSellingCards(page), title));
    if (id) return id;
    await page.mouse.wheel(0, 1100);
    await pause(600, 1000);
  }
  if (matchedNoId) log(`matched "${matchedNoId}" but Facebook renders no listing id on that card (older "Renew Listing" layout)`);
  return null;
}

async function typeSellingSearch(page, q) {
  const box = page.getByPlaceholder(/search your listings/i);
  if (await box.count().catch(() => 0)) {
    await box.first().click();
    await pause(180, 400);
    await page.keyboard.press('Control+a');
    await pause(80, 180);
    await page.keyboard.press('Backspace');
    await page.keyboard.type(q, { delay: rnd(35, 85) });
    await page.keyboard.press('Enter');
    return true;
  }
  const el = await handleOrNull(page, () => (
    document.querySelector('input[placeholder*="Search your listings" i]')
    || [...document.querySelectorAll('input[type=search],input[type=text]')]
      .find((i) => /search/i.test(i.getAttribute('placeholder') || i.getAttribute('aria-label') || ''))
    || null
  ));
  if (!el) return false;
  await clearAndTypeInto(page, el, q);
  await page.keyboard.press('Enter');
  return true;
}

async function clearSellingSearch(page) {
  const box = page.getByPlaceholder(/search your listings/i);
  if (!(await box.count().catch(() => 0))) return;
  await box.first().click();
  await pause(80, 180);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await pause(700, 1200);
}

async function filterSellingList(page, title, log, confirmed) {
  const queries = sellingSearchQueries(title);
  if (!queries.length) return { typed: false, matched: false };
  let typed = false;
  for (const q of queries) {
    const ok = await typeSellingSearch(page, q);
    if (!ok) {
      log('selling search box not found');
      return { typed: false, matched: false };
    }
    typed = true;
    log(`filtered Your listings by "${q}"`);
    await pause(1800, 2800);
    const cards = await extractSellingCards(page);
    if (pickBestCard(cards, title, confirmed)) return { typed: true, matched: true };
  }
  return { typed, matched: false };
}

async function setSellingStatusFilter(page, want, log) {
  const opened = await page.evaluate(() => {
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const buttons = [...document.querySelectorAll('[role=button],button')]
      .filter((b) => shown(b) && /^status$/i.test((b.innerText || '').trim().split('\n')[0]));
    if (!buttons.length) return false;
    buttons.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    buttons[0].click();
    return true;
  }).catch(() => false);
  if (!opened) {
    log('status filter not found');
    return false;
  }
  await pause(400, 800);
  const re = new RegExp(`^${want}( listings)?$`, 'i');
  const clicked = await clickNamed(page, [
    { role: 'menuitem', name: re, fallback: want },
    { role: 'option', name: re, fallback: want },
    { role: 'radio', name: re, fallback: want },
    { role: 'menuitemradio', name: re, fallback: want },
    { role: 'checkbox', name: re, fallback: want },
    { name: re, fallback: want },
  ]);
  if (clicked) {
    log(`status filter → ${clicked}`);
    await pause(900, 1600);
    return true;
  }
  log(`status filter option "${want}" not found`);
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

async function openSellingCardMenu(page, { listingId, title, confirmed }, log) {
  const extracted = await extractSellingCards(page);
  const byId = listingId ? extracted.find((c) => c.id && c.id === String(listingId)) : null;
  const best = byId || pickBestCard(extracted, title || '', confirmed);
  if (!best) {
    log(`card menu not opened (visible cards: ${extracted.length}${extracted.length ? `; ${extracted.map((c) => c.title).slice(0, 8).join(' | ')}` : ''})`);
    return { ok: false, found: extracted.length, titles: extracted.map((c) => c.title).slice(0, 8) };
  }

  const result = await page.evaluate(({ listingId, title, actionSrc }) => {
    const actionRe = new RegExp(actionSrc, 'i');
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
    const n = (s) => String(s || '')
      .replace(/[\u2010-\u2015]/g, '-')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const want = n(title).slice(0, 32);
    const wantId = listingId ? String(listingId) : '';

    const actionBtns = [...document.querySelectorAll('[role=button],button')]
      .filter((b) => shown(b) && actionRe.test((b.innerText || '').trim().split('\n')[0]));

    const cards = [];
    for (const action of actionBtns) {
      // Same card boundary as extractSellingCards: the button row alone
      // contains the word "sold" (from "Mark as sold"), so the old condition
      // stopped there and every title comparison ran against "Mark as sold".
      let node = action;
      let card = null;
      for (let i = 0; i < 16 && node; i++) {
        const txt = node.innerText || '';
        if (/\$\s?[\d,]/.test(txt) && txt.length > 60) {
          card = node;
          break;
        }
        node = node.parentElement;
      }
      if (card && !cards.includes(card)) cards.push(card);
    }

    const idFrom = (el) => {
      const a = el.querySelector('a[href*="/marketplace/item/"], a[href*="listing_id="]');
      const href = a ? (a.getAttribute('href') || '') : '';
      const html = el.innerHTML || '';
      const m = href.match(/\/marketplace\/item\/(\d+)/)
        || href.match(/listing_id=(\d+)/)
        || html.match(/\/marketplace\/item\/(\d+)/)
        || html.match(/listing_id=(\d+)/);
      return m ? m[1] : '';
    };

    let card = null;
    if (wantId) card = cards.find((c) => idFrom(c) === wantId) || null;
    if (!card && want) card = cards.find((c) => n(c.innerText).includes(want)) || null;
    if (!card) {
      return {
        ok: false,
        found: cards.length,
        titles: cards.map((c) => (c.innerText || '').split('\n')[0]).slice(0, 8),
      };
    }

    const skip = /mark as sold|mark as available|offer delivery|boost|renew|share|relist/i;
    const btns = [...card.querySelectorAll('[role=button],button')].filter(shown);
    let more = btns.find((b) => {
      const al = (b.getAttribute('aria-label') || '').toLowerCase();
      const t = (b.innerText || '').trim();
      return /^more|more options|options menu|see more|more actions/.test(al)
        || t === '...' || t === '…' || /^[·•.]{2,3}$/.test(t);
    });
    if (!more) {
      // Fallback: the "..." trigger is an icon button with no text. The card
      // title is ALSO a role=button, so "last leftover" could grab the title
      // and open the listing instead of its menu. Prefer textless buttons.
      const cardTitle = (card.innerText || '').split('\n')[0].trim();
      const leftovers = btns.filter((b) => {
        const t = (b.innerText || '').trim();
        const al = b.getAttribute('aria-label') || '';
        if (skip.test(t) || skip.test(al)) return false;
        return t !== cardTitle;
      });
      const iconOnly = leftovers.filter((b) => !(b.innerText || '').trim());
      more = iconOnly[iconOnly.length - 1] || leftovers[leftovers.length - 1] || null;
    }
    if (!more) {
      return { ok: false, found: cards.length, noMore: true, title: (card.innerText || '').split('\n')[0] };
    }

    more.click();
    return {
      ok: true,
      listingId: idFrom(card) || wantId || null,
      title: (card.innerText || '').split('\n')[0],
    };
  }, { listingId: best.id || listingId || null, title: best.title || title, actionSrc: CARD_ACTION_RE_SRC });

  if (result && result.ok) {
    log(`opened card menu${result.title ? ` for "${String(result.title).slice(0, 60)}"` : ''}`);
    await pause(500, 1100);
    return result;
  }
  if (result) {
    const extra = result.noMore ? '; no ... button' : '';
    const seen = result.titles && result.titles.length ? `; ${result.titles.join(' | ')}` : '';
    log(`card menu not opened (visible cards: ${result.found}${seen}${extra})`);
  }
  return result || { ok: false };
}

async function sellingCardPresent(page, { listingId, title, confirmed }) {
  const cards = await extractSellingCards(page);
  if (listingId && cards.some((c) => c.id === String(listingId))) return true;
  return !!pickBestCard(cards, title || '', confirmed);
}

// The few cards that plausibly are this item, best first — what a
// which_listing question puts on its buttons. Includes cards with no listing
// id: Facebook omits it on the older layout, and the exact title is enough to
// lock the match in for good.
export async function sellingCandidates(page, title, limit = 4) {
  const cards = await extractSellingCards(page);
  return cards
    .map((c) => ({ ...c, ...scoreTitleMatch(c.text || c.title || '', title || '') }))
    .filter((c) => c.hits > 0 && c.title)
    .sort((a, b) => b.ratio - a.ratio || b.hits - a.hits)
    .slice(0, limit)
    .map((c, i) => ({ key: `c${i}`, id: c.id || null, title: c.title, ratio: Number(c.ratio.toFixed(2)) }));
}

async function findSellingListingId(page, { title, confirmed }, log) {
  const cards = await extractSellingCards(page);
  const best = pickBestCard(cards, title || '', confirmed);
  if (best && best.id) {
    log(`found listing id ${best.id} on Your selling`);
    return best.id;
  }
  if (best) log('matched a Your selling card but it has no listing id');
  else log('no listing id on the matching Your selling card');
  return null;
}

/**
 * Delete one Marketplace listing. Never "Mark as sold". Facebook is not told
 * whether the item sold — the listing just disappears, and existing chats
 * show it is no longer listed.
 */
export async function deleteListing(ctx, item, opts = {}) {
  const { shotDir, log = () => {} } = opts;
  const page = await ctx.newPage();
  const shot = async (tag) => {
    if (!shotDir) return null;
    mkdirSync(shotDir, { recursive: true });
    const p = path.join(shotDir, `del-${item.slug}-${tag}.png`);
    await page.screenshot({ path: p, fullPage: false }).catch(() => {});
    return p;
  };

  const m = String(item.fb_listing_url || item.listing_url || '').match(/\/marketplace\/item\/(\d+)/);
  let listingId = m ? m[1] : null;
  const itemUrl = listingId ? `https://www.facebook.com/marketplace/item/${listingId}/` : null;
  const editUrl = listingId ? `https://www.facebook.com/marketplace/edit/?listing_id=${listingId}` : null;

  page.on('dialog', async (d) => {
    try {
      if (/delete/i.test(d.message()) && !SOLD_REASON.test(d.message())) await d.accept();
      else await d.dismiss();
    } catch { /* dialog already gone */ }
  });

  try {
    // Path 1 — listing page, then More → Delete listing.
    if (itemUrl) {
      log(`navigating to listing: ${itemUrl}`);
      await page.goto(itemUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await assertNoFriction(page, 'delete-item-load');
      await pause(1500, 3000);
      if (await listingLooksGone(page, listingId)) {
        log('listing already gone');
        await shot('already-gone');
        return { success: true, already: true };
      }
      if (await clickDeleteListingControl(page, log)) {
        await pause(1500, 2800);
        await assertNoFriction(page, 'delete-after-item');
        await shot('after-item');
        if (await listingLooksGone(page, listingId)) return { success: true };
      } else {
        await openMoreMenu(page);
        if (await clickDeleteListingControl(page, log)) {
          await pause(1500, 2800);
          await assertNoFriction(page, 'delete-after-more');
          await shot('after-more');
          if (await listingLooksGone(page, listingId)) return { success: true };
        }
      }
    }

    // Path 2 — edit form often has a Delete listing control.
    if (editUrl) {
      log(`trying edit page delete: ${editUrl}`);
      await page.goto(editUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await assertNoFriction(page, 'delete-edit-load');
      await pause(1200, 2200);
      if (await clickDeleteListingControl(page, log)) {
        await pause(1500, 2800);
        await assertNoFriction(page, 'delete-after-edit');
        await shot('after-edit');
        if (await listingLooksGone(page, listingId)) return { success: true };
      }
    }

    // Path 3 — Your selling. Almost every live row has no permalink (Facebook
    // lands on Your listings after Publish), so this is the real path. Search
    // the list, open THAT card's "..." (Delete listing lives there, next to
    // Mark as sold — we never click Mark as sold), then confirm.
    //
    // If search finds nothing, the listing is already gone (deleted in the FB
    // app) OR it is on the Sold filter. Other live cards on the unfiltered
    // page are NOT a reason to fail.
    log('trying Your selling');
    await page.goto('https://www.facebook.com/marketplace/you/selling', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await assertNoFriction(page, 'delete-selling-load');
    await pause(2000, 3500);

    const searchThisView = async (shotTag) => {
      const found = await filterSellingList(page, item.title, log, item.fb_card_title);
      await shot(shotTag);
      if (!found.matched) return { ...found, opened: { ok: false } };
      const opened = await openSellingCardMenu(page, { listingId, title: item.title || '', confirmed: item.fb_card_title }, log);
      return { ...found, opened };
    };

    let view = await searchThisView('search');
    if (!view.matched && view.typed) {
      if (await setSellingStatusFilter(page, 'Sold', log)) {
        view = await searchThisView('search-sold');
      }
      if (!view.matched && await setSellingStatusFilter(page, 'All', log)) {
        view = await searchThisView('search-all');
      }
    } else if (!view.typed) {
      let opened = await openSellingCardMenu(page, { listingId, title: item.title || '', confirmed: item.fb_card_title }, log);
      if (!opened.ok) {
        await clearSellingSearch(page);
        for (let i = 0; i < 6 && !opened.ok; i++) {
          await page.mouse.wheel(0, 900);
          await pause(400, 800);
          opened = await openSellingCardMenu(page, { listingId, title: item.title || '', confirmed: item.fb_card_title }, log);
        }
      }
      view = { typed: false, matched: opened.ok, opened };
    }

    if (view.opened && view.opened.ok) {
      if (view.opened.listingId && !listingId) listingId = String(view.opened.listingId);
      if (await clickDeleteListingControl(page, log)) {
        await pause(1500, 2800);
        await assertNoFriction(page, 'delete-after-selling');
        await shot('after-selling');
        if (await listingLooksGone(page, listingId)) return { success: true };
        await page.keyboard.press('Escape').catch(() => {});
        if (!(await sellingCardPresent(page, { listingId, title: item.title || '', confirmed: item.fb_card_title }))) {
          log('card gone from Your selling after delete click');
          return { success: true };
        }
      } else {
        log('card found but no Delete listing control on the menu');
        await shot('no-delete-control');
      }
    } else {
      log('listing not on Your selling (active or sold) — treating as already gone');
      await shot('already-gone-selling');
      return { success: true, already: true };
    }

    // If the selling card gave us an id, retry the item/edit URLs we skipped.
    if (listingId && !itemUrl) {
      const foundItem = `https://www.facebook.com/marketplace/item/${listingId}/`;
      const foundEdit = `https://www.facebook.com/marketplace/edit/?listing_id=${listingId}`;
      log(`retrying with discovered listing id ${listingId}`);
      await page.goto(foundItem, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pause(1200, 2200);
      if (await listingLooksGone(page, listingId)) return { success: true, already: true };
      await openMoreMenu(page);
      if (await clickDeleteListingControl(page, log)) {
        await pause(1500, 2800);
        if (await listingLooksGone(page, listingId)) return { success: true };
      }
      await page.goto(foundEdit, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pause(1200, 2200);
      if (await clickDeleteListingControl(page, log)) {
        await pause(1500, 2800);
        if (await listingLooksGone(page, listingId)) return { success: true };
      }
    }

    // Final truth: reload the item. Gone = success. Still live = fail.
    if (itemUrl) {
      await page.goto(itemUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await pause(1200, 2200);
      await shot('verify');
      if (await listingLooksGone(page, listingId)) return { success: true };
    } else if (await listingLooksGone(page, listingId)) {
      return { success: true };
    }

    if (!itemUrl && !listingId) {
      log('no permalink and delete did not confirm — treating as already down');
      await shot('already-gone-no-id');
      return { success: true, already: true };
    }

    const names = await visibleButtonNames(page);
    await shot('stuck');
    throw new Error(`Could not delete listing. Visible buttons: ${names.join(' | ')}`);
  } finally {
    await page.close().catch(() => {});
  }
}


// Meta's AI can answer buyer messages in your name, without you seeing them.
// Switching that on is a decision for the seller, not the agent, so the default
// is OFF. The switch is now driven to an explicit state rather
// than nudged in one direction, so "off" also means "turn it off if Facebook
// defaults it on".
async function setMetaAiReply(page, want, log) {
  try {
    const sw = await handleOrNull(page, (wantOn) => {
      const isReply = (t) => /meta ai|ai.{0,12}(reply|respond)|answer.{0,12}questions/i.test(t || '');
      const cands = [...document.querySelectorAll('[role=switch],[role=checkbox],input[type=checkbox]')];
      for (const c of cands) {
        const scope = c.closest('div[class]')?.parentElement?.innerText || '';
        if (isReply(c.getAttribute('aria-label')) || isReply(scope)) {
          const on = c.getAttribute('aria-checked') === 'true' || c.checked === true;
          return on === !!wantOn ? null : c;
        }
      }
      return null;
    }, !!want);
    if (sw) {
      await sw.click();
      log(`Meta AI auto-reply: ${want ? 'enabled' : 'disabled'}`);
      await pause(400, 900);
    } else {
      log(`Meta AI auto-reply: already ${want ? 'on' : 'off'}`);
    }
  } catch { /* never fail a listing over an optional toggle */ }
}
