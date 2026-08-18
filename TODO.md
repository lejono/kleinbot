# TODO

## Feature Requests

- **Full notes history, bounded reads** — `saveNotes` (`src/ai.ts:102-115`) enforces `MAX_NOTES_LINES = 50` at *write* time, so line 51 is deleted, not just unread. Keep an append-only archive and have `readNotes` return only the last 50 entries, so prompt size is unchanged. Months of notes can be silently lost this way.
- **Handle @-mentions on arrival, not on the next tick** — `PROCESS_INTERVAL` is 10 min, so a direct mention of the bot can sit that long before anything happens, which in a live conversation is indistinguishable from being ignored. `mentionedJids` is already on the queued message, so triggering an immediate cycle for mentions and DMs is cheap; keep the 10-min batch for everything else.
- **Image support** — Download and process images sent in WhatsApp messages. Baileys provides `downloadMediaMessage()` to get the image buffer. Main challenge: `claude --print` doesn't accept image input, so this would require switching to the Anthropic API SDK (which accepts base64 images in the messages array) or finding another way to pass images to Claude.

## Bugs / Improvements

- **Messages permanently destroyed by a short API outage** — a ~20 min upstream 529 window is enough to destroy queued messages. Three defects: `MAX_RETRIES = 3` at one retry per 10-min cycle (`src/daemon.ts:43`) cannot outlive even a brief incident; `src/ai.ts:237` logs only stderr while `claude --print` writes API errors to stdout, so the error line was blank and the cause invisible; and on drop `src/daemon.ts:410-418` calls `markProcessed()`, making the loss permanent with no alert to the admin.
- ~~**Cache Claude response on send failure** — fixed: cached decisions are reused on retry~~
- ~~**Check connection health before processing** — fixed: skips processing when disconnected~~
- ~~**Stale socket after reconnect** — fixed: `getCurrentSocket()` always returns the active socket~~
