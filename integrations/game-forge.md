# Game Forge Integration

Edit games on Game Forge via WhatsApp messages to Kleinbot.

## Game Forge API

Game Forge runs at `http://localhost:3456` (local) or on Fly.io (production).

### Relevant Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/games` | List all games (grouped by user) |
| GET | `/games/{id}` | Load a specific game |
| POST | `/generate` | AI-powered game edit (SSE streaming) |
| POST | `/games/save` | Save game after edit |
| GET | `/status` | Server capabilities and budget info |

### Authentication

Headers on every request:
- `X-User` — username (e.g. "alex")
- `X-Auth` — password

### Generate Request

```
POST /generate
Content-Type: application/json
X-User: alex
X-Auth: <password>

{
  "message": "make the frog jump higher",
  "gameId": "1700000000000",
  "mode": "smart"
}
```

Response is SSE streamed:
```
data: {"type":"thinking","message":"Working on your game..."}
data: {"type":"result","data":{"type":"game","gameName":"Moon Frog","summary":"Made the frog faster...","code":"<!DOCTYPE html>..."}}
data: [DONE]
```

### Game File Format

JSON in `games/{username}/{id}.json`:
```json
{
  "id": "1700000000000",
  "name": "Moon Frog: Lost Caves",
  "code": "<!DOCTYPE html>...",
  "history": [...],
  "lastModified": "2025-12-22T08:48:40Z"
}
```

## Proposed WhatsApp UX

### Commands

- `game list` — list games for a user
- `game edit <name>: <instruction>` — edit a game by name
- `game status` — check if Game Forge is reachable and within budget

### Example Conversation

```
User: game list
Bot:  alex's games:
      1. Moon Frog: Lost Caves
      2. Star Racer
      3. Maze Runner

User: game edit Moon Frog: make the background purple and add stars
Bot:  Editing Moon Frog... (this takes a moment)
      Done! Changes:
      - Changed background from blue to purple
      - Added randomly placed stars that twinkle
      Play at: https://game-forge.example/play/moon-frog-123
```

## Design Decisions Needed

1. **User mapping** — How does a WhatsApp user map to a Game Forge user? Options:
   - Fixed mapping in config (WhatsApp JID -> Game Forge username)
   - Dedicated bot account that can edit any user's games
   - User specifies username in command (`game edit alex/Moon Frog: ...`)

2. **AI mode** — Which model handles the edit? Options:
   - Always `smart` (Game Forge decides complexity)
   - Configurable per chat in `chats.json`
   - Let user specify (`game edit Moon Frog (opus): make it harder`)

3. **Confirmation** — Edit immediately, or ask first?
   - For quick edits, just do it (versioning provides undo)
   - For destructive-sounding requests ("delete all enemies"), confirm

4. **Permissions** — Who can edit whose games?
   - Only the mapped user can edit their own
   - Parents (admin) can edit any child's games
   - Violence level settings still apply (enforced by Game Forge)

5. **Game Forge availability** — Is it always running?
   - If on Fly.io: yes, but may have cold starts
   - If local only: Kleinbot needs to handle "Game Forge is offline" gracefully

## Implementation Notes

- Consume SSE stream from `/generate` — collect chunks until `[DONE]`
- After successful generate, call `/games/save` to persist
- Game Forge already handles versioning (auto-backup before save)
- Budget enforcement is server-side — Kleinbot just forwards the error if over budget
- Consider a timeout (~60s) for AI generation — Opus can be slow on complex edits
