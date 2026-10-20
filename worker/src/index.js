// Agent Sell Stuff -- a Facebook Marketplace selling copilot on Cloudflare Workers.
//
// You message photos to your own Telegram bot. This worker receives the
// Telegram webhook itself, stores photos in R2 and item state in D1, makes ONE
// Claude call to write the listing and price it, and sends you an approve card
// right back in Telegram. After you tap Approve, the desk-machine poster (see
// ../poster) claims the item over an authenticated endpoint and posts it to
// Facebook Marketplace in your own logged-in Chrome.
//
// This worker NEVER touches Facebook. Facebook has no listing API, so the
// browser part lives in the poster, on a machine you control.
//
// State machine:
//   draft -> researched -> pending_approval -> approved -> posting -> posted -> sold -> archived
//                                  `-> rejected                   `-> needs_attention (3 strikes)
//
// Routes:
//   POST /telegram/webhook      Telegram updates (secret-token header checked)
//   GET  /img/<key>?t=<token>   photo bytes for Telegram cards and the poster
//   GET  /health                liveness
//   everything else             Authorization: Bearer <ADMIN_KEY>

// 'posting' = claimed by the poster and mid-flight in a real
// browser. It exists so two pollers can never take the same item, and so a
// crashed run is visible (and reapable) instead of looking approved-but-idle.
// 'needs_attention' = the poster tried MAX_POST_ATTEMPTS times and hit the
// same wall each time. claimForPosting only ever selects status='approved', so
// parking an item here makes it structurally unreachable by the poster. That is
// the whole point: a deterministic failure (bad category, missing field) is not
// fixed by trying again, and retrying it is how an account gets flagged.
import {
  inboxReport, inboxClaim, inboxSent, inboxFailed, applyReplyDecision, replyFromTelegram, replyIdFromCard,
  applyMeetupDecision, meetupTick, inboxCommand, INBOX_HELP, useTimezone,
} from './inbox.js';

// Helpers the buyer-message lane (inbox.js) borrows. Function declarations are
// hoisted, so this object can sit above them.
const H = {
  json: (...a) => json(...a),
  esc: (s) => esc(s),
  tgSend: (...a) => tgSend(...a),
  parseJson: (s) => parseJson(s),
  logEvent: (...a) => logEvent(...a),
  anthropic: (env, { body }) => {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body,
    });
  },
  // inbox.js speaks in {text, decision} choices; a Telegram button carries the
  // decision string as its callback_data (always well under 64 bytes).
  sendHubCard: (env, item, heroKey, _summary, choices, _extId) => sendCard(
    env,
    item && item.id ? item : null,
    heroKey,
    `<b>${esc(item.title || '')}</b>

${esc(item.description || '')}`,
    choices.map((c) => ({ text: c.text, callback_data: c.decision })),
  ),
};

const STATUSES = ['draft', 'researched', 'pending_approval', 'approved', 'posting', 'posted', 'sold', 'rejected', 'archived', 'needs_attention'];
const EVENT_TYPES = ['intake', 'research', 'proposed', 'approved', 'rejected', 'posted', 'sold', 'archived', 'note'];

// Strikes before an item stops being retried. Three is enough to ride out a
// genuine transient (a slow page, a one-off DOM miss) and few enough that a
// permanent fault is caught inside ~15 minutes instead of running all night.
const MAX_POST_ATTEMPTS = 3;

// delete_queued / edit_queued: 0=none, 1=queued, 2=in-flight (claimed by the poster).

// Facebook Marketplace's own category labels, read off the live create-listing
// form (spellings vary by locale -- "Jewellery" vs "Jewelry"). The picker
// accepts nothing else, so the research prompt asks for one of these verbatim
// and the poster fuzzy-matches against the LIVE picker, falling back to a
// generic shelf.
const FB_CATEGORIES = [
  'Tools', 'Furniture', 'Household', 'Garden', 'Appliances', 'Video Games',
  'Books, films & music', 'Bags & luggage', "Women's clothing & shoes",
  "Men's clothing & shoes", 'Jewellery and accessories', 'Health & beauty',
  'Pet supplies', 'Baby & children', 'Toys and games', 'Electronics & computers',
  'Mobile phones', 'Bicycles', 'Arts & crafts', 'Sport and outdoors', 'Car parts',
  'Musical Instruments', 'Antiques and collectibles', 'Garage sale',
  'Miscellaneous', 'Vehicles',
];

function json(data, status = 200) {
  return Response.json(data, { status });
}

// Constant-time-ish compare so the shared secret is not leaked by timing.
function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function authed(request, env) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') && safeEq(h.slice(7), env.ADMIN_KEY);
}

async function getItem(env, slug) {
  return env.DB.prepare('SELECT * FROM items WHERE slug=?').bind(slug).first();
}

async function logEvent(env, itemId, type, payload = null) {
  await env.DB.prepare('INSERT INTO events (item_id, type, payload) VALUES (?,?,?)')
    .bind(itemId, EVENT_TYPES.includes(type) ? type : 'note', payload ? JSON.stringify(payload) : null).run();
}

async function setStatus(env, item, status, eventType, payload = null) {
  await env.DB.prepare("UPDATE items SET status=?, updated_at=datetime('now') WHERE id=?")
    .bind(status, item.id).run();
  await logEvent(env, item.id, eventType, payload);
}

// tgSend uses parse_mode HTML, so anything item-derived (titles come from a
// model reading photos) must be escaped or a stray & or < silently kills the
// whole message with a Telegram 400.
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function imgUrl(env, r2Key) {
  return `${String(env.WORKER_URL || '').replace(/\/$/, '')}/img/${r2Key}?t=${env.IMG_TOKEN}`;
}

// ---------------------------------------------------------------------------
// Telegram cards (direct Bot API -- no relay)
// ---------------------------------------------------------------------------
// A card is a photo with a caption and inline buttons. Button taps come back to
// /telegram/webhook as callback_query updates; callback_data is kept under
// Telegram's 64-byte limit:
//   ap:<itemId>            approve        rj:<itemId>          reject
//   pd:<itemId>:<price>    take the drop  pk:<itemId>          keep the price
//   dc:<decisionId>:<n>    answer a question (n = index into the stored choices)
// Every card's message_id is saved in `cards`, so replying to a card in Telegram
// tells us which item you mean.
async function sendCard(env, item, heroKey, text, buttons) {
  const caption = String(text).slice(0, 1000);
  const reply_markup = { inline_keyboard: buttons.map((b) => [b]) };
  let r = null;
  if (heroKey && env.WORKER_URL) {
    r = await tgApi(env, 'sendPhoto', {
      chat_id: env.TELEGRAM_CHAT_ID, photo: imgUrl(env, heroKey), caption, parse_mode: 'HTML', reply_markup,
    });
  }
  // No photo, or Telegram could not fetch it: fall back to a plain text card
  // rather than losing the question.
  if (!r || !r.ok) {
    r = await tgApi(env, 'sendMessage', {
      chat_id: env.TELEGRAM_CHAT_ID, text: caption, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup,
    });
  }
  if (!r || !r.ok) {
    return { ok: false, error: `telegram: ${String((r && r.description) || 'no response').slice(0, 160)}` };
  }
  const messageId = r.result && r.result.message_id;
  if (messageId && item && item.id) {
    await env.DB.prepare('INSERT OR REPLACE INTO cards (message_id, item_id) VALUES (?,?)').bind(String(messageId), item.id).run();
  }
  return { ok: true, message_id: messageId };
}

// ---------------------------------------------------------------------------
// Decision gate — every judgement call goes to Telegram as a question
// ---------------------------------------------------------------------------
// Every judgement call goes to Telegram as a question with buttons, instead of
// the agent deciding for itself.
//
// Anything the agent would otherwise decide raises one of these. The item is
// parked (awaiting_decision=1) so the poster skips it rather than retrying into
// the same unanswered fork, and it is released the moment you tap.
//
// Deliberately NOT gated:
//   * posting an approved item -- one approval is enough, no second tap
//   * post/edit/delete failures -- 3 strikes then a notification
// Those are notifications, not questions, and adding buttons to them would bury
// the cards that actually need you.

const DECISION_KINDS = ['nothing_sellable', 'which_listing', 'looks_gone', 'category', 'floor_block'];

async function askDecision(env, item, { kind, question, body, choices, payload }) {
  if (!DECISION_KINDS.includes(kind)) throw new Error(`unknown decision kind ${kind}`);
  const list = (choices || []).filter((c) => c && c.key && c.text).slice(0, 6);
  if (!list.length) throw new Error('a decision needs at least one choice');

  // One open question per item per kind. Re-asking the same thing every poll
  // would turn one fault into dozens of Telegram messages.
  if (item) {
    const open = await env.DB.prepare(
      "SELECT id FROM decisions WHERE item_id=? AND kind=? AND status='pending' LIMIT 1"
    ).bind(item.id, kind).first();
    if (open) return { ok: true, decision_id: open.id, already_open: true };
  }

  const row = await env.DB.prepare(
    'INSERT INTO decisions (item_id, kind, question, payload, choices) VALUES (?,?,?,?,?) RETURNING id'
  ).bind(
    item ? item.id : null,
    kind,
    question,
    payload ? JSON.stringify(payload) : null,
    JSON.stringify(list),
  ).first();

  if (item) {
    await env.DB.prepare("UPDATE items SET awaiting_decision=1, updated_at=datetime('now') WHERE id=?").bind(item.id).run();
    await logEvent(env, item.id, 'note', { decision_asked: { id: row.id, kind } });
  }

  const heroRow = item
    ? await env.DB.prepare('SELECT r2_key FROM photos WHERE item_id=? ORDER BY ord LIMIT 1').bind(item.id).first()
    : null;
  const card0 = await sendCard(
    env,
    item,
    heroRow ? heroRow.r2_key : null,
    `${esc(question)}${body ? `\n\n${esc(body)}` : ''}`,
    list.map((c, i) => ({ text: c.text, callback_data: `dc:${row.id}:${i}` })),
  );
  if (!card0.ok) {
    // A question you never saw must not silently park the item forever.
    await env.DB.prepare("UPDATE decisions SET status='superseded', answer='card-failed' WHERE id=?").bind(row.id).run();
    if (item) {
      await env.DB.prepare('UPDATE items SET awaiting_decision=0 WHERE id=?').bind(item.id).run();
      await logEvent(env, item.id, 'note', { decision_card_failed: { id: row.id, kind, error: card0.error || 'card failed' } });
    }
    return { ok: false, decision_id: row.id, error: card0.error || 'card failed' };
  }
  return { ok: true, decision_id: row.id };
}

