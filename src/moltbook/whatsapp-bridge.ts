import type { WASocket } from "baileys";
import { config } from "../config.js";
import type { MoltbookWhatsAppAction } from "../types.js";
import type { MoltbookCrossPollination } from "./types.js";
import * as client from "./client.js";
import { loadMoltbookState, saveMoltbookState, drainCrossPollination } from "./state.js";
import { sendTextMessage } from "../whatsapp.js";

/**
 * Handle a moltbookAction from a WhatsApp Claude response.
 * Returns the text to send back to the chat (or null).
 */
export async function handleMoltbookAction(
  action: MoltbookWhatsAppAction,
): Promise<string | null> {
  if (!config.moltbookApiKey) {
    return "Moltbook integration isn't configured yet.";
  }

  switch (action.type) {
    case "search": {
      if (!action.query) return "No search query provided.";
      try {
        const results = await client.search(config.moltbookApiKey, action.query, 5);
        if (results.length === 0) return `No results on Moltbook for "${action.query}".`;

        const lines = results.map((r, i) => {
          if (r.title) return `${i + 1}. "${r.title}" (${r.type})`;
          if (r.name) return `${i + 1}. ${r.name} (${r.type})`;
          return `${i + 1}. ${r.type}: ${(r.content || r.description || "").slice(0, 100)}`;
        });
        return `Moltbook results for "${action.query}":\n${lines.join("\n")}`;
      } catch (err: any) {
        console.error("[moltbook] Search failed:", err.message);
        return "Couldn't search Moltbook right now, sorry.";
      }
    }

    case "hot": {
      try {
        const posts = await client.getFeed(config.moltbookApiKey, "hot", 5);
        if (posts.length === 0) return "Nothing hot on Moltbook right now.";

        const lines = posts.map((p, i) =>
          `${i + 1}. "${p.title}" by ${p.author?.name || "unknown"} in r/${p.submolt.name} (${p.upvotes}↑ ${p.comment_count}💬)`,
        );
        return `Hot on Moltbook right now:\n${lines.join("\n")}`;
      } catch (err: any) {
        console.error("[moltbook] Feed fetch failed:", err.message);
        return "Couldn't fetch the Moltbook feed right now, sorry.";
      }
    }

    case "post": {
      if (!action.title || !action.content) return "Need a title and content to post.";
      try {
        const post = await client.createPost(
          config.moltbookApiKey,
          action.submolt || "general",
          action.title,
          action.content,
        );
        return `Posted to Moltbook: "${post.title}" in r/${action.submolt || "general"}`;
      } catch (err: any) {
        console.error("[moltbook] Post creation failed:", err.message);
        return "Couldn't post to Moltbook right now, sorry.";
      }
    }

    default:
      return null;
  }
}

/**
 * Send queued cross-pollination digests to moltbook-enabled WhatsApp chats.
 * Called during the regular process interval.
 */
export async function sendCrossPollination(sock: WASocket): Promise<void> {
  if (!config.moltbookApiKey) return;

  const state = loadMoltbookState();
  const items = drainCrossPollination(state);

  if (items.length === 0) {
    saveMoltbookState(state);
    return;
  }

  const digest = formatDigest(items);

  // Find all moltbook-enabled chats
  const fs = await import("fs");
  const raw = fs.readFileSync(config.chatsConfigFile, "utf-8");
  const chats = JSON.parse(raw);

  for (const [jid, chatConfig] of Object.entries(chats)) {
    if (jid === "default") continue;
    if (!(chatConfig as any).moltbook) continue;

    try {
      await sendTextMessage(sock, jid, digest);
      console.log(`[moltbook] Sent cross-pollination digest to ${jid}`);
    } catch (err: any) {
      console.error(`[moltbook] Failed to send digest to ${jid}:`, err.message);
    }
  }

  saveMoltbookState(state);
}

function formatDigest(items: MoltbookCrossPollination[]): string {
  const lines = items.map((item) =>
    `• "${item.title}" (r/${item.submolt}): ${item.snippet}`,
  );
  return `From Moltbook:\n${lines.join("\n")}`;
}

/**
 * Send a morning briefing message to all moltbook-enabled WhatsApp chats.
 */
export async function sendBriefing(sock: WASocket, message: string): Promise<void> {
  const fsModule = await import("fs");
  const raw = fsModule.readFileSync(config.chatsConfigFile, "utf-8");
  const chats = JSON.parse(raw);

  for (const [jid, chatConfig] of Object.entries(chats)) {
    if (jid === "default") continue;
    if (!(chatConfig as any).moltbook) continue;

    try {
      await sendTextMessage(sock, jid, message);
      console.log(`[briefing] Sent morning briefing to ${jid}`);
    } catch (err: any) {
      console.error(`[briefing] Failed to send briefing to ${jid}:`, err.message);
    }
  }
}
