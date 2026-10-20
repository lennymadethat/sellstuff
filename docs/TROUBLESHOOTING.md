# When it goes quiet

Work down this list.

| Symptom | Likely cause | Fix |
|---|---|---|
| You send photos, no card comes back | Anthropic account is out of credit, or `ANTHROPIC_API_KEY` is wrong. You should still get an error message in Telegram. | Add credit, or `npx wrangler secret put ANTHROPIC_API_KEY`. Then reply `redo`. |
| The bot never answers at all | The webhook isn't set, or the secret doesn't match. | `GET /admin/webhook-info` shows Telegram's last error. Re-run `POST /admin/set-webhook`. |
| The bot replies "Your chat id is ..." | `TELEGRAM_CHAT_ID` isn't set. | `npx wrangler secret put TELEGRAM_CHAT_ID` with that number. |
| Cards arrive as text with no photo | Telegram couldn't fetch the photo link. | Set `WORKER_URL` in `wrangler.toml` and redeploy. Check `IMG_TOKEN` is set. |
| You tapped Approve, nothing posts | `AUTO_POST_FB` isn't `"on"`, the poster isn't running, or it is halted. | `powershell -File poster/install.ps1 -Status` shows all three. |
| Approved items sit there | Claims return `already-posting`, `auto-post-off`, or `daily-cap` (only if you set `MAX_POSTS_PER_DAY`). | The poster log says which. A cap resets at midnight UTC. |
| It mentions a listing you already took down | The poster hasn't synced since (it needs to be signed in). | Check the log for `sync:` lines. It syncs on start and every 6 hours. |
| Poster says the profile isn't signed in | The Facebook session expired. | `node login.mjs` in `poster/`, sign in by hand. |
| `*** LANE HALTED ***` | Facebook showed a checkpoint. Screenshots are in `poster/logs/shots/`. | Sort it out in Chrome yourself, then `install.ps1 -Resume`. |
| Buyers message you but no reply cards come | The poster only reads chats between listings, and only while signed in. `buyers` in Telegram lists what is waiting. | Check the poster log for `inbox:` lines. Run `npm run db:buyers` if you upgraded from an older copy. |
| A reply card says it couldn't send | The chat wouldn't open, or the poster couldn't see its message afterwards. | Open the chat in Messenger. If it went out, do nothing; if not, send it yourself or reply to the card with the text. |
| An item is `needs_attention` | It failed 3 times. The reason is in `status` and `why`. | Fix the cause (try `category Tools`), then send `retry`. |
| Nothing at all is happening, and no errors | Cards waiting on your tap. | `GET /stats`: `pending > 0` with `approved: 0` means it is waiting on you. The daily nudge names them. |
| An edit or delete keeps failing with "which listing" | Two near-identical listings. | Answer the Telegram question; your pick is remembered. |

## Restarting the poster

`run-poster.cmd` is a supervisor. Kill the `node` process and it respawns 30
seconds later with whatever is on disk. That is the right way to pick up a code
change.

Don't launch the startup `.vbs` to "restart" it. The supervisor is already
running, and a second one gives you two pollers racing one Chrome profile. Check
there is exactly one:

```
powershell -File poster/install.ps1 -Status
```

## Running the poster by hand

```
node poster.mjs --once --dry   # claim one item, fill the form, STOP at Publish
node poster.mjs --once         # claim one item and actually post it
node poster.mjs                # the loop
```

Set `SELLSTUFF_WATCH=1` in `poster/.env` to bring the Chrome window on screen
and watch a run. Normally it is parked off-screen so it doesn't steal focus.

## Repairing missing links

```
node backfill-permalinks.mjs --dry   # report only
node backfill-permalinks.mjs         # record resolved links
```

Read-only against Facebook. It writes only to your own database.

## Facebook changed the form

The poster fails loudly with the visible button names in the error, and the item
goes back through the strike counter. It never half-posts. Selectors in
`poster/fb.mjs` match on structure and visible label text, never on class names,
so they survive most redesigns. Hand an agent the error text and `fb.mjs`.
