import { initConfig } from "./config.js";
import { createDiscordTransport } from "./discord.js";
import { startDaemon } from "./daemon.js";
import { acquirePidLock } from "./pidguard.js";

initConfig("discord");
acquirePidLock("discord");

startDaemon({
  createTransport: (hooks) => createDiscordTransport(hooks?.onOutgoingDm),
  enableMoltbook: false,
  enableBriefing: false,
  dmAccessControl: true,
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
