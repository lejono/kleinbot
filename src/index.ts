import { config } from "./config.js";
import { startConnection, sendTextMessage, sendPollMessage, isConnected, getCurrentSocket } from "./whatsapp.js";
import { loadState, saveState, isProcessed, markProcessed, isDmAllowed, allowDm } from "./state.js";
import { askClaude, getChatConfig, ensureChatConfig, saveNotes, readNotes } from "./ai.js";
import { loadPending, savePending } from "./pending.js";
import type { ChatMessage, ClaudeResponse } from "./types.js";
import { runMoltbookCycle } from "./moltbook/cycle.js";
import { handleMoltbookAction, sendCrossPollination } from "./moltbook/whatsapp-bridge.js";

// How often to check accumulated messages and maybe respond (ms)
const PROCESS_INTERVAL = parseInt(process.env.PROCESS_INTERVAL || "60000", 10);

const state = loadState();
const pendingByChat = loadPending();

// Track IDs currently in pending queues to avoid duplicates from repeated events
const pendingIds = new Set<string>();

// Cache Claude decisions when sends fail, so we retry just the send (not the whole Claude call)
const cachedDecisions = new Map<string, ClaudeResponse>();

// Track retry failures per chat — drop messages after MAX_RETRIES to prevent infinite loops
const MAX_RETRIES = 3;
const retryCounts = new Map<string, number>();

function rebuildPendingIds(): void {
  pendingIds.clear();
  for (const queue of pendingByChat.values()) {
    for (const msg of queue) pendingIds.add(msg.id);
  }
}

function prunePending(): void {
  for (const [chatJid, queue] of pendingByChat.entries()) {
    const filtered = queue.filter((msg) => !isProcessed(state, msg.id));
    if (filtered.length > 0) {
      pendingByChat.set(chatJid, filtered);
    } else {
      pendingByChat.delete(chatJid);
    }
  }
  rebuildPendingIds();
  savePending(pendingByChat);
}

prunePending();

function isDm(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net");
}

function isAdminCommand(msg: ChatMessage): boolean {
  if (!config.adminJid) return false;
  return msg.senderJid === config.adminJid && msg.text.startsWith("/");
}

async function handleAdminCommand(msg: ChatMessage): Promise<void> {
  const [cmd, ...args] = msg.text.split(/\s+/);
  const chatJid = msg.chatJid;

  switch (cmd) {
    case "/status": {
      const chatConfig = getChatConfig(chatJid);
      const pending = pendingByChat.get(chatJid)?.length || 0;
      const historyCount = state.messageHistory.filter((m) => m.chatJid === chatJid).length;
      const dmCount = state.allowedDmJids.length;
      const lines = [
        `Model: ${chatConfig.model}`,
        `Verbosity: ${chatConfig.verbosity ?? 3}/5`,
        `History: ${historyCount} messages`,
        `Pending: ${pending}`,
        `Approved DMs: ${dmCount}`,
      ];
      if (chatConfig.description) lines.push(`Description: ${chatConfig.description}`);
      await sendTextMessage(getCurrentSocket()!, chatJid, lines.join("\n"));
      break;
    }

    case "/notes": {
      const notes = readNotes(chatJid);
      await sendTextMessage(getCurrentSocket()!, chatJid, notes || "(no notes)");
      break;
    }

    case "/allow": {
      // /allow 44xxxxxxxxxx — manually approve a DM JID
      const jid = args[0]?.includes("@") ? args[0] : `${args[0]}@s.whatsapp.net`;
      if (allowDm(state, jid)) {
        saveState(state);
        await sendTextMessage(getCurrentSocket()!, chatJid, `Approved DM: ${jid}`);
      } else {
        await sendTextMessage(getCurrentSocket()!, chatJid, `Already approved: ${jid}`);
      }
      break;
    }

    case "/allowed": {
      const list = state.allowedDmJids.length > 0
        ? state.allowedDmJids.join("\n")
        : "(none)";
      await sendTextMessage(getCurrentSocket()!, chatJid, `Approved DMs:\n${list}`);
      break;
    }

    case "/help": {
      await sendTextMessage(getCurrentSocket()!, chatJid, [
        "/status — bot status for this chat",
        "/notes — show bot's notes for this chat",
        "/allow <number> — approve a DM contact",
        "/allowed — list approved DM contacts",
        "/help — this message",
      ].join("\n"));
      break;
    }

    default:
      await sendTextMessage(getCurrentSocket()!, chatJid, `Unknown command: ${cmd}. Try /help`);
  }
}

