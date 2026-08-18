# Plan: Tool Profiles for Programmatic Claude Agents

**Date:** 2026-03-25
**Status:** Draft — awaiting security review

## The Problem

Every project that spawns `claude --print` faces the same question: what tools should the agent have access to? The current approaches are:

- **Too restrictive:** Kleinbot grants only `WebSearch,WebFetch` — can't run research scripts
- **Too permissive:** Vibefeld uses `--dangerously-skip-permissions` — agents can do anything

The solution is `--allowedTools` with explicit scoping. This is **hard-enforced** by Claude Code at runtime (not a prompt hint). Shell operators like `&&`, `||`, `;` are detected and blocked. Each callsite gets exactly the tools it needs.

## How `--allowedTools` Works

```bash
# Grant specific tools
claude --print --allowedTools "WebSearch,WebFetch"

# Grant Bash restricted to specific commands
claude --print --allowedTools "Bash(python3 /path/to/script *)"

# Grant file access restricted to specific paths
claude --print --allowedTools "Read,Write(data/output/*)"

# Combine them
claude --print --allowedTools "Read,Write(data/*),Bash(af *),Bash(python3 *)"
```

Enforcement is at the Claude Code runtime level:
- Commands are parsed and validated **before execution**
- `Bash(safe-cmd *) ` blocks `safe-cmd foo && cat /etc/passwd`
- Pattern matching is strict about word boundaries and operators

## Tool Profiles by Project

### Kleinbot

| Task | Current | Proposed |
|------|---------|----------|
| Chat response | `WebSearch,WebFetch` | No change |
| Morning briefing | `WebSearch,WebFetch` | No change |
| Moltbook cycle | _(none)_ | No change |
| `/social` research | _(doesn't exist)_ | See "Kleinbot Research" below |

### Vibefeld

| Task | Current | Proposed |
|------|---------|----------|
| ralph.sh (orchestrator) | `--dangerously-skip-permissions` | `Read,Write,Edit,Glob,Grep,Bash(af *),Bash(python3 *),Agent` |
| auto-prove.sh (prover agents) | `--dangerously-skip-permissions` | `Read,Bash(af *)` |

The vibefeld agents work exclusively through the `af` CLI tool (`af claim`, `af refine`, `af release`). They don't need unrestricted Bash — they need `Bash(af *)` and `Read` to inspect node content. The orchestrator (ralph) needs broader access to coordinate, but still scoped.

**Note:** The vibefeld profiles need validation against actual agent behaviour. The `af` tool may invoke subcommands that need additional patterns. Test with `--allowedTools` first and see what gets blocked.

### Another local service (reference)

Already uses explicit tools: `Read,Write,Edit,Bash,Glob,Grep`. Bash is unrestricted here, which may be acceptable since that service processes trusted direct input from its own user. Worth reviewing separately.

---

## Kleinbot Research Feature

### User-facing command

```
/social openai pentagon deal
```

Triggers a last30days multi-source research run and returns synthesised results.

### Architecture: Daemon-Controlled (no Bash for Claude)

The daemon handles script invocation directly. Claude only synthesises the output. This is the safest approach because Claude never gets Bash access when processing untrusted chat messages.

```
User sends: /social openai pentagon deal
    ↓
Daemon detects /social trigger (TypeScript regex)
Daemon checks: chat has "research": true in config
Daemon sends "Researching..." placeholder to chat
    ↓
Daemon sanitises topic: strip non-alphanumeric (except spaces, hyphens), cap at 200 chars
Daemon spawns Python script directly (no Claude):
    python3 ~/.claude/skills/last30days/scripts/last30days.py \
        "openai pentagon deal" --agent --emit=compact --quick
    ↓
Script runs (30-90s with --quick), returns compact results to stdout
    ↓
Daemon feeds results to claude --print (WebSearch,WebFetch only — NO Bash):
    System prompt: research synthesis instructions
    User prompt: "Synthesise these findings into a conversational response: {script output}"
    ↓
Claude synthesises, returns JSON response
Daemon sends to chat
```

**Why this over giving Claude Bash access:**
- Untrusted messages never reach a Bash-capable agent
- Topic sanitisation is in TypeScript (our code), not Claude's judgement
- Script invocation is hardcoded, not constructed by the model
- Same `WebSearch,WebFetch` profile as normal chat — no privilege escalation
- Claude can still do supplementary web searches during synthesis

### Per-chat config

```json
{
  "120363000000000000@g.us": {
    "prompt": "prompts/default.md",
    "model": "opus",
    "research": true
  }
}
```

Only chats with `"research": true` can trigger `/social`. Others get no response.

### Changes to `src/ai.ts`

New function — runs the script directly, feeds output to Claude for synthesis:

```typescript
import { execFile } from "child_process";

const LAST30DAYS_SCRIPT = path.join(
  os.homedir(), ".claude/skills/last30days/scripts/last30days.py"
);

export async function runResearch(
  topic: string,
  chatConfig: ChatConfig,
  chatJid: string
): Promise<ClaudeResponse> {
  // 1. Sanitise topic (daemon-controlled, not Claude)
  const sanitised = topic.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 200);

  // 2. Run script directly (no Claude involvement)
  const scriptOutput = await new Promise<string>((resolve, reject) => {
    execFile("python3", [
      LAST30DAYS_SCRIPT, sanitised,
      "--agent", "--emit=compact", "--quick",
    ], {
      timeout: 120_000,  // 2 min for --quick
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`last30days failed: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
  });

  // 3. Feed output to Claude for synthesis (WebSearch,WebFetch only — no Bash)
  const systemPrompt = fs.readFileSync(
    path.resolve(projectRoot, "prompts/research.md"), "utf-8"
  );

  const prompt = [
    `Research topic: ${sanitised}`,
    "",
    "## Raw research data (from multi-source scan)",
    scriptOutput.slice(0, 50_000),  // cap output fed to Claude
    "",
    "Synthesise these findings into a conversational response.",
    "Include key highlights, notable discussions, and any consensus or controversy.",
    "Cite sources where possible (subreddit names, X handles, YouTube channels).",
    "Reply ONLY with valid JSON (no markdown fences):",
    '{"shouldRespond": true, "response": "your synthesised findings"}',
  ].join("\n");

  // Same spawn pattern as askClaude(), same tool profile as normal chat
  const result = await new Promise<string>((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, [
      "--print",
      "--model", chatConfig.model,
      "--no-session-persistence",
      "--system-prompt", systemPrompt,
      "--allowedTools", "WebSearch,WebFetch",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000,
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`claude exited with code ${code}`));
      else resolve(stdout.trim());
    });

    proc.on("error", reject);
    proc.stdin.write(prompt);
    proc.stdin.end();
  });

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { shouldRespond: false };
    return JSON.parse(jsonMatch[0]) as ClaudeResponse;
  } catch {
    return { shouldRespond: false };
  }
}
```

### Changes to daemon (transport entry points)

In the message processing loop, before `askClaude()`:

```typescript
// Check for /social command
const researchMatch = latestMessage?.text?.match(
  /^\/(social|research)\s+(.+)/i
);

