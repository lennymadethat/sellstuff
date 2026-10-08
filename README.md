# Agent Sell Stuff

**Snap a photo. Message it to him on Telegram. He writes the listing, prices it, and posts it to Facebook Marketplace.**

"He" is a small agent that lives in two places: a Cloudflare Worker in the
cloud, and a poster program on a computer you own. You only ever talk to the
Telegram bot.

> **Heads up.** Automating Facebook Marketplace may break Facebook's terms.
> Use it on your own account at your own risk.

## What it does

- **Takes photos from Telegram.** Send one item's photos in one message. Add a
  caption if you want to tell it something ("works, small scratch, want $40
  minimum").
- **Writes the listing.** One Claude call looks at the photos and returns a
  title, a description, a condition, a Facebook category, an asking price and a
  floor price (the lowest you'd take), plus its reasoning.
- **Asks you first.** You get an approve card in Telegram with the photo, the
  price and two buttons. Nothing is ever posted without your tap.
- **Posts it.** A program on your own computer opens your real, logged-in
  Chrome and fills in the Facebook Marketplace form, one listing at a time, at
  human speed. Facebook has no listing API for individuals, so a browser is the
  only way.
- **Looks after it.** Edits the price on a live listing, deletes a listing when
  you say so, proposes a 10% price drop after a week, and nudges you about
  cards you never tapped.
- **Asks instead of guessing.** Any judgement call (which of two similar
  listings is this one? is it already gone?) comes to you as a Telegram
  question with buttons.

```
 you ──photos──> Telegram bot ──webhook──> Cloudflare Worker ──> Claude
                                              │  photos in R2, items in D1
          approve card (Approve / Reject) <───┘
 you ──tap Approve──>  Worker marks the item "approved"
                                              ▲
 your computer: poster ──claim one item──────┘   (shared secret)
   └─> your real Chrome ──> Facebook Marketplace ──> reports back "posted"
```

## What you need

- A Telegram account.
- A Cloudflare account (the free plan to start; Workers, D1 and R2 are used).
- An Anthropic API key with a little credit on it.
- A computer that stays on, with **Google Chrome** and **Node.js 20+**. The
  install script is for Windows (PowerShell). On Mac or Linux, run
  `node poster.mjs` under any process manager you like.
- A Facebook account you can sign into by hand once.

## Setup

About 20 minutes. Prefer to have a coding agent do it? Paste
[`KIT.md`](KIT.md) into Claude Code, Codex or Cursor.

1. **Make the Telegram bot.** In Telegram, message **@BotFather**, send
   `/newbot`, and follow the prompts. Keep the bot token it gives you. Invent a
   random string (letters, digits, `_` and `-`) for the webhook secret.
2. **Get the code and install.**
   ```
   git clone <this repo>
   cd sellstuff
   npm install
   ```
3. **Create the Cloudflare pieces.**
   ```
   npx wrangler login
   npx wrangler d1 create sellstuff
   npx wrangler r2 bucket create sellstuff-photos
   ```
   Copy the `database_id` that `d1 create` prints into `wrangler.toml`. Then
   build the tables:
   ```
   npm run db:init
   ```
4. **Deploy.**
   ```
   npx wrangler deploy
   ```
   Note the URL it prints. Uncomment `WORKER_URL` in `wrangler.toml`, put that
   URL in, and deploy once more.
5. **Set the secrets.** Each command asks you to paste the value.
   ```
   npx wrangler secret put ADMIN_KEY                 # long random string, you invent it
   npx wrangler secret put IMG_TOKEN                 # another long random string
   npx wrangler secret put TELEGRAM_BOT_TOKEN        # from BotFather
   npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # the string from step 1
   npx wrangler secret put ANTHROPIC_API_KEY         # from console.anthropic.com
   ```
   To make a random string:
   `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
6. **Point Telegram at the Worker.**
   ```
   curl -X POST https://YOUR_WORKER_URL/admin/set-webhook -H "Authorization: Bearer YOUR_ADMIN_KEY"
   ```
   The answer should say `"ok": true`.
7. **Tell the bot who you are.** Send your bot any message. It replies with
   your chat id. Set it (it takes effect right away):
   ```
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```
   From now on the bot ignores everyone else.
8. **Install the poster on your computer.**
   ```
   cd poster
   copy .env.example .env      (Mac/Linux: cp .env.example .env)
   ```
   Edit `.env`: your Worker URL and the same `ADMIN_KEY` from step 5. Then:
   ```
   npm install
   node login.mjs
   ```
   A Chrome window opens. **Sign into Facebook yourself, once.** The kit never
   sees your password. Then register the poster to start at logon:
   ```
   powershell -ExecutionPolicy Bypass -File install.ps1
   ```
9. **Try it.** Send the bot photos of something you want to sell. In a minute
   you get a card. Tap Approve. To watch the poster fill the form without
   publishing, run `node poster.mjs --once --dry` from the `poster` folder
   after approving.

## Commands

Text these to your bot. Reply to a card to aim at that item; otherwise it uses
the most recent one.

| You send | What happens |
|---|---|
| photos (one message) | New listing: researched, priced, card sent |
| `250` or `$250` | Set the asking price (a live listing gets edited on Facebook) |
| `floor 100` | Set your walk-away price |
| `250/100` | Both at once |
| `why` | How it landed on that price. Free and instant |
| `status` | What is live, waiting, or stuck, and why |
| `retry` | Put a listing it gave up on back in the queue |
| `redo` | Run the research again |
| `category Tools` | Change the category |
| `sold 40` | Log a sale |
| `remove` (as a reply to a card) | Delete the listing from Facebook. A delete, never "mark as sold" |
| anything else | A real conversation about the item. It only changes a price if you tell it to |

## Safety rails

These exist so the agent can't run away with your account.

- **You tap Approve on every listing.** Nothing posts itself.
- **5 new listings a day.** Set by `MAX_POSTS_PER_DAY`. The Worker enforces it,
  so the poster can't exceed it even if told to.
- **One thing at a time.** Claims are locked in the database, so two browsers
  never drive your account together. There is a real 4 to 7 minute gap between
  listings, random pauses between form fields, and per-character typing.
- **Three failures park an item.** After 3 failed tries it goes to
  `needs_attention`, you get one message, and it is not retried until you send
  `retry`. A retry loop is the pattern that gets accounts flagged.
- **A Facebook checkpoint halts everything.** If Facebook shows a captcha, an
  identity check or an "unusual activity" screen, the poster stops, writes
  `poster/logs/HALTED`, tells you on Telegram, and refuses to claim anything
  until you clear it in Chrome and run `install.ps1 -Resume`.
- **Kill switch.** Set `AUTO_POST_FB = "off"` in `wrangler.toml` and run
  `npx wrangler deploy`. Approved items wait; the poster does nothing.
- **Your real account only.** Never a second or burner account.
- **It never reads or sends Facebook messages.** The poster posts, edits and
  deletes listings. That is all.
- **Meta AI auto-reply is left off** on listings it posts.
- **Private by default.** The bot answers only your chat id. The Worker's admin
  routes need your `ADMIN_KEY`. Photos are served only with your `IMG_TOKEN`.

More in [`docs/SAFETY.md`](docs/SAFETY.md).

## What it costs

Cloudflare Workers, D1 and R2 are cheap and have free allowances. Telegram is
free. The only metered thing is Claude: one call per new listing (the photos
are most of the cost) and a small text-only call when you chat about an item.
Typing `why`, `status`, a price, or any other command costs nothing. Check your
chosen model's price page for the exact numbers.

## What is in the box

```
worker/src/index.js        the whole Worker (Telegram, state, pricing, claim queue)
poster/                    runs on your computer
  poster.mjs               claim -> post / edit / delete -> report loop
  fb.mjs                   the Marketplace form driver
  match.mjs (+ test)       matches your listing to a card on Your listings
  login.mjs                one-time Facebook sign-in
  install.ps1              start-at-logon, -Status, -Resume, -Uninstall
  backfill-permalinks.mjs  repairs missing listing links
migrations/0001_init.sql   the database
wrangler.toml              Worker config with placeholders
docs/                      how it works, safety, API, troubleshooting
AGENTS.md                  paste into a coding agent to set it all up
KIT.md                     the shortcut version of that
```

## Docs

- [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) the whole chain, step by step
- [`docs/SAFETY.md`](docs/SAFETY.md) the rules and where each one is enforced
- [`docs/API.md`](docs/API.md) the Worker's routes
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) when it goes quiet

## Not done

Mercari and OfferUp are not in this kit. eBay is not either; only Facebook
Marketplace is wired up.

## License

MIT. See [`LICENSE`](LICENSE).
