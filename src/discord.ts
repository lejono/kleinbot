import { Client, GatewayIntentBits, Partials, ChannelType } from "discord.js";
import { config } from "./config.js";
import type { ChatMessage } from "./types.js";
import type { Transport, MessageHandler } from "./transport.js";

const MAX_MESSAGE_LENGTH = 2000;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at last newline before limit
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

/**
 * Create a Discord transport using discord.js gateway (WebSocket).
 */
export function createDiscordTransport(
  onOutgoingDm?: (dmChannelId: string) => void,
): Transport {
  let client: Client;
  let connected = false;
  let botUserId: string | null = null;

  return {
    name: "discord",

    async start(onMessage: MessageHandler) {
      client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel], // Required for DM messageCreate events
      });

      client.on("ready", () => {
        botUserId = client.user?.id ?? null;
        connected = true;
        console.log(`Connected to Discord as ${client.user?.tag}`);
      });

      client.on("messageCreate", (message) => {
        // Skip bot's own messages and other bots
        if (message.author.id === botUserId) return;
        if (message.author.bot) return;
        // Skip messages without text content
        if (!message.content) return;

        const chatMessage: ChatMessage = {
          id: message.id,
          chatJid: message.channelId,
          timestamp: Math.floor(message.createdTimestamp / 1000),
          sender: message.member?.displayName || message.author.displayName || message.author.username,
          senderJid: message.author.id,
          text: message.content,
          mentionedJids: message.mentions.users.map((u) => u.id),
        };

        onMessage([chatMessage]);
      });

      await client.login(config.discordBotToken);
    },

    isConnected() {
      return connected;
    },

    async sendText(chatId, text) {
      const channel = await client.channels.fetch(chatId);
      if (channel && "send" in channel) {
        const chunks = splitMessage(text);
        for (const chunk of chunks) {
          await channel.send(chunk);
        }
        // Auto-approve DM on outgoing message
        if (onOutgoingDm && channel.type === ChannelType.DM) {
          onOutgoingDm(chatId);
        }
      }
    },

    async sendFile(chatId, buffer, fileName, _mimetype, caption) {
      const channel = await client.channels.fetch(chatId);
      if (channel && "send" in channel) {
        await channel.send({
          content: caption || undefined,
          files: [{ attachment: buffer, name: fileName }],
        });
        return true;
      }
      return false;
    },

    async sendPoll(chatId, poll) {
      const channel = await client.channels.fetch(chatId);
      if (channel && "send" in channel) {
        await channel.send({
          poll: {
            question: { text: poll.question.slice(0, 300) },
            answers: poll.options.slice(0, 10).map((opt) => ({
              text: opt.slice(0, 55),
            })),
            allowMultiselect: poll.multiSelect ?? false,
            duration: 24, // hours
          },
        });
        return true;
      }
      return false;
    },

    isDm(chatId) {
      // Channel cache is populated by messageCreate before daemon calls this
      const channel = client.channels.cache.get(chatId);
      if (channel) return channel.type === ChannelType.DM;
      return false;
    },

    isGroup(chatId) {
      const channel = client.channels.cache.get(chatId);
      if (!channel) return false;
      return (
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildVoice ||
        channel.type === ChannelType.GuildAnnouncement ||
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread
      );
    },

    async fetchGroupDescription(chatId) {
      try {
        const channel = await client.channels.fetch(chatId);
        if (!channel || !("name" in channel)) return null;
        return {
          subject: (channel as any).name || "",
          description: (channel as any).topic || "",
        };
      } catch (err: any) {
        console.error(`Failed to fetch Discord channel info for ${chatId}:`, err.message);
        return null;
      }
    },

    shutdown() {
      if (client) {
        client.destroy();
        connected = false;
      }
    },
  };
}
