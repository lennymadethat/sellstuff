# Safety rules

The agent drives a real Facebook account. These rules keep it from doing
anything you wouldn't, and from getting the account flagged. Each one is
enforced in code, not just promised.

> Automating Facebook Marketplace may break Facebook's terms. Use it on your
> own account at your own risk. These rails lower the odds of trouble. They
> don't remove it.

| # | Rule | Where it is enforced |
|---|---|---|
| 1 | **Your real account only.** Never a second, burner or alias account. | The poster uses one Chrome profile that you signed into yourself. |
| 2 | **A human tap on every listing and every reply.** Nothing publishes without Approve; no buyer message goes out without Send or your own typed words. | The Worker only ever hands the poster items in `approved`, and replies in `approved`. Only a tap on that reply's card, or text you typed in reply to it, sets that. |
| 3 | **Human speed.** Random pauses between fields, per-character typing, 4 to 7 minutes between listings. | `poster/fb.mjs`, `poster/poster.mjs` |
| 4 | **Daily cap.** 20 new listings a day by default; set your own with `MAX_POSTS_PER_DAY`. | The Worker's claim endpoint. The poster can't exceed it. |
| 5 | **One at a time.** | `posting` status is a database lock, plus `edit_queued=2` and `delete_queued=2`. |
| 6 | **Three strikes.** After 3 failed attempts an item is parked as `needs_attention` and not retried. | Worker `markPostFailed`. The claim query never selects parked items. |
| 7 | **Stop on friction.** A checkpoint, captcha, identity prompt or "unusual activity" screen ends the run untouched and halts the whole lane. | `poster/fb.mjs` scans after every stage. `poster/logs/HALTED` stops the loop until you run `install.ps1 -Resume`. |
| 8 | **Kill switch.** | `AUTO_POST_FB = "off"` in `wrangler.toml`, then `npx wrangler deploy`. |
| 9 | **Replies, never conversations it starts.** The poster reads chats and answers only a thread where the buyer spoke last, one reply at a time. A send that dies halfway is reported to you, never retyped. | `poster/inbox.mjs`, Worker `inboxClaim` / `inboxFailed`. |
| 9a | **Never your address, never under your floor.** Pickups are offered only at your `spot`, inside your `hours`. A draft that agrees a price under your floor is flagged on the card. | Worker `draftReply` in `worker/src/inbox.js`. |
| 9b | **Buyer messages are data.** A link, a payment request or a "verification code" gets a polite decline draft and a note to you. | The drafting prompt; you still see every draft before it is sent. |
| 10 | **Delete is not "mark as sold".** Facebook is never told whether an item sold. | `deleteListing` in `poster/fb.mjs`. |
| 11 | **Meta AI auto-reply stays off.** The agent's drafts, approved by you, are the only replies. | `postListing` drives the toggle to off. |
| 12 | **Questions, not guesses.** The agent asks before binning, relinking, archiving or going under your floor. | Worker `askDecision`. |
| 13 | **Private by default.** The bot answers only your chat id; admin routes need `ADMIN_KEY`; photo links need `IMG_TOKEN`. | Worker `handleUpdate`, `authed`, `serveImg`. |

## Why three strikes

A deterministic failure (a bad category, a missing field) isn't fixed by
trying again. Retrying it twenty times means twenty create-listing sessions and
eighty photo uploads from one browser, which is the pattern that gets an
account flagged. A daily cap that only counts successes can't catch that, so
failures have their own counter.

The reaper counts too. A poster that dies mid-post never reports a failure, so
an item stuck in `posting` for 25 minutes costs a strike when it is released.

## Why a checkpoint halts everything

Retrying into a platform control is itself what gets an account flagged. So on
any hit the poster abandons the run, writes `HALTED`, and won't claim another
item until a human has looked. False alarms are fine. A missed checkpoint is not.

To clear a halt: open Chrome yourself, sort out whatever Facebook is asking,
then run `powershell -ExecutionPolicy Bypass -File install.ps1 -Resume` in the
`poster` folder.

## What it can't promise

Facebook changes its pages without notice. If the form changes, the poster
fails loudly with the button names it could see, the item goes back through the
strike counter, and nothing is half-posted. Fixing the selectors is your job,
or an agent's.
