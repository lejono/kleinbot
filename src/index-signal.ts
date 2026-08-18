import { initConfig } from "./config.js";
import { createSignalTransport } from "./signal.js";
import { startDaemon } from "./daemon.js";
import { acquirePidLock } from "./pidguard.js";

initConfig("signal");
acquirePidLock("signal");

startDaemon({
  createTransport: (hooks) => createSignalTransport(hooks?.onOutgoingDm),
  enableMoltbook: true,
  enableBriefing: true,
  dmAccessControl: true,
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
