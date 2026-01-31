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
import type { ChatMessage, PollData } from "./types.js";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

export type MessageHandler = (messages: ChatMessage[]) => void;
export type OutgoingDmHandler = (dmJid: string) => void;

/**
 * Persistent WhatsApp connection with auto-reconnect.
 * Calls onMessage for incoming messages, onOutgoingDm when we send a DM.
 */
export async function startConnection(
  onMessage: MessageHandler,
  onOutgoingDm?: OutgoingDmHandler
): Promise<WASocket> {
  const { version } = await fetchLatestBaileysVersion();
  console.log("Using WA Web version:", version.join("."));

  const startSocket = async (): Promise<WASocket> => {
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

    const sock = makeWASocket({
      auth: state,
      logger,
      version,
      markOnlineOnConnect: false,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\nScan this QR code with WhatsApp on the Kleinbot phone:");
        console.log("(Linked Devices → Link a Device)\n");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("Connected to WhatsApp");
      } else if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          console.error("Logged out — delete data/auth/ and re-pair");
          process.exit(1);
        }
        // Auto-reconnect for any other close reason
        console.log(`Disconnected (status ${statusCode}), reconnecting in 5s...`);
        await new Promise(r => setTimeout(r, 5000));
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
        onMessage(extracted);
      }
    });

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

export async function sendTextMessage(
  sock: WASocket,
  jid: string,
  text: string
): Promise<void> {
  await sock.sendMessage(jid, { text });
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
