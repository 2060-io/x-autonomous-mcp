import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer, type ServerSettings } from "./server.js";
import type { XApiClient } from "./x-api.js";
import { getDefaultState, saveState } from "./state.js";

// The rule a client derives from these, per tool: read-only means read; else
// destructive means delete; else open world means external; else write.
// Written out here on its own (not imported) so a change to the table in
// tool-meta.ts has to be made twice on purpose.
const EXPECTED: Record<string, { readOnly: boolean; destructive: boolean; openWorld: boolean; idempotent: boolean }> = {
  post_tweet: { readOnly: false, destructive: false, openWorld: true, idempotent: false },
  reply_to_tweet: { readOnly: false, destructive: false, openWorld: true, idempotent: false },
  quote_tweet: { readOnly: false, destructive: false, openWorld: true, idempotent: false },
  delete_tweet: { readOnly: false, destructive: true, openWorld: true, idempotent: false },
  get_tweet: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  search_tweets: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  get_user: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  get_timeline: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  get_mentions: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  get_followers: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  get_following: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  get_non_followers: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  like_tweet: { readOnly: false, destructive: false, openWorld: true, idempotent: false },
  retweet: { readOnly: false, destructive: false, openWorld: true, idempotent: false },
  follow_user: { readOnly: false, destructive: false, openWorld: true, idempotent: false },
  unfollow_user: { readOnly: false, destructive: true, openWorld: true, idempotent: false },
  unlike_tweet: { readOnly: false, destructive: true, openWorld: true, idempotent: true },
  unretweet: { readOnly: false, destructive: true, openWorld: true, idempotent: true },
  upload_media: { readOnly: false, destructive: false, openWorld: true, idempotent: false },
  get_metrics: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  get_list_members: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  get_list_tweets: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  get_followed_lists: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
  // Runs due workflow steps, which can unlike, delete and unfollow on X.
  get_next_task: { readOnly: false, destructive: true, openWorld: true, idempotent: false },
  submit_task: { readOnly: false, destructive: true, openWorld: true, idempotent: false },
  start_workflow: { readOnly: false, destructive: true, openWorld: true, idempotent: false },
  get_workflow_status: { readOnly: true, destructive: false, openWorld: false, idempotent: true },
  cleanup_non_followers: { readOnly: false, destructive: true, openWorld: true, idempotent: false },
  get_queue: { readOnly: true, destructive: false, openWorld: false, idempotent: true },
  complete_queue_item: { readOnly: false, destructive: false, openWorld: false, idempotent: true },
  get_digest: { readOnly: true, destructive: false, openWorld: true, idempotent: true },
};

function ayniRule(a: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean }): string {
  if (a.readOnlyHint) return "read";
  if (a.destructiveHint) return "delete";
  if (a.openWorldHint) return "external";
  return "write";
}

const settings: ServerSettings = {
  budgetConfig: { maxReplies: 8, maxOriginals: 2, maxLikes: 20, maxRetweets: 5, maxFollows: 10, maxUnfollows: 10, maxDeletes: 5 },
  compactMode: true,
  dedupEnabled: true,
  toonEnabled: false,
  protectedAccounts: [],
  digestConfig: { timezone: "", hours: [8], windowMinutes: 60, enabled: false },
};

let tmpDir: string;
let statePath: string;

