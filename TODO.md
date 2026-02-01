# TODO

## Feature Requests

- **Image support** — Download and process images sent in WhatsApp messages. Baileys provides `downloadMediaMessage()` to get the image buffer. Main challenge: `claude --print` doesn't accept image input, so this would require switching to the Anthropic API SDK (which accepts base64 images in the messages array) or finding another way to pass images to Claude.

## Bugs / Improvements

- ~~**Cache Claude response on send failure** — fixed: cached decisions are reused on retry~~
- ~~**Check connection health before processing** — fixed: skips processing when disconnected~~
- ~~**Stale socket after reconnect** — fixed: `getCurrentSocket()` always returns the active socket~~
