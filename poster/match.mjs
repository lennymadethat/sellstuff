// Pure title matching for Facebook "Your listings" cards.
// Kept out of fb.mjs so a Facebook wording change can be unit-tested without
// opening Chrome. Browser code stays in fb.mjs.

const STOP = new Set([
  'and', 'or', 'the', 'a', 'an', 'of', 'for', 'with', 'amp', 'w',
  'goods', 'supplies', 'other', 'misc', 'item', 'items',
]);

export function normTitle(s) {
  return String(s || '')
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function titleTokens(s) {
  return normTitle(s).split(' ').filter((t) => t && !STOP.has(t));
}

export function scoreTitleMatch(haystack, title) {
  const want = titleTokens(title);
  if (!want.length) return { hits: 0, ratio: 0, want: 0 };
  const have = new Set(titleTokens(haystack));
  const hits = want.filter((t) => have.has(t)).length;
  return { hits, ratio: hits / want.length, want: want.length };
}

// Distinctive queries for the Your listings search box. Long first-40-char
// prefixes fail on Facebook (Acme 24" → "Acme 24  Monitor…", long-title overflow).
// Short brand/model tokens filter; token scoring then picks the right card.
export function sellingSearchQueries(title) {
  const tokens = titleTokens(title);
  const out = [];
  if (tokens.length >= 3) out.push(tokens.slice(0, 4).join(' '));
  if (tokens[0] && (tokens[0].length >= 5 || /\d/.test(tokens[0]))) out.push(tokens[0]);
  if (tokens.length >= 2) out.push(tokens.slice(0, 2).join(' '));
  return [...new Set(out.filter(Boolean))];
}

// cards: [{ id?, text, title? }]. Returns the uniquely best card or null.
//
// The bar is deliberately high. A miss costs one skipped edit; a WRONG match
// points a later Remove at somebody else's listing. A backfill dry run once
// matched a winch remote ("... w/ Waterproof Case") to a survival kit
// ("Rugged Waterproof ... Kit Case") on two shared tokens (waterproof, case)
// under an older hits >= 2 rule.
// Overlap now has to be a real majority of the title, not two stray words.
const MIN_HITS = 3;
const MIN_RATIO = 0.55;
// How far ahead of the runner-up the winner must be before we trust it.
const MIN_MARGIN = 0.15;

// Once you have answered a which_listing question, the exact card title you
// pointed at beats any amount of scoring — including for two near-identical
// listings, which scoring can never separate and correctly refuses to guess.
export function pickConfirmedCard(cards, confirmedTitle) {
  const want = normTitle(confirmedTitle);
  if (!want) return null;
  const hits = (cards || []).filter((c) => normTitle(c.title || '') === want);
  return hits.length === 1 ? hits[0] : null;
}

export function pickBestCard(cards, title, confirmedTitle) {
  const confirmed = pickConfirmedCard(cards, confirmedTitle);
  if (confirmed) return { ...confirmed, hits: 0, ratio: 1, want: 0, confirmed: true };

  const want = titleTokens(title).length;
  if (!want) return null;
  const scored = (cards || []).map((c) => ({
    ...c,
    ...scoreTitleMatch(c.text || c.title || '', title),
  }));
  scored.sort((a, b) => b.ratio - a.ratio || b.hits - a.hits);
  if (!scored.length) return null;

  const top = scored[0];
  // Short titles ("Acme 20 Monitor") can't clear MIN_HITS, so they must match
  // every token they have instead.
  const enough = want <= MIN_HITS ? top.hits === want : (top.hits >= MIN_HITS && top.ratio >= MIN_RATIO);
  if (!enough) return null;

  const runner = scored[1];
  if (runner && (top.ratio - runner.ratio) < MIN_MARGIN) return null;
  return top;
}
