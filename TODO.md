# TODO

## Feature Requests

- **Full notes history, bounded reads** — `saveNotes` (`src/ai.ts:102-115`) enforces `MAX_NOTES_LINES = 50` at *write* time, so line 51 is deleted, not just unread. Keep an append-only archive and have `readNotes` return only the last 50 entries, so prompt size is unchanged. Months of notes can be silently lost this way.
- **Handle @-mentions on arrival, not on the next tick** — `PROCESS_INTERVAL` is 10 min, so a direct mention of the bot can sit that long before anything happens, which in a live conversation is indistinguishable from being ignored. `mentionedJids` is already on the queued message, so triggering an immediate cycle for mentions and DMs is cheap; keep the 10-min batch for everything else.
- **Image support** — Download and process images sent in WhatsApp messages. Baileys provides `downloadMediaMessage()` to get the image buffer. Main challenge: `claude --print` doesn't accept image input, so this would require switching to the Anthropic API SDK (which accepts base64 images in the messages array) or finding another way to pass images to Claude.
- **Roam mode: more than one pipe group** — today the comms daemon pipes exactly one chat (`ROAM_PIPE_CHAT_JID`) to the roam daemon. Let a second group (for example the one that receives the daily briefing) be handed to the roam daemon too, so replies there are answered from the research side instead of the comms model. Every piped group is trusted, as now. Needs: inbox messages tagged with their source group; one outbox reply channel per group, recipient pinned by folder as now; per-group chat log, group page and log lines (new groups start with empty notes). The inbox-format change touches `onNewMessages` in `src/daemon.ts` and keeps the existing order: after the access gate and raw capture, before any comms-model processing.

## Bugs / Improvements

- ~~**Copy inbound attachments to a durable store at flag time** — fixed: flagged attachments are copied into the flag dir's attachments/ store~~
- **Emit `task` flags for reminders/action points given in chat** — a
  reminder or to-do sent to the bot in conversation is currently answered
  conversationally but raises no flag, so no downstream agent ever
  schedules it. The chat prompt should emit a `task` flag (type exists in
  the shared schema) alongside its reply.

- **Messages permanently destroyed by a short API outage** — a ~20 min upstream 529 window is enough to destroy queued messages. Three defects: `MAX_RETRIES = 3` at one retry per 10-min cycle (`src/daemon.ts:43`) cannot outlive even a brief incident; `src/ai.ts:237` logs only stderr while `claude --print` writes API errors to stdout, so the error line was blank and the cause invisible; and on drop `src/daemon.ts:410-418` calls `markProcessed()`, making the loss permanent with no alert to the admin.
- ~~**Cache Claude response on send failure** — fixed: cached decisions are reused on retry~~
- ~~**Check connection health before processing** — fixed: skips processing when disconnected~~
- ~~**Stale socket after reconnect** — fixed: `getCurrentSocket()` always returns the active socket~~
