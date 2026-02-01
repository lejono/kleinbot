# TODO

## Feature Requests

- **Image support** — Download and process images sent in WhatsApp messages. Baileys provides `downloadMediaMessage()` to get the image buffer. Main challenge: `claude --print` doesn't accept image input, so this would require switching to the Anthropic API SDK (which accepts base64 images in the messages array) or finding another way to pass images to Claude.

## Bugs / Improvements

- **Cache Claude response on send failure** — When `sendTextMessage` fails and messages are re-queued, the next cycle calls Claude again from scratch, wasting an API call to regenerate a response that was already good. Should cache the decision and retry just the send.
- **Check connection health before processing** — The bot processes pending messages on a timer regardless of whether the WhatsApp socket is connected. Should skip processing (or delay) when the connection is down to avoid repeated fail/retry loops.
