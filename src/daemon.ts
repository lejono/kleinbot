import { config, dataDir } from "./config.js";
import { loadState, saveState, isProcessed, markProcessed, allowDm, requiresApproval } from "./state.js";
import { askClaude, getChatConfig, ensureChatConfig, isKnownChat, saveNotes, readNotes } from "./ai.js";
import { loadPending, savePending } from "./pending.js";
import type { ChatMessage, ClaudeResponse, CalendarEvent } from "./types.js";
import type { Transport } from "./transport.js";
import { runMorningBriefing } from "./moltbook/cycle.js";
import { handleMoltbookAction, sendBriefing } from "./moltbook/transport-bridge.js";
import { loadMoltbookState, hasRunToday } from "./moltbook/state.js";
import { logActivity } from "./activity.js";
import { isExpenseReceipt, writeExpenseFlag, isEditorCommand, writeEditorFlag, isVoiceNote, writeVoiceNoteFlag, collectSheetActions, writeSheetEditFlag } from "./entourage.js";
import { startEntourageWatcher } from "./entourage-watcher.js";
import { appendRawMessage } from "./raw-capture.js";

// How often to check accumulated messages and maybe respond (ms)
const PROCESS_INTERVAL = parseInt(process.env.PROCESS_INTERVAL || "60000", 10);

export interface DaemonOptions {
  createTransport: (hooks?: { onOutgoingDm?: (dmJid: string) => void }) => Transport;
  enableMoltbook?: boolean;
  enableBriefing?: boolean;
  dmAccessControl?: boolean;
}