// Answer handler. Every branch must clear awaiting_decision, or the item stays
// parked and the agent looks dead.
async function applyDecision(env, decisionId, key) {
  const d = await env.DB.prepare('SELECT * FROM decisions WHERE id=?').bind(decisionId).first();
  if (!d) return json({ ok: false, error: 'unknown decision' }, 404);
  if (d.status !== 'pending') return json({ ok: true, idempotent: true, status: d.status });

  const item = d.item_id ? await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(d.item_id).first() : null;
  let payload = {};
  try { payload = JSON.parse(d.payload || '{}'); } catch { payload = {}; }

  const finish = async (note, release = true) => {
    await env.DB.prepare("UPDATE decisions SET status='answered', answer=?, answered_at=datetime('now') WHERE id=?")
      .bind(key, decisionId).run();
    if (item && release) {
      await env.DB.prepare("UPDATE items SET awaiting_decision=0, updated_at=datetime('now') WHERE id=?").bind(item.id).run();
    }
    if (item) await logEvent(env, item.id, 'note', { decision_answered: { id: decisionId, kind: d.kind, answer: key } });
    if (note) await tgSend(env, note);
    return json({ ok: true, kind: d.kind, answer: key });
  };

  if (!item) return finish('⚠️ That question is no longer attached to an item.', false);

  switch (d.kind) {
    case 'nothing_sellable': {
      if (key === 'bin') {
        await setStatus(env, item, 'archived', 'archived', { reason: 'nothing-sellable', by: 'seller' });
        return finish(`🗑 Binned <b>${esc(item.slug)}</b>. Nothing was ever listed.`, false);
      }
      // 'keep' — park it as a draft so you can add notes and re-run research.
      await setStatus(env, item, 'draft', 'note', { kept_after_nothing_sellable: true });
      return finish(`📝 Kept <b>${esc(item.slug)}</b> as a draft. Send better photos with a note instead, or reply <code>redo</code> to price it again.`);
    }

    case 'which_listing': {
      if (key === 'none') {
        return finish(`👍 Left <b>${esc(item.title || item.slug)}</b> alone — I won't touch a listing I can't identify.`);
      }
      const picked = (payload.candidates || []).find((c) => String(c.key) === String(key));
      if (!picked) return finish('⚠️ That option is no longer available — nothing was changed.');
      // Two things get recorded, because Facebook only renders a listing id on
      // its newer cards. The id gives a permalink; the exact card title makes
      // the match unambiguous even on the older layout that has no id at all.
      const url = picked.id ? `https://www.facebook.com/marketplace/item/${picked.id}/` : null;
      if (url) {
        await env.DB.prepare("UPDATE items SET fb_listing_url=?, fb_card_title=?, updated_at=datetime('now') WHERE id=?")
          .bind(url, picked.title || null, item.id).run();
      } else {
        await env.DB.prepare("UPDATE items SET fb_card_title=?, updated_at=datetime('now') WHERE id=?")
          .bind(picked.title || null, item.id).run();
      }
      await logEvent(env, item.id, 'note', { which_listing: { url, card_title: picked.title || null }, via: 'seller-decision' });
      return finish(`🔗 Locked <b>${esc(item.title || item.slug)}</b> onto “${esc(picked.title || 'that listing')}”. Edits and Remove will use it from now on.`);
    }

    case 'looks_gone': {
      if (key === 'archive') {
        await env.DB.prepare('UPDATE items SET fb_listing_url=NULL, delete_queued=0 WHERE id=?').bind(item.id).run();
        await setStatus(env, item, 'archived', 'archived', { removed: true, confirmed_by: 'seller' });
        return finish(`✅ Archived <b>${esc(item.title || item.slug)}</b> — treating it as already down on Facebook.`, false);
      }
      await env.DB.prepare('UPDATE items SET delete_queued=0 WHERE id=?').bind(item.id).run();
      return finish(`👍 Left <b>${esc(item.title || item.slug)}</b> as live. I won't try to remove it again until you ask.`);
    }

    case 'category': {
      if (key === 'keep') {
        return finish(`👍 Leaving <b>${esc(item.title || item.slug)}</b> where it is.`);
      }
      const picked = (payload.options || []).find((o) => String(o.key) === String(key));
      if (!picked || !picked.category) return finish('⚠️ That shelf is no longer on offer — nothing was changed.');
      // Queue the live edit too. Recording the category without moving the
      // listing would leave this app and Facebook disagreeing, which is how
      // "it says it did it" turns into "it didn't do it".
      await env.DB.prepare("UPDATE items SET category=?, edit_queued=1, updated_at=datetime('now') WHERE id=?")
        .bind(picked.category, item.id).run();
      await logEvent(env, item.id, 'note', { category_chosen: picked.category, by: 'seller', edit_queued: true });
      return finish(`🏷 Moving <b>${esc(item.title || item.slug)}</b> to <b>${esc(picked.category)}</b> — the poster will update the listing.`);
    }

    case 'floor_block': {
      if (key === 'keep') {
        return finish(`👍 Holding <b>${esc(item.title || item.slug)}</b> at $${item.price_ask}.`);
      }
      if (key === 'stop') {
        await env.DB.prepare("UPDATE items SET price_floor=price_ask, updated_at=datetime('now') WHERE id=?").bind(item.id).run();
        await logEvent(env, item.id, 'note', { drops_stopped: { at: item.price_ask, by: 'seller' } });
        return finish(`🛑 No more drops on <b>${esc(item.title || item.slug)}</b> — its floor is now its asking price, and I won't raise it again.`);
      }
      // 'floor' — go to the floor exactly, and queue the live edit.
      const floor = Number(payload.floor);
      if (!Number.isFinite(floor) || floor <= 0) return finish('⚠️ That floor no longer looks right — nothing was changed.');
      await env.DB.prepare(
        "UPDATE items SET price_ask=?, edit_queued=1, updated_at=datetime('now') WHERE id=?"
      ).bind(floor, item.id).run();
      await logEvent(env, item.id, 'note', { price_drop_approved: { from: item.price_ask, to: floor, at_floor: true } });
      return finish(`✅ <b>${esc(item.title || item.slug)}</b> dropped to its floor, $${floor}. the poster will update the Facebook listing.`);
    }

    default:
      return finish('⚠️ I no longer know how to act on that question.');
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------
async function createItem(env, body) {
  const slug = String(body.slug || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return json({ ok: false, error: 'slug required (kebab-case)' }, 400);
  const dup = await getItem(env, slug);
  if (dup) return json({ ok: false, error: 'slug exists' }, 409);
  const row = await env.DB.prepare('INSERT INTO items (slug, notes) VALUES (?,?) RETURNING id, slug')
    .bind(slug, body.notes || null).first();
  await logEvent(env, row.id, 'intake', { notes: body.notes || null });
  return json({ ok: true, id: row.id, slug: row.slug });
}

async function uploadPhoto(env, request, item, url) {
  const ord = Math.max(0, parseInt(url.searchParams.get('ord') || '0', 10) || 0);
  const extRaw = String(url.searchParams.get('ext') || 'jpg').toLowerCase();
  const ext = ['jpg', 'jpeg', 'png', 'webp'].includes(extRaw) ? extRaw : 'jpg';
  const key = `items/${item.slug}/${ord}.${ext}`;
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return json({ ok: false, error: 'empty body' }, 400);
  await env.PHOTOS.put(key, bytes, {
    httpMetadata: { contentType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' },
  });
  await env.DB.prepare('DELETE FROM photos WHERE item_id=? AND ord=?').bind(item.id, ord).run();
  await env.DB.prepare('INSERT INTO photos (item_id, r2_key, ord) VALUES (?,?,?)').bind(item.id, key, ord).run();
  return json({ ok: true, r2_key: key, ord });
}

async function addComps(env, item, body) {
  const comps = Array.isArray(body.comps) ? body.comps : [];
  if (!comps.length) return json({ ok: false, error: 'comps array required' }, 400);
  for (const c of comps) {
    await env.DB.prepare('INSERT INTO comps (item_id, source, title, price, url, note) VALUES (?,?,?,?,?,?)')
      .bind(item.id, c.source || 'other', c.title || null, c.price != null ? Number(c.price) : null, c.url || null, c.note || null).run();
  }
  await logEvent(env, item.id, 'research', { comps: comps.length });
  return json({ ok: true, added: comps.length });
}

async function propose(env, item, body) {
  for (const f of ['title', 'description', 'price_ask']) {
    if (body[f] == null || body[f] === '') return json({ ok: false, error: `${f} required` }, 400);
  }

  // The model correctly returns $0 when the photos contain nothing sellable.
  // That must never become an approvable card — one mis-tap would publish
  // personal photos at $0 — but it was also being *decided* here: the item was
  // rejected outright and the message had no buttons. Binning something of his
  // is your call, so it is a question with two answers.
  if (Number(body.price_ask) <= 0) {
    await env.DB.prepare(
      "UPDATE items SET title=?, description=?, price_ask=0, updated_at=datetime('now') WHERE id=?"
    ).bind(body.title, body.description, item.id).run();
    await logEvent(env, item.id, 'note', { no_sellable_item: true, title: body.title });
    const asked = await askDecision(env, { ...item, title: body.title || item.slug }, {
      kind: 'nothing_sellable',
      question: "🤷 I can't see anything sellable in those photos — what do you want to do?",
      body: `${String(body.description || '').slice(0, 400)}\n\nThere is no Approve button here on purpose: nothing priced at $0 should ever go live.`,
      choices: [
        { key: 'keep', text: '📝 Keep it — I\'ll add notes/photos' },
        { key: 'bin', text: '🗑 Bin it' },
      ],
    });
    // If the question could not be delivered, fall back to the old behaviour
    // rather than leaving a $0 item drifting in the pipeline.
    if (!asked.ok) {
      await setStatus(env, item, 'rejected', 'rejected', { auto: 'no-sellable-item', card_failed: true });
      return json({ ok: true, status: 'rejected', reason: 'no-sellable-item', asked: false });
    }
    return json({ ok: true, status: 'awaiting_decision', reason: 'no-sellable-item', decision_id: asked.decision_id });
  }
  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  await env.DB.prepare(
    "UPDATE items SET title=?, description=?, category=?, condition=?, price_ask=?, price_floor=?,"
    + " pricing_reasoning=COALESCE(?, pricing_reasoning), price_confidence=COALESCE(?, price_confidence),"
    + " status='researched', updated_at=datetime('now') WHERE id=?"
  ).bind(body.title, body.description, body.category || null, body.condition || null,
    Number(body.price_ask), num(body.price_floor),
    body.pricing_reasoning || null, body.price_confidence || null, item.id).run();
  const fresh = await getItem(env, item.slug);

  const hero = await env.DB.prepare('SELECT r2_key FROM photos WHERE item_id=? ORDER BY ord LIMIT 1').bind(item.id).first();
  // Live sold comps and AI price estimates are counted separately so the card
  // never passes an AI guess off as scraped comps.
  const agg = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(price) AS lo, MAX(price) AS hi FROM comps WHERE item_id=? AND price IS NOT NULL AND source!='ai-estimate'").bind(item.id).first();

  const autoFb = String(env.AUTO_POST_FB || '').toLowerCase() === 'on';
  const lines = [`🏷 <b>${esc(fresh.title)}</b>`, ''];
  lines.push(esc(String(fresh.description || '').slice(0, 480)));
  lines.push('');
  lines.push(`📍 <b>$${fresh.price_ask}</b>${fresh.price_floor != null ? ` · floor $${fresh.price_floor}` : ''} — Facebook Marketplace${autoFb ? '' : ' (auto-poster is OFF)'}`);
  if (fresh.pricing_reasoning) lines.push(esc(fresh.pricing_reasoning));
  lines.push(agg.n
    ? `📊 ${agg.n} sold comps $${agg.lo}–$${agg.hi}`
    : `📊 AI-priced — no live sold comps, this is reading photos not sale data`);
  lines.push('');
  lines.push('Reply to this card with a number to change the price, or <code>why</code> to hear the reasoning.');

  const buttons = [
    { text: `✅ Approve — post at $${fresh.price_ask}`, callback_data: `ap:${item.id}` },
    { text: '❌ Reject', callback_data: `rj:${item.id}` },
  ];
  const card = await sendCard(env, fresh, hero ? hero.r2_key : null, lines.join('\n'), buttons);
  if (!card.ok) {
    // stays researched — retry with POST /items/<slug>/research
    await logEvent(env, item.id, 'note', { card_failed: card.error || null });
    return json({ ok: false, error: `could not send the Telegram card: ${card.error}`, status: 'researched' }, 502);
  }
  await setStatus(env, fresh, 'pending_approval', 'proposed', { price_ask: fresh.price_ask, message_id: card.message_id });
  return json({ ok: true, status: 'pending_approval', message_id: card.message_id });
}

// A button tap from Telegram. `data` is the callback_data string (see the card
// notes above). Returns { toast } -- the short text shown on the user's screen.
async function handleTap(env, ctx, data) {
  const parts = String(data || '').split(':');
  const kind = parts[0];

  // Buyer replies and pickups (inbox.js).
  if (kind === 'reply' || kind === 'meet') {
    const res = kind === 'reply'
      ? await applyReplyDecision(env, H, Number(parts[1]), parts[2])
      : await applyMeetupDecision(env, H, Number(parts[1]), parts[2], markSold);
    const j = await res.json().catch(() => ({}));
    const toast = { send: 'Sending', skip: 'Skipped', mute: 'Ignoring this buyer', sold: 'Logged as sold', noshow: 'Noted', cancel: 'Cancelled' }[parts[2]];
    return { toast: j.ok ? (j.idempotent ? 'Already handled' : toast || 'Done') : 'That card is no longer valid.' };
  }

  if (kind === 'dc') {
    const decisionId = Number(parts[1]);
    const idx = Number(parts[2]);
    const d = await env.DB.prepare('SELECT choices, status FROM decisions WHERE id=?').bind(decisionId).first();
    if (!d) return { toast: 'That question no longer exists.' };
    if (d.status !== 'pending') return { toast: 'Already answered.' };
    let choices = [];
    try { choices = JSON.parse(d.choices || '[]'); } catch { choices = []; }
    const picked = choices[idx];
    if (!picked) return { toast: 'That option is no longer available.' };
    await applyDecision(env, decisionId, picked.key);
    return { toast: 'Done' };
  }

  const item = await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(Number(parts[1])).first();
  if (!item) return { toast: 'Unknown item.' };

  if (kind === 'pd') {
    const approvedPrice = Number(parts[2]);
    if (!Number.isFinite(approvedPrice) || approvedPrice <= 0) return { toast: 'Bad price.' };
    if (item.status !== 'posted') return { toast: 'That listing is not live any more.' };
    const oldPrice = item.price_ask;
    await env.DB.prepare("UPDATE items SET price_ask=?, edit_queued=1, updated_at=datetime('now') WHERE id=?")
      .bind(approvedPrice, item.id).run();
    await logEvent(env, item.id, 'note', { price_drop_approved: { from: oldPrice, to: approvedPrice }, edit_queued: true });
    await tgSend(env, `✅ Price drop approved for <b>${esc(item.title || item.slug)}</b> to $${approvedPrice}.\n\nQueued — the poster will change the Facebook listing to $${approvedPrice}.`);
    return { toast: `Dropping to $${approvedPrice}` };
  }
  if (kind === 'pk') {
    await logEvent(env, item.id, 'note', { price_drop_rejected: { price: item.price_ask } });
    await tgSend(env, `👍 Keeping <b>${esc(item.title || item.slug)}</b> at $${item.price_ask}.`);
    return { toast: 'Price kept' };
  }

  if (kind !== 'ap' && kind !== 'rj') return { toast: 'Unknown button.' };
  const decision = kind === 'ap' ? 'approved' : 'rejected';
  if (item.status === decision) return { toast: 'Already done.' };
  if (item.status !== 'pending_approval') {
    // stale card tap (item already moved on) — acknowledge, change nothing
    await logEvent(env, item.id, 'note', { stale_decision: decision, at_status: item.status });
    return { toast: `That listing is already ${item.status}.` };
  }
  await setStatus(env, item, decision, decision, { via: 'telegram' });
  if (decision === 'approved') {
    const autoFb = String(env.AUTO_POST_FB || '').toLowerCase() === 'on';
    await tgSend(env, autoFb
      ? `✅ Approved: <b>${esc(item.title)}</b>. It's in the posting queue — the poster picks it up within a couple of minutes.`
      : `✅ Approved: <b>${esc(item.title)}</b>. But the auto-poster is switched OFF (AUTO_POST_FB), so it will wait until you turn it on.`);
    return { toast: 'Approved' };
  }
  await tgSend(env, `❌ Rejected: <b>${esc(item.title)}</b>. Send better photos, or reply <code>redo</code> to price it again.`);
  return { toast: 'Rejected' };
}

async function queue(env, url) {
  const status = url.searchParams.get('status') || 'approved';
  if (!STATUSES.includes(status)) return json({ ok: false, error: 'bad status' }, 400);

  let limit = null;
  if (status === 'approved') {
    const cap = parseInt(env.MAX_POSTS_PER_DAY, 10) || 20;
    const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE posted_at IS NOT NULL AND date(posted_at)=date('now')").first();
    if (today.n >= cap) return json({ ok: true, items: [], capped: true, posted_today: today.n });
    limit = cap - today.n;
  }
  const rows = await env.DB.prepare(`SELECT * FROM items WHERE status=? ORDER BY updated_at ${limit ? 'LIMIT ' + limit : ''}`)
    .bind(status).all();
  const items = [];
  for (const it of rows.results) {
    const photos = await env.DB.prepare('SELECT r2_key, ord FROM photos WHERE item_id=? ORDER BY ord').bind(it.id).all();
    const comps = await env.DB.prepare('SELECT source, title, price, url, note FROM comps WHERE item_id=? ORDER BY id').bind(it.id).all();
    items.push({ ...it, photos: photos.results.map((p) => ({ ...p, url: imgUrl(env, p.r2_key) })), comps: comps.results });
  }
  return json({ ok: true, items, capped: false });
}

// ---------------------------------------------------------------------------
// Auto-post lane -- the work queue for the desk-machine poster
//
// Facebook Marketplace has no listing API, so the ONLY way to post is a real
// logged-in browser. The poster polls /post-queue/claim, takes ONE approved
// item, drives your real Chrome via Playwright, then calls /items/<slug>/posted
// or /items/<slug>/post-failed.
//
// Claiming is a conditional UPDATE (WHERE status='approved'), so a race between
// two pollers is decided by the database, not by luck. A run that dies mid-post
// leaves the item in 'posting'; the reaper below releases it after 25 minutes so
// it never gets stranded -- and never gets double-posted by an impatient retry.
// ---------------------------------------------------------------------------
const POSTING_STALE_MIN = 25;

async function claimForPosting(env, body) {
  if (String(env.AUTO_POST_FB || '').toLowerCase() !== 'on') {
    return json({ ok: true, item: null, reason: 'auto-post-off' });
  }
  // Reaping a stuck 'posting' item is itself a retry, so it has to cost a
  // strike. A poster that dies mid-post never calls /post-failed, so without
  // this the reaper is a second unbounded loop that bypasses the counter
  // entirely — same outward pattern, different code path.
  await env.DB.prepare(
    "UPDATE items SET post_attempts = COALESCE(post_attempts,0) + 1, last_post_error='run died mid-post (reaped)', last_post_error_at=datetime('now') WHERE status='posting' AND updated_at < datetime('now', ?)"
  ).bind(`-${POSTING_STALE_MIN} minutes`).run();
  const buried = await env.DB.prepare(
    "UPDATE items SET status='needs_attention', updated_at=datetime('now') WHERE status='posting' AND updated_at < datetime('now', ?) AND post_attempts >= ?"
  ).bind(`-${POSTING_STALE_MIN} minutes`, MAX_POST_ATTEMPTS).run();
  const reaped = await env.DB.prepare(
    "UPDATE items SET status='approved', updated_at=datetime('now') WHERE status='posting' AND updated_at < datetime('now', ?)"
  ).bind(`-${POSTING_STALE_MIN} minutes`).run();
  if (buried.meta && buried.meta.changes) {
    await tgSend(env, `🚫 ${buried.meta.changes} listing(s) died mid-post ${MAX_POST_ATTEMPTS}× and are parked as needs_attention. Nothing was posted; I've stopped retrying them.`);
  }
  if (reaped.meta && reaped.meta.changes) {
    await tgSend(env, `♻️ Released ${reaped.meta.changes} listing(s) stuck mid-post for over ${POSTING_STALE_MIN} min — they're approved again and will be retried.`);
  }

  // Reap stuck edits: reset edit_queued back to 1
  const reapedEdits = await env.DB.prepare(
    "UPDATE items SET edit_queued=1, last_post_error='edit died mid-flight (reaped)', last_post_error_at=datetime('now') WHERE edit_queued=2 AND updated_at < datetime('now', ?)"
  ).bind(`-${POSTING_STALE_MIN} minutes`).run();
  if (reapedEdits.meta && reapedEdits.meta.changes) {
    await tgSend(env, `♻️ Released ${reapedEdits.meta.changes} listing(s) stuck mid-edit for over ${POSTING_STALE_MIN} min — queued again.`);
  }

  const reapedDeletes = await env.DB.prepare(
    "UPDATE items SET delete_queued=1, last_post_error='delete died mid-flight (reaped)', last_post_error_at=datetime('now') WHERE delete_queued=2 AND updated_at < datetime('now', ?)"
  ).bind(`-${POSTING_STALE_MIN} minutes`).run();
  if (reapedDeletes.meta && reapedDeletes.meta.changes) {
    await tgSend(env, `♻️ Released ${reapedDeletes.meta.changes} listing(s) stuck mid-remove for over ${POSTING_STALE_MIN} min — queued again.`);
  }

  // One at a time, oldest first. Never claim while another is mid-flight —
  // two Chrome windows racing the same account is exactly the pattern that
  // reads as automation to Meta.
  const busy = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE status='posting' OR edit_queued=2 OR delete_queued=2").first();
  if (busy.n) return json({ ok: true, item: null, reason: 'already-posting' });

  // 0. Removals first — you tapped Remove; take it down before anything else.
  // No listing URL required: the poster can match on title from Your selling.
  const delCand = await env.DB.prepare(
    "SELECT * FROM items WHERE delete_queued=1 AND COALESCE(awaiting_decision,0)=0 ORDER BY updated_at LIMIT 1"
  ).first();

  if (delCand) {
    const claim = await env.DB.prepare(
      "UPDATE items SET delete_queued=2, updated_at=datetime('now') WHERE id=? AND delete_queued=1"
    ).bind(delCand.id).run();
    if (!claim.meta.changes) return json({ ok: true, item: null, reason: 'raced' });
    await logEvent(env, delCand.id, 'note', { auto_delete: 'claimed', by: body.by || 'poster' });
    return json({
      ok: true,
      action: 'delete',
      item: { ...delCand, delete_queued: 2 },
    });
  }

  // 1. Check for queued edits (prioritize updating live listing prices/text).
  const editCand = await env.DB.prepare(
    "SELECT * FROM items WHERE edit_queued=1 AND COALESCE(awaiting_decision,0)=0 ORDER BY updated_at LIMIT 1"
  ).first();

  if (editCand) {
    const claim = await env.DB.prepare(
      "UPDATE items SET edit_queued=2, updated_at=datetime('now') WHERE id=? AND edit_queued=1"
    ).bind(editCand.id).run();
    if (!claim.meta.changes) return json({ ok: true, item: null, reason: 'raced' });
    await logEvent(env, editCand.id, 'note', { auto_edit: 'claimed', by: body.by || 'poster' });
    
    return json({
      ok: true,
      action: 'edit',
      item: { ...editCand, edit_queued: 2 },
    });
  }

  // 2. Otherwise, check for new posts (subject to daily cap)
  const cap = parseInt(env.MAX_POSTS_PER_DAY, 10) || 20;
  const today = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE posted_at IS NOT NULL AND date(posted_at)=date('now')").first();
  if (today.n >= cap) return json({ ok: true, item: null, reason: 'daily-cap', posted_today: today.n });

  // price_ask > 0 is a hard floor, not a formality: a $0 item means the model
  // found nothing sellable in the photos. propose() already refuses to card
  // those, but this is the last gate before a real browser publishes something,
  // so it does not take propose()'s word for it.
  const cand = await env.DB.prepare(
    "SELECT * FROM items WHERE status='approved' AND price_ask > 0 AND COALESCE(awaiting_decision,0)=0 ORDER BY updated_at LIMIT 1"
  ).first();
  if (!cand) return json({ ok: true, item: null, reason: 'empty' });

  const claim = await env.DB.prepare(
    "UPDATE items SET status='posting', updated_at=datetime('now') WHERE id=? AND status='approved'"
  ).bind(cand.id).run();
  if (!claim.meta.changes) return json({ ok: true, item: null, reason: 'raced' });
  await logEvent(env, cand.id, 'note', { auto_post: 'claimed', by: body.by || 'poster' });

  const photos = await env.DB.prepare('SELECT r2_key, ord FROM photos WHERE item_id=? ORDER BY ord').bind(cand.id).all();
  return json({
    ok: true,
    action: 'post',
    item: { ...cand, status: 'posting', photos: photos.results.map((p) => ({ ...p, url: imgUrl(env, p.r2_key) })) },
    posted_today: today.n,
    cap,
  });
}

// The poster calls this on ANY failure. A Facebook checkpoint, captcha, or
// identity prompt is never worked around — the run stops, the item is parked,
// and you are told plainly.
async function markPostFailed(env, item, body) {
  const reason = String(body.reason || 'unknown').slice(0, 400);
  const checkpoint = !!body.checkpoint;

  // Count the strike FIRST, and read it back, so the decision below is made on
  // the stored number rather than on whatever the caller believed.
  const row = await env.DB.prepare(
    "UPDATE items SET post_attempts = COALESCE(post_attempts,0) + 1, last_post_error=?, last_post_error_at=datetime('now') WHERE id=? RETURNING post_attempts"
  ).bind(reason, item.id).first();
  const attempts = (row && row.post_attempts) || 1;

  // A checkpoint always stops the lane dead on the first one — never retried,
  // never counted down. Strikes are for ordinary failures.
  if (checkpoint) {
    await setStatus(env, item, 'needs_attention', 'note', { auto_post_failed: reason, checkpoint: true, attempts });
    await tgSend(env, `🛑 Facebook showed a checkpoint while auto-posting <b>${esc(item.title)}</b>.\n\nI stopped immediately and touched nothing. The auto-poster has halted itself — clear the checkpoint in Chrome, then post this one by hand.\n<code>${esc(reason)}</code>`);
    return json({ ok: true, status: 'needs_attention', halt: true, attempts });
  }

  if (attempts >= MAX_POST_ATTEMPTS) {
    await setStatus(env, item, 'needs_attention', 'note', { auto_post_failed: reason, attempts, dead_lettered: true });
    await tgSend(env,
      `🚫 Gave up on <b>${esc(item.title)}</b> after ${attempts} attempts — same failure each time, so it's a real fault, not bad luck.\n\n`
      + `<code>${esc(reason)}</code>\n\n`
      + `I've stopped trying. It will NOT be retried, and nothing was posted. Tell me what to change (e.g. <code>category Electronics</code>) and I'll put it back in the queue, or say <code>retry</code> to just try again.`);
    return json({ ok: true, status: 'needs_attention', attempts, dead_lettered: true });
  }

  // Under the limit — genuinely worth one more go.
  await setStatus(env, item, 'approved', 'note', { auto_post_failed: reason, attempts });
  await tgSend(env, `⚠️ Auto-post failed for <b>${esc(item.title)}</b> — attempt ${attempts} of ${MAX_POST_ATTEMPTS}. I'll try again.\n<code>${esc(reason)}</code>`);
  return json({ ok: true, status: 'approved', attempts });
}

async function markLink(env, item, body) {
  const raw = String(body.fb_listing_url || body.url || '').trim();
  const m = raw.match(/facebook\.com\/marketplace\/item\/(\d+)/);
  if (!m) return json({ ok: false, error: 'need a facebook.com/marketplace/item/<id> URL' }, 400);
  const url = `https://www.facebook.com/marketplace/item/${m[1]}/`;
  await env.DB.prepare(
    "UPDATE items SET fb_listing_url=?, updated_at=datetime('now') WHERE id=?"
  ).bind(url, item.id).run();
  await logEvent(env, item.id, 'note', { fb_listing_url: url, via: body.via || 'manual' });
  return json({ ok: true, fb_listing_url: url });
}

async function markPosted(env, item, body) {
  // A manual report always has the URL. The auto lane sometimes publishes fine
  // but can't scrape the permalink (Facebook doesn't always route to it) —
  // allow_no_url lets a verified publish record itself rather than being
  // reported as a failure and retried into a duplicate listing.
  if (!body.fb_listing_url && !body.allow_no_url) return json({ ok: false, error: 'fb_listing_url required' }, 400);
  // Clear the strikes — the item made it. Leaving a stale count behind would
  // make a future unrelated failure inherit it and dead-letter early.
  await env.DB.prepare("UPDATE items SET fb_listing_url=?, posted_at=datetime('now'), post_attempts=0, last_post_error=NULL WHERE id=?")
    .bind(body.fb_listing_url || null, item.id).run();
  await setStatus(env, item, 'posted', 'posted', { url: body.fb_listing_url || null, via: body.via || 'manual' });
  if (body.via === 'auto') {
    await tgSend(env, `✅ Live on Facebook Marketplace: <b>${esc(item.title)}</b> — $${item.price_ask}${body.fb_listing_url ? `\n${body.fb_listing_url}` : '\n(posted — permalink not captured; it\'s in Your Listings)'}`);
  }
  return json({ ok: true, status: 'posted' });
}

async function handleRemoveItem(env, item) {
  if (item.status === 'archived') {
    return json({ ok: true, status: 'archived', already: true });
  }
  if (item.status === 'posting') {
    return json({ ok: false, error: 'still going up — wait until it is live, then remove' }, 409);
  }

  const liveOnFb = item.status === 'posted' || item.status === 'sold' || !!item.fb_listing_url;

  if (liveOnFb) {
    if (item.delete_queued === 1 || item.delete_queued === 2) {
      return json({ ok: true, queued: true, status: item.status, already: true });
    }
    // Delete wins over a pending edit. Facebook is never told this sold.
    await env.DB.prepare(
      "UPDATE items SET delete_queued=1, edit_queued=0, updated_at=datetime('now') WHERE id=?"
    ).bind(item.id).run();
    await logEvent(env, item.id, 'note', { remove_queued: true, via: 'admin' });
    return json({ ok: true, queued: true, status: item.status });
  }

  // Never posted — just take it out of the queue. Nothing to tell Facebook.
  await env.DB.prepare("UPDATE items SET delete_queued=0, edit_queued=0 WHERE id=?").bind(item.id).run();
  await setStatus(env, item, 'archived', 'archived', { removed: true, never_posted: true });
  return json({ ok: true, queued: false, status: 'archived' });
}

async function markRemoved(env, item, body) {
  await env.DB.prepare(
    "UPDATE items SET delete_queued=0, edit_queued=0, post_attempts=0, last_post_error=NULL, fb_listing_url=NULL, updated_at=datetime('now') WHERE id=?"
  ).bind(item.id).run();
  await setStatus(env, item, 'archived', 'archived', { removed: true, via: body.via || 'auto', fb_told_sold: false });
  await tgSend(env, `🗑️ Taken down on Facebook: <b>${esc(item.title)}</b>\nNo sold/unsold reason was sent. Buyers who messaged will see it is no longer listed.`);
  return json({ ok: true, status: 'archived' });
}

async function markRemoveFailed(env, item, body) {
  const reason = String(body.reason || 'unknown').slice(0, 400);
  const checkpoint = !!body.checkpoint;

  await env.DB.prepare(
    "UPDATE items SET last_post_error=?, last_post_error_at=datetime('now') WHERE id=?"
  ).bind(reason, item.id).run();

  // The poster stopped to ask you a question rather than failing. Release the
  // lock but do NOT count a strike — three unanswered questions is not an item
  // that failed three times, and dead-lettering it would bury the question.
  if (body.asked) {
    await env.DB.prepare("UPDATE items SET delete_queued=0 WHERE id=?").bind(item.id).run();
    await logEvent(env, item.id, 'note', { paused_for_decision: reason });
    return json({ ok: true, asked: true });
  }

  if (checkpoint) {
    await env.DB.prepare("UPDATE items SET delete_queued=0 WHERE id=?").bind(item.id).run();
    await logEvent(env, item.id, 'note', { auto_delete_failed: reason, checkpoint: true });
    await tgSend(env, `🛑 Facebook showed a checkpoint while removing <b>${esc(item.title)}</b>.\n\nThe auto-poster has halted itself. Delete it by hand in Chrome if you still want it gone.\n<code>${esc(reason)}</code>`);
    return json({ ok: true, halt: true });
  }

  const row = await env.DB.prepare(
    "UPDATE items SET post_attempts = COALESCE(post_attempts,0) + 1 WHERE id=? RETURNING post_attempts"
  ).bind(item.id).first();
  const attempts = (row && row.post_attempts) || 1;

  if (attempts >= MAX_POST_ATTEMPTS) {
    await env.DB.prepare("UPDATE items SET delete_queued=0, post_attempts=0 WHERE id=?").bind(item.id).run();
    await logEvent(env, item.id, 'note', { auto_delete_failed: reason, attempts, dead_lettered: true });
    await tgSend(env, `🚫 Gave up removing <b>${esc(item.title)}</b> after ${attempts} attempts:\n<code>${esc(reason)}</code>\n\nDelete it by hand on Facebook.`);
    return json({ ok: true, dead_lettered: true });
  }

  await env.DB.prepare("UPDATE items SET delete_queued=1 WHERE id=?").bind(item.id).run();
  await logEvent(env, item.id, 'note', { auto_delete_failed: reason, attempts });
  return json({ ok: true, attempts });
}

async function handleEditItem(env, item, body) {
  const { title, description, price_ask } = body;
  if (!title || !description || price_ask == null) {
    return json({ ok: false, error: 'title, description, price_ask required' }, 400);
  }

  const newPrice = Number(price_ask);
  if (Number.isNaN(newPrice) || newPrice <= 0) {
    return json({ ok: false, error: 'invalid price' }, 400);
  }

  await env.DB.prepare(
    "UPDATE items SET title=?, description=?, price_ask=?, updated_at=datetime('now') WHERE id=?"
  ).bind(title, description, newPrice, item.id).run();

  await logEvent(env, item.id, 'note', {
    manual_edit: {
      from: { title: item.title, description: item.description, price_ask: item.price_ask },
      to: { title, description, price_ask: newPrice }
    }
  });

  if (item.status === 'posted') {
    await env.DB.prepare("UPDATE items SET edit_queued=1 WHERE id=?").bind(item.id).run();
    await logEvent(env, item.id, 'note', { edit_queued: { price: newPrice } });
  }

  return json({ ok: true, status: item.status });
}

async function markEdited(env, item, body) {
  await env.DB.prepare("UPDATE items SET edit_queued=0, post_attempts=0, last_post_error=NULL WHERE id=?")
    .bind(item.id).run();
  await logEvent(env, item.id, 'note', { auto_edit: 'success', via: 'auto' });
  await tgSend(env, `✅ Live update successful on Facebook: <b>${esc(item.title)}</b> is now listing at $${item.price_ask}`);
  return json({ ok: true, status: 'posted' });
}

async function markEditFailed(env, item, body) {
  const reason = String(body.reason || 'unknown').slice(0, 400);
  const checkpoint = !!body.checkpoint;

  await env.DB.prepare(
    "UPDATE items SET last_post_error=?, last_post_error_at=datetime('now') WHERE id=?"
  ).bind(reason, item.id).run();

  // The poster stopped to ask you a question rather than failing. Release the
  // lock but do NOT count a strike — three unanswered questions is not an item
  // that failed three times, and dead-lettering it would bury the question.
  if (body.asked) {
    await env.DB.prepare("UPDATE items SET edit_queued=0 WHERE id=?").bind(item.id).run();
    await logEvent(env, item.id, 'note', { paused_for_decision: reason });
    return json({ ok: true, asked: true });
  }

  if (checkpoint) {
    await env.DB.prepare("UPDATE items SET edit_queued=0 WHERE id=?").bind(item.id).run();
    await logEvent(env, item.id, 'note', { auto_edit_failed: reason, checkpoint: true });
    await tgSend(env, `🛑 Facebook showed a checkpoint while auto-updating <b>${esc(item.title)}</b>.\n\nThe auto-poster has halted itself. Please check Facebook in Chrome and edit it manually.\n<code>${esc(reason)}</code>`);
    return json({ ok: true, halt: true });
  }

  const row = await env.DB.prepare(
    "UPDATE items SET post_attempts = COALESCE(post_attempts,0) + 1 WHERE id=? RETURNING post_attempts"
  ).bind(item.id).first();
  const attempts = (row && row.post_attempts) || 1;

  if (attempts >= MAX_POST_ATTEMPTS) {
    await env.DB.prepare("UPDATE items SET edit_queued=0, post_attempts=0 WHERE id=?").bind(item.id).run();
    await logEvent(env, item.id, 'note', { auto_edit_failed: reason, attempts, dead_lettered: true });
    await tgSend(env, `🚫 Gave up auto-updating <b>${esc(item.title)}</b> after ${attempts} attempts:\n<code>${esc(reason)}</code>\n\nPlease update it manually.`);
    return json({ ok: true, dead_lettered: true });
  }

  await env.DB.prepare("UPDATE items SET edit_queued=1 WHERE id=?").bind(item.id).run();
  await logEvent(env, item.id, 'note', { auto_edit_failed: reason, attempts });
  return json({ ok: true, attempts });
}

async function markSold(env, item, body) {
  if (body.sold_price == null) return json({ ok: false, error: 'sold_price required' }, 400);
  const days = item.posted_at
    ? await env.DB.prepare("SELECT CAST(julianday('now') - julianday(?) AS INTEGER) AS d").bind(item.posted_at).first()
    : { d: null };
  await env.DB.prepare("INSERT OR REPLACE INTO ledger (item_id, sold_price, sold_at, days_listed, buyer_note) VALUES (?,?,datetime('now'),?,?)")
    .bind(item.id, Number(body.sold_price), days.d, body.buyer_note || null).run();
  await env.DB.prepare("UPDATE items SET sold_at=datetime('now') WHERE id=?").bind(item.id).run();
  await setStatus(env, item, 'sold', 'sold', { sold_price: Number(body.sold_price), days_listed: days.d });
  return json({ ok: true, status: 'sold', days_listed: days.d });
}

async function overrideStatus(env, item, body) {
  const status = String(body.status || '');
  if (!STATUSES.includes(status)) return json({ ok: false, error: `status must be one of ${STATUSES.join('|')}` }, 400);
  await setStatus(env, item, status, status, { manual: true, note: body.note || null });
  return json({ ok: true, status });
}

// Test fixtures live in the same tables as real stock. One predicate, used by
// /stats and /inventory, so they can never disagree about what counts as a sale.
const NOT_A_FIXTURE = `
  slug NOT LIKE 'smoke-%'
  AND slug NOT LIKE '%fixture%'
  AND COALESCE(title,'') NOT LIKE 'Smoke %'
  AND COALESCE(title,'') NOT LIKE '%DRY-RUN%'
  AND COALESCE(notes,'') NOT LIKE '%FIXTURE%'
`;

async function stats(env) {
  const live = await env.DB.prepare(
    "SELECT slug, title, price_ask, fb_listing_url AS url, CAST(julianday('now') - julianday(posted_at) AS INTEGER) AS days_live FROM items WHERE status='posted' ORDER BY posted_at"
  ).all();
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE status='pending_approval'").first();
  const approved = await env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE status='approved'").first();
  // Derive days-to-sell from the dates and fall back to the stored column.
  const led = await env.DB.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(l.sold_price),0) AS revenue,'
    + " AVG(COALESCE(NULLIF(l.days_listed,0), julianday(i.sold_at) - julianday(i.posted_at))) AS avg_days"
    + ` FROM ledger l JOIN items i ON i.id = l.item_id WHERE ${NOT_A_FIXTURE}`
  ).first();
  return json({
    ok: true,
    live: live.results,
    pending: pending.n,
    approved: approved.n,
    sold: led.n,
    revenue: led.revenue,
    avg_days_to_sell: led.avg_days != null ? Math.round(led.avg_days * 10) / 10 : null,
  });
}

// One shot of every active listing + real solds, with photos, so a dashboard
// (or backfill-permalinks.mjs) needs one call instead of N+1.
async function inventory(env) {
  const rows = await env.DB.prepare(`
    SELECT * FROM items
    WHERE (
         status IN ('draft','researched','pending_approval','approved','posting','posted','sold','rejected','needs_attention')
         OR (status='archived' AND sold_at IS NOT NULL AND slug NOT LIKE 'smoke-%' AND title NOT LIKE 'Smoke %')
       )
       AND slug NOT LIKE '%fixture%'
       AND slug NOT LIKE 'smoke-%'
       AND COALESCE(title,'') NOT LIKE '%DRY-RUN%'
       AND COALESCE(notes,'') NOT LIKE '%FIXTURE%'
    ORDER BY
      CASE status
        WHEN 'needs_attention' THEN 0
        WHEN 'posting' THEN 1
        WHEN 'pending_approval' THEN 2
        WHEN 'approved' THEN 3
        WHEN 'posted' THEN 4
        WHEN 'sold' THEN 5
        WHEN 'rejected' THEN 6
        ELSE 7
      END,
      COALESCE(posted_at, updated_at) DESC
    LIMIT 120
  `).all();

  const items = [];
  let askOnFloor = 0;
  let liveN = 0;
  let pipelineN = 0;
  for (const it of (rows.results || [])) {
    const photos = await env.DB.prepare('SELECT r2_key, ord FROM photos WHERE item_id=? ORDER BY ord').bind(it.id).all();
    const photoList = (photos.results || []).map((p) => ({
      ord: p.ord,
      key: p.r2_key,
      url: imgUrl(env, p.r2_key),
    }));
    let daysLive = null;
    if (it.posted_at) {
      const d = await env.DB.prepare("SELECT CAST(julianday('now') - julianday(?) AS INTEGER) AS d").bind(it.posted_at).first();
      daysLive = d?.d ?? null;
    }
    let soldPrice = null;
    if (it.status === 'sold' || it.sold_at) {
      const led = await env.DB.prepare('SELECT sold_price, days_listed, buyer_note FROM ledger WHERE item_id=?').bind(it.id).first();
      if (led) soldPrice = led.sold_price;
    }
    const url = it.fb_listing_url || null;
    if (it.status === 'posted') {
      liveN += 1;
      askOnFloor += Number(it.price_ask) || 0;
    }
    if (['draft', 'researched', 'pending_approval', 'approved', 'posting', 'needs_attention'].includes(it.status)) {
      pipelineN += 1;
    }
    items.push({
      id: it.id,
      slug: it.slug,
      title: it.title || it.slug,
      description: it.description || null,
      category: it.category || null,
      condition: it.condition || null,
      notes: it.notes || null,
      status: it.status,
      price_ask: it.price_ask,
      price_floor: it.price_floor,
      url,
      posted_at: it.posted_at || null,
      sold_at: it.sold_at || null,
      sold_price: soldPrice,
      days_live: daysLive,
      post_attempts: it.post_attempts || 0,
      last_post_error: it.last_post_error || null,
      edit_queued: it.edit_queued || 0,
      delete_queued: it.delete_queued || 0,
      created_at: it.created_at,
      updated_at: it.updated_at,
      hero: photoList[0]?.url || null,
      photos: photoList,
      photos_n: photoList.length,
    });
  }

  const led = await env.DB.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(l.sold_price),0) AS revenue,'
    + " AVG(COALESCE(NULLIF(l.days_listed,0), julianday(i.sold_at) - julianday(i.posted_at))) AS avg_days"
    + ` FROM ledger l JOIN items i ON i.id = l.item_id WHERE ${NOT_A_FIXTURE}`
  ).first();

  return json({
    ok: true,
    asof: new Date().toISOString(),
    counts: {
      live: liveN,
      pipeline: pipelineN,
      sold: led?.n || 0,
      total: items.length,
      ask_on_floor: askOnFloor,
      revenue: led?.revenue || 0,
      avg_days_to_sell: led?.avg_days != null ? Math.round(led.avg_days * 10) / 10 : null,
    },
    items,
    fb_selling: 'https://www.facebook.com/marketplace/you/selling',
  });
}

