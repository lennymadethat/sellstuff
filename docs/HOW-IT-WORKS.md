# How it works

A plain-English map of what happens when you send a photo.

## The chain, end to end

| # | Where | What happens |
|---|---|---|
| 1 | Telegram to the Worker | Telegram calls your Worker's `/telegram/webhook`. Photos sent together share a `media_group_id`, so the Worker buffers them and treats them as one item. |
| 2 | Worker | Photos go into the R2 bucket. A row goes into the D1 database with status `draft`. |
| 3 | Worker to Claude | Once the burst has been quiet for a few seconds, the photos plus your caption go to Claude in one call. It returns title, description, condition, category, asking price, floor price, reasoning and a confidence level. |
| 4 | Worker to Telegram | You get a card: photo, price, two buttons. Status `pending_approval`. |
| 5 | You | Tap **Approve**. Status becomes `approved`. |
| 6 | Poster (your computer) | Every minute it asks the Worker `POST /post-queue/claim`. The Worker hands out at most one item and marks it `posting`. |
| 7 | Poster to Facebook | It opens your real Chrome, fills the Marketplace form, picks the category from what Facebook is actually showing, and publishes. |
| 8 | Poster to Worker | It reports `posted` (with the link if it could capture one) or `post-failed` with the reason. You get a Telegram message either way. |

Facebook has no listing API for individuals. That is why step 7 drives a
browser. Every crossposting product on the market does the same.

## The state of an item

```
draft -> researched -> pending_approval -> approved -> posting -> posted -> sold -> archived
                             |                              |
                             v                              v
                          rejected                   needs_attention  (3 strikes or a checkpoint)
```

`posting` is a lock. While an item is in it, the poster owns it. Nothing else
should post it by hand.

## The work queue

The poster claims one of three kinds of job, in this order:

1. **Delete** a listing you asked to remove.
2. **Edit** a live listing (a new price, or a price drop you approved).
3. **Post** a newly approved item, if fewer than the daily cap went up today.

Deletes and edits don't count against the daily cap.

## Questions instead of guesses

When the agent can't be sure, it asks. Each is a Telegram card with buttons:

| Question | Asked when |
|---|---|
| `nothing_sellable` | The model prices the photos at $0 (nothing to sell). Keep it as a draft, or bin it. |
| `which_listing` | On "Your listings" two cards could be this item. Pick one. Your choice is remembered. |
| `looks_gone` | A listing can't be found before a delete. Is it already gone? |
| `category` | Facebook had no matching shelf, so the item went up under a generic one. Where should it live? |
| `floor_block` | A weekly price drop would go under your floor, or it is already at the floor. |

While a question is open the item is parked, so the poster skips it instead of
retrying into the same fork.

## Where the price comes from

Claude looks at the photos and your caption, judges condition from what it can
see, and prices for a quick local cash sale. It stores its own one-line
reasoning on the item, so `why` is free.

Be clear-eyed about the basis. Unless you add real sold comps, the price is a
model reading photographs. It is not scraped sale data. `why` says which one
you are looking at.

## Daily job

A cron runs at 16:00 UTC. It proposes a 10% drop on any listing that has been
live 7 days (never below your floor; if it would be, it asks), and sends one
message naming any card you haven't tapped in 2 days.

## Files

| Thing | Where |
|---|---|
| Worker | `worker/src/index.js` |
| Browser driver | `poster/fb.mjs` |
| Poll loop | `poster/poster.mjs` |
| Poster log | `poster/logs/poster.log` |
| Manual brake | `poster/logs/HALTED` |
| Database | `migrations/0001_init.sql` |
