import net from "net";
import { config } from "./config.js";
import type { ChatMessage } from "./types.js";
import type { Transport, MessageHandler } from "./transport.js";

const MAX_MESSAGE_LENGTH = 2000; // Signal's practical limit

// --- JSON-RPC over Unix socket ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class SignalRpcClient {
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private onNotification: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 60000;
  private socketPath: string;
  private _connected = false;
  private shouldReconnect = true;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  get connected(): boolean {
    return this._connected;
  }

  connect(onNotification: (method: string, params: Record<string, unknown>) => void): Promise<void> {
    this.onNotification = onNotification;
    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      let resolved = false;

      socket.on("connect", () => {
        this._connected = true;
        this.reconnectDelay = 1000;
        this.socket = socket;
        resolved = true;
        resolve();
      });

      socket.on("data", (data) => {
        this.buffer += data.toString();
        this.processBuffer();
      });

      socket.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          reject(err);
          return;
        }
        console.error("[signal-rpc] Socket error:", err.message);
      });

      socket.on("close", () => {
        this._connected = false;
        this.socket = null;
        // Reject all pending requests
        for (const [id, req] of this.pending) {
          clearTimeout(req.timer);
          req.reject(new Error("Socket closed"));
          this.pending.delete(id);
        }
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg: JsonRpcResponse = JSON.parse(trimmed);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const req = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(req.timer);
          if (msg.error) {
            req.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
          } else {
            req.resolve(msg.result);
          }
        } else if ((msg as any).method && this.onNotification) {
          // This is a notification (no id, has method)
          this.onNotification((msg as any).method, (msg as any).params || {});
        }
      } catch {
        // Skip malformed lines
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    console.log(`[signal-rpc] Reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.doConnect();
        console.log("[signal-rpc] Reconnected to signal-cli");
      } catch (err: any) {
        console.error("[signal-rpc] Reconnect failed:", err.message);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || !this._connected) {
      throw new Error("Not connected to signal-cli");
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", method, id, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 30000);

      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify(request) + "\n");
    });
  }

  shutdown(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this._connected = false;
  }
}

// --- Signal transport ---

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt <= 0) splitAt = MAX_MESSAGE_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}

function getSocketPath(): string {
  if (process.env.SIGNAL_SOCKET_PATH) return process.env.SIGNAL_SOCKET_PATH;
  const xdg = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
  return `${xdg}/signal-cli/socket`;
}

export function createSignalTransport(
  onOutgoingDm?: (dmChannelId: string) => void,
): Transport {
  const rpc = new SignalRpcClient(getSocketPath());
  const account = process.env.SIGNAL_ACCOUNT || "";

  if (!account) {
    throw new Error("SIGNAL_ACCOUNT env var is required (bot's phone number, e.g. +447123456789)");
  }

  return {
    name: "signal",

    async start(onMessage: MessageHandler) {
      await rpc.connect((method, params) => {
        if (method !== "receive") return;

        const envelope = (params as any).envelope;
        if (!envelope) return;

        // Skip own messages
        if (envelope.sourceNumber === account) return;

        const dataMessage = envelope.dataMessage;
        if (!dataMessage || !dataMessage.message) return;

        const groupId = dataMessage.groupInfo?.groupId;
        const chatId = groupId || envelope.sourceNumber;
        if (!chatId) return;

        const chatMessage: ChatMessage = {
          id: `${envelope.sourceNumber}-${envelope.timestamp}`,
          chatJid: chatId,
          timestamp: Math.floor(envelope.timestamp / 1000),
          sender: envelope.sourceName || envelope.sourceNumber,
          senderJid: envelope.sourceNumber,
          text: dataMessage.message,
        };

        // Include quote if present
        if (dataMessage.quote?.text) {
          chatMessage.quotedText = dataMessage.quote.text;
        }

        // Include mentions if present
        if (dataMessage.mentions?.length) {
          chatMessage.mentionedJids = dataMessage.mentions.map(
            (m: { number: string }) => m.number,
          );
        }

        onMessage([chatMessage]);
      });

      console.log(`Connected to Signal via signal-cli (account: ${account})`);
    },

    isConnected() {
      return rpc.connected;
    },

    async sendText(chatId, text) {
      const chunks = splitMessage(text);
      for (const chunk of chunks) {
        const params: Record<string, unknown> = {
          account,
          message: chunk,
        };
        if (chatId.startsWith("+")) {
          params.recipient = [chatId];
        } else {
          params.groupId = chatId;
        }
        await rpc.call("send", params);
      }
      // Auto-approve DM on outgoing message
      if (onOutgoingDm && chatId.startsWith("+")) {
        onOutgoingDm(chatId);
      }
    },

    async sendFile(chatId, buffer, fileName, mimetype, caption) {
      const dataUri = `data:${mimetype};filename=${fileName};base64,${buffer.toString("base64")}`;
      const params: Record<string, unknown> = {
        account,
        message: caption || "",
        attachments: [dataUri],
      };
      if (chatId.startsWith("+")) {
        params.recipient = [chatId];
      } else {
        params.groupId = chatId;
      }
      await rpc.call("send", params);
      return true;
    },

    async sendPoll(chatId, poll) {
      // Signal has no native polls — text fallback (same approach as Slack)
      const lines = [
        `*${poll.question}*`,
        ...poll.options.map((opt, i) => `${i + 1}. ${opt}`),
        poll.multiSelect ? "(select multiple)" : "(pick one)",
      ];
      await this.sendText(chatId, lines.join("\n"));
      return true;
    },

    isDm(chatId) {
      return chatId.startsWith("+");
    },

    isGroup(chatId) {
      return !chatId.startsWith("+");
    },

    async fetchGroupDescription(chatId) {
      if (chatId.startsWith("+")) return null;
      try {
        const groups = (await rpc.call("listGroups", { account })) as any[];
        const group = groups?.find((g: any) => g.id === chatId || g.groupId === chatId);
        if (!group) return null;
        return {
          subject: group.name || "",
          description: group.description || "",
        };
      } catch (err: any) {
        console.error(`Failed to fetch Signal group info for ${chatId}:`, err.message);
        return null;
      }
    },

    shutdown() {
      rpc.shutdown();
    },
  };
}
