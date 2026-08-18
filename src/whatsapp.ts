import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  type WASocket,
  type proto,
} from "baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import qrcode from "qrcode-terminal";
import { config } from "./config.js";
import { isAdminAddEvent, isSameJid } from "./jid.js";
import type { ChatMessage, PollData } from "./types.js";
import type { Transport, GroupAddHandler } from "./transport.js";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

// Module-level connection state — updated on connect/disconnect
let currentSock: WASocket | null = null;
let connected = false;

// Watchdog: force reconnect if no messages received for too long.
// Baileys keepalive only checks ping/pong — a "zombie" socket can pass
// keepalive checks while silently dropping incoming messages.
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // check every 5 min
const WATCHDOG_TIMEOUT_MS = 60 * 60 * 1000;  // reconnect if no messages for 1 hour
let lastMessageReceived = Date.now();
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

export function isConnected(): boolean {
  return connected && currentSock !== null;
}

export function getCurrentSocket(): WASocket | null {
  return currentSock;
}

export type MessageHandler = (messages: ChatMessage[]) => void;
export type OutgoingDmHandler = (dmJid: string) => void;

/**
 * The bot's own known identities. sock.user is a Contact carrying .id (either form),
 * .lid (@lid) and .jid (@s.whatsapp.net) for the same account; group participants
 * arrive as @lid, so all forms are needed to reliably recognise ourselves.
 */
function ownJids(sock: WASocket): string[] {
  const user = sock.user;
  if (!user) return [];
  return [user.id, user.lid, user.jid].filter((j): j is string => !!j);
}

/**
 * Persistent WhatsApp connection with auto-reconnect.
 * Calls onMessage for incoming messages, onOutgoingDm when we send a DM,
 * onGroupAdd when the bot is added to a group.
 */
