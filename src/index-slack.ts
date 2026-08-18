import { initConfig } from "./config.js";
import { createSlackTransport } from "./slack.js";
import { startDaemon } from "./daemon.js";
import { acquirePidLock } from "./pidguard.js";

initConfig("slack");
acquirePidLock("slack");

startDaemon({
  createTransport: () => createSlackTransport(),
  enableMoltbook: false,
  enableBriefing: false,
  dmAccessControl: false,
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
