/**
 * The streamable HTTP layer, in both account modes, against a fake X API on
 * 127.0.0.1 (no external network). The fake checks every OAuth 1.0a
 * signature the way X does (RFC 5849), so a wrong secret or a badly signed
 * read is refused like X would refuse it. Its search answer is the frozen
 * search-tweets fixture; the other answers are minimal acknowledgements.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import type { AddressInfo } from "net";
import type { Server } from "http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp, type HttpApp, type Logger } from "./http.js";
import { AccountRegistry } from "./accounts.js";
import { buildServer, type ServerSettings } from "./server.js";
import { XApiClient } from "./x-api.js";
import { resolveStartup, singleStatePath, headerStateDir, sessionIdleMs } from "./config.js";

// ------------------------------------------------------------------
// Test accounts (credentials in the shape X issues; not real keys)
// ------------------------------------------------------------------

interface FakeAccount {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
  bearer?: string;
  id: string;
  username: string;
}

const ALICE: FakeAccount = {
  apiKey: "AliceKey0000000000000000A",
  apiSecret: "AliceApiSecret" + "a".repeat(36),
  accessToken: "1001-AliceAccessToken" + "b".repeat(24),
  accessTokenSecret: "AliceTokenSecret" + "c".repeat(29),
  id: "1001",
  username: "AliceAcct",
};
const BOB: FakeAccount = {
  apiKey: "BobKey0000000000000000000",
  apiSecret: "BobApiSecret" + "d".repeat(38),
  accessToken: "2002-BobAccessToken" + "e".repeat(26),
  accessTokenSecret: "BobTokenSecret" + "f".repeat(31),
  id: "2002",
  username: "BobAcct",
};
// The single-account (environment) mode reads with an app bearer token.
const ENV_ACCOUNT: FakeAccount = {
  apiKey: "EnvKey0000000000000000000",
  apiSecret: "EnvApiSecret" + "g".repeat(38),
  accessToken: "3003-EnvAccessToken" + "h".repeat(26),
  accessTokenSecret: "EnvTokenSecret" + "i".repeat(31),
  bearer: "EnvBearerToken" + "j".repeat(40),
  id: "3003",
  username: "EnvAcct",
};

const header = (a: FakeAccount) => `${a.apiKey}:${a.apiSecret}:${a.accessToken}:${a.accessTokenSecret}`;

/** Every credential string a test must never see in a log, answer or file. */
const SECRETS = [ALICE, BOB, ENV_ACCOUNT].flatMap((a) => [
  a.apiKey, a.apiSecret, a.accessToken, a.accessTokenSecret, header(a), ...(a.bearer ? [a.bearer] : []),
]);

// ------------------------------------------------------------------
// Fake X API
// ------------------------------------------------------------------

interface XCall {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: "oauth1" | "bearer";
  account: string; // user id
}

function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** RFC 5849 signature check, done independently of the oauth-1.0a library. */
function verifyOAuth1(req: express.Request, accounts: FakeAccount[]): FakeAccount | null {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("OAuth ")) return null;
  const params: Record<string, string> = {};
  for (const part of auth.slice(6).split(/,\s*/)) {
    const eq = part.indexOf("=");
    params[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1).replace(/^"|"$/g, ""));
  }
  const account = accounts.find((a) => a.apiKey === params.oauth_consumer_key && a.accessToken === params.oauth_token);
  if (!account) return null;

  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  const pairs: Array<[string, string]> = [];
  url.searchParams.forEach((v, k) => pairs.push([k, v])); // form decoding: "+" is a space
  for (const [k, v] of Object.entries(params)) {
    if (k !== "oauth_signature" && k !== "realm") pairs.push([k, v]);
  }
  const normalized = pairs
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [req.method.toUpperCase(), rfc3986(`${url.origin}${url.pathname}`), rfc3986(normalized)].join("&");
  const key = `${rfc3986(account.apiSecret)}&${rfc3986(account.accessTokenSecret)}`;
  const expected = crypto.createHmac("sha1", key).update(base).digest("base64");
  return expected === params.oauth_signature ? account : null;
}

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadSearchFixture(): unknown {
  const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES, "search-tweets.json"), "utf-8"));
  delete raw._source;
  delete raw._endpoint;
  return raw;
}

