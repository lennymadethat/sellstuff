// Facebook sync.
//
// So the agent never talks about things you already deleted or sold yourself:
// the poster reads Your listings (every card, with its Active / Sold
// state) and posts it here. Facebook is the truth; the desk is corrected to
// match it:
//   card shows Active  -> stays 'posted' (and learns its permalink if missing)
//   card shows Sold    -> 'sold' (you sold it yourself; price unknown, so no
//                         ledger row is invented)
//   no card at all     -> 'archived' (you deleted it yourself)
// Anything archived or sold stops getting price drops, edits and removals.
//
// A scan that read nothing changes nothing. A scan that would archive most of
// the desk at once asks first, in one card — a half-loaded page must never
// wipe the desk.

const words = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2));
function score(a, b) {
  const A = words(a); const B = words(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.max(A.size, B.size);
}
const idOf = (url) => { const m = String(url || '').match(/marketplace\/item\/(\d+)/); return m ? m[1] : null; };

async function kvSet(env, k, v) {
  await env.DB.prepare("INSERT INTO kv (k, v, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=datetime('now')")
    .bind(k, v).run();
}

// The daily price-drop pass only talks about a listing when the desk has seen
// Facebook recently; otherwise it would be proposing drops on things that are
// already gone.
export async function syncIsFresh(env, hours = 30) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k='fb_synced_at'").first();
  if (!r || !r.v) return false;
  return Date.now() - Date.parse(r.v) < hours * 3600 * 1000;
}

// body: { cards: [{ id, title, state: 'active'|'sold' }], complete: true }
export async function syncFromFacebook(env, h, body) {
  const cards = (Array.isArray(body.cards) ? body.cards : [])
    .filter((c) => c && (c.id || c.title))
    .map((c) => ({ id: String(c.id || ''), title: String(c.title || '').slice(0, 200), state: c.state === 'sold' ? 'sold' : 'active' }));
  if (!cards.length || body.complete !== true) {
    return h.json({ ok: false, error: 'scan read no listings (or was not complete) — nothing changed' }, 400);
  }

  const live = (await env.DB.prepare(
    "SELECT * FROM items WHERE status IN ('posted','needs_attention')"
  ).all()).results || [];

  const used = new Set();
  const plan = [];
  for (const it of live) {
    const id = idOf(it.fb_listing_url);
    let card = id ? cards.find((c) => c.id === id) : null;
    if (!card && it.fb_card_title) card = cards.find((c) => c.title === it.fb_card_title && !used.has(c));
    if (!card) {
      // Best title match, and only if it is clearly this item and not a twin.
      const ranked = cards.filter((c) => !used.has(c)).map((c) => ({ c, s: score(it.title, c.title) })).sort((a, b) => b.s - a.s);
      if (ranked[0] && ranked[0].s >= 0.6 && (!ranked[1] || ranked[0].s - ranked[1].s >= 0.15)) card = ranked[0].c;
    }
    if (card) used.add(card);
    plan.push({ it, card, action: !card ? 'gone' : card.state === 'sold' ? 'sold' : 'active' });
  }

  const gone = plan.filter((p) => p.action === 'gone');
  // dry: report what WOULD change and touch nothing (first run after sign-in).
  if (body.dry) {
    return h.json({ ok: true, dry: true, cards: cards.length, live_before: live.length,
      plan: plan.map((p) => ({ slug: p.it.slug, title: p.it.title, action: p.action, card: p.card ? p.card.title : null })) });
  }
  // Big batch: ask once rather than trust one page load with most of the desk.
  if (gone.length > 5 && gone.length > live.length * 0.5 && !body.confirmed) {
    await kvSet(env, 'fb_sync_pending', JSON.stringify({ at: new Date().toISOString(), slugs: gone.map((p) => p.it.slug) }));
    const ask = await h.askDecision(env, null, {
      kind: 'sync_bulk',
      question: `🔄 Facebook shows ${cards.length} listing(s), but ${gone.length} of the ${live.length} I think are live aren't there. Did you take them all down?`,
      body: gone.slice(0, 15).map((p) => `• ${p.it.title}`).join('\n') + (gone.length > 15 ? `\n…and ${gone.length - 15} more` : ''),
      choices: [
        { key: 'archive', text: `✅ Yes — clear all ${gone.length} off the desk` },
        { key: 'keep', text: '✋ No — leave them, the page didn\'t load right' },
      ],
    });
    // Everything except the big archive still applies now.
    await apply(env, h, plan.filter((p) => p.action !== 'gone'));
    await kvSet(env, 'fb_synced_at', new Date().toISOString());
    return h.json({ ok: true, asked: true, decision_id: ask.decision_id, gone: gone.length });
  }

  const res = await apply(env, h, plan);
  await kvSet(env, 'fb_synced_at', new Date().toISOString());
  if (res.sold.length || res.gone.length) {
    const lines = ['🔄 Checked your Facebook listings and updated my notes:'];
    if (res.gone.length) lines.push('', `Gone from Facebook (cleared, I won't mention them again):`, ...res.gone.map((t) => `• ${h.esc(t)}`));
    if (res.sold.length) lines.push('', `Marked sold on Facebook:`, ...res.sold.map((t) => `• ${h.esc(t)}`));
    lines.push('', `${res.active} still live.`);
    await h.tgSend(env, lines.join('\n'));
  }
  return h.json({ ok: true, live_before: live.length, ...res, cards: cards.length });
}