if (researchMatch && chatConfig.research) {
  const topic = researchMatch[2].trim();
  console.log(`[research] Running last30days for "${topic}" in ${chatJid}`);

  // Send placeholder immediately
  await transport.sendText(chatJid, `Researching "${topic}" across Reddit, X, YouTube, HN, and more. This takes 1-2 minutes...`);

  try {
    const result = await runResearch(topic, chatConfig, chatJid);
    if (result.shouldRespond && result.response) {
      await transport.sendText(chatJid, result.response);
    } else {
      await transport.sendText(chatJid, "Research completed but I couldn't synthesise a useful response. Try a more specific topic.");
    }
  } catch (err) {
    console.error(`[research] Failed:`, err);
    await transport.sendText(chatJid, "Research failed — the script timed out or encountered an error.");
  }
  return;
}
```

### Rate limiting

```typescript
const researchCooldowns = new Map<string, number>();
const RESEARCH_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// Before running research:
const lastRun = researchCooldowns.get(chatJid) || 0;
if (Date.now() - lastRun < RESEARCH_COOLDOWN_MS) {
  await transport.sendText(chatJid, "Research is rate-limited to once per 10 minutes. Try again later.");
  return;
}
researchCooldowns.set(chatJid, Date.now());
```

---

## Security Analysis

### Threat model

Kleinbot processes **untrusted messages** from WhatsApp/Signal users. An attacker could:

1. Craft a `/social` topic string to exploit the Python script's argument parser
2. Abuse research to burn API rate limits
3. Use research output to exfiltrate information via Claude's synthesis

### Mitigations

| Threat | Mitigation | Residual risk |
|--------|-----------|---------------|
| Shell injection via topic | Daemon sanitises topic in TypeScript (`[^a-zA-Z0-9 _-]` stripped); script invoked via `execFile` (no shell) | Python's argparse receives sanitised string — low risk |
| Claude runs unintended Bash | Claude never gets Bash access — same `WebSearch,WebFetch` as normal chat | None — no privilege escalation |
| API rate limit abuse | 10-minute per-chat cooldown; `--quick` flag limits API calls | Determined attacker in multiple chats could still burn quota |
| API key exposure | Keys loaded by Python script internally; never in prompts or Claude output | Script error messages could theoretically leak partial keys — review last30days error handling |
| Prompt injection via research output | Claude synthesises script output, which contains untrusted web content | Mark research data as untrusted in synthesis prompt; Claude already has prompt injection defences |
| Per-chat access control | `"research": true` required in chat config | Admin must explicitly enable; off by default |

### What's NOT in scope

- The last30days script itself — it's third-party (MIT, mvanhorn), installed via ClawHub. We treat it as a trusted dependency. Its own security is out of scope for this review, though we should review its error output for key leakage.
- The `~/.config/last30days/.env` credentials — these are user-managed. We just ensure they're never passed through Claude.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `prompts/research.md` | Create | Synthesis prompt for research results |
| `src/ai.ts` | Modify | Add `runResearch()` function |
| `src/types.ts` | Modify | Add `research?: boolean` to `ChatConfig` |
| `src/index-whatsapp.ts` | Modify | Add `/social` trigger + rate limiting |
| `src/index-signal.ts` | Modify | Same |
| `prompts/chats.json` | Modify | Add `research: true` to enabled chats |
| `CLAUDE.md` | Modify | Document `/social` command and tool profiles |

## Implementation Order

1. Write `prompts/research.md` (synthesis instructions)
2. Add `runResearch()` to `ai.ts` (daemon-controlled script invocation)
3. Add `ChatConfig.research` to types
4. Add `/social` trigger + rate limiting to transport entry points
5. Enable on one test chat, run `/social` with `--quick`
6. Review output for key leakage or unexpected content
7. Enable on remaining chats

## Vibefeld Follow-Up

Separate task: replace `--dangerously-skip-permissions` in `ralph.sh` and `auto-prove.sh` with scoped `--allowedTools`. Needs its own plan since the required tools depend on what `af` subcommands the agents actually invoke. Suggested starting point:

```bash
# ralph.sh (orchestrator)
--allowedTools "Read,Write,Edit,Glob,Grep,Bash(af *),Bash(python3 *),Agent"

# auto-prove.sh (prover agents)
--allowedTools "Read,Bash(af *)"
```

Test by running a proof cycle and seeing what gets blocked.