async function serveImg(env, r2Key, url) {
  if (!safeEq(url.searchParams.get('t'), env.IMG_TOKEN)) return json({ ok: false }, 404);
  const obj = await env.PHOTOS.get(r2Key);
  if (!obj) return json({ ok: false }, 404);
  return new Response(obj.body, {
    headers: {
      'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg',
      'cache-control': 'private, max-age=3600',
    },
  });
}

// ---------------------------------------------------------------------------
// Telegram: photo intake, text commands, webhook
//
// Telegram posts every message you send your bot to /telegram/webhook. One
// Telegram media group (multi-select -> one send) = one listing: the photos
// arrive as separate updates sharing a media_group_id, we buffer them, and once
// the burst goes quiet we download -> store -> run Claude vision -> send the
// approval card. Zero taps until the finished card.
// ---------------------------------------------------------------------------
async function tgApi(env, method, params) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params),
  }).catch(() => null);
  return r ? r.json().catch(() => null) : null;
}

function tgSend(env, text, extra = {}) {
  return tgApi(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

async function tgDownloadPhoto(env, fileId) {
  const info = await tgApi(env, 'getFile', { file_id: fileId });
  if (!info || !info.ok) return null;
  const fpath = info.result.file_path;
  const r = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fpath}`).catch(() => null);
  if (!r || !r.ok) return null;
  const ext = (fpath.split('.').pop() || 'jpg').toLowerCase();
  return { bytes: await r.arrayBuffer(), ext: ['jpg', 'jpeg', 'png', 'webp'].includes(ext) ? ext : 'jpg' };
}

function slugFrom(caption) {
  const base = String(caption || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'item';
  return `${base}-${crypto.randomUUID().slice(0, 4)}`;
}

function b64(arrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function parseJson(s) {
  if (!s) return null;
  let t = String(s).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Text commands -- "250", "floor 100", "status", "why", "retry", "redo"
//
// An approval card is a sent message, not a form, so rather than making the card
// editable, plain text to your bot acts on the item it's about: reply to a card
// to target that item, or just text a price and it hits the item most recently
// in play. Deliberately forgiving about format -- this gets typed one-handed.
// ---------------------------------------------------------------------------

// Every card we send is recorded in `cards` (message_id -> item), so a reply to
// a card identifies its item.
async function resolveTargetItem(env, msg) {
  const r = msg.reply_to_message;
  if (r && r.message_id) {
    const row = await env.DB.prepare(
      'SELECT i.* FROM cards c JOIN items i ON i.id = c.item_id WHERE c.message_id = ?'
    ).bind(String(r.message_id)).first();
    if (row) return row;
  }
  // No reply: the item most recently in play. Anything already sold or
  // rejected is done being priced. needs_attention IS in play -- it's the one
  // waiting on you, and `retry` exists specifically to revive it.
  return env.DB.prepare(
    "SELECT * FROM items WHERE status IN ('pending_approval','approved','posting','posted','needs_attention') ORDER BY updated_at DESC LIMIT 1"
  ).first();
}

const HELP = '📸 Send photos of one item (select them all, one send) and I\'ll price it and send back a ready-to-approve listing.\n\nOr text me:\n• <code>250</code> or <code>$250</code> — set the asking price\n• <code>floor 100</code> — set your walk-away price\n• <code>250/100</code> — both at once\n• <code>why</code> — how I landed on that price (free, instant)\n• <code>status</code> — what\'s live and what\'s waiting\n• <code>retry</code> — put a given-up listing back in the queue\n• <code>redo</code> — run the research again on the latest item\n• <code>category Tools</code> — change the category\n• <code>sold 40</code> — log a sale\n• <code>remove</code> — (as a reply to a card) take the listing down\n\n<b>Or just talk to me.</b> "why so cheap?", "are you sure?", "why did only some post?" — I can see the whole queue, so I can tell you what\'s stuck and why. I only change the price if you tell me to.\n\nReply to a listing card to target that one; otherwise I use the most recent.';

// "why this price" — answered from what we already stored, so it costs nothing
// and returns instantly. The reasoning used to be truncated into the end of the
// buyer-facing description and thrown away; now it lives on the item.
function explainPrice(item, comps) {
  const lines = [`💲 <b>${esc(item.title || item.slug)}</b> — asking $${item.price_ask}${item.price_floor != null ? `, floor $${item.price_floor}` : ''}`];
  lines.push('');
  lines.push(item.pricing_reasoning ? `${esc(item.pricing_reasoning)}` : 'No stored reasoning for this one — it was priced before I started keeping it, or the price was set by hand.');
  if (item.price_confidence) {
    lines.push('');
    lines.push(item.price_confidence === 'high'
      ? '✅ I was confident on this one.'
      : `⚠️ ${esc(item.price_confidence)} confidence — worth a sanity check.`);
  }
  const real = comps.filter((c) => c.source !== 'ai-estimate' && c.price != null);
  if (real.length) {
    const lo = Math.min(...real.map((c) => c.price));
    const hi = Math.max(...real.map((c) => c.price));
    lines.push('');
    lines.push(`📊 Based on ${real.length} real sold comp${real.length > 1 ? 's' : ''}: $${lo}–$${hi}`);
  } else {
    lines.push('');
    lines.push('📊 <b>No real sold comps</b> — this is the AI reading the photos, not scraped sale prices. Treat it as a starting point.');
  }
  lines.push('');
  lines.push('Ask me anything about it, or send a number to change it.');
  return lines.join('\n');
}

// Why did nothing happen to this item? Answered from state, not guessed. The
// silent-forever cases are the ones worth naming explicitly.
function whyStalled(it, autoFb) {
  if (it.status === 'posted') return 'LIVE on Facebook Marketplace';
  if (it.status === 'sold') return 'sold';
  if (it.status === 'rejected') return 'you rejected it';
  if (it.status === 'pending_approval') return 'waiting for you to tap Approve';
  if (it.status === 'needs_attention') return `GAVE UP after ${it.post_attempts} tries — ${String(it.last_post_error || 'unknown').slice(0, 80)}`;
  if (it.status === 'posting') return 'being posted right now';
  if (it.status === 'approved') {
    return autoFb
      ? 'approved, waiting its turn in the posting queue'
      : 'approved but the Facebook auto-poster is switched off (AUTO_POST_FB), so it waits until you turn it on';
  }
  return it.status;
}

// Free-text conversation about the item in play (pricingChat below) reads only
// what we already hold -- no photos, so a text turn is a fraction of the cost of
// re-running research -- and can propose a new price, but only APPLIES one when
// you actually instructed a change. A pricing agent that quietly rewrites the
// number every time you question it is worse than useless.

// One direct call to the Anthropic Messages API. Returns the text of the reply.
// ANTHROPIC_API_KEY is a worker secret; MODEL (a plain var) picks the model.
async function callClaude(env, { system, content, max_tokens = 2048 }) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set (wrangler secret put ANTHROPIC_API_KEY)');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.MODEL || 'claude-sonnet-5-5',
      max_tokens,
      ...(system ? { system } : {}),
      messages: [{ role: 'user', content }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (j.stop_reason === 'refusal') throw new Error('model declined to answer');
  return {
    text: (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(''),
    stop: j.stop_reason,
  };
}

async function pricingChat(env, item, question, comps, queue) {
  const real = comps.filter((c) => c.source !== 'ai-estimate' && c.price != null);
  const context = [
    `Item: ${item.title || item.slug}`,
    `Condition: ${item.condition || 'unknown'} · Category: ${item.category || 'unset'}`,
    `Status: ${item.status}`,
    `Current asking price: $${item.price_ask}`,
    `Current floor (walk-away): ${item.price_floor != null ? `$${item.price_floor}` : 'not set'}`,
    item.pricing_reasoning ? `How the price was originally set: ${item.pricing_reasoning}` : 'No stored pricing reasoning.',
    item.price_confidence ? `Original confidence: ${item.price_confidence}` : '',
    real.length
      ? `Real sold comps: ${real.map((c) => `$${c.price}${c.title ? ` (${c.title})` : ''}`).join(', ')}`
      : 'NO real sold comps exist — the price came from reading photos, not from scraped sales.',
    item.description ? `Listing description: ${item.description.slice(0, 600)}` : '',
    item.notes ? `Seller notes: ${item.notes}` : '',
    '',
    // Without this, a question about the QUEUE ("why did only some post?") gets
    // answered as if it were about whichever item happened to be newest.
    'Everything else currently in play, newest first:',
    ...(queue || []).map((q) => `- ${q.title || q.slug} ($${q.price_ask}) — ${q.why}`),
  ].filter((l) => l !== null && l !== undefined).join('\n');

  const system = `You are Agent Sell Stuff, the pricing and listing assistant for a person's resale business, talking to the seller over Telegram.

Answer their question directly and briefly — two or three sentences, plain text, no markdown headers or bullet lists. Telegram, not a report.

IMPORTANT — work out what they are actually asking about before you answer. You are given one item in focus AND the rest of the current queue. If the question is about the queue as a whole ("why did only some post?", "what's stuck?", "did they all go up?") then answer about the QUEUE using the list, and name the specific items and the specific reasons. Do not answer a queue question as if it were about the item in focus. If the question is clearly about the item in focus, answer about that.

Never say something failed when the stated reason is that it is waiting on setup or on a human tap, and never say something is fine when the stated reason is that it can never post. Use the reasons you were given verbatim in meaning — do not invent a cause.

Be honest about the basis for a price. If there are no real sold comps, say so plainly rather than implying market data exists. If they push back on a price, actually reconsider it — do not just defend the original number, and do not just cave either. If they are right, say so.

Only set "apply" to true when they have clearly INSTRUCTED a price change ("make it 45", "drop it to 40", "set the floor at 20"). A question — "is that too high?", "why so cheap?", "would 60 work?" — is NOT an instruction: answer it, suggest a number in "proposed_ask" if you have one, but leave apply false and let them decide.

Return ONLY a JSON object, no prose and no code fences, exactly in this shape:
{"reply": "your answer, 2-3 sentences, plain text", "proposed_ask": integer or null, "proposed_floor": integer or null, "apply": true or false}`;

  const { text } = await callClaude(env, {
    system,
    content: `${context}\n\n---\nThe seller asks: ${question}`,
    max_tokens: 1024,
  });
  const p = parseJson(text);
  if (!p || !p.reply) throw new Error(`unparseable chat reply: ${text.slice(0, 200)}`);
  return p;
}

async function tgText(env, msg) {
  const raw = String(msg.text || '').trim();
  if (!raw) return json({ ok: true, ignored: 'empty' });
  const low = raw.toLowerCase().replace(/^\//, '');

  if (low === 'help' || low === 'start') { await tgSend(env, HELP + INBOX_HELP); return json({ ok: true, cmd: 'help' }); }

  // A reply to a buyer card is the message you want sent -- check this before
  // anything else, or "250" typed as a reply would reprice an item instead.
  const replyId = replyIdFromCard(msg);
  if (replyId) return replyFromTelegram(env, H, replyId, raw);

  const inboxRes = await inboxCommand(env, H, low, raw);
  if (inboxRes) return inboxRes;

  if (low === 'status') {
    const rows = await env.DB.prepare(
      "SELECT slug, title, price_ask, status, post_attempts, last_post_error FROM items WHERE status IN ('pending_approval','approved','posting','posted','needs_attention') ORDER BY updated_at DESC LIMIT 8"
    ).all();
    const led = await env.DB.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(sold_price),0) AS rev FROM ledger').first();
    const autoFb = String(env.AUTO_POST_FB || '').toLowerCase() === 'on';
    const lines = rows.results.map((r) => {
      const flag = r.status === 'posted' ? '✅' : r.status === 'needs_attention' ? '🚫' : '•';
      return `${flag} ${esc(r.title || r.slug)} — $${r.price_ask ?? '—'}\n   ↳ ${esc(whyStalled(r, autoFb))}`;
    });
    const stuck = rows.results.filter((r) => r.status === 'needs_attention').length;
    const tail = [];
    if (stuck) tail.push(`🚫 ${stuck} gave up — fix and send <code>retry</code>.`);
    await tgSend(env, `${lines.join('\n') || 'Nothing in play.'}\n\nSold: ${led.n} · $${led.rev}${tail.length ? `\n\n${tail.join('\n')}` : ''}`);
    return json({ ok: true, cmd: 'status' });
  }

  // Price forms: "250", "$250", "price 250", "ask $250", "250/100", "floor 100"
  const both = low.match(/^\$?(\d{1,6})\s*\/\s*\$?(\d{1,6})$/);
  const floorOnly = low.match(/^floor\s*\$?(\d{1,6})$/);
  const askOnly = low.match(/^(?:price|ask)?\s*\$?(\d{1,6})$/);
  const catCmd = raw.match(/^category\s+(.{2,60})$/i);
  let ask = null;
  let floor = null;
  if (both) { ask = Number(both[1]); floor = Number(both[2]); }
  else if (floorOnly) { floor = Number(floorOnly[1]); }
  else if (askOnly) { ask = Number(askOnly[1]); }

  // Everything below needs an item, including the conversational lane.
  const target = await resolveTargetItem(env, msg);

  if (low === 'why' || low === 'why?' || low === 'why this price') {
    if (!target) { await tgSend(env, 'Nothing in play — send me photos of something first.'); return json({ ok: true, cmd: 'no-target' }); }
    const comps = await env.DB.prepare('SELECT source, title, price FROM comps WHERE item_id=?').bind(target.id).all();
    await tgSend(env, explainPrice(target, comps.results || []));
    return json({ ok: true, cmd: 'why', slug: target.slug });
  }

  // Run the research again (e.g. after a failed Claude call, or a rejected card).
  if (low === 'redo') {
    const it = target && ['draft', 'researched', 'rejected', 'pending_approval'].includes(target.status)
      ? target
      : await env.DB.prepare("SELECT * FROM items WHERE status IN ('draft','researched','rejected','pending_approval') ORDER BY updated_at DESC LIMIT 1").first();
    if (!it) { await tgSend(env, 'Nothing to redo — send me photos of something first.'); return json({ ok: true, cmd: 'no-target' }); }
    await tgSend(env, `🔄 Researching <b>${esc(it.title || it.slug)}</b> again…`);
    try { await researchAndPropose(env, it); }
    catch (e) { await tgSend(env, `⚠️ Couldn't research it: <code>${esc(String((e && e.message) || e).slice(0, 200))}</code>`); }
    return json({ ok: true, cmd: 'redo', slug: it.slug });
  }

  // Revive a dead-lettered listing: clear the strikes and put it back in the
  // queue. Without this, needs_attention is a one-way door — the poster can
  // never claim the item again, by design.
  if (low === 'retry') {
    if (!target) { await tgSend(env, 'Nothing to retry.'); return json({ ok: true, cmd: 'no-target' }); }
    if (target.status !== 'needs_attention') {
      await tgSend(env, `<b>${esc(target.title || target.slug)}</b> is <code>${target.status}</code>, not stuck — nothing to retry.`);
      return json({ ok: true, cmd: 'retry', noop: true });
    }
    await env.DB.prepare("UPDATE items SET post_attempts=0, status='approved', updated_at=datetime('now') WHERE id=?").bind(target.id).run();
    await logEvent(env, target.id, 'note', { retry: 'manual', via: 'telegram', was: target.last_post_error });
    await tgSend(env, `♻️ Back in the queue: <b>${esc(target.title || target.slug)}</b>\nStrikes cleared. It gets ${MAX_POST_ATTEMPTS} more attempts before I stop again.\n\nLast failure was:\n<code>${esc(String(target.last_post_error || 'unknown'))}</code>`);
    return json({ ok: true, cmd: 'retry', slug: target.slug });
  }

  // "sold 40" -- log a sale for the item in play (or the card you replied to).
  const soldCmd = low.match(/^sold\s+\$?(\d{1,6})$/);
  if (soldCmd) {
    if (!target) { await tgSend(env, 'Nothing in play — reply to a listing card and say <code>sold 40</code>.'); return json({ ok: true, cmd: 'no-target' }); }
    await markSold(env, target, { sold_price: Number(soldCmd[1]) });
    await tgSend(env, `💰 Logged: <b>${esc(target.title || target.slug)}</b> sold for $${soldCmd[1]}.\n\nThe Facebook listing is still up — reply <code>remove</code> to this card and I'll take it down.`);
    return json({ ok: true, cmd: 'sold', slug: target.slug });
  }

  // "remove" takes a listing down on Facebook. It is a delete, never "mark as
  // sold". Only fires on a reply to a card, so it can't hit the wrong item.
  if (low === 'remove') {
    if (!msg.reply_to_message || !target) { await tgSend(env, 'Reply to the listing card you want removed, and say <code>remove</code>.'); return json({ ok: true, cmd: 'no-target' }); }
    const res = await handleRemoveItem(env, target);
    const out = await res.json().catch(() => ({}));
    await tgSend(env, out.queued
      ? `🗑 Queued: the poster will delete <b>${esc(target.title || target.slug)}</b> from Facebook within a few minutes.`
      : out.ok ? `🗑 <b>${esc(target.title || target.slug)}</b> archived. It was never posted, so nothing to take down.` : `⚠️ ${esc(out.error || 'could not remove it')}`);
    return json({ ok: true, cmd: 'remove', slug: target.slug });
  }

  if (catCmd) {
    if (!target) { await tgSend(env, 'Nothing in play — send me photos of something first.'); return json({ ok: true, cmd: 'no-target' }); }
    const cat = catCmd[1].trim();
    await env.DB.prepare("UPDATE items SET category=?, updated_at=datetime('now') WHERE id=?").bind(cat, target.id).run();
    await logEvent(env, target.id, 'note', { category_edit: { from: target.category, to: cat }, via: 'telegram' });
    await tgSend(env, `🏷️ Category for <b>${esc(target.title || target.slug)}</b> is now <code>${esc(cat)}</code>.\n\nThis is a hint, not a hard setting — at post time I match it against the categories Facebook is actually showing and fall back to a generic one if nothing fits.${target.status === 'needs_attention' ? '\n\nSend <code>retry</code> to put it back in the queue.' : ''}`);
    return json({ ok: true, cmd: 'category', slug: target.slug, category: cat });
  }

  // Not a command and not a number → talk about it, rather than dumping HELP.
  if (ask == null && floor == null) {
    if (!target) { await tgSend(env, HELP); return json({ ok: true, cmd: 'help-no-target' }); }
    const comps = await env.DB.prepare('SELECT source, title, price FROM comps WHERE item_id=?').bind(target.id).all();
    // Hand the model the whole live queue with a plain reason per item, so a
    // question about "why only some posted" is answerable.
    const autoFb = String(env.AUTO_POST_FB || '').toLowerCase() === 'on';
    const q = await env.DB.prepare(
      "SELECT slug,title,price_ask,status,post_attempts,last_post_error FROM items WHERE status IN ('pending_approval','approved','posting','posted','needs_attention') ORDER BY updated_at DESC LIMIT 8"
    ).all();
    const queue = (q.results || []).map((it) => ({ ...it, why: whyStalled(it, autoFb) }));
    let p;
    try {
      p = await pricingChat(env, target, raw, comps.results || [], queue);
    } catch (e) {
      await tgSend(env, `⚠️ Couldn't think that through — ${esc(String((e && e.message) || e).slice(0, 200))}\n\nThe price is unchanged. Send a number to set it directly.`);
      return json({ ok: false, cmd: 'chat', error: String((e && e.message) || e) }, 502);
    }

    const out = [`💬 <b>${esc(target.title || target.slug)}</b> — $${target.price_ask}`, '', esc(p.reply)];

    if (p.apply && (p.proposed_ask != null || p.proposed_floor != null)) {
      const nAsk = p.proposed_ask != null ? Number(p.proposed_ask) : target.price_ask;
      const nFloor = p.proposed_floor != null ? Number(p.proposed_floor) : target.price_floor;
      await env.DB.prepare("UPDATE items SET price_ask=?, price_floor=?, updated_at=datetime('now') WHERE id=?").bind(nAsk, nFloor, target.id).run();
      await logEvent(env, target.id, 'note', { price_edit: { from: { ask: target.price_ask, floor: target.price_floor }, to: { ask: nAsk, floor: nFloor } }, via: 'telegram-chat' });
      out.push('', `✅ Changed it: asking $${nAsk}${nFloor != null ? ` · floor $${nFloor}` : ''}`);
    } else if (p.proposed_ask != null && Number(p.proposed_ask) !== target.price_ask) {
      // A suggestion, not a change. Say plainly that nothing moved.
      out.push('', `💡 I'd suggest $${Number(p.proposed_ask)}${p.proposed_floor != null ? ` (floor $${Number(p.proposed_floor)})` : ''} — <b>not changed</b>. Send <code>${Number(p.proposed_ask)}</code> if you want it.`);
    }

    await tgSend(env, out.join('\n'));
    return json({ ok: true, cmd: 'chat', slug: target.slug, applied: !!p.apply });
  }

  const item = target;
  if (!item) { await tgSend(env, 'Nothing to price right now — send me photos of something first.'); return json({ ok: true, cmd: 'no-target' }); }

  const nextAsk = ask != null ? ask : item.price_ask;
  const nextFloor = floor != null ? floor : item.price_floor;
  await env.DB.prepare("UPDATE items SET price_ask=?, price_floor=?, updated_at=datetime('now') WHERE id=?")
    .bind(nextAsk, nextFloor, item.id).run();
  await logEvent(env, item.id, 'note', { price_edit: { from: { ask: item.price_ask, floor: item.price_floor }, to: { ask: nextAsk, floor: nextFloor } }, via: 'telegram' });

  // Be straight about what the number actually changes. A live listing keeps
  // its old price on Facebook until the poster edits it, so queue that edit.
  if (item.status === 'posted' && ask != null && ask !== item.price_ask) {
    await env.DB.prepare("UPDATE items SET edit_queued=1 WHERE id=?").bind(item.id).run();
    await logEvent(env, item.id, 'note', { edit_queued: { price: nextAsk } });
  }
  const tail = item.status === 'posted'
    ? (ask != null && ask !== item.price_ask
      ? `\n\nThis one is live — queued. The poster will change the Facebook listing to $${nextAsk} within a few minutes.`
      : `\n\nThis one is live; only the walk-away floor changed, so Facebook needs no edit.`)
    : item.status === 'posting'
      ? `\n\n⏳ It's being posted right now, so this price may not make it onto this listing.`
      : item.status === 'pending_approval'
        ? `\n\nThe card above still shows the old number — Approve still works, it'll use $${nextAsk}.`
        : '';

  await tgSend(env, `💲 <b>${esc(item.title || item.slug)}</b>\nAsking $${nextAsk}${nextFloor != null ? ` · floor $${nextFloor}` : ''}${tail}`);
  return json({ ok: true, cmd: 'price', slug: item.slug, ask: nextAsk, floor: nextFloor });
}

