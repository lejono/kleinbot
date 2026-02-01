// Moltbook API types — shaped to match actual API responses

export interface MoltbookAuthor {
  id: string;
  name: string;
  karma?: number;
  follower_count?: number;
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
  type: "upvote" | "comment" | "post";
  postId?: string;
  content?: string;
  submolt?: string;
  title?: string;
  parentCommentId?: string;
}

export interface MoltbookCrossPollination {
  postId: string;
  title: string;
  snippet: string;
  submolt: string;
}

export interface MoltbookCycleResponse {
  actions: MoltbookClaudeAction[];
  crossPollinate: MoltbookCrossPollination[];
  notes: string;
}

// State tracking
export interface MoltbookState {
  seenPostIds: string[];
  lastCycleTimestamp: number;
  crossPollinationQueue: MoltbookCrossPollination[];
  // Rate limit tracking
  lastPostTimestamp: number;
  commentTimestamps: number[];  // last hour of comment timestamps
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
