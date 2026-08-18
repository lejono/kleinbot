import type { ChatMessage, PollData } from "./types.js";

export type MessageHandler = (messages: ChatMessage[]) => void;

/** The bot was added to a group. addedByAdmin means the configured admin did it. */
export interface GroupAddEvent {
  chatId: string;
  /** Raw JID of whoever added the bot — logged for diagnosing JID-format mismatches */
  addedBy: string;
  addedByAdmin: boolean;
}

export type GroupAddHandler = (evt: GroupAddEvent) => void;

export interface Transport {
  /** Transport name for logging ("whatsapp", "slack") */
  readonly name: string;

  /** Start the connection. Calls onMessage when new messages arrive. */
  start(onMessage: MessageHandler): Promise<void>;

  /** Is the transport currently connected and able to send? */
  isConnected(): boolean;

  /** Send a text message to a chat */
  sendText(chatId: string, text: string): Promise<void>;

  /** Send a file/document. Returns false if unsupported. */
  sendFile(chatId: string, buffer: Buffer, fileName: string, mimetype: string, caption?: string): Promise<boolean>;

  /** Send a poll. Returns false if unsupported. */
  sendPoll(chatId: string, poll: PollData): Promise<boolean>;

  /** Check if a chat ID represents a direct message (vs group) */
  isDm(chatId: string): boolean;

  /** Check if a chat ID is a group/channel where metadata can be fetched */
  isGroup(chatId: string): boolean;

  /** Fetch group/channel description for auto-populating chat config */
  fetchGroupDescription(chatId: string): Promise<{ subject: string; description: string } | null>;

  /**
   * Register a handler for "the bot was added to a group". Optional: only transports
   * with a real add-event concept implement it (WhatsApp). Transports that don't simply
   * omit it and keep the normal approval gate as their only path.
   */
  onGroupAdd?(handler: GroupAddHandler): void;

  /** Clean shutdown */
  shutdown(): void;
}