async function startFakeX(accounts: FakeAccount[]) {
  const calls: XCall[] = [];
  const unavailable = new Set<string>(); // user ids whose /users/me answers 503
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const auth = req.headers.authorization ?? "";
    let account: FakeAccount | null = null;
    let kind: XCall["auth"] = "oauth1";
    if (auth.startsWith("Bearer ")) {
      kind = "bearer";
      account = accounts.find((a) => a.bearer && auth === `Bearer ${a.bearer}`) ?? null;
    } else {
      account = verifyOAuth1(req, accounts);
    }
    if (!account) {
      res.status(401).json({ title: "Unauthorized", type: "about:blank", status: 401, detail: "Unauthorized" });
      return;
    }
    calls.push({ method: req.method, path: req.path, query: req.query as Record<string, string>, auth: kind, account: account.id });
    res.locals.account = account;
    next();
  });
  app.get("/2/users/me", (_req, res) => {
    const a = res.locals.account as FakeAccount;
    if (unavailable.has(a.id)) {
      res.status(503).json({ title: "Service Unavailable" });
      return;
    }
    res.json({ data: { id: a.id, name: a.username, username: a.username } });
  });
  app.post("/2/users/:id/likes", (req, res) => {
    if (req.params.id !== (res.locals.account as FakeAccount).id) {
      res.status(403).json({ title: "Forbidden" });
      return;
    }
    res.json({ data: { liked: true } });
  });
  app.get("/2/tweets/search/recent", (_req, res) => {
    res.json(loadSearchFixture());
  });

  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}/2`,
    calls,
    unavailable,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ------------------------------------------------------------------
// The server under test
// ------------------------------------------------------------------

function settings(overrides: Partial<ServerSettings["budgetConfig"]> = {}): ServerSettings {
  return {
    budgetConfig: { maxReplies: 8, maxOriginals: 2, maxLikes: 20, maxRetweets: 5, maxFollows: 10, maxUnfollows: 10, maxDeletes: 5, ...overrides },
    compactMode: true,
    dedupEnabled: true,
    toonEnabled: false,
    protectedAccounts: [],
    digestConfig: { timezone: "", hours: [8], windowMinutes: 60, enabled: false },
  };
}

/** Collects every log line the HTTP layer writes. */
function captureLogger(lines: string[]): Logger {
  const fmt = (m: string, e?: unknown) => (e === undefined ? m : `${m} ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`);
  return {
    info: (m) => lines.push(fmt(m)),
    warn: (m) => lines.push(fmt(m)),
    error: (m, e) => lines.push(fmt(m, e)),
  };
}

async function listen(http: HttpApp) {
  const server = await new Promise<Server>((resolve) => {
    const s = http.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await http.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startHeaderMode(xBase: string, stateDir: string, logs: string[], opts: { maxLikes?: number; sessionIdleMs?: number; sweepIntervalMs?: number } = {}) {
  const registry = new AccountRegistry({ stateDir, apiBase: xBase });
  const s = settings({ maxLikes: opts.maxLikes ?? 20 });
  const http = createHttpApp({
    mode: "header",
    mcpPath: "/mcp",
    healthPath: "/healthz",
    bodyLimit: "1mb",
    logger: captureLogger(logs),
    registry,
    sessionIdleMs: opts.sessionIdleMs ?? 0,
    sweepIntervalMs: opts.sweepIntervalMs,
    buildServer: (account) =>
      buildServer({
        client: account.client,
        statePath: account.statePath,
        settings: s,
        getAccount: async () => ({ id: account.userId, username: account.username }),
      }),
  });
  const server = await listen(http);
  return { ...server, http, registry };
}

/** Everything the tests saw come back: HTTP bodies and tool results. */
const seen: string[] = [];

async function connect(url: string, account?: FakeAccount) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: account ? { headers: { "X-Account": header(account) } } : undefined,
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>).map((c) => c.text).join("\n");
  seen.push(text);
  return { isError: result.isError === true, text };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } },
};

async function rawPost(url: string, headers: Record<string, string>, body: unknown = INIT) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  seen.push(text);
  return { status: res.status, text, headers: res.headers };
}

function stateFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out;
}

async function waitFor(check: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ------------------------------------------------------------------

let fakeX: Awaited<ReturnType<typeof startFakeX>>;
let tmpDir: string;
let logs: string[];
let consoleLines: string[];

beforeAll(async () => {
  fakeX = await startFakeX([ALICE, BOB, ENV_ACCOUNT]);
});

afterAll(async () => {
  await fakeX.close();
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-mcp-http-test-"));
  logs = [];
  consoleLines = [];
  fakeX.calls.length = 0;
  fakeX.unavailable.clear();
  // Anything written straight to the console is captured too.
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("header mode: refusing a missing or bad X-Account header", () => {
  it("answers 401 with a JSON-RPC error when the header is missing", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs);
    try {
      const r = await rawPost(mcp.url, {});
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain("X-Account");
      const body = JSON.parse(r.text);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toContain("needs the X-Account header");
      expect(fakeX.calls).toHaveLength(0);
      expect(mcp.registry.size).toBe(0);
    } finally {
      await mcp.close();
    }
  });

  it("answers 401 when the header is malformed, without repeating it", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs);
    try {
      const bad = `${ALICE.apiKey}:${ALICE.apiSecret}:${ALICE.accessToken}`;
      const r = await rawPost(mcp.url, { "X-Account": bad });
      expect(r.status).toBe(401);
      expect(JSON.parse(r.text).error.message).toContain("malformed");
      expect(r.text).not.toContain(ALICE.apiKey);
      expect(fakeX.calls).toHaveLength(0);
    } finally {
      await mcp.close();
    }
  });

  it("answers 401 when X rejects the keys", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs);
    try {
      // Well-formed, but the secret is not Alice's: X refuses the signature.
      const wrongSecret = `${ALICE.apiKey}:${"W".repeat(50)}:${ALICE.accessToken}:${ALICE.accessTokenSecret}`;
      const r = await rawPost(mcp.url, { "X-Account": wrongSecret });
      expect(r.status).toBe(401);
      const body = JSON.parse(r.text);
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toBe("Unauthorized: X rejected the credentials in the X-Account header.");
      expect(body.id).toBe(1);
      // Unknown keys are refused the same way.
      const unknown = `${"Z".repeat(25)}:${"Y".repeat(50)}:9999-${"X".repeat(40)}:${"V".repeat(45)}`;
      expect((await rawPost(mcp.url, { "X-Account": unknown })).status).toBe(401);
      expect(mcp.registry.size).toBe(0);
      expect(mcp.http.sessionCount()).toBe(0);
    } finally {
      await mcp.close();
    }
  });

  it("answers 503 when X cannot be asked, and opens no session", async () => {
    fakeX.unavailable.add(ALICE.id);
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs);
    try {
      const r = await rawPost(mcp.url, { "X-Account": header(ALICE) });
      expect(r.status).toBe(503);
      expect(mcp.registry.size).toBe(0);
    } finally {
      await mcp.close();
    }
  });

  it("checks the keys with GET /2/users/me on initialize", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs);
    try {
      const { client, transport } = await connect(mcp.url, ALICE);
      expect(fakeX.calls.filter((c) => c.path === "/2/users/me")).toEqual([
        expect.objectContaining({ method: "GET", auth: "oauth1", account: ALICE.id }),
      ]);
      await transport.terminateSession();
      await client.close();
    } finally {
      await mcp.close();
    }
  });
});

describe("header mode: a session is bound to its account", () => {
  it("answers 401 when the header changes or disappears mid-session", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs);
    try {
      const { client, transport } = await connect(mcp.url, ALICE);
      const sessionId = transport.sessionId!;
      const list = { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} };

      // Another valid account on Alice's session.
      const other = await rawPost(mcp.url, { "X-Account": header(BOB), "Mcp-Session-Id": sessionId }, list);
      expect(other.status).toBe(401);
      expect(JSON.parse(other.text).error.message).toContain("does not match the account this session was opened with");

      // One character changed.
      const changed = header(ALICE).slice(0, -1) + "Q";
      expect((await rawPost(mcp.url, { "X-Account": changed, "Mcp-Session-Id": sessionId }, list)).status).toBe(401);

      // No header at all.
      expect((await rawPost(mcp.url, { "Mcp-Session-Id": sessionId }, list)).status).toBe(401);

      // The right header still works, on the same session.
      const ok = await rawPost(mcp.url, { "X-Account": header(ALICE), "Mcp-Session-Id": sessionId }, list);
      expect(ok.status).toBe(200);
      expect(ok.text).toContain("like_tweet");

      await transport.terminateSession();
      await client.close();
    } finally {
      await mcp.close();
    }
  });

  it("answers 404 for an unknown session so the client opens a new one", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs);
    try {
      const r = await rawPost(mcp.url, { "X-Account": header(ALICE), "Mcp-Session-Id": "no-such-session" }, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect(r.status).toBe(404);
    } finally {
      await mcp.close();
    }
  });
});

describe("header mode: two accounts at once", () => {
  it("keeps separate clients, state files and budgets", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs, { maxLikes: 1 });
    try {
      const alice = await connect(mcp.url, ALICE);
      const bob = await connect(mcp.url, BOB);
      expect(mcp.registry.size).toBe(2);

      const a1 = await call(alice.client, "like_tweet", { tweet_id: "111" });
      expect(a1.isError).toBe(false);
      expect(a1.text).toContain("1/1 likes used");

      // Bob's budget is his own: Alice's like does not count against it.
      const b1 = await call(bob.client, "like_tweet", { tweet_id: "222" });
      expect(b1.isError).toBe(false);
      expect(b1.text).toContain("1/1 likes used");

      // Alice is out of likes, Bob's dedup does not know her tweet.
      const a2 = await call(alice.client, "like_tweet", { tweet_id: "333" });
      expect(a2.isError).toBe(true);
      expect(a2.text).toContain("Daily like limit reached (1/1)");

      const aliceState = JSON.parse(fs.readFileSync(path.join(tmpDir, "accounts", "1001.json"), "utf-8"));
      const bobState = JSON.parse(fs.readFileSync(path.join(tmpDir, "accounts", "2002.json"), "utf-8"));
      expect(aliceState.budget.likes).toBe(1);
      expect(aliceState.engaged.liked.map((e: { tweet_id: string }) => e.tweet_id)).toEqual(["111"]);
      expect(bobState.budget.likes).toBe(1);
      expect(bobState.engaged.liked.map((e: { tweet_id: string }) => e.tweet_id)).toEqual(["222"]);
      expect(fs.existsSync(path.join(tmpDir, "x-mcp-state.json"))).toBe(false);

      // Each like went to X signed with its own account's keys.
      const likes = fakeX.calls.filter((c) => c.method === "POST" && c.path.endsWith("/likes"));
      expect(likes).toEqual([
        expect.objectContaining({ path: "/2/users/1001/likes", account: "1001", auth: "oauth1" }),
        expect.objectContaining({ path: "/2/users/2002/likes", account: "2002", auth: "oauth1" }),
      ]);

      // Clients are dropped when their sessions close.
      await alice.transport.terminateSession();
      await alice.client.close();
      await waitFor(() => mcp.registry.size === 1);
      await bob.transport.terminateSession();
      await bob.client.close();
      await waitFor(() => mcp.registry.size === 0);
    } finally {
      await mcp.close();
    }
  });

  it("shares one client between two sessions of the same account", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs);
    try {
      const s1 = await connect(mcp.url, ALICE);
      const s2 = await connect(mcp.url, ALICE);
      expect(mcp.http.sessionCount()).toBe(2);
      expect(mcp.registry.size).toBe(1);
      await s1.transport.terminateSession();
      await s1.client.close();
      await waitFor(() => mcp.http.sessionCount() === 1);
      expect(mcp.registry.size).toBe(1);
      await s2.transport.terminateSession();
      await s2.client.close();
      await waitFor(() => mcp.registry.size === 0);
    } finally {
      await mcp.close();
    }
  });

  it("closes a session left idle without a DELETE and drops its client", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs, { sessionIdleMs: 100, sweepIntervalMs: 20 });
    try {
      const { client, transport } = await connect(mcp.url, ALICE);
      const sessionId = transport.sessionId!;
      await call(client, "get_queue", {});
      await client.close(); // no terminateSession: the client just goes away
      await waitFor(() => mcp.http.sessionCount() === 0);
      expect(mcp.registry.size).toBe(0);
      const r = await rawPost(mcp.url, { "X-Account": header(ALICE), "Mcp-Session-Id": sessionId }, { jsonrpc: "2.0", id: 3, method: "tools/list" });
      expect(r.status).toBe(404);
    } finally {
      await mcp.close();
    }
  });
});

describe("header mode: reads", () => {
  it("signs reads with OAuth 1.0a user context, search queries with spaces included", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs);
    try {
      const { client, transport } = await connect(mcp.url, ALICE);
      const r = await call(client, "search_tweets", { query: "AI safety -is:retweet (lang:en OR lang:de)", max_results: 10 });
      expect(r.isError).toBe(false);
      expect(r.text).toContain('"data"');
      const search = fakeX.calls.find((c) => c.path === "/2/tweets/search/recent");
      expect(search).toMatchObject({ auth: "oauth1", account: ALICE.id });
      expect(search!.query.query).toBe("AI safety -is:retweet (lang:en OR lang:de)");
      await transport.terminateSession();
      await client.close();
    } finally {
      await mcp.close();
    }
  });
});

describe("header mode: the account argument", () => {
  it("refuses a call pinned to another account and lets the right one through", async () => {
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs);
    try {
      const { client, transport } = await connect(mcp.url, ALICE);

      for (const other of ["@BobAcct", "BobAcct", "2002"]) {
        const r = await call(client, "like_tweet", { tweet_id: "444", account: other });
        expect(r.isError).toBe(true);
        expect(r.text).toContain("Account mismatch: this session acts for @AliceAcct (user id 1001)");
        expect(r.text).toContain("Nothing was done.");
      }
      expect(fakeX.calls.filter((c) => c.path.endsWith("/likes"))).toHaveLength(0);
      expect(fs.existsSync(path.join(tmpDir, "accounts", "1001.json"))).toBe(false);

      const byHandle = await call(client, "like_tweet", { tweet_id: "444", account: "@aliceacct" });
      expect(byHandle.isError).toBe(false);
      const byId = await call(client, "like_tweet", { tweet_id: "555", account: "1001" });
      expect(byId.isError).toBe(false);
      expect(fakeX.calls.filter((c) => c.path.endsWith("/likes"))).toHaveLength(2);

      await transport.terminateSession();
      await client.close();
    } finally {
      await mcp.close();
    }
  });
});

describe("credentials never leak", () => {
  it("keeps every credential out of logs, HTTP answers, tool results and state", async () => {
    seen.length = 0;
    const mcp = await startHeaderMode(fakeX.base, tmpDir, logs, { maxLikes: 1 });
    try {
      // Every refusal path.
      await rawPost(mcp.url, {});
      await rawPost(mcp.url, { "X-Account": `${header(ALICE)}:extra` });
      await rawPost(mcp.url, { "X-Account": `${ALICE.apiKey}:${"W".repeat(50)}:${ALICE.accessToken}:${ALICE.accessTokenSecret}` });
      fakeX.unavailable.add(BOB.id);
      await rawPost(mcp.url, { "X-Account": header(BOB) });
      fakeX.unavailable.clear();

      // Working sessions, tool errors included.
      const alice = await connect(mcp.url, ALICE);
      const bob = await connect(mcp.url, BOB);
      await rawPost(mcp.url, { "X-Account": header(BOB), "Mcp-Session-Id": alice.transport.sessionId! }, { jsonrpc: "2.0", id: 9, method: "tools/list" });
      await call(alice.client, "like_tweet", { tweet_id: "1" });
      await call(alice.client, "like_tweet", { tweet_id: "2" }); // budget refusal
      await call(alice.client, "like_tweet", { tweet_id: "3", account: "@BobAcct" }); // account refusal
      await call(alice.client, "like_tweet", { tweet_id: "3", account: header(ALICE) }); // a secret in the wrong place
      await call(bob.client, "search_tweets", { query: "mcp server" });
      await call(bob.client, "get_tweet", { tweet_id: "not-an-id" }); // tool error
      await call(bob.client, "get_metrics", { tweet_id: "999" }); // X error (no such route in the fake)
      await call(bob.client, "get_next_task", {});
      await alice.transport.terminateSession();
      await alice.client.close();
      await bob.transport.terminateSession();
      await bob.client.close();
    } finally {
      await mcp.close();
    }

    const files = stateFiles(tmpDir);
    expect(files.length).toBeGreaterThan(0);
    const haystacks: Array<[string, string]> = [
      ...logs.map((l) => ["log", l] as [string, string]),
      ...consoleLines.map((l) => ["console", l] as [string, string]),
      ...seen.map((s) => ["answer", s] as [string, string]),
      ...files.map((f) => [`state ${path.basename(f)}`, fs.readFileSync(f, "utf-8")] as [string, string]),
    ];
    expect(logs.length).toBeGreaterThan(0);
    for (const [where, text] of haystacks) {
      for (const secret of SECRETS) {
        expect(text.includes(secret), `${where} contains a credential`).toBe(false);
      }
    }
  });
});

describe("single-account mode (no X_MCP_ACCOUNTS)", () => {
  it("serves the environment account without any X-Account header, as before", async () => {
    const client = new XApiClient({
      apiKey: ENV_ACCOUNT.apiKey,
      apiSecret: ENV_ACCOUNT.apiSecret,
      accessToken: ENV_ACCOUNT.accessToken,
      accessTokenSecret: ENV_ACCOUNT.accessTokenSecret,
      bearerToken: ENV_ACCOUNT.bearer,
      apiBase: fakeX.base,
    });
    const statePath = path.join(tmpDir, "x-mcp-state.json");
    const http = createHttpApp({
      mode: "single",
      mcpPath: "/mcp",
      healthPath: "/healthz",
      bodyLimit: "1mb",
      logger: captureLogger(logs),
      buildServer: () =>
        buildServer({ client, statePath, settings: settings(), getAccount: () => client.getAuthenticatedUser() }),
    });
    const mcp = await listen(http);
    try {
      // No session yet and not an initialize: 400, as today.
      const noSession = await rawPost(mcp.url, {}, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(noSession.status).toBe(400);
      expect(JSON.parse(noSession.text).error.message).toBe("Bad Request: no session. Send an initialize request first.");

      const s = await connect(mcp.url);
      const like = await call(s.client, "like_tweet", { tweet_id: "777" });
      expect(like.isError).toBe(false);
      const search = await call(s.client, "search_tweets", { query: "AI safety" });
      expect(search.isError).toBe(false);

      // Reads still use the app bearer token; writes OAuth 1.0a.
      expect(fakeX.calls.find((c) => c.path === "/2/tweets/search/recent")).toMatchObject({ auth: "bearer", account: ENV_ACCOUNT.id });
      expect(fakeX.calls.find((c) => c.path.endsWith("/likes"))).toMatchObject({ auth: "oauth1", account: ENV_ACCOUNT.id });

      // Same single state file; no per-account directory.
      expect(JSON.parse(fs.readFileSync(statePath, "utf-8")).budget.likes).toBe(1);
      expect(fs.existsSync(path.join(tmpDir, "accounts"))).toBe(false);

      // The account guard works here too (the account comes from /2/users/me).
      const wrong = await call(s.client, "get_queue", { account: "@AliceAcct" });
      expect(wrong.isError).toBe(true);
      expect(wrong.text).toContain("this session acts for @EnvAcct (user id 3003)");
      expect((await call(s.client, "get_queue", { account: "@EnvAcct" })).isError).toBe(false);

      // An X-Account header changes nothing in this mode.
      const withHeader = await connect(mcp.url, ALICE);
      expect((await call(withHeader.client, "get_queue", { account: "@EnvAcct" })).isError).toBe(false);

      await s.transport.terminateSession();
      await s.client.close();
      await withHeader.transport.terminateSession();
      await withHeader.client.close();
    } finally {
      await mcp.close();
    }
  });
});

describe("startup configuration", () => {
  it("keeps today's single-account mode when X_MCP_ACCOUNTS is unset", () => {
    expect(resolveStartup({})).toEqual({ accounts: "env", transport: "stdio" });
    expect(resolveStartup({ MCP_TRANSPORT: "http" })).toEqual({ accounts: "env", transport: "http" });
    expect(singleStatePath({})).toBe(path.resolve(process.cwd(), "x-mcp-state.json"));
    expect(singleStatePath({ X_MCP_STATE_FILE: "/data/x-mcp-state.json" })).toBe("/data/x-mcp-state.json");
  });

  it("serves the header mode over streamable HTTP", () => {
    expect(resolveStartup({ X_MCP_ACCOUNTS: "header", MCP_TRANSPORT: "http" })).toEqual({ accounts: "header", transport: "http" });
    expect(resolveStartup({ X_MCP_ACCOUNTS: "header", MCP_TRANSPORT: "streamableHttp" })).toEqual({ accounts: "header", transport: "http" });
  });

  it("refuses the header mode over stdio with a clear message", () => {
    expect(() => resolveStartup({ X_MCP_ACCOUNTS: "header" })).toThrow(/needs the streamable HTTP transport: set MCP_TRANSPORT=http/);
    expect(() => resolveStartup({ X_MCP_ACCOUNTS: "header", MCP_TRANSPORT: "stdio" })).toThrow(/X-Account/);
  });

  it("refuses an unknown accounts mode", () => {
    expect(() => resolveStartup({ X_MCP_ACCOUNTS: "headers", MCP_TRANSPORT: "http" })).toThrow(/Invalid X_MCP_ACCOUNTS/);
  });

  it("puts header-mode state under X_MCP_STATE_DIR, else next to X_MCP_STATE_FILE", () => {
    expect(headerStateDir({ X_MCP_STATE_DIR: "/data" })).toBe(path.resolve("/data"));
    expect(headerStateDir({ X_MCP_STATE_FILE: "/data/x-mcp-state.json" })).toBe(path.resolve("/data"));
    expect(headerStateDir({})).toBe(process.cwd());
  });

  it("reads the session idle timeout", () => {
    expect(sessionIdleMs({})).toBe(1_800_000);
    expect(sessionIdleMs({ X_MCP_SESSION_IDLE_SECONDS: "0" })).toBe(0);
    expect(sessionIdleMs({ X_MCP_SESSION_IDLE_SECONDS: "90" })).toBe(90_000);
    expect(() => sessionIdleMs({ X_MCP_SESSION_IDLE_SECONDS: "soon" })).toThrow();
  });
});