async function connect(clientStub: Partial<XApiClient> = {}) {
  const server = buildServer({
    client: clientStub as XApiClient,
    statePath,
    settings,
    getAccount: async () => ({ id: "1001", username: "AliceAcct" }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function text(result: unknown): string {
  const content = (result as { content: Array<{ text: string }> }).content;
  return content.map((c) => c.text).join("\n");
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-mcp-server-test-"));
  statePath = path.join(tmpDir, "state.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tool annotations", () => {
  it("annotates all 31 tools as expected", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(tools).toHaveLength(31);
    for (const tool of tools) {
      const e = EXPECTED[tool.name];
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: e.readOnly,
        destructiveHint: e.destructive,
        idempotentHint: e.idempotent,
        openWorldHint: e.openWorld,
      });
    }
  });

  it("gives each tool the rule its name and effects call for", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const rules = Object.fromEntries(tools.map((t) => [t.name, ayniRule(t.annotations ?? {})]));
    expect(rules.get_tweet).toBe("read");
    expect(rules.get_queue).toBe("read");
    expect(rules.get_digest).toBe("read");
    expect(rules.delete_tweet).toBe("delete");
    expect(rules.unfollow_user).toBe("delete");
    expect(rules.unlike_tweet).toBe("delete");
    expect(rules.unretweet).toBe("delete");
    expect(rules.cleanup_non_followers).toBe("delete");
    expect(rules.get_next_task).toBe("delete");
    expect(rules.post_tweet).toBe("external");
    expect(rules.like_tweet).toBe("external");
    expect(rules.complete_queue_item).toBe("write");
  });
});

describe("account argument", () => {
  it("is an optional string on every tool's input schema", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
      expect(props.account?.type, tool.name).toBe("string");
      expect(tool.inputSchema.required ?? [], tool.name).not.toContain("account");
    }
  });

  it("refuses a local tool for another account and changes nothing", async () => {
    const state = getDefaultState();
    state.queue.push({
      id: "q:1", type: "mention_post", status: "pending", created_at: new Date().toISOString(),
      text: "hi @x", intent_url: "https://x.com/intent/post?text=hi", source_tool: "post_tweet",
    });
    saveState(statePath, state);
    const before = fs.readFileSync(statePath, "utf-8");

    const { client } = await connect();
    const r = await client.callTool({ name: "complete_queue_item", arguments: { queue_id: "q:1", action: "posted", account: "@BobAcct" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Account mismatch: this session acts for @AliceAcct (user id 1001), not @bobacct. Nothing was done.");
    expect(fs.readFileSync(statePath, "utf-8")).toBe(before);

    const ok = await client.callTool({ name: "complete_queue_item", arguments: { queue_id: "q:1", action: "posted", account: "@aliceacct" } });
    expect(ok.isError).toBeFalsy();
    expect(text(ok)).toContain("marked as posted");
  });

  it("refuses an X tool for another account before calling X", async () => {
    const likeTweet = vi.fn();
    const { client } = await connect({ likeTweet } as Partial<XApiClient>);
    const r = await client.callTool({ name: "like_tweet", arguments: { tweet_id: "123", account: "2002" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Account mismatch");
    expect(likeTweet).not.toHaveBeenCalled();
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("refuses the workflow tools for another account before running workflows", async () => {
    const { client } = await connect();
    for (const name of ["get_next_task", "submit_task", "start_workflow", "cleanup_non_followers"]) {
      const args = name === "submit_task"
        ? { workflow_id: "w", response: {}, account: "@other" }
        : name === "start_workflow"
          ? { type: "follow_cycle", target: "@someone", account: "@other" }
          : { account: "@other" };
      const r = await client.callTool({ name, arguments: args });
      expect(r.isError, name).toBe(true);
      expect(text(r), name).toContain("Account mismatch");
    }
  });
});

describe("parameter suggestions", () => {
  it("still catches unknown parameters with the account guard added", async () => {
    const { client } = await connect();
    const r = await client.callTool({ name: "post_tweet", arguments: { text: "x", poll_option: ["a", "b"] } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Did you mean 'poll_options'?");
    expect(text(r)).toContain("Valid parameters for post_tweet: text, poll_options, poll_duration_minutes, media_ids, account");
  });

  it("suggests 'account' for a typo and for other ways to name it", async () => {
    const { client } = await connect();
    const typo = await client.callTool({ name: "get_tweet", arguments: { tweet_id: "1", acount: "@AliceAcct" } });
    expect(text(typo)).toContain("Unknown parameter 'acount': Did you mean 'account'?");
    const alias = await client.callTool({ name: "get_tweet", arguments: { tweet_id: "1", as_account: "@AliceAcct" } });
    expect(text(alias)).toContain("Unknown parameter 'as_account': Use 'account'");
  });
});
