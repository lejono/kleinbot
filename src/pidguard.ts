import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { dataDir } from "./config.js";
import type { TransportName } from "./config.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid: number): void {
  // pkill -P kills all children, then we kill the parent
  try { execFileSync("pkill", ["-9", "-P", String(pid)], { stdio: "ignore" }); } catch { /* no children */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
}

function sleepMs(ms: number): void {
  try { execFileSync("sleep", [String(ms / 1000)], { stdio: "ignore" }); } catch { /* */ }
}

/**
 * Ensure only one daemon runs per transport.
 * Writes a PID file; on startup, kills any stale process holding it.
 */
export function acquirePidLock(transport: TransportName): void {
  const pidFile = path.join(dataDir, `${transport}.pid`);

  // Check for existing PID file
  try {
    const oldPid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
    if (oldPid && !isNaN(oldPid) && isAlive(oldPid)) {
      console.log(`Killing stale ${transport} daemon (PID ${oldPid})...`);
      killTree(oldPid);

      // Wait up to 3s for it to die
      const start = Date.now();
      while (Date.now() - start < 3000 && isAlive(oldPid)) {
        sleepMs(100);
      }

      if (isAlive(oldPid)) {
        console.error(`Failed to kill stale ${transport} daemon (PID ${oldPid})`);
        process.exit(1);
      }
    }
  } catch {
    // No PID file or parse error — first run
  }

  // Write our PID
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(process.pid));

  // Clean up on exit
  const cleanup = () => {
    try {
      const current = fs.readFileSync(pidFile, "utf-8").trim();
      if (current === String(process.pid)) {
        fs.unlinkSync(pidFile);
      }
    } catch {
      // Already gone
    }
  };

  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
}