export async function startDaemon(options: DaemonOptions): Promise<void> {
  const {
    createTransport,
    enableMoltbook = true,
    enableBriefing = true,
    dmAccessControl = true,
  } = options;

  const state = loadState();
  const pendingByChat = loadPending();

  // Track IDs currently in pending queues to avoid duplicates from repeated events
  const pendingIds = new Set<string>();

  // Cache Claude decisions when sends fail, so we retry just the send (not the whole Claude call)
  const cachedDecisions = new Map<string, ClaudeResponse>();

  // Track retry failures per chat — drop messages after MAX_RETRIES to prevent infinite loops
  const MAX_RETRIES = 3;
  const retryCounts = new Map<string, number>();
  const blockedChatNotified = new Set<string>();

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

  // Create onOutgoingDm hook for DM auto-approve
  const onOutgoingDm = dmAccessControl
    ? (dmJid: string) => {
        if (allowDm(state, dmJid)) {
          console.log(`[dm-approve] Auto-approved DM with ${dmJid} (you replied)`);
          saveState(state);
        }
      }
    : undefined;

  const transport = createTransport({ onOutgoingDm });

  // The admin adding the bot to a group is an explicit statement of intent, so treat it
  // as approval — the group equivalent of the onOutgoingDm auto-approve above. Only
  // transports with a real add-event concept provide this hook; the rest keep the gate
  // as their only path. Note this cannot replace the gate even on WhatsApp: the event
  // only arrives if the daemon was connected at the moment of the add.
  if (dmAccessControl && transport.onGroupAdd) {
    transport.onGroupAdd(({ chatId, addedByAdmin }) => {
      if (!addedByAdmin) return;
      if (allowDm(state, chatId)) {
        console.log(`[group-approve] Auto-approved ${chatId} (admin added me)`);
        saveState(state);
      }
    });
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
        await transport.sendText(chatJid, lines.join("\n"));
        break;
      }

      case "/notes": {
        const notes = readNotes(chatJid);
        await transport.sendText(chatJid, notes || "(no notes)");
        break;
      }

      case "/allow": {
        // /allow <id> — manually approve a DM contact or a new group
        let jid = args[0];
        if (!jid) {
          await transport.sendText(chatJid, "Usage: /allow <user_id>");
          break;
        }
        // WhatsApp bare numbers need the @s.whatsapp.net suffix
        if (transport.name === "whatsapp" && !jid.includes("@")) {
          jid = `${jid}@s.whatsapp.net`;
        }
        if (allowDm(state, jid)) {
          saveState(state);
          await transport.sendText(chatJid, `Approved: ${jid}`);
        } else {
          await transport.sendText(chatJid, `Already approved: ${jid}`);
        }
        break;
      }

      case "/allowed": {
        const list = state.allowedDmJids.length > 0
          ? state.allowedDmJids.join("\n")
          : "(none)";
        await transport.sendText(chatJid, `Approved DMs/groups:\n${list}`);
        break;
      }

      case "/help": {
        await transport.sendText(chatJid, [
          "/status — bot status for this chat",
          "/notes — show bot's notes for this chat",
          "/allow <number> — approve a DM contact or new group",
          "/allowed — list approved DMs/groups",
          "/help — this message",
        ].join("\n"));
        break;
      }

      default:
        await transport.sendText(chatJid, `Unknown command: ${cmd}. Try /help`);
    }
  }

  function toIcsDatetime(iso: string): string {
    return iso.replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15);
  }

  function generateIcs(event: CalendarEvent): Buffer {
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}@kleinbot`;
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Kleinbot//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${toIcsDatetime(new Date().toISOString())}`,
      `DTSTART:${toIcsDatetime(event.start)}`,
      `DTEND:${toIcsDatetime(event.end)}`,
      `SUMMARY:${event.title}`,
    ];
    if (event.location) lines.push(`LOCATION:${event.location}`);
    if (event.description) lines.push(`DESCRIPTION:${event.description}`);
    lines.push("END:VEVENT", "END:VCALENDAR");
    return Buffer.from(lines.join("\r\n") + "\r\n", "utf-8");
  }

  function onNewMessages(messages: ChatMessage[]) {
    for (const msg of messages) {
      if (isProcessed(state, msg.id) || pendingIds.has(msg.id)) continue;

      // Access control: skip unapproved DMs, and unapproved brand-new groups
      // (unless from admin). An already-onboarded group is never gated — see
      // requiresApproval() in state.ts.
      const isDm = transport.isDm(msg.chatJid);
      const isGroup = transport.isGroup(msg.chatJid);
      const chatKind = { isDm, isGroup, isKnownChat: isGroup ? isKnownChat(msg.chatJid) : true };
      if (dmAccessControl && requiresApproval(state, msg, chatKind, config.adminJid)) {
        const kindLabel = isDm ? "DM" : "new group";
        console.log(`[blocked] ${kindLabel} from unapproved ${msg.chatJid}: ${msg.text.slice(0, 40)}`);
        logActivity(transport.name, msg.chatJid, "blocked", msg.sender);

        // Notify the person once that they need approval
        if (!blockedChatNotified.has(msg.chatJid)) {
          blockedChatNotified.add(msg.chatJid);
          transport.sendText(msg.chatJid,
            "Hey! I got your message but I need to be approved by my admin first. I've let them know — sit tight."
          ).catch(() => {});
          // Notify admin
          if (config.adminJid) {
            transport.sendText(config.adminJid,
              `Someone added me to a ${kindLabel === "DM" ? "DM" : "new group"}: ${msg.chatJid} ("${msg.text.slice(0, 60)}")\nUse /allow ${msg.chatJid} to approve.`
            ).catch(() => {});
          }
        }

        continue;
      }

      console.log(`[new] [${msg.chatJid}] ${msg.sender}: ${msg.text.slice(0, 80)}`);
      logActivity(transport.name, msg.chatJid, "received", msg.sender);

      // Onboard a new group the instant the admin speaks in it. ensureChatConfig() also
      // runs in processPending(), but that only fires every PROCESS_INTERVAL (10 min on
      // WhatsApp) — so without this, other members keep hitting the gate for up to ten
      // minutes after the admin has already vouched for the group. Fire-and-forget
      // matches the appendRawMessage pattern below; ensureChatConfig() is idempotent.
      if (isGroup && config.adminJid && msg.senderJid === config.adminJid) {
        ensureChatConfig(msg.chatJid, transport).catch((err) =>
          console.error(`[onboard] Failed to onboard ${msg.chatJid}:`, err),
        );
      }

      // Durable raw capture — append the full message to an append-only log,
      // decoupled from the rolling state window. Best-effort: never block or fail
      // message processing over capture. See raw-capture.ts.
      appendRawMessage(dataDir, transport.name, msg).catch(err =>
        console.error(`[raw-capture] Failed to append raw message:`, err),
      );

      // Entourage: detect expense receipts and flag for orchestrator
      if (isExpenseReceipt(msg)) {
        writeExpenseFlag(msg).catch(err =>
          console.error(`[entourage] Failed to write expense flag:`, err),
        );
        transport.sendText(msg.chatJid, "Got your receipt, processing...").catch(() => {});
      }

      // Entourage: detect /revise commands for the editor agent
      if (isEditorCommand(msg)) {
        writeEditorFlag(msg).catch(err =>
          console.error(`[entourage] Failed to write editor flag:`, err),
        );
        transport.sendText(msg.chatJid, "Starting scene revision...").catch(() => {});
      }

      // Entourage: voice notes from admin always flagged for EA
      if (isVoiceNote(msg)) {
        writeVoiceNoteFlag(msg).catch(err =>
          console.error(`[entourage] Failed to write voicenote flag:`, err),
        );
      }

      pendingIds.add(msg.id);
      const queue = pendingByChat.get(msg.chatJid) || [];
      queue.push(msg);
      pendingByChat.set(msg.chatJid, queue);
    }

    if (messages.length > 0) {
      savePending(pendingByChat);
    }
  }

  async function processPending() {
    if (pendingByChat.size === 0) return;

    if (!transport.isConnected()) {
      console.log(`Skipping processing — not connected to ${transport.name}`);
      return;
    }

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
      await ensureChatConfig(chatJid, transport);

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
          await transport.sendText(chatJid, decision.response);
          logActivity(transport.name, chatJid, "responded");

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
          await transport.sendPoll(chatJid, decision.poll);
          logActivity(transport.name, chatJid, "poll-sent", decision.poll.question);
        }

        if (decision.calendarEvent) {
          const ev = decision.calendarEvent;
          console.log(`Sending calendar invite to ${chatJid}: ${ev.title}`);
          const icsBuffer = generateIcs(ev);
          const fileName = ev.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") + ".ics";
          await transport.sendFile(chatJid, icsBuffer, fileName, "text/calendar");
          logActivity(transport.name, chatJid, "calendar-sent", ev.title);
        }

        // Handle shared-sheet edits — emit an intent flag for the orchestrator,
        // which holds the Google credential and posts the ✓ confirmation itself.
        // We never confirm success here (the LLM has no way to know the write
        // landed), which is what kills the old "added balloons" confabulation.
        const sheetActions = collectSheetActions(decision);
        for (const action of sheetActions) {
          console.log(`[sheet] Intent: ${action.op} "${action.item}" -> ${action.list}`);
          writeSheetEditFlag(chatJid, action).catch(err =>
            console.error(`[sheet] Failed to write sheet_edit flag:`, err),
          );
        }

        // Handle Moltbook actions
        if (decision.moltbookAction) {
          console.log(`[moltbook] Action: ${decision.moltbookAction.type}`);
          try {
            const moltbookResult = await handleMoltbookAction(decision.moltbookAction);
            if (moltbookResult) {
              await transport.sendText(chatJid, moltbookResult);
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

  // --- Main startup ---

  if (!config.adminJid) {
    console.warn("WARNING: Admin ID not set — /commands will be disabled");
  }

  console.log(`${config.botName} starting (${transport.name}) — responding to all chats`);
  console.log(`Process interval: ${PROCESS_INTERVAL / 1000}s`);
  if (dmAccessControl) {
    console.log(`Approved DMs: ${state.allowedDmJids.length}`);
  }
  console.log(`Pending messages restored: ${pendingIds.size}`);

  const moltbookEnabled = enableMoltbook && !!config.moltbookApiKey;
  if (moltbookEnabled) {
    console.log("Moltbook enabled — morning briefing at 05:30 UK time");
  }

  await transport.start(onNewMessages);

  // Start entourage outgoing flag watcher (relays orchestrator replies to transport)
  const entourageWatcher = startEntourageWatcher(transport);

  // Periodically process accumulated messages
  setInterval(processPending, PROCESS_INTERVAL);

  // Morning briefing: check every process-loop tick if it's time
  if (enableBriefing && moltbookEnabled) {
    let briefingRunning = false;

    async function checkMorningBriefing(): Promise<void> {
      if (briefingRunning || !transport.isConnected()) return;

      const mState = loadMoltbookState();
      if (hasRunToday(mState)) return;

      // Check if it's past 05:30 UK time
      const ukNow = new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/London" }));
      const ukHour = ukNow.getHours();
      const ukMinute = ukNow.getMinutes();
      if (ukHour < 5 || (ukHour === 5 && ukMinute < 30)) return;

      briefingRunning = true;
      try {
        console.log("[briefing] Time for morning briefing");
        const message = await runMorningBriefing();
        if (message) {
          await sendBriefing(transport, message);
        }
      } catch (err: any) {
        console.error("[briefing] Error:", err.message);
      } finally {
        briefingRunning = false;
      }
    }

    setInterval(checkMorningBriefing, PROCESS_INTERVAL);
  }

  // Keep process alive
  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    entourageWatcher.stop();
    saveState(state);
    savePending(pendingByChat);
    transport.shutdown();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("Received SIGTERM, shutting down...");
    entourageWatcher.stop();
    saveState(state);
    savePending(pendingByChat);
    transport.shutdown();
    process.exit(0);
  });
}
