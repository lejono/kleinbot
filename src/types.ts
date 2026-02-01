export interface ChatMessage {
  id: string;
  chatJid: string;      // group JID or 1-1 JID
  timestamp: number;
  sender: string;       // push name or phone number
  senderJid: string;
  text: string;
  quotedText?: string;  // if replying to another message
  mentionedJids?: string[];
}

export interface BotState {
  lastProcessedTimestamp: number;
  processedMessageIds: string[];
  messageHistory: ChatMessage[];
  allowedDmJids: string[];         // auto-approved DM contacts
}

export interface MoltbookWhatsAppAction {
  type: "search" | "post" | "hot";
  query?: string;
  title?: string;
  content?: string;
  submolt?: string;
}

export interface PollData {
  question: string;
  options: string[];
  multiSelect?: boolean;  // default false (single choice)
}

export interface ClaudeResponse {
  shouldRespond: boolean;
  response?: string;
  notes?: string;       // bot's notes to remember for next time
  poll?: PollData;
  moltbookAction?: MoltbookWhatsAppAction;
}

export interface ChatConfig {
  prompt: string;       // path to prompt .md file
  model: string;        // claude model name
  description?: string; // what this chat/group is about
  verbosity?: number;   // 1-5: how eagerly the bot participates (default 3)
  context?: string;     // path to static context .md file (manually edited)
  moltbook?: boolean;   // if true, Moltbook cross-pollination and commands enabled
}

export interface ChatsConfig {
  [jid: string]: ChatConfig;
}

export interface Config {
  botName: string;
  adminJid: string;               // JID that can send /commands
  maxResponsesPerRun: number;
  historyWindow: number;
  authDir: string;
  stateFile: string;
  pendingFile: string;
  chatsConfigFile: string;
  moltbookApiKey: string;
  moltbookStateFile: string;
  moltbookHeartbeatInterval: number;  // ms between autonomous cycles
}
