# KIT.md — what's in the Agent Sell Stuff kit

**Snap a photo. Message it to him on Telegram. He writes the listing, prices it, and posts it to Facebook Marketplace.**

This is a starter kit, not a finished product. It is one Cloudflare Worker plus
one Playwright poster, small enough to read in an afternoon and change.

> Automating Facebook Marketplace may break Facebook's terms. Use it on your
> own account at your own risk.

## Fastest way in

Open [`AGENTS.md`](AGENTS.md), copy everything below its line into Claude Code,
Codex or Cursor, and answer its questions. It does the whole setup and stops
only when it needs a secret from you or a Facebook sign-in only you can do.

Prefer to do it yourself? [`README.md`](README.md) has the numbered steps.

## The two halves

| Half | Lives | Does |
|---|---|---|
| **Worker** (`worker/`) | Cloudflare | Receives the Telegram webhook, stores photos (R2) and items (D1), makes the Claude call, sends approve cards, drafts buyer replies and books pickups, hands the poster one job at a time, enforces the daily cap and the three-strikes rule |
| **Poster** (`poster/`) | A computer you own | Claims a job over an authenticated endpoint, drives your real logged-in Chrome to post, edit or delete the listing, reads buyer chats and types the replies you approved, reports back |

They talk over one shared secret (`ADMIN_KEY` on the Worker, `SELLSTUFF_ADMIN_KEY`
in `poster/.env`).

## Things you might change

| I want to... | Change |
|---|---|
| Use a different Claude model | `MODEL` in `wrangler.toml` (any model that reads images) |
| Post more or fewer a day | `MAX_POSTS_PER_DAY` in `wrangler.toml`. Go slowly; this is the account-safety knob |
| Change how listings are written or priced | the prompt in `researchAndPropose` in `worker/src/index.js` |
| Another currency or country | the prompt (says US dollars) and `FB_CATEGORIES`, which follow Facebook's labels for your locale |
| Change the price-drop rule | `proposePriceDrops` (10% after 7 days, never under the floor) |
| Change how buyer replies are written | the prompt in `draftReply` in `worker/src/inbox.js` |
| Pickup place and times | text the bot `spot <place>` and `hours <times>` |
| Your timezone | `TIMEZONE` in `wrangler.toml` |
| Stop all posting right now | `AUTO_POST_FB = "off"`, then `npx wrangler deploy` |
| Fix a broken Facebook form | `poster/fb.mjs`. Selectors match on structure and visible label text, not class names |

## What is deliberately not here

- **Mercari, OfferUp, eBay.** Only Facebook Marketplace is wired up.
- **A web dashboard.** Telegram is the interface; the Worker's `/stats` and
  `/inventory` routes give you the data if you want to build one.

## Costs

Cloudflare and Telegram are cheap or free at this scale. Claude is the only
metered piece: one call per new listing, and a small text call when you chat
about an item. Commands like `why`, `status` and a plain price cost nothing.

## License

MIT. See [`LICENSE`](LICENSE).