export async function startConnection(
  onMessage: MessageHandler,
  onOutgoingDm?: OutgoingDmHandler,
  onGroupAdd?: GroupAddHandler
): Promise<WASocket> {
  let { version } = await fetchLatestBaileysVersion();
  console.log("Using WA Web version:", version.join("."));

  const startSocket = async (): Promise<WASocket> => {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

    const sock = makeWASocket({
      auth: state,
      logger,
      version,
      markOnlineOnConnect: false,
    });

    currentSock = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\nScan this QR code with WhatsApp on the Kleinbot phone:");
        console.log("(Linked Devices → Link a Device)\n");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        connected = true;
        lastMessageReceived = Date.now();
        console.log("Connected to WhatsApp");

        // Start watchdog for zombie socket detection
        if (watchdogTimer) clearInterval(watchdogTimer);
        watchdogTimer = setInterval(() => {
          if (!connected) return;
          const silent = Date.now() - lastMessageReceived;
          if (silent > WATCHDOG_TIMEOUT_MS) {
            console.log(`Watchdog: no messages for ${Math.round(silent / 60000)}m, forcing reconnect...`);
            sock.end(undefined);
          }
        }, WATCHDOG_INTERVAL_MS);
      } else if (connection === "close") {
        if (watchdogTimer) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
        }
        connected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          console.error("Logged out — delete data/auth/ and re-pair");
          process.exit(1);
        }
        // Auto-reconnect for any other close reason
        console.log(`Disconnected (status ${statusCode}), reconnecting in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
        // Re-fetch version on 405 (version rejected by WhatsApp)
        if (statusCode === 405) {
          try {
            const fresh = await fetchLatestBaileysVersion();
            version = fresh.version;
            console.log("Re-fetched WA Web version:", version.join("."));
          } catch (err) {
            console.error("Failed to fetch latest version, retrying with current:", err);
          }
        }
        startSocket();
      }
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      // Detect outgoing DMs for auto-approve
      if (onOutgoingDm) {
        for (const msg of messages) {
          if (msg.key.fromMe && msg.key.remoteJid?.endsWith("@s.whatsapp.net")) {
            onOutgoingDm(msg.key.remoteJid);
          }
        }
      }

      const extracted = extractMessages(messages, sock.user?.id || "");
      if (extracted.length > 0) {
        lastMessageReceived = Date.now();
        onMessage(extracted);
      }
    });

    // The admin adding the bot to a group is explicit approval of that group.
    // Only arrives while connected — an add that happens while the daemon is down
    // produces no event, so the approval gate remains the fallback.
    if (onGroupAdd) {
      sock.ev.on("group-participants.update", (evt) => {
        const botJids = ownJids(sock);
        const aboutUs = evt.action === "add"
          && evt.participants.some((p) => botJids.some((self) => isSameJid(p, self)));
        if (!aboutUs) return;

        const addedByAdmin = isAdminAddEvent(evt, botJids, config.adminJid);
        // Log the raw author whenever we do NOT auto-approve: if the JID namespace ever
        // differs from ADMIN_JID this check silently never fires, and this line is the
        // only way to tell that apart from "a stranger added me".
        if (!addedByAdmin) {
          console.log(
            `[group-add] Added to ${evt.id} by ${evt.author} — not the configured admin `
            + `(${config.adminJid || "unset"}); group stays gated.`
          );
        }
        onGroupAdd({ chatId: evt.id, addedBy: evt.author, addedByAdmin });
      });
    }

    // Catch up on messages missed while offline (history sync on reconnect)
    sock.ev.on("messaging-history.set", ({ messages }) => {
      const extracted = extractMessages(messages, sock.user?.id || "");
      if (extracted.length > 0) {
        console.log(`[history-sync] Processing ${extracted.length} missed message(s)`);
        onMessage(extracted);
      }
    });

    return sock;
  };

  return startSocket();
}

export function extractMessages(
  messages: proto.IWebMessageInfo[],
  botJid: string
): ChatMessage[] {
  const results: ChatMessage[] = [];

  for (const msg of messages) {
    if (msg.key.fromMe) continue;

    const chatJid = msg.key.remoteJid;
    if (!chatJid) continue;

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text;
    if (!text) continue;

    const timestamp = typeof msg.messageTimestamp === "number"
      ? msg.messageTimestamp
      : Number(msg.messageTimestamp);

    // In groups, participant is the sender; in DMs, remoteJid is the sender
    const senderJid = msg.key.participant || chatJid;

    results.push({
      id: msg.key.id || `${timestamp}-${senderJid}`,
      chatJid,
      timestamp,
      sender: msg.pushName || senderJid.split("@")[0],
      senderJid,
      text,
      quotedText: msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ?? undefined,
      mentionedJids: msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? undefined,
    });
  }

  return results.sort((a, b) => a.timestamp - b.timestamp);
}

export async function fetchGroupDescription(
  sock: WASocket,
  jid: string
): Promise<{ subject: string; description: string } | null> {
  try {
    const meta = await sock.groupMetadata(jid);
    return {
      subject: meta.subject || "",
      description: meta.desc || "",
    };
  } catch (err) {
    console.error(`Failed to fetch group metadata for ${jid}:`, err);
    return null;
  }
}

export async function sendTextMessage(
  sock: WASocket,
  jid: string,
  text: string
): Promise<void> {
  await sock.sendMessage(jid, { text });
}

export async function sendDocumentMessage(
  sock: WASocket,
  jid: string,
  buffer: Buffer,
  fileName: string,
  mimetype: string,
  caption?: string
): Promise<void> {
  await sock.sendMessage(jid, { document: buffer, mimetype, fileName, caption });
}

export async function sendPollMessage(
  sock: WASocket,
  jid: string,
  poll: PollData
): Promise<void> {
  await sock.sendMessage(jid, {
    poll: {
      name: poll.question,
      values: poll.options.slice(0, 12).map(o => o.slice(0, 100)),
      selectableCount: poll.multiSelect ? 0 : 1,
    },
  });
}

/**
 * Factory: wraps the module-level WhatsApp connection into a Transport.
 */
export function createWhatsAppTransport(
  onOutgoingDm?: (dmJid: string) => void,
): Transport {
  // Captured before start() so the daemon can register its handler at construction
  // time; startConnection() reads it when the socket is created (and on reconnect).
  let groupAddHandler: GroupAddHandler | undefined;

  return {
    name: "whatsapp",

    async start(onMessage) {
      await startConnection(onMessage, onOutgoingDm, (evt) => groupAddHandler?.(evt));
    },

    onGroupAdd(handler) {
      groupAddHandler = handler;
    },

    isConnected() {
      return connected && currentSock !== null;
    },

    async sendText(chatId, text) {
      await sendTextMessage(currentSock!, chatId, text);
    },

    async sendFile(chatId, buffer, fileName, mimetype, caption) {
      await sendDocumentMessage(currentSock!, chatId, buffer, fileName, mimetype, caption);
      return true;
    },

    async sendPoll(chatId, poll) {
      await sendPollMessage(currentSock!, chatId, poll);
      return true;
    },

    isDm(chatId) {
      // WhatsApp DMs: classic format (@s.whatsapp.net) or LID format (@lid)
      return chatId.endsWith("@s.whatsapp.net") || chatId.endsWith("@lid");
    },

    isGroup(chatId) {
      return chatId.endsWith("@g.us");
    },

    async fetchGroupDescription(chatId) {
      if (!currentSock) return null;
      return fetchGroupDescription(currentSock, chatId);
    },

    shutdown() {
      currentSock?.end(undefined);
    },
  };
}
