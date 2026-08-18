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
    const msg = parsed.message || parsed.error || `HTTP ${res.status}`;
    throw new MoltbookApiError(
      res.status,
      parsed.error || "UNKNOWN",
      typeof msg === "string" ? msg : JSON.stringify(msg),
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

  // Retry once on cooldown (429)
  let json: any;
  try {
    json = await rawRequest(
      `/posts/${encodeURIComponent(postId)}/comments`,
      apiKey,
      { method: "POST", body: JSON.stringify(body) },
    );
  } catch (err: any) {
    if (err instanceof MoltbookApiError && (err.status === 429 || err.status === 400 || err.message.includes("cooldown"))) {
      console.log("[moltbook] Comment cooldown, waiting 10s...");
      await new Promise((r) => setTimeout(r, 10_000));
      json = await rawRequest(
        `/posts/${encodeURIComponent(postId)}/comments`,
        apiKey,
        { method: "POST", body: JSON.stringify(body) },
      );
    } else {
      throw err;
    }
  }

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
 * Convert word-numbers to digits.
 * Handles: "thirty two" → 32, "nine" → 9, "one hundred" → 100, etc.
 */
function wordsToNumber(text: string): number | null {
  const ones: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19,
  };
  const tens: Record<string, number> = {
    twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
    seventy: 70, eighty: 80, ninety: 90,
  };

  const words = text.trim().split(/\s+/);
  let result = 0;
  let current = 0;

  for (const w of words) {
    if (ones[w] !== undefined) {
      current += ones[w];
    } else if (tens[w] !== undefined) {
      current += tens[w];
    } else if (w === "hundred") {
      current = (current || 1) * 100;
    } else if (w === "thousand") {
      current = (current || 1) * 1000;
      result += current;
      current = 0;
    }
  }
  result += current;
  return result > 0 || text.includes("zero") ? result : null;
}

/**
 * Extract all numbers from text — both digits ("32") and words ("thirty two").
 * Handles Moltbook's heavy obfuscation which inserts random chars AND spaces
 * inside words: "tW/eNtY ThReE" or "F iV E" or "tWeN tY".
 * Strategy: strip everything non-alpha, collapse ALL spaces, then scan for
 * number words as substrings in the resulting blob.
 */
function extractNumbers(text: string): number[] {
  const numbers: number[] = [];

  // Extract digit-numbers from original text
  const digitMatches = text.match(/\d+(\.\d+)?/g);
  if (digitMatches) numbers.push(...digitMatches.map(Number));

  // Strip ALL non-alpha, lowercase, remove ALL spaces → one big string
  const blob = text.replace(/[^a-zA-Z]/g, "").toLowerCase();

  // Number words to scan for, longest first to match greedily
  const numberWords: [string, number][] = [
    ["nineteen", 19], ["eighteen", 18], ["seventeen", 17], ["sixteen", 16],
    ["fifteen", 15], ["fourteen", 14], ["thirteen", 13], ["twelve", 12],
    ["eleven", 11], ["twenty", 20], ["thirty", 30], ["forty", 40],
    ["fifty", 50], ["sixty", 60], ["seventy", 70], ["eighty", 80],
    ["ninety", 90], ["hundred", 100], ["thousand", 1000],
    ["zero", 0], ["one", 1], ["two", 2], ["three", 3], ["four", 4],
    ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9],
    ["ten", 10],
  ];

  // Find all number word occurrences with their positions
  const found: { pos: number; word: string; value: number }[] = [];
  for (const [word, value] of numberWords) {
    let searchFrom = 0;
    while (true) {
      const idx = blob.indexOf(word, searchFrom);
      if (idx === -1) break;
      found.push({ pos: idx, word, value });
      searchFrom = idx + word.length;
    }
  }

  // Sort by position, then greedily select non-overlapping matches
  found.sort((a, b) => a.pos - b.pos || b.word.length - a.word.length);
  const selected: { pos: number; word: string; value: number }[] = [];
  let lastEnd = -1;
  for (const f of found) {
    if (f.pos >= lastEnd) {
      selected.push(f);
      lastEnd = f.pos + f.word.length;
    }
  }

  // Group adjacent number words into compound numbers (e.g. twenty + three = 23)
  let current = 0;
  let prevEnd = -1;
  for (const s of selected) {
    // If there's a gap of more than a few chars, flush the current number
    if (prevEnd >= 0 && s.pos - prevEnd > 10) {
      if (current > 0) numbers.push(current);
      current = 0;
    }
    if (s.word === "hundred") {
      current = (current || 1) * 100;
    } else if (s.word === "thousand") {
      current = (current || 1) * 1000;
    } else {
      current += s.value;
    }
    prevEnd = s.pos + s.word.length;
  }
  if (current > 0) numbers.push(current);

  // Deduplicate
  return [...new Set(numbers)];
}

/**
 * Detect operator from obfuscated text.
 * Same strategy: strip to alpha blob, scan for operator words.
 */
function detectOperator(text: string): string {
  const blob = text.replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (blob.includes("total") || blob.includes("plus") || blob.includes("add") || blob.includes("combined") || blob.includes("sum")) return "+";
  if (blob.includes("remains") || blob.includes("reduces") || blob.includes("minus") || blob.includes("subtract") || blob.includes("slows") || blob.includes("left")) return "-";
  if (blob.includes("times") || blob.includes("multiply")) return "*";
  if (blob.includes("divide")) return "/";
  // Fallback: check literal operators in original text
  if (text.includes("*")) return "*";
  if (text.includes("+")) return "+";
  return "*"; // default
}

/**
 * Solve a Moltbook verification challenge.
 * Challenges are obfuscated math like:
 *   "lObStEr cLaW fOrCe iS ThIrTy TwO NeWtOnS AnD WAtEr PrEsSuRe Is EiGhT NeWtOnS WhAtS ToTaL?"
 * Strategy: strip noise, extract numbers (digits or words), find operator, compute.
 */
function solveVerificationChallenge(challenge: string): number | null {
  const numbers = extractNumbers(challenge);
  if (numbers.length < 2) return null;

  const op = detectOperator(challenge);
  switch (op) {
    case "+": return numbers[0] + numbers[1];
    case "-": return numbers[0] - numbers[1];
    case "*": return numbers[0] * numbers[1];
    case "/": return numbers[1] !== 0 ? numbers[0] / numbers[1] : null;
    default: return numbers[0] * numbers[1];
  }
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