async function tgIngest(env, ctx, msg) {
  if (!msg) return json({ ok: true, ignored: 'empty' });
  const chatId = String(msg.chat && msg.chat.id);
  // The webhook already refused every chat except TELEGRAM_CHAT_ID; this is
  // belt and braces for the one place that writes to D1 and R2 on a stranger's
  // say-so.
  if (String(env.TELEGRAM_CHAT_ID || '') !== chatId) {
    return json({ ok: true, ignored: 'foreign chat' });
  }
  if (!Array.isArray(msg.photo) || !msg.photo.length) {
    if (msg.text) return tgText(env, msg);
    return json({ ok: true, ignored: 'no photo' });
  }
  const groupKey = msg.media_group_id ? `mg:${msg.media_group_id}` : `single:${msg.message_id}`;
  const caption = String(msg.caption || '').trim();
  const best = msg.photo[msg.photo.length - 1]; // Telegram sizes ascending → last = largest

  // Claim group creation atomically; the winner also creates the item.
  const slug = slugFrom(caption);
  const claimed = await env.DB.prepare(
    'INSERT INTO intake_buffer (group_key, chat_id, caption, slug) VALUES (?,?,?,?) ON CONFLICT(group_key) DO NOTHING RETURNING group_key'
  ).bind(groupKey, chatId, caption || null, slug).first();
  if (claimed) {
    const itemRow = await env.DB.prepare("INSERT INTO items (slug, notes, status) VALUES (?,?,'draft') RETURNING id").bind(slug, caption || null).first();
    await logEvent(env, itemRow.id, 'intake', { via: 'telegram', group: groupKey, caption: caption || null });
    await env.DB.prepare('UPDATE intake_buffer SET item_id=? WHERE group_key=?').bind(itemRow.id, groupKey).run();
    ctx.waitUntil(tgSend(env, '📸 Got it — pulling your photos and researching. Your listing card lands here in a moment.'));
  }
  // Resolve the buffer/item (the creator may still be mid-flight for a sibling photo).
  let buf = await env.DB.prepare('SELECT * FROM intake_buffer WHERE group_key=?').bind(groupKey).first();
  for (let i = 0; i < 15 && (!buf || !buf.item_id); i++) {
    await new Promise((r) => setTimeout(r, 200));
    buf = await env.DB.prepare('SELECT * FROM intake_buffer WHERE group_key=?').bind(groupKey).first();
  }
  if (!buf || !buf.item_id) return json({ ok: false, error: 'buffer not ready' }, 500);

  const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM photos WHERE item_id=?').bind(buf.item_id).first();
  const ord = cnt.n || 0;
  const dl = await tgDownloadPhoto(env, best.file_id);
  if (dl) {
    const key = `items/${buf.slug}/${ord}.${dl.ext}`;
    await env.PHOTOS.put(key, dl.bytes, { httpMetadata: { contentType: dl.ext === 'png' ? 'image/png' : dl.ext === 'webp' ? 'image/webp' : 'image/jpeg' } });
    await env.DB.prepare('INSERT INTO photos (item_id, r2_key, ord) VALUES (?,?,?)').bind(buf.item_id, key, ord).run();
  }
  await env.DB.prepare("UPDATE intake_buffer SET n_photos=n_photos+1, last_at=datetime('now'), caption=COALESCE(NULLIF(caption,''), ?) WHERE group_key=?")
    .bind(caption || null, groupKey).run();

  ctx.waitUntil(finalizeBurst(env, groupKey));
  return json({ ok: true, group: groupKey, ord });
}