async function apply(env, h, plan) {
  const out = { active: 0, sold: [], gone: [], linked: 0 };
  for (const p of plan) {
    const it = p.it;
    if (p.action === 'active') {
      out.active++;
      if (p.card.id && !idOf(it.fb_listing_url)) {
        await env.DB.prepare("UPDATE items SET fb_listing_url=?, updated_at=datetime('now') WHERE id=?")
          .bind(`https://www.facebook.com/marketplace/item/${p.card.id}/`, it.id).run();
        out.linked++;
      }
      continue;
    }
    // Sold or gone: stop every queued action on it, then move it off the desk.
    await env.DB.prepare(
      "UPDATE items SET status=?, edit_queued=0, delete_queued=0, awaiting_decision=0, updated_at=datetime('now')"
      + (p.action === 'sold' ? ", sold_at=COALESCE(sold_at, datetime('now'))" : '') + ' WHERE id=?'
    ).bind(p.action === 'sold' ? 'sold' : 'archived', it.id).run();
    await env.DB.prepare("UPDATE decisions SET status='superseded', answer='fb-sync' WHERE item_id=? AND status='pending'").bind(it.id).run();
    await h.logEvent(env, it.id, p.action === 'sold' ? 'sold' : 'archived', { fb_sync: p.action, by: 'facebook-sync' });
    (p.action === 'sold' ? out.sold : out.gone).push(it.title || it.slug);
  }
  return out;
}

// The one-tap answer to the big-batch question.
export async function applySyncBulk(env, h, key) {
  const r = await env.DB.prepare("SELECT v FROM kv WHERE k='fb_sync_pending'").first();
  let pending = null;
  try { pending = r && r.v ? JSON.parse(r.v) : null; } catch { pending = null; }
  await env.DB.prepare("DELETE FROM kv WHERE k='fb_sync_pending'").run();
  if (key !== 'archive' || !pending) {
    await h.tgSend(env, '👍 Left them as they are. I\'ll check Facebook again on the next pass.');
    return;
  }
  let n = 0;
  for (const slug of pending.slugs || []) {
    const it = await env.DB.prepare("SELECT * FROM items WHERE slug=? AND status IN ('posted','needs_attention')").bind(slug).first();
    if (!it) continue;
    await apply(env, h, [{ it, card: null, action: 'gone' }]);
    n++;
  }
  await h.tgSend(env, `🧹 Cleared ${n} listing(s) that are no longer on Facebook. I won't bring them up again.`);
}

// "clear old" — bin approval cards you never tapped (things you sold or gave
// away before approving). Never touches anything live.
export async function clearStaleApprovals(env, h, days = 3) {
  const rows = (await env.DB.prepare(
    `SELECT id, title, slug FROM items WHERE status IN ('pending_approval','researched','draft') AND updated_at < datetime('now', ?)`
  ).bind(`-${days} days`).all()).results || [];
  for (const it of rows) {
    await env.DB.prepare("UPDATE items SET status='archived', awaiting_decision=0, updated_at=datetime('now') WHERE id=?").bind(it.id).run();
    await env.DB.prepare("UPDATE decisions SET status='superseded', answer='cleared' WHERE item_id=? AND status='pending'").bind(it.id).run();
    await h.logEvent(env, it.id, 'archived', { cleared: 'stale-approval', by: 'you' });
  }
  await h.tgSend(env, rows.length
    ? `🧹 Binned ${rows.length} old card(s) you never approved:\n${rows.map((r) => `• ${h.esc(r.title || r.slug)}`).join('\n')}`
    : '🧹 No old unapproved cards to clear.');
  return rows.length;
}
