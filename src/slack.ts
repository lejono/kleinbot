import { App } from "@slack/bolt";
import { config } from "./config.js";
import type { ChatMessage } from "./types.js";
import type { Transport, MessageHandler } from "./transport.js";

/**
 * Create a Slack transport using Socket Mode via @slack/bolt.
 */
export function createSlackTransport(): Transport {
  let app: App;
  let connected = false;

  return {
    name: "slack",

    async start(onMessage: MessageHandler) {
      app = new App({
        socketMode: true,
        appToken: config.slackAppToken,
        token: config.slackBotToken,
      });

      // Handle regular channel messages
      app.message(async ({ message }) => {
        const msg = message as any;
        if (msg.subtype || msg.bot_id) return; // skip edits, bot messages
        if (!msg.text) return;

        const chatMessage: ChatMessage = {
          id: msg.ts,
          chatJid: msg.channel, // chatJid field name kept for cross-platform compat
          timestamp: Math.floor(parseFloat(msg.ts)),
          sender: msg.user || "unknown",
          senderJid: msg.user || "unknown",
          text: msg.text,
        };

        onMessage([chatMessage]);
      });

      // Handle @mentions
      app.event("app_mention", async ({ event }) => {
        if (!event.text) return;

        const chatMessage: ChatMessage = {
          id: event.ts,
          chatJid: event.channel,
          timestamp: Math.floor(parseFloat(event.ts)),
          sender: event.user || "unknown",
          senderJid: event.user || "unknown",
          text: event.text,
        };

        onMessage([chatMessage]);
      });

      await app.start();
      connected = true;
      console.log("Connected to Slack (Socket Mode)");
    },

    isConnected() {
      return connected;
    },

    async sendText(chatId, text) {
      await app.client.chat.postMessage({
        channel: chatId,
        text,
      });
    },

    async sendFile(chatId, buffer, fileName, mimetype, caption) {
      await app.client.filesUploadV2({
        channel_id: chatId,
        file: buffer,
        filename: fileName,
        initial_comment: caption,
      });
      return true;
    },

    async sendPoll(chatId, poll) {
      // Slack doesn't have native polls — use text fallback with numbered options
      const lines = [
        `*${poll.question}*`,
        ...poll.options.map((opt, i) => `${i + 1}. ${opt}`),
        poll.multiSelect ? "(select multiple)" : "(pick one)",
      ];
      await app.client.chat.postMessage({
        channel: chatId,
        text: lines.join("\n"),
      });
      return true;
    },

    isDm(chatId) {
      // Slack DM channel IDs start with "D"
      return chatId.startsWith("D");
    },

    isGroup(chatId) {
      // Slack public/private channels start with "C" or "G"
      return chatId.startsWith("C") || chatId.startsWith("G");
    },

    async fetchGroupDescription(chatId) {
      try {
        const result = await app.client.conversations.info({ channel: chatId });
        const ch = result.channel;
        if (!ch) return null;
        return {
          subject: (ch as any).name || "",
          description: (ch as any).purpose?.value || (ch as any).topic?.value || "",
        };
      } catch (err: any) {
        console.error(`Failed to fetch Slack channel info for ${chatId}:`, err.message);
        return null;
      }
    },

    shutdown() {
      if (app) {
        app.stop().catch(() => {});
        connected = false;
      }
    },
  };
}