// Fires ~6s after each photo; the last one standing (5s of quiet) wins the claim
// and runs research once for the whole burst.
async function finalizeBurst(env, groupKey) {
  await new Promise((r) => setTimeout(r, 6000));
  const quiet = await env.DB.prepare("SELECT item_id, finalized, (julianday('now') - julianday(last_at))*86400 AS secs FROM intake_buffer WHERE group_key=?").bind(groupKey).first();
  if (!quiet || quiet.finalized || quiet.secs < 5) return;
  const claim = await env.DB.prepare('UPDATE intake_buffer SET finalized=1 WHERE group_key=? AND finalized=0').bind(groupKey).run();
  if (!claim.meta || claim.meta.changes === 0) return; // another timer already took it
  const item = await env.DB.prepare('SELECT * FROM items WHERE id=?').bind(quiet.item_id).first();
  if (!item) return;
  try {
    await researchAndPropose(env, item);
  } catch (e) {
    await logEvent(env, item.id, 'note', { research_error: String((e && e.message) || e) });
    await tgSend(env, `⚠️ Couldn't research <b>${esc(item.slug)}</b> — photos are saved. Reply <code>redo</code> to try again.\n<code>${esc(String((e && e.message) || e).slice(0, 200))}</code>`);
  }
}

// Claude vision -> listing copy + price -> the approval card via propose().
async function researchAndPropose(env, item) {
  const photos = await env.DB.prepare('SELECT r2_key FROM photos WHERE item_id=? ORDER BY ord LIMIT 6').bind(item.id).all();
  const images = [];
  for (const p of photos.results) {
    const obj = await env.PHOTOS.get(p.r2_key);
    if (!obj) continue;
    images.push({ type: 'image', source: { type: 'base64', media_type: (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg', data: b64(await obj.arrayBuffer()) } });
  }
  if (!images.length) throw new Error('no photos to research');
  const notes = item.notes ? `\n\nSeller notes (use them — they may state condition, flaws, or a floor price): ${item.notes}` : '';

  const prompt = `You are pricing and writing a Facebook Marketplace listing for a used item shown in these photos.${notes}\n\n`
    + `First, judge condition honestly from what you can see.\n\n`
    + `Then price it for Facebook Marketplace: sold LOCALLY for cash and collected in person. Price to move quickly to one nearby buyer, in whole US dollars. Also give a floor: the lowest you would accept.\n\n`
    + `If the photos contain nothing that can be sold (a person, a pet, a room with nothing for sale, a blurry mess), return price 0.\n\n`
    // Facebook's category picker only accepts its own labels. Asking for one of
    // them up front beats fuzzy-matching free text at post time -- the poster
    // still falls back to a generic if this comes back as something else.
    + `"category" MUST be exactly one of: ${FB_CATEGORIES.join(', ')}.\n\n`
    + `Return ONLY a JSON object, no prose:\n`
    + `{"identify": what the item is in one line, "title": listing title <=70 chars, "category": one of the categories above, "condition": one of "New"|"Like New"|"Good"|"Fair"|"Salvage", "description": 2-4 honest buyer-facing sentences, "price": integer USD asking price, "floor": integer USD lowest to accept, "pricing_reasoning": one short line on how you got the number, "confidence": "high"|"medium"|"low"}`;

  const ask = async (extra) => callClaude(env, {
    content: [...images, { type: 'text', text: prompt + (extra || '') }],
    max_tokens: 2048, // 1024 can truncate a reply mid-JSON
  });
  let { text, stop } = await ask();
  let p = parseJson(text);
  const usable = (o) => o && o.title && o.price != null;
  if (!usable(p)) {
    ({ text, stop } = await ask('\n\nIMPORTANT: output the raw JSON object ONLY — no markdown fences, no prose, and make sure it is complete.'));
    p = parseJson(text);
  }
  if (!usable(p)) throw new Error(`unparseable model output (stop=${stop}): ${text.slice(0, 400)}`);

  const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
  // $0 is the "nothing sellable here" signal and must stay meaningful, so a
  // missing price is an error, never a silent zero.
  const price = num(p.price);
  if (price == null) throw new Error('model returned no usable price');
  const floor = num(p.floor);

  await env.DB.prepare('INSERT INTO comps (item_id, source, title, price, note) VALUES (?,?,?,?,?)')
    .bind(item.id, 'ai-estimate', p.identify || item.slug, price, p.pricing_reasoning || null).run();
  await logEvent(env, item.id, 'research', { via: 'ai', model: env.MODEL || 'claude-sonnet-5-5', confidence: p.confidence || null, price });

  const tail = [];
  if (p.confidence && p.confidence !== 'high') tail.push(`⚠️ ${p.confidence} confidence — worth a sanity check.`);
  return propose(env, item, {
    title: p.title,
    description: p.description + (tail.length ? `\n\n${tail.join('\n')}` : ''),
    category: p.category || null,
    condition: p.condition || null,
    price_ask: price,
    price_floor: floor,
    // Kept on the item, not just glued to the description -- this is what makes
    // "why this price?" answerable instantly and for free, with no second call.
    pricing_reasoning: p.pricing_reasoning || null,
    price_confidence: p.confidence || null,
  });
}

// ---------------------------------------------------------------------------
// Automatic Weekly Price Drops (Markdown)
// ---------------------------------------------------------------------------
async function proposePriceDrops(env) {
  // Query all items currently posted (live listings)
  const items = await env.DB.prepare(
    "SELECT * FROM items WHERE status = 'posted' AND price_ask > 0"
  ).all();

  const results = [];

  for (const item of (items.results || [])) {
    if (!item.posted_at) continue;

    // Calculate days live from posted_at
    const daysRow = await env.DB.prepare(
      "SELECT CAST(julianday('now') - julianday(?) AS INTEGER) AS d"
    ).bind(item.posted_at).first();
    const daysLive = daysRow?.d ?? 0;

    // Check if it's been at least 7 days since it was posted
    if (daysLive < 7) continue;

    // Check if we have proposed or approved a price drop for this item in the last 7 days
    const recentEvent = await env.DB.prepare(
      "SELECT id FROM events WHERE item_id = ? AND type = 'note' AND " +
      "(payload LIKE '%price_drop_proposed%' OR payload LIKE '%price_drop_approved%') AND " +
      "created_at > datetime('now', '-7 days') LIMIT 1"
    ).bind(item.id).first();

    if (recentEvent) {
      // Already had a price drop interaction within the last 7 days, skip
      continue;
    }

    // "Stop asking about this one" has to mean stop. Without this the item sits
    // at floor == ask forever and the floor question comes back every 7 days,
    // which is nagging dressed up as consent.
    const stopped = await env.DB.prepare(
      "SELECT id FROM events WHERE item_id=? AND payload LIKE '%drops_stopped%' LIMIT 1"
    ).bind(item.id).first();
    if (stopped) continue;

    // Calculate 10% price drop
    let proposedPrice = Math.round(item.price_ask * 0.9);

    // A 10% drop that would breach the floor is never silently clamped, and an
    // item already at its floor is never silently skipped forever -- that would
    // be the agent deciding on its own that an item has gone as low as it
    // should. Both are your calls, so both ask.
    const atFloor = item.price_floor != null && item.price_ask <= item.price_floor;
    const wouldBreach = item.price_floor != null && proposedPrice < item.price_floor;
    if (atFloor || wouldBreach) {
      const floor = Number(item.price_floor);
      const choices = [];
      if (!atFloor && floor > 0) choices.push({ key: 'floor', text: `📉 Drop to the floor, $${floor}` });
      choices.push({ key: 'keep', text: `✋ Keep it at $${item.price_ask}` });
      choices.push({ key: 'stop', text: '🛑 Stop asking about this one' });
      const asked = await askDecision(env, item, {
        kind: 'floor_block',
        question: atFloor
          ? `📉 ${item.title || item.slug} has been up ${daysLive} days and is already at its floor of $${floor}.`
          : `📉 ${item.title || item.slug} has been up ${daysLive} days. A 10% drop would be $${Math.round(item.price_ask * 0.9)}, below its floor of $${floor}.`,
        body: `Asking $${item.price_ask}, floor $${floor}. I won't go under the floor on my own.`,
        choices,
        payload: { floor },
      });
      // Logged in the shape the 7-day guard above looks for, so a question he
      // has already answered is not re-asked on tomorrow's run.
      if (asked.ok && !asked.already_open) {
        await logEvent(env, item.id, 'note', { price_drop_proposed: { asked: 'floor_block', floor } });
      }
      results.push({ slug: item.slug, asked: 'floor_block', ok: asked.ok, decision_id: asked.decision_id });
      continue;
    }

    // If rounding leads to the same price, skip
    if (proposedPrice >= item.price_ask) {
      continue;
    }

    // Let's propose the drop!
    const hero = await env.DB.prepare(
      'SELECT r2_key FROM photos WHERE item_id=? ORDER BY ord LIMIT 1'
    ).bind(item.id).first();
    const heroKey = hero ? hero.r2_key : null;

    // Build the comps / reasoning summary
    const compSummary = 
      `📉 Weekly price markdown proposal (-10%)\n` +
      `Live for ${daysLive} days without selling.\n` +
      `Current Price: $${item.price_ask} (floor: ${item.price_floor != null ? `$${item.price_floor}` : 'none'})\n` +
      `Proposed Price: $${proposedPrice}`;

    const buttons = [
      { text: `📉 Drop price to $${proposedPrice}`, callback_data: `pd:${item.id}:${proposedPrice}` },
      { text: `✋ Keep at $${item.price_ask}`, callback_data: `pk:${item.id}` },
    ];

    const card = await sendCard(env, item, heroKey, `<b>${esc(item.title || item.slug)}</b>\n\n${esc(compSummary)}`, buttons);
    if (card.ok) {
      await logEvent(env, item.id, 'note', { price_drop_proposed: { price: proposedPrice, from: item.price_ask } });
      results.push({ slug: item.slug, from: item.price_ask, to: proposedPrice });
    } else {
      await logEvent(env, item.id, 'note', { price_drop_propose_failed: { error: card.error || null } });
    }
  }

  return results;
}

// A card you never tap stalls the whole pipeline silently: nothing moves to
// 'approved', so the poster has nothing to claim and simply goes quiet.
// Once a day, name them — one message, never per-item spam.
const APPROVAL_NUDGE_AFTER_DAYS = 2;

async function nudgeStaleApprovals(env) {
  const rows = await env.DB.prepare(
    `SELECT slug, title, price_ask, CAST(julianday('now') - julianday(updated_at) AS INTEGER) AS age
     FROM items
     WHERE status='pending_approval'
       AND updated_at < datetime('now', '-${APPROVAL_NUDGE_AFTER_DAYS} days')
       AND ${NOT_A_FIXTURE}
     ORDER BY updated_at`
  ).all();
  const items = rows.results || [];
  if (!items.length) return { nudged: 0 };
  const lines = items.map((i) => `• <b>${esc(i.title)}</b> — $${i.price_ask} (${i.age}d waiting)`);
  const plural = items.length > 1;
  await tgSend(env, [
    `⏳ ${items.length} listing${plural ? 's are' : ' is'} still waiting on your tap:`,
    '',
    ...lines,
    '',
    `Nothing posts until you Approve or Reject — scroll back to the listing card${plural ? 's' : ''} above.`,
  ].join('\n'));
  // Record what it did. A notification that leaves no trace cannot be told
  // apart from one that never fired.
  for (const i of items) {
    const row = await env.DB.prepare('SELECT id FROM items WHERE slug=?').bind(i.slug).first();
    if (row) await logEvent(env, row.id, 'note', { approval_nudged: { age_days: i.age } });
  }
  return { nudged: items.length };
}

// ---------------------------------------------------------------------------
// Telegram webhook dispatch
// ---------------------------------------------------------------------------
async function handleUpdate(env, ctx, update) {
  const msg = update.message;
  const cq = update.callback_query;
  const chatId = String(msg ? (msg.chat && msg.chat.id) : (cq && cq.message && cq.message.chat && cq.message.chat.id) || '');
  if (!chatId || chatId === 'undefined') return;

  // First run: the bot does not know who you are yet. Tell whoever messaged it
  // their own chat id so they can set TELEGRAM_CHAT_ID. Nothing else happens.
  if (!env.TELEGRAM_CHAT_ID) {
    if (msg) {
      await tgApi(env, 'sendMessage', {
        chat_id: chatId,
        text: `Hi! Your chat id is ${chatId}.\n\nSet it on the worker and redeploy:\n  npx wrangler secret put TELEGRAM_CHAT_ID\nthen paste ${chatId}. Until then I won't act on anything.`,
      });
    }
    return;
  }
  // Single-seller bot: strangers get silence.
  if (chatId !== String(env.TELEGRAM_CHAT_ID)) return;

  if (cq) {
    let result;
    try { result = await handleTap(env, ctx, cq.data); }
    catch (e) {
      console.log('tap error', String((e && e.message) || e));
      result = { toast: 'Something went wrong — check the worker logs.' };
    }
    await tgApi(env, 'answerCallbackQuery', { callback_query_id: cq.id, text: result.toast || 'Done' });
    // Take the buttons off so a card cannot be tapped twice.
    if (cq.message) {
      await tgApi(env, 'editMessageReplyMarkup', {
        chat_id: chatId, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] },
      });
    }
    return;
  }
  if (msg) await tgIngest(env, ctx, msg);
}

// ---------------------------------------------------------------------------
// Worker entry
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';
    const method = request.method;
    // Card photo links need the worker's own public URL. Prefer the configured
    // one; otherwise learn it from the first request.
    if (!env.WORKER_URL) env.WORKER_URL = url.origin;
    useTimezone(env.TIMEZONE);

    if (path === '/health') return json({ ok: true, worker: 'sellstuff' });

    const img = path.match(/^\/img\/(.+)$/);
    if (img && method === 'GET') return serveImg(env, decodeURIComponent(img[1]), url);

    // Telegram -> us. Authenticated by the secret token you gave setWebhook, which
    // Telegram echoes back in this header on every call.
    if (path === '/telegram/webhook' && method === 'POST') {
      if (!safeEq(request.headers.get('x-telegram-bot-api-secret-token'), env.TELEGRAM_WEBHOOK_SECRET)) {
        return json({ ok: false, error: 'bad secret' }, 401);
      }
      const update = await request.json().catch(() => null);
      // Answer Telegram immediately (it retries slow webhooks) and do the work
      // in the background.
      if (update) ctx.waitUntil(handleUpdate(env, ctx, update).catch((e) => console.log('update error', String((e && e.message) || e))));
      return json({ ok: true });
    }

    // Everything below is admin-gated (Authorization: Bearer <ADMIN_KEY>).
    if (!authed(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);

    // One call to point Telegram at this worker.
    if (path === '/admin/set-webhook' && method === 'POST') {
      const r = await tgApi(env, 'setWebhook', {
        url: `${url.origin}/telegram/webhook`,
        secret_token: env.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      });
      return json({ ok: !!(r && r.ok), webhook: `${url.origin}/telegram/webhook`, telegram: r });
    }
    if (path === '/admin/webhook-info' && method === 'GET') {
      return json({ ok: true, telegram: await tgApi(env, 'getWebhookInfo', {}) });
    }

    if (path === '/items' && method === 'POST') {
      return createItem(env, await request.json().catch(() => ({})));
    }
    if (path === '/queue' && method === 'GET') return queue(env, url);
    // The poster's work queue. POST, not GET -- it mutates.
    if (path === '/post-queue/claim' && method === 'POST') {
      return claimForPosting(env, await request.json().catch(() => ({})));
    }
    // Buyer messages: the poster reports threads, claims one approved reply at
    // a time, and reports how the send went.
    if (path === '/inbox/report' && method === 'POST') {
      return inboxReport(env, H, await request.json().catch(() => ({})));
    }
    if (path === '/inbox/claim' && method === 'POST') return inboxClaim(env, H);
    const ib = path.match(/^\/inbox\/(\d+)\/(sent|failed)$/);
    if (ib && method === 'POST') {
      const b = await request.json().catch(() => ({}));
      return ib[2] === 'sent' ? inboxSent(env, H, Number(ib[1])) : inboxFailed(env, H, Number(ib[1]), b);
    }
    // Plain notice from the poster (e.g. "Chrome is signed out").
    if (path === '/notify' && method === 'POST') {
      const b = await request.json().catch(() => ({}));
      if (!b.text) return json({ ok: false, error: 'text required' }, 400);
      await tgSend(env, esc(String(b.text).slice(0, 1500)));
      return json({ ok: true });
    }
    if (path === '/meetup-tick' && method === 'POST') return json({ ok: true, ...(await meetupTick(env, H)) });
    if (path === '/decisions' && method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT d.id, d.kind, d.question, d.choices, d.status, d.answer, d.created_at, d.answered_at, i.slug, i.title
         FROM decisions d LEFT JOIN items i ON i.id = d.item_id
         WHERE d.status = COALESCE(?, d.status)
         ORDER BY d.id DESC LIMIT 50`
      ).bind(url.searchParams.get('status')).all();
      return json({ ok: true, decisions: rows.results || [] });
    }
    if (path === '/stats' && method === 'GET') return stats(env);
    if (path === '/inventory' && method === 'GET') return inventory(env);
    if (path === '/nudge' && method === 'POST') {
      return json({ ok: true, ...(await nudgeStaleApprovals(env)) });
    }
    if (path === '/propose-price-drops' && method === 'POST') {
      const results = await proposePriceDrops(env);
      return json({ ok: true, proposed: results });
    }

    const m = path.match(/^\/items\/([a-z0-9-]+)\/(photos|comps|propose|post-failed|posted|sold|status|research|edit|edited|edit-failed|remove|removed|remove-failed|link|ask)$/);
    if (m && method === 'POST') {
      const item = await getItem(env, m[1]);
      if (!item) return json({ ok: false, error: 'unknown item' }, 404);
      if (m[2] === 'research') {
        // Re-run the AI research on an already-ingested item (photos in R2).
        try { await researchAndPropose(env, item); return json({ ok: true, note: 'card sent' }); }
        catch (e) { return json({ ok: false, error: String((e && e.message) || e).slice(0, 500) }, 502); }
      }
      if (m[2] === 'photos') return uploadPhoto(env, request, item, url);
      const body = await request.json().catch(() => ({}));
      if (m[2] === 'comps') return addComps(env, item, body);
      if (m[2] === 'propose') return propose(env, item, body);
      if (m[2] === 'posted') return markPosted(env, item, body);
      if (m[2] === 'post-failed') return markPostFailed(env, item, body);
      if (m[2] === 'sold') return markSold(env, item, body);
      if (m[2] === 'status') return overrideStatus(env, item, body);
      if (m[2] === 'edit') return handleEditItem(env, item, body);
      if (m[2] === 'edited') return markEdited(env, item, body);
      if (m[2] === 'edit-failed') return markEditFailed(env, item, body);
      if (m[2] === 'remove') return handleRemoveItem(env, item);
      if (m[2] === 'removed') return markRemoved(env, item, body);
      if (m[2] === 'remove-failed') return markRemoveFailed(env, item, body);
      if (m[2] === 'link') return markLink(env, item, body);
      if (m[2] === 'ask') {
        // The poster raises a question it cannot answer itself (which listing is
        // this, is it already gone, what category). It then drops the item and
        // moves on -- the answer arrives as a tap, not as a blocked browser.
        try { return json(await askDecision(env, item, body)); }
        catch (e) { return json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }, 400); }
      }
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
  // Two crons: daily price drops + nudges, and a 15-minute pickup tick
  // (hour-before reminders and "did it sell?" cards).
  async scheduled(controller, env, ctx) {
    useTimezone(env.TIMEZONE);
    if (controller.cron === '*/15 * * * *') {
      ctx.waitUntil(meetupTick(env, H));
      return;
    }
    ctx.waitUntil((async () => {
      await proposePriceDrops(env);
      await nudgeStaleApprovals(env);
    })());
  },
};
