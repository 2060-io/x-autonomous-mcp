#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { XApiClient } from "./x-api.js";
import { buildServer, loadServerSettings, resolveProtectedAccountIds, type ServerContext, type ServerSettings } from "./server.js";
import { AccountRegistry } from "./accounts.js";
import { createHttpApp, consoleLogger, type HttpApp } from "./http.js";
import { ENV_CREDENTIAL_NAMES, headerStateDir, resolveStartup, sessionIdleMs, singleStatePath, type StartupConfig } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}. See .env.example for required variables.`);
  }
  return value;
}

// ============================================================
// START SERVER
// ============================================================

async function startStdio(ctx: ServerContext): Promise<void> {
  const server = buildServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function httpOptions() {
  return {
    port: Number(process.env.MCP_PORT ?? process.env.PORT ?? "8000"),
    mcpPath: process.env.MCP_PATH ?? "/mcp",
    healthPath: process.env.MCP_HEALTH_PATH ?? "/healthz",
    bodyLimit: process.env.MCP_BODY_LIMIT ?? "50mb",
  };
}

async function listen(http: HttpApp, port: number, banner: string): Promise<void> {
  await new Promise<void>((resolve) => {
    http.app.listen(port, () => {
      console.error(banner);
      resolve();
    });
  });

  const shutdown = async (signal: string) => {
    console.error(`[x-mcp] Received ${signal}, shutting down ${http.sessionCount()} session(s)`);
    try {
      await http.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/** One account from the X_API_* environment variables (stdio or HTTP). */
async function startSingleAccount(settings: ServerSettings, transport: "stdio" | "http"): Promise<void> {
  const client = new XApiClient({
    apiKey: requireEnv("X_API_KEY"),
    apiSecret: requireEnv("X_API_SECRET"),
    accessToken: requireEnv("X_ACCESS_TOKEN"),
    accessTokenSecret: requireEnv("X_ACCESS_TOKEN_SECRET"),
    bearerToken: requireEnv("X_BEARER_TOKEN"),
  });
  const ctx: ServerContext = {
    client,
    statePath: singleStatePath(process.env),
    settings,
    getAccount: () => client.getAuthenticatedUser(),
  };

  await resolveProtectedAccountIds(client, settings.protectedAccounts);

  if (transport === "stdio") {
    await startStdio(ctx);
    return;
  }

  const { port, mcpPath, healthPath, bodyLimit } = httpOptions();
  const http = createHttpApp({
    mode: "single",
    mcpPath,
    healthPath,
    bodyLimit,
    logger: consoleLogger,
    buildServer: () => buildServer(ctx),
  });
  await listen(
    http,
    port,
    `[x-mcp] StreamableHTTP transport listening on :${port}${mcpPath} (body limit: ${bodyLimit}, health: ${healthPath})`,
  );
}

/** One account per MCP session, from the X-Account header (HTTP only). */
async function startHeaderAccounts(settings: ServerSettings): Promise<void> {
  const ignored = ENV_CREDENTIAL_NAMES.filter((name) => process.env[name]);
  if (ignored.length > 0) {
    console.error(`[x-mcp] X_MCP_ACCOUNTS=header: ignoring ${ignored.join(", ")} (accounts come from the X-Account header)`);
  }

  const stateDir = headerStateDir(process.env);
  const registry = new AccountRegistry({ stateDir });

  // Protected accounts are global: resolve their user ids once, with the
  // first verified account's client (a public lookup).
  let protectedIds: Promise<void> | null = null;

  const { port, mcpPath, healthPath, bodyLimit } = httpOptions();
  const http = createHttpApp({
    mode: "header",
    mcpPath,
    healthPath,
    bodyLimit,
    logger: consoleLogger,
    registry,
    sessionIdleMs: sessionIdleMs(process.env),
    onAccountVerified: async (account) => {
      protectedIds ??= resolveProtectedAccountIds(account.client, settings.protectedAccounts);
      await protectedIds;
    },
    buildServer: (account) =>
      buildServer({
        client: account.client,
        statePath: account.statePath,
        settings,
        getAccount: async () => ({ id: account.userId, username: account.username }),
      }),
  });
  await listen(
    http,
    port,
    `[x-mcp] StreamableHTTP transport listening on :${port}${mcpPath} (body limit: ${bodyLimit}, health: ${healthPath}, accounts: X-Account header, state: ${path.join(stateDir, "accounts")})`,
  );
}

async function main(): Promise<void> {
  let startup: StartupConfig;
  let settings: ServerSettings;
  try {
    startup = resolveStartup(process.env);
    settings = loadServerSettings();
  } catch (error) {
    // A configuration mistake: say what to change, without a stack trace.
    console.error(`[x-mcp] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  if (startup.accounts === "header") {
    await startHeaderAccounts(settings);
  } else {
    await startSingleAccount(settings, startup.transport);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
