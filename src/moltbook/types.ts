// Moltbook API types — shaped to match actual API responses

export interface MoltbookAuthor {
  id: string;
  name: string;
  karma?: number;
  follower_count?: number;
  is_following?: boolean;
}

export interface MoltbookSubmoltRef {
  id: string;
  name: string;
  display_name: string;
}

export interface MoltbookPost {
  id: string;
  title: string;
  content?: string | null;
  url?: string | null;
  upvotes: number;
  downvotes: number;
  comment_count: number;
  created_at: string;
  author: MoltbookAuthor | null;
  submolt: MoltbookSubmoltRef;
}

export interface MoltbookComment {
  id: string;
  content: string;
  upvotes: number;
  downvotes: number;
  created_at: string;
  parent_id: string | null;
  author: MoltbookAuthor | null;
  replies?: MoltbookComment[];
}

export interface MoltbookAgent {
  follower_count?: number;
  following_count?: number;
  posts_count?: number;
  comments_count?: number;
  id: string;
  name: string;
  description: string;
  karma: number;
  is_claimed: boolean;
}

export interface MoltbookSubmolt {
  id: string;
  name: string;
  display_name: string;
  description?: string;
}

// Registration response
export interface MoltbookRegistration {
  agent: {
    api_key: string;
    claim_url: string;
    verification_code: string;
  };
  important: string;
}

// Claude's response format for autonomous Moltbook participation
export interface MoltbookClaudeAction {
  type: "upvote" | "comment" | "post" | "follow";
  agent?: string;
  postId?: string;
  content?: string;
  submolt?: string;
  title?: string;
  parentCommentId?: string;
  parentId?: string;
}

export interface MoltbookCrossPollination {
  postId: string;
  title: string;
  snippet: string;
  submolt: string;
  author?: string;
}

export interface MoltbookCycleResponse {
  actions: MoltbookClaudeAction[];
  crossPollinate: MoltbookCrossPollination[];
  notes: string;
}

// Morning briefing response
export interface BriefingResponse {
  message: string | null;
  journalEntry: string;
}

// State tracking
export interface MoltbookState {
  voiceAttemptDate?: string;
  presenceAttemptDate?: string;
  followedAgentNames?: string[];
  followDate?: string;
  followsToday?: number;
  answeredReplyIds?: string[];
  seenPostIds: string[];
  lastCycleTimestamp: number;
  lastCycleAttemptAt: number;
  crossPollinationQueue: MoltbookCrossPollination[];
  // Rate limit tracking
  lastPostTimestamp: number;
  commentTimestamps: number[];  // last hour of comment timestamps
  // Morning briefing tracking
  lastRunDate: string;  // ISO date string e.g. "2026-02-02"
  briefingAttemptDate: string;
  briefingAttemptCount: number;
  briefingLastAttemptAt: number;
  briefingLastError?: string;
}

// Search results
export interface MoltbookSearchResult {
  id: string;
  type: "post" | "agent" | "submolt";
  title?: string;
  content?: string;
  name?: string;
  description?: string;
  similarity: number;
}

// Profile activity differs from full thread objects; it is scoped to this agent.
export interface MoltbookProfileComment {
  id: string;
  content: string;
  upvotes: number;
  created_at: string;
  post: { id: string };
  // Optional if a future response provides them; current profiles omit both.
  reply_count?: number;
  author?: MoltbookAuthor | null;
}

export interface MoltbookProfilePost {
  id: string;
  title: string;
  content_preview?: string;
  content?: string | null;
  upvotes: number;
  comment_count: number;
  created_at: string;
  author?: MoltbookAuthor | null;
}

export interface MoltbookProfile {
  agent: MoltbookAgent;
  recentComments: MoltbookProfileComment[];
  recentPosts: MoltbookProfilePost[];
}
