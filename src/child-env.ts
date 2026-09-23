// Environment for model child processes (claude, codex). Only an allowlist is passed on:
// the bot's own secrets and routing settings (Signal, admin, entourage, roam, Moltbook)
// never reach a model process, and each backend sees only its own credentials.
// MODEL_CHILD_ENV_ALLOW adds names (comma-separated), for example cloud-provider credentials.
export type ChildBackend = "claude" | "codex";

export const baseEnvNames = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "TZ", "KLEINBOT_TEMP_DIR",
  // Network settings a model CLI needs behind a proxy or a private CA.
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS"];

export function childEnvironment(backend: ChildBackend): NodeJS.ProcessEnv {
  const allowed = new Set([...baseEnvNames, ...(process.env.MODEL_CHILD_ENV_ALLOW || "").split(",").map(name => name.trim())]);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name === "MOLTBOOK_API_KEY" || name === "CLAUDECODE" || /^(ROAM_|SIGNAL_|ADMIN_|ENTOURAGE_)/.test(name)) continue;
    if (backend === "claude" ? /^(OPENAI_|CODEX_)/.test(name) : /^(CLAUDE_|ANTHROPIC_)/.test(name)) continue;
    const backendAllowed = backend === "claude" ? /^(CLAUDE_CODE_|ANTHROPIC_)/.test(name) || name === "CLAUDE_CONFIG_DIR"
      : name === "OPENAI_API_KEY" || name.startsWith("CODEX_");
    if (allowed.has(name) || backendAllowed) env[name] = value;
  }
  return env;
}
