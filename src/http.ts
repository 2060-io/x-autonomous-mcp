import { randomBytes, randomUUID } from "node:crypto";
import express from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ACCOUNT_HEADER,
  AccountRegistry,
  hashAccountHeader,
  parseAccountHeader,
  sameAccountHash,
  type AccountCredentials,
  type AccountEntry,
} from "./accounts.js";
import { XApiError } from "./x-api.js";

/**
 * Where the HTTP layer writes. Messages never carry credentials: at most an
 * X user id and an HTTP status.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.error(message),
  warn: (message) => console.error(message),
  error: (message, err) => (err === undefined ? console.error(message) : console.error(message, err)),
};

interface CommonOptions {
  mcpPath: string;
  healthPath: string;
  bodyLimit: string;
  logger: Logger;
}

/** One account from the environment (stdio's twin over HTTP). */
export interface SingleAccountHttpOptions extends CommonOptions {
  mode: "single";
  buildServer: () => McpServer;
}

/** One account per MCP session, from the X-Account header. */
export interface HeaderAccountHttpOptions extends CommonOptions {
  mode: "header";
  registry: AccountRegistry;
  buildServer: (account: AccountEntry) => McpServer;
  /** Runs once the account is verified, before its session's server is built. */
  onAccountVerified?: (account: AccountEntry) => Promise<void>;
  /** Close a session after this long with no request (0 = never). */
  sessionIdleMs: number;
  /** How often idle sessions are looked for. Default: min(60s, sessionIdleMs). */
  sweepIntervalMs?: number;
}

export type HttpAppOptions = SingleAccountHttpOptions | HeaderAccountHttpOptions;

export interface HttpApp {
  app: express.Express;
  sessionCount(): number;
  close(): Promise<void>;
}

type Session = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** Header mode: hash of the X-Account value the session was opened with. */
  accountHash?: Buffer;
  /** Header mode: the account, for logs (user id only). */
  account?: AccountEntry;
  inflight: number;
  lastSeen: number;
};

// --- JSON-RPC error answers (header mode) ---
// None of them repeats the header or any part of it.

const UNAUTHORIZED_CODE = -32001;
const HEADER_FORMAT = "<api_key>:<api_secret>:<access_token>:<access_token_secret>";
const MSG_MISSING = `Unauthorized: this server needs the X-Account header, ${HEADER_FORMAT}.`;
const MSG_MALFORMED = `Unauthorized: the X-Account header is malformed. Expected ${HEADER_FORMAT}, four OAuth 1.0a values of ASCII letters and digits (the access token is <user id>-<letters and digits>).`;
const MSG_REJECTED = "Unauthorized: X rejected the credentials in the X-Account header.";
const MSG_MISMATCH = "Unauthorized: the X-Account header does not match the account this session was opened with.";
const MSG_UNAVAILABLE = "Service unavailable: could not check the X-Account credentials with X. Try again later.";

function rpcId(body: unknown): string | number | null {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const id = (body as { id?: unknown }).id;
    if (typeof id === "string" || typeof id === "number") return id;
  }
  return null;
}

function unauthorized(res: express.Response, message: string, id: string | number | null = null): void {
  res
    .status(401)
    .set("WWW-Authenticate", 'X-Account realm="x-autonomous-mcp"')
    .json({ jsonrpc: "2.0", error: { code: UNAUTHORIZED_CODE, message }, id });
}

