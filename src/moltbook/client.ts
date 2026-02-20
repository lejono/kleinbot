import type {
  MoltbookPost,
  MoltbookComment,
  MoltbookAgent,
  MoltbookSubmolt,
  MoltbookRegistration,
  MoltbookSearchResult,
} from "./types.js";

const BASE_URL = "https://www.moltbook.com/api/v1";

class MoltbookApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = "MoltbookApiError";
  }
}

async function rawRequest(
  path: string,
  apiKey?: string,
  options: RequestInit = {},
): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> || {}),
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const remaining = res.headers.get("X-RateLimit-Remaining");
  if (remaining !== null && parseInt(remaining, 10) <= 5) {
    console.warn(`[moltbook] Rate limit warning: ${remaining} requests remaining`);
  }

  // Some endpoints return empty body on success (e.g. upvote)
  const text = await res.text();
  if (!res.ok) {
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = {}; }
    throw new MoltbookApiError(
      res.status,
      parsed.error || "UNKNOWN",
      parsed.error || `HTTP ${res.status}`,
      parsed.hint,
    );
  }

  if (!text) return {};
  return JSON.parse(text);
}

// --- Agent Management ---

export async function registerAgent(
  name: string,
  description: string,
): Promise<MoltbookRegistration> {
  return rawRequest("/agents/register", undefined, {
    method: "POST",
    body: JSON.stringify({ name, description }),
  }) as Promise<MoltbookRegistration>;
}

export async function getMe(apiKey: string): Promise<MoltbookAgent> {
  const json = await rawRequest("/agents/me", apiKey);
  return json.agent as MoltbookAgent;
}

export async function getAgentProfile(name: string): Promise<MoltbookAgent> {
  const json = await rawRequest(`/agents/profile?name=${encodeURIComponent(name)}`);
  return json.agent as MoltbookAgent;
}

export async function followAgent(apiKey: string, name: string): Promise<void> {
  await rawRequest(`/agents/${encodeURIComponent(name)}/follow`, apiKey, { method: "POST" });
}

// --- Feed & Posts ---

export async function getFeed(
  apiKey: string,
  sort: "hot" | "new" | "top" | "rising" = "hot",
  limit = 25,
): Promise<MoltbookPost[]> {
  const json = await rawRequest(`/posts?sort=${sort}&limit=${limit}`, apiKey);
  return (json.posts || []) as MoltbookPost[];
}

export async function getPersonalizedFeed(
  apiKey: string,
  sort: "hot" | "new" | "top" | "rising" = "hot",
  limit = 25,
): Promise<MoltbookPost[]> {
  const json = await rawRequest(`/feed?sort=${sort}&limit=${limit}`, apiKey);
  return (json.posts || []) as MoltbookPost[];
}

/** Returns {post, comments} from the single-post endpoint */
export async function getPostWithComments(
  apiKey: string,
  postId: string,
): Promise<{ post: MoltbookPost; comments: MoltbookComment[] }> {
  const json = await rawRequest(`/posts/${encodeURIComponent(postId)}`, apiKey);
  return {
    post: json.post as MoltbookPost,
    comments: (json.comments || []) as MoltbookComment[],
  };
}

export async function createPost(
  apiKey: string,
  submolt: string,
  title: string,
  content: string,
): Promise<MoltbookPost> {
  const json = await rawRequest("/posts", apiKey, {
    method: "POST",
    body: JSON.stringify({ submolt, title, content }),
  });
  return (json.post || json) as MoltbookPost;
}

// --- Comments ---

export async function addComment(
  apiKey: string,
  postId: string,
  content: string,
  parentId?: string,
): Promise<MoltbookComment> {
  const body: Record<string, string> = { content };
  if (parentId) body.parent_id = parentId;
  const json = await rawRequest(
    `/posts/${encodeURIComponent(postId)}/comments`,
    apiKey,
    { method: "POST", body: JSON.stringify(body) },
  );

  // Handle verification challenge if present
  const verification = json.comment?.verification;
  if (verification?.verification_code && verification?.challenge_text) {
    const answer = solveVerificationChallenge(verification.challenge_text);
    if (answer !== null) {
      await rawRequest("/verify", apiKey, {
        method: "POST",
        body: JSON.stringify({
          verification_code: verification.verification_code,
          answer: answer.toFixed(2),
        }),
      });
      console.log(`[moltbook] Verified comment (challenge answer: ${answer.toFixed(2)})`);
    } else {
      console.warn(`[moltbook] Could not solve verification challenge: ${verification.challenge_text}`);
    }
  }

  return (json.comment || json) as MoltbookComment;
}

/**
 * Solve a Moltbook verification challenge.
 * Challenges are obfuscated math like:
 *   "lObStEr hAs cLaW fOrCe nEwToNs: tWeNtY fIvE nEwToNs * tHrEe cLaWs, wHaT Is ToTaL?"
 * Strategy: strip noise, extract numbers, find operator (* + -), compute.
 */
function solveVerificationChallenge(challenge: string): number | null {
  // Normalize: lowercase, strip non-alphanumeric except operators
  const clean = challenge.toLowerCase().replace(/[^a-z0-9.*+\-/\s]/g, " ");

  // Extract all numbers (digits)
  const numbers = clean.match(/\d+(\.\d+)?/g)?.map(Number) || [];

  if (numbers.length >= 2) {
    // Find the operator
    if (clean.includes("*") || clean.includes("times") || clean.includes("multiply")) {
      return numbers[0] * numbers[1];
    }
    if (clean.includes("+") || clean.includes("plus") || clean.includes("add") || clean.includes("total")) {
      return numbers[0] + numbers[1];
    }
    if (clean.includes("-") || clean.includes("minus") || clean.includes("subtract")) {
      return numbers[0] - numbers[1];
    }
    if (clean.includes("/") || clean.includes("divide")) {
      return numbers[1] !== 0 ? numbers[0] / numbers[1] : null;
    }
    // Default: multiply (most common pattern)
    return numbers[0] * numbers[1];
  }

  return null;
}

// --- Voting ---

export async function upvotePost(apiKey: string, postId: string): Promise<void> {
  await rawRequest(`/posts/${encodeURIComponent(postId)}/upvote`, apiKey, { method: "POST" });
}

export async function upvoteComment(apiKey: string, commentId: string): Promise<void> {
  await rawRequest(`/comments/${encodeURIComponent(commentId)}/upvote`, apiKey, { method: "POST" });
}

// --- Submolts ---

export async function listSubmolts(apiKey: string): Promise<MoltbookSubmolt[]> {
  const json = await rawRequest("/submolts", apiKey);
  return (json.submolts || []) as MoltbookSubmolt[];
}

export async function subscribeSubmolt(apiKey: string, name: string): Promise<void> {
  await rawRequest(`/submolts/${encodeURIComponent(name)}/subscribe`, apiKey, { method: "POST" });
}

// --- Search ---

export async function search(
  apiKey: string,
  query: string,
  limit = 25,
): Promise<MoltbookSearchResult[]> {
  const json = await rawRequest(
    `/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    apiKey,
  );
  return (json.results || json.data || []) as MoltbookSearchResult[];
}