function onNewMessages(messages: ChatMessage[]) {
  for (const msg of messages) {
    if (isProcessed(state, msg.id) || pendingIds.has(msg.id)) continue;

    // DM access control: skip unapproved DMs (unless from admin)
    if (isDm(msg.chatJid) && msg.senderJid !== config.adminJid && !isDmAllowed(state, msg.chatJid)) {
      console.log(`[blocked] DM from unapproved ${msg.chatJid}: ${msg.text.slice(0, 40)}`);
      continue;
    }

    console.log(`[new] [${msg.chatJid}] ${msg.sender}: ${msg.text.slice(0, 80)}`);

    pendingIds.add(msg.id);
    const queue = pendingByChat.get(msg.chatJid) || [];
    queue.push(msg);
    pendingByChat.set(msg.chatJid, queue);
  }

  if (messages.length > 0) {
    savePending(pendingByChat);
  }
}

function onOutgoingDm(dmJid: string) {
  if (allowDm(state, dmJid)) {
    console.log(`[dm-approve] Auto-approved DM with ${dmJid} (you replied)`);
    saveState(state);
  }
}

async function processPending() {
  // Send any queued Moltbook cross-pollination digests (independent of pending messages)
  if (config.moltbookApiKey && isConnected()) {
    try {
      await sendCrossPollination(getCurrentSocket()!);
    } catch (err: any) {
      console.error("[moltbook] Cross-pollination failed:", err.message);
    }
  }

  if (pendingByChat.size === 0) return;

  if (!isConnected()) {
    console.log("Skipping processing — not connected to WhatsApp");
    return;
  }

  const sock = getCurrentSocket()!;

  // Snapshot and clear the queues so new messages don't interfere
  const chatBatches = new Map(pendingByChat);
  pendingByChat.clear();

  for (const [chatJid, batch] of chatBatches) {
    // Handle admin commands — process and remove them from the batch
    const normalMessages: ChatMessage[] = [];
    for (const msg of batch) {
      if (isAdminCommand(msg)) {
        await handleAdminCommand(msg);
        markProcessed(state, msg);
        pendingIds.delete(msg.id);
      } else {
        normalMessages.push(msg);
      }
    }

    if (normalMessages.length === 0) {
      saveState(state);
      continue;
    }

    console.log(`Processing ${normalMessages.length} message(s) from ${chatJid}...`);

    // Auto-create config entry for unknown chats
    await ensureChatConfig(chatJid, sock);

    let decision: ClaudeResponse | undefined;
    try {
      // Use cached decision if available (Claude succeeded but send failed last time)
      decision = cachedDecisions.get(chatJid);
      if (decision) {
        console.log(`Retrying cached response for ${chatJid}`);
        cachedDecisions.delete(chatJid);
      } else {
        const chatConfig = getChatConfig(chatJid);
        // Filter history to this chat for context
        const recentHistory = state.messageHistory
          .filter((m) => m.chatJid === chatJid)
          .slice(-config.historyWindow);
        decision = await askClaude(recentHistory, normalMessages, chatConfig, chatJid);
      }

      // Save bot notes if provided
      if (decision.notes) {
        saveNotes(chatJid, decision.notes);
      }

      if (decision.shouldRespond && decision.response) {
        console.log(`Responding to ${chatJid}: ${decision.response.slice(0, 80)}...`);
        await sendTextMessage(sock, chatJid, decision.response);

        // Record our own response in history for context
        markProcessed(state, {
          id: `bot-${Date.now()}`,
          chatJid,
          timestamp: Math.floor(Date.now() / 1000),
          sender: config.botName,
          senderJid: "self",
          text: decision.response,
        });
      } else if (!decision.poll) {
        console.log(`Claude decided not to respond to ${chatJid}`);
      }

      if (decision.poll) {
        console.log(`Sending poll to ${chatJid}: ${decision.poll.question}`);
        await sendPollMessage(sock, chatJid, decision.poll);
      }

      // Handle Moltbook actions triggered from WhatsApp
      if (decision.moltbookAction) {
        console.log(`[moltbook] WhatsApp action: ${decision.moltbookAction.type}`);
        try {
          const moltbookResult = await handleMoltbookAction(decision.moltbookAction);
          if (moltbookResult) {
            await sendTextMessage(sock, chatJid, moltbookResult);
          }
        } catch (err: any) {
          console.error(`[moltbook] Action failed:`, err.message);
        }
      }

      // Mark messages as processed only after everything succeeds (Claude + send)
      // This prevents duplicates in history when sends fail and messages are retried
      for (const msg of normalMessages) {
        markProcessed(state, msg);
        pendingIds.delete(msg.id);
      }
      cachedDecisions.delete(chatJid);
      retryCounts.delete(chatJid);
      saveState(state);
    } catch (err) {
      const retries = (retryCounts.get(chatJid) || 0) + 1;
      retryCounts.set(chatJid, retries);

      if (retries >= MAX_RETRIES) {
        console.error(`Dropping ${normalMessages.length} message(s) for ${chatJid} after ${retries} failures:`, err);
        // Mark as processed so they don't come back
        for (const msg of normalMessages) {
          markProcessed(state, msg);
          pendingIds.delete(msg.id);
        }
        retryCounts.delete(chatJid);
        cachedDecisions.delete(chatJid);
        saveState(state);
      } else {
        console.error(`Error processing messages for ${chatJid} (retry ${retries}/${MAX_RETRIES}):`, err);
        // Cache the Claude decision so we retry just the send, not the whole Claude call
        if (decision) {
          cachedDecisions.set(chatJid, decision);
        }
        // Put messages back so they're retried next cycle
        const existing = pendingByChat.get(chatJid) || [];
        pendingByChat.set(chatJid, [...normalMessages, ...existing]);
      }
    }
  }

  savePending(pendingByChat);
}

