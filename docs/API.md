# Worker routes

Admin routes need `Authorization: Bearer <ADMIN_KEY>`. The poster uses the same
header, with the key from `poster/.env`.

## Open

| Route | Does |
|---|---|
| `GET /health` | Liveness. |
| `POST /telegram/webhook` | Telegram updates. Checked against `TELEGRAM_WEBHOOK_SECRET` (the `x-telegram-bot-api-secret-token` header). |
| `GET /img/<r2 key>?t=<IMG_TOKEN>` | Photo bytes, so Telegram can show cards and the poster can download. |

## Admin

| Route | Does |
|---|---|
| `POST /admin/set-webhook` | Points Telegram at this Worker. |
| `GET /admin/webhook-info` | What Telegram thinks the webhook is, and its last error. |
| `GET /stats` | Live listings, pending, approved, sold, revenue, average days to sell. |
| `GET /inventory` | Every active item with photos and statuses. |
| `GET /queue?status=approved` | Items in a status. |
| `GET /decisions?status=pending` | Questions you still owe an answer on. |
| `POST /nudge` | Send the stale-approval nudge now. |
| `POST /propose-price-drops` | Run the weekly markdown pass now. |

## The poster's endpoints

| Route | Does |
|---|---|
| `POST /post-queue/claim` | Hands out one job: `{action: "delete" \| "edit" \| "post", item}`, or `{item: null, reason}`. Reasons: `empty`, `daily-cap`, `already-posting`, `auto-post-off`. |
| `POST /items/<slug>/posted` | `{fb_listing_url?, allow_no_url?}` The post is live. |
| `POST /items/<slug>/post-failed` | `{reason, checkpoint?}` Counts a strike. |
| `POST /items/<slug>/edited`, `/edit-failed` | A live edit finished or failed. |
| `POST /items/<slug>/removed`, `/remove-failed` | A delete finished or failed. |
| `POST /items/<slug>/link` | Record a listing's Facebook link. |
| `POST /items/<slug>/ask` | Raise a Telegram question. `{kind, question, body?, choices: [{key, text}], payload?}` |
| `POST /inbox/report` | `{threads: [{thread_key, thread_url, buyer_name, listing_title, messages: [{dir: "in" \| "out", body}]}]}` Drafts a reply card for each thread where the buyer spoke last. |
| `POST /inbox/claim` | Hands out one approved reply: `{reply: {id, thread_key, thread_url, buyer_name, text}}`, or `{reply: null, reason}`. |
| `POST /inbox/<id>/sent` | The reply is in the chat. Books the pickup if it confirmed one. |
| `POST /inbox/<id>/failed` | `{reason, checkpoint?, definitely_not_sent?}` |
| `POST /notify` | `{text}` A plain message to your Telegram (e.g. "Chrome is signed out"). |
| `POST /meetup-tick` | Run the pickup reminder / "did it sell?" pass now. |

## Item management

| Route | Does |
|---|---|
| `POST /items` | `{slug, notes?}` Make an item by hand. |
| `POST /items/<slug>/photos?ord=0&ext=jpg` | Raw image bytes as the body. |
| `POST /items/<slug>/research` | Run the Claude research again and send a card. |
| `POST /items/<slug>/propose` | Skip the AI and send a card with your own `{title, description, price_ask, price_floor, category?, condition?}`. |
| `POST /items/<slug>/edit` | `{title, description, price_ask}` Update; a live listing gets an edit queued. |
| `POST /items/<slug>/remove` | Delete from Facebook (or archive if never posted). |
| `POST /items/<slug>/sold` | `{sold_price, buyer_note?}` Log a sale. |
| `POST /items/<slug>/status` | `{status, note?}` Manual state fix. Every change is logged. |

Item history lives in the `events` table:

```
npx wrangler d1 execute sellstuff --remote --command "SELECT * FROM events WHERE item_id=(SELECT id FROM items WHERE slug='SLUG') ORDER BY id"
```
