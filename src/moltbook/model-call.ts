import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { modelConfig, researchConfig, tempDir, type ModelBackend } from "../config.js";
import { childEnvironment } from "../child-env.js";

export async function callModel(opts: {
  backend: ModelBackend; model: string; systemPrompt: string; prompt: string;
  tools: "none" | "web" | "research-read"; timeoutMs: number; outputSchemaFile?: string;
}): Promise<string> {
  if (opts.tools === "research-read" && opts.backend !== "claude") throw new Error("Research reads require Claude confinement");
  const cwd = opts.tools === "research-read" ? researchConfig.dir : undefined;
  if (cwd) {
    fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
    fs.mkdirSync(researchConfig.wikiDir, { recursive: true, mode: 0o700 });
  }
  const dir = opts.backend === "codex" ? fs.mkdtempSync(path.join(tempDir, "kleinbot-model-")) : undefined;
  const output = dir ? path.join(dir, "answer.txt") : "";
  const args = opts.backend === "claude"
    ? ["--print", "--model", opts.model, "--no-session-persistence", "--system-prompt", opts.systemPrompt,
      ...(opts.tools === "research-read"
        ? ["--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--restricted", "--safe-mode",
          "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands",
          "--permission-mode", "dontAsk", "--add-dir", researchConfig.dir, researchConfig.wikiDir]
        : ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--safe-mode", "--disable-slash-commands",
          ...(opts.tools === "none" ? ["--tools", ""] : ["--allowedTools", "WebSearch,WebFetch"])])]
    : ["exec", "-m", opts.model, "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral",
      ...modelConfig.codexDisableFeatures.flatMap(feature => ["--disable", feature]),
      "-C", dir!, "-o", output, ...(opts.outputSchemaFile ? ["--output-schema", opts.outputSchemaFile] : []), "-"];
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const proc = spawn(opts.backend === "claude" ? modelConfig.claudeBin : modelConfig.codexBin, args, {
        cwd, env: childEnvironment(opts.backend), stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
      });
      let stdout = "", stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        if (process.platform !== "win32" && proc.pid) {
          try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
        } else proc.kill("SIGKILL");
        proc.stdin.destroy();
        proc.stdout.destroy();
        proc.stderr.destroy();
        console.error(`[model] ${opts.backend}:`, stderr);
        reject(new Error(`${opts.backend} timed out`));
      }, opts.timeoutMs);
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 500); });
      proc.on("error", () => { clearTimeout(timer); reject(new Error(`${opts.backend} failed to start`)); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return;
        if (code !== 0) {
          console.error(`[model] ${opts.backend}:`, stderr);
          reject(new Error(`${opts.backend} exited with code ${code}`));
        } else resolve(stdout.trim());
      });
      proc.stdin.on("error", () => {});
      proc.stdin.end(opts.backend === "claude" ? opts.prompt : `${opts.systemPrompt}\n\n${opts.prompt}`);
    });
    return dir ? fs.readFileSync(output, "utf8").trim() : stdout;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}
