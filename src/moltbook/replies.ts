import { moltbookPresenceConfig } from "../config.js";
import * as client from "./client.js";
import type { MoltbookComment, MoltbookProfile, MoltbookState } from "./types.js";

export interface OfferedReply { postId: string; comment: MoltbookComment; ownText: string }

export function flattenReplies(comments: MoltbookComment[], parent: string | null = null): MoltbookComment[] {
  return comments.flatMap(c => [{ ...c, parent_id: c.parent_id ?? parent }, ...flattenReplies(c.replies || [], c.id)]);
}

export async function findReplies(apiKey: string, profile: MoltbookProfile, state: MoltbookState, now = Date.now()): Promise<OfferedReply[]> {
  const recent = (x: { created_at: string }) => {
    const time = Date.parse(x.created_at);
    return time <= now && time >= now - moltbookPresenceConfig.replyLookbackDays * 86400000;
  };
  const ownComments = profile.recentComments.filter(recent);
  const ownPosts = profile.recentPosts.filter(recent);
  const threads = [...ownComments.map(c => ({ id: c.post?.id, created_at: c.created_at })), ...ownPosts]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const ids = [...new Set(threads.map(p => p.id).filter(Boolean))].slice(0, moltbookPresenceConfig.replyThreads);
  const result: OfferedReply[] = [];
  for (const postId of ids) {
    try {
      const { comments } = await client.getPostWithComments(apiKey, postId);
      const flat = flattenReplies(comments);
      const mine = new Map(ownComments.filter(c => c.post?.id === postId).map(c => [c.id, c.content]));
      const ownPost = ownPosts.find(p => p.id === postId);
      const answered = new Set([...(state.answeredReplyIds || []),
        ...flat.filter(c => c.author?.id === profile.agent.id).map(c => c.parent_id)]);
      for (const comment of flat) {
        if (comment.author?.id === profile.agent.id || answered.has(comment.id)) continue;
        const ownText = comment.parent_id ? mine.get(comment.parent_id)
          : ownPost ? `${ownPost.title}\n${ownPost.content ?? ownPost.content_preview ?? ""}` : undefined;
        if (ownText !== undefined && !result.some(r => r.comment.id === comment.id)) result.push({ postId, comment, ownText });
      }
    } catch { console.warn("[moltbook] Reply thread unavailable"); }
  }
  return result.slice(0, 100);
}