async function main() {
  if (!config.adminJid) {
    console.warn("WARNING: ADMIN_JID not set in .env — /commands will be disabled");
  }

  console.log(`Kleinbot starting — responding to all chats`);
  console.log(`Process interval: ${PROCESS_INTERVAL / 1000}s`);
  console.log(`Approved DMs: ${state.allowedDmJids.length}`);
  console.log(`Pending messages restored: ${pendingIds.size}`);

  if (config.moltbookApiKey) {
    console.log(`Moltbook enabled — heartbeat every ${Math.round(config.moltbookHeartbeatInterval / 3600000)}h`);
  } else {
    console.log("Moltbook disabled (no MOLTBOOK_API_KEY)");
  }

  await startConnection(onNewMessages, onOutgoingDm);

  // Periodically process accumulated messages
  setInterval(processPending, PROCESS_INTERVAL);

  // Moltbook autonomous participation heartbeat
  if (config.moltbookApiKey) {
    // Run first cycle after a short delay (let WhatsApp connect first)
    setTimeout(() => {
      runMoltbookCycle().catch((err) =>
        console.error("[moltbook] Cycle error:", err),
      );
    }, 30_000);

    setInterval(() => {
      runMoltbookCycle().catch((err) =>
        console.error("[moltbook] Cycle error:", err),
      );
    }, config.moltbookHeartbeatInterval);
  }

  // Keep process alive
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    saveState(state);
    savePending(pendingByChat);
    getCurrentSocket()?.end(undefined);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down...");
    saveState(state);
    savePending(pendingByChat);
    getCurrentSocket()?.end(undefined);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
