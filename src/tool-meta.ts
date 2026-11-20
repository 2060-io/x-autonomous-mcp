import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

// --- Valid parameter keys per tool (for Levenshtein suggestions) ---
// Every tool also takes the optional `account` guard (see checkAccountArg).

export const VALID_KEYS: Record<string, string[]> = {
  post_tweet: ["text", "poll_options", "poll_duration_minutes", "media_ids", "account"],
  reply_to_tweet: ["tweet_id", "text", "media_ids", "account"],
  quote_tweet: ["tweet_id", "text", "media_ids", "account"],
  delete_tweet: ["tweet_id", "account"],
  get_tweet: ["tweet_id", "account"],
  search_tweets: ["query", "max_results", "min_likes", "min_retweets", "sort_order", "since_id", "next_token", "account"],
  get_user: ["username", "user_id", "account"],
  get_timeline: ["user", "max_results", "next_token", "account"],
  get_mentions: ["max_results", "since_id", "next_token", "account"],
  get_followers: ["user", "max_results", "next_token", "account"],
  get_following: ["user", "max_results", "next_token", "account"],
  follow_user: ["user", "account"],
  unfollow_user: ["user", "account"],
  get_non_followers: ["max_pages", "account"],
  like_tweet: ["tweet_id", "account"],
  retweet: ["tweet_id", "account"],
  unlike_tweet: ["tweet_id", "account"],
  unretweet: ["tweet_id", "account"],
  upload_media: ["media_data", "mime_type", "media_category", "account"],
  get_metrics: ["tweet_id", "account"],
  get_list_members: ["list_id", "max_results", "next_token", "account"],
  get_list_tweets: ["list_id", "max_results", "next_token", "account"],
  get_followed_lists: ["max_results", "next_token", "account"],
  get_next_task: ["account"],
  submit_task: ["workflow_id", "response", "account"],
  start_workflow: ["type", "target", "reply_tweet_id", "account"],
  get_workflow_status: ["type", "include_completed", "account"],
  cleanup_non_followers: ["max_unfollow", "max_pages", "account"],
  get_queue: ["status", "account"],
  complete_queue_item: ["queue_id", "action", "account"],
  get_digest: ["account"],
};

// --- MCP tool annotations ---
// A client derives each tool's rule from these, in this order: read-only
// means read; else destructive means delete; else open world means external;
// else write. So a hint errs on the cautious side whenever a tool can do more
// than its name says.
//
// - readOnlyHint: the tool changes nothing on X. Some reads still keep the
//   server's own bookkeeping (get_mentions caches who mentioned the account,
//   get_digest marks queue items the operator already posted).
// - destructiveHint: the tool can remove or undo something on X. The three
//   workflow tools (get_next_task, submit_task, start_workflow) run every due
//   workflow step, and a due follow_cycle cleanup unlikes, deletes the reply
//   and unfollows, and a due reply_track audit deletes a reply: so they are
//   destructive, and get_next_task is not read-only despite its name.
// - openWorldHint: the tool calls X. False only for tools that read or change
//   the server's own state file and nothing else.
// - idempotentHint: a repeat call with the same arguments has no further effect.

const READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const LOCAL_READ: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const UNDO: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Tweets
  post_tweet: WRITE,
  reply_to_tweet: WRITE,
  quote_tweet: WRITE,
  // Budget-counted: a repeat delete spends budget again, so not idempotent.
  delete_tweet: DESTRUCTIVE,
  get_tweet: READ,
  // Search and users
  search_tweets: READ,
  get_user: READ,
  get_timeline: READ,
  get_mentions: READ,
  get_followers: READ,
  get_following: READ,
  get_non_followers: READ,
  // Engagement
  like_tweet: WRITE,
  retweet: WRITE,
  follow_user: WRITE,
  // Budget-counted: a repeat unfollow spends budget again, so not idempotent.
  unfollow_user: DESTRUCTIVE,
  unlike_tweet: UNDO,
  unretweet: UNDO,
  // Media and metrics
  upload_media: WRITE,
  get_metrics: READ,
  // Lists
  get_list_members: READ,
  get_list_tweets: READ,
  get_followed_lists: READ,
  // Workflows (see destructiveHint above)
  get_next_task: DESTRUCTIVE,
  submit_task: DESTRUCTIVE,
  start_workflow: DESTRUCTIVE,
  get_workflow_status: LOCAL_READ,
  cleanup_non_followers: DESTRUCTIVE,
  // Human-in-the-loop queue
  get_queue: LOCAL_READ,
  complete_queue_item: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Calls X (the account's recent replies) to close queue items already posted.
  get_digest: READ,
};