export function createHttpApp(opts: HttpAppOptions): HttpApp {
  const { mcpPath, healthPath, bodyLimit, logger } = opts;

  // Session-managed streamable HTTP (MCP SDK standard pattern).
  //
  // The MCP streamable HTTP transport can't be reused across independent
  // sessions: stateless mode explicitly throws "Stateless transport cannot be
  // reused across requests", and a single stateful transport rejects a second
  // initialize with "Invalid Request: Server already initialized". So each
  // client session gets its own transport+server pair, keyed by the session ID
  // the SDK assigns on the initialize response. Subsequent requests look it up
  // via the Mcp-Session-Id header. Sessions are torn down on transport close.
  const sessions = new Map<string, Session>();
  // Key of the header hashes; random per process and never stored.
  const hashKey = randomBytes(32);

  const app = express();

  if (opts.mode === "header") {
    // Runs before the body is parsed, so a request without a valid header is
    // refused without reading its body. Every request needs the header; one
    // on an existing session needs the header the session was opened with.
    app.all(mcpPath, (req, res, next) => {
      const parsed = parseAccountHeader(req.headers[ACCOUNT_HEADER]);
      if (!parsed.ok) {
        unauthorized(res, parsed.reason === "missing" ? MSG_MISSING : MSG_MALFORMED);
        return;
      }
      const hash = hashAccountHeader(parsed.value, hashKey);
      const sessionId = req.headers["mcp-session-id"];
      if (typeof sessionId === "string") {
        const session = sessions.get(sessionId);
        if (!session) {
          // MCP: a 404 on a session id tells the client to initialize again.
          res.status(404).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Session not found. Send an initialize request to open a new session." },
            id: null,
          });
          return;
        }
        if (!session.accountHash || !sameAccountHash(hash, session.accountHash)) {
          unauthorized(res, MSG_MISMATCH);
          return;
        }
      }
      res.locals.account = { credentials: parsed.credentials, hash };
      next();
    });
  }

  // express.json default body limit is 100 KB — far too small for base64-encoded
  // media uploads. Allow up to 50 MB (matches X's media size limits) so tools like
  // upload_media can accept typical images and videos over the streamable HTTP transport.
  app.use(express.json({ limit: bodyLimit }));
  app.get(healthPath, (_req, res) => {
    res.status(200).send("ok");
  });

  async function openSingleSession(builder: () => McpServer): Promise<Session> {
    const mcpServer = builder();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, session);
      },
    });
    const session: Session = { server: mcpServer, transport, inflight: 0, lastSeen: Date.now() };
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await mcpServer.connect(transport);
    return session;
  }

  async function openHeaderSession(
    o: HeaderAccountHttpOptions,
    req: express.Request,
    res: express.Response,
  ): Promise<Session | undefined> {
    const { credentials, hash } = res.locals.account as { credentials: AccountCredentials; hash: Buffer };
    let verified;
    try {
      verified = await o.registry.verify(credentials, hash);
    } catch (err) {
      if (err instanceof XApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
        logger.warn(`[x-mcp] X refused the credentials of an X-Account header (HTTP ${err.status})`);
        unauthorized(res, MSG_REJECTED, rpcId(req.body));
      } else {
        const why = err instanceof XApiError ? `HTTP ${err.status}` : "no usable answer";
        logger.warn(`[x-mcp] could not check an X-Account header with X (${why})`);
        res.status(503).json({ jsonrpc: "2.0", error: { code: -32000, message: MSG_UNAVAILABLE }, id: rpcId(req.body) });
      }
      return undefined;
    }

    const entry = o.registry.retain(verified);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      o.registry.release(entry);
    };

    try {
      if (o.onAccountVerified) await o.onAccountVerified(entry);
      const mcpServer = o.buildServer(entry);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, session);
          logger.info(`[x-mcp] session opened for X account ${entry.userId}`);
        },
      });
      const session: Session = { server: mcpServer, transport, accountHash: hash, account: entry, inflight: 0, lastSeen: Date.now() };
      transport.onclose = () => {
        if (transport.sessionId && sessions.get(transport.sessionId) === session) {
          sessions.delete(transport.sessionId);
          logger.info(`[x-mcp] session closed for X account ${entry.userId}`);
        }
        release();
      };
      await mcpServer.connect(transport);
      return session;
    } catch (err) {
      release();
      throw err;
    }
  }

  app.all(mcpPath, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let session = sessionId ? sessions.get(sessionId) : undefined;
      let fresh = false;

      if (!session) {
        // No session yet — only initialize requests are allowed to create one.
        const body = req.body as { method?: string } | undefined;
        const isInitialize = req.method === "POST" && body?.method === "initialize";
        if (!isInitialize) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no session. Send an initialize request first." },
            id: null,
          });
          return;
        }

        session = opts.mode === "header" ? await openHeaderSession(opts, req, res) : await openSingleSession(opts.buildServer);
        if (!session) return; // refused, answer already sent
        fresh = true;
      }

      const current = session;
      current.inflight++;
      current.lastSeen = Date.now();
      res.on("close", () => {
        current.inflight--;
        current.lastSeen = Date.now();
      });

      await current.transport.handleRequest(req, res, req.body);

      // An initialize the SDK refused leaves no session behind: free its account.
      if (fresh && opts.mode === "header" && !(current.transport.sessionId && sessions.has(current.transport.sessionId))) {
        await current.transport.close().catch(() => undefined);
      }
    } catch (err) {
      logger.error("[x-mcp] handleRequest error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Header mode: a client that goes away without closing its session (no
  // DELETE) would keep the session, and its account's client, forever.
  let sweeper: NodeJS.Timeout | undefined;
  if (opts.mode === "header" && opts.sessionIdleMs > 0) {
    const idleMs = opts.sessionIdleMs;
    sweeper = setInterval(() => {
      const now = Date.now();
      for (const [sid, s] of sessions) {
        if (s.inflight <= 0 && now - s.lastSeen >= idleMs) {
          logger.info(`[x-mcp] closing idle session of X account ${s.account?.userId ?? "unknown"}`);
          // transport.close() runs onclose, which forgets the session and releases the account.
          void s.transport.close().catch(() => undefined);
          void s.server.close().catch(() => undefined);
          sessions.delete(sid);
        }
      }
    }, opts.sweepIntervalMs ?? Math.min(60_000, idleMs));
    sweeper.unref();
  }

  return {
    app,
    sessionCount: () => sessions.size,
    async close() {
      if (sweeper) clearInterval(sweeper);
      for (const [, { transport, server }] of sessions) {
        try { await transport.close(); } catch { /* ignore */ }
        try { await server.close(); } catch { /* ignore */ }
      }
      sessions.clear();
    },
  };
}
