export interface MessageAttachment {
  id: string;            // signal-cli attachment ID or platform-specific ID
  contentType: string;   // MIME type (e.g. "image/jpeg")
  filename: string | null;
  size: number;          // bytes
  localPath: string;     // resolved absolute path on disk
}

export interface ChatMessage {
  id: string;
  chatJid: string;      // chat identifier (WhatsApp JID or Slack channel ID)
  timestamp: number;
  sender: string;       // display name
  senderJid: string;    // sender identifier (WhatsApp JID or Slack user ID)
  text: string;
  quotedText?: string;  // if replying to another message
  mentionedJids?: string[];
  attachments?: MessageAttachment[];
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

export interface CalendarEvent {
  title: string;
  start: string;      // ISO 8601 datetime, e.g. "2026-02-25T19:00:00"
  end: string;         // ISO 8601 datetime
  location?: string;
  description?: string;
}

// A shared-Google-Sheet edit intent. Kleinbot only EMITS this; the orchestrator
// (which holds the Google credential) validates it against a hardcoded
// sheet/tab allowlist and performs the write. See
// docs/plans/2026-07-13-kleinbot-sheet-writing.md.
export interface SheetAction {
  op: "append" | "remove" | "list";
  list: string;         // short alias (e.g. "shopping", "todo") — resolved by the orchestrator
  item?: string;        // free text for append/remove; ignored for list
}

export interface ClaudeResponse {
  shouldRespond: boolean;
  response?: string;
  notes?: string;       // bot's notes to remember for next time
  poll?: PollData;
  calendarEvent?: CalendarEvent;
  moltbookAction?: MoltbookWhatsAppAction;
  sheetAction?: SheetAction;        // single edit (back-compat)
  sheetActions?: SheetAction[];     // multiple edits in one message
}

export interface ChatConfig {
  prompt: string;       // path to prompt .md file
  model: string;        // claude model name
  description?: string; // what this chat/group is about
  verbosity?: number;   // 1-5: how eagerly the bot participates (default 3)
  context?: string;     // path to static context .md file (manually edited)
  moltbook?: boolean;   // if true, Moltbook cross-pollination and commands enabled
  briefing?: boolean;   // if true, receives news briefing messages
  sheetLists?: string[]; // if set, chat can drive a shared Google Sheet; these are
                         // the list aliases the LLM may target (e.g. ["shopping", "todo"]).
                         // The sheet ID + tab mapping lives ONLY in the orchestrator config.
}

export interface ChatsConfig {
  [jid: string]: ChatConfig;
}

export interface Config {
  botName: string;
  adminJid: string;               // admin identifier (WhatsApp JID or Slack user ID)
  maxResponsesPerRun: number;
  historyWindow: number;
  authDir: string;
  stateFile: string;
  pendingFile: string;
  notesDir: string;
  chatsConfigFile: string;
  moltbookApiKey: string;
  moltbookStateFile: string;
  adminGroupJid: string;          // optional admin-channel group ID, from env
  editorGroupJid: string;         // editor-agent group ID (user data, from env)
  // Slack-specific (empty for WhatsApp)
  slackAppToken: string;
  slackBotToken: string;
  // Discord-specific (empty for WhatsApp/Slack)
  discordBotToken: string;
}
