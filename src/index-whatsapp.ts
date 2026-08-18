import { initConfig } from "./config.js";
import { createWhatsAppTransport } from "./whatsapp.js";
import { startDaemon } from "./daemon.js";
import { acquirePidLock } from "./pidguard.js";

initConfig("whatsapp");
acquirePidLock("whatsapp");

startDaemon({
  createTransport: (hooks) => createWhatsAppTransport(hooks?.onOutgoingDm),
  enableMoltbook: true,
  enableBriefing: true,
  dmAccessControl: true,
}).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
