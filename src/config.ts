import path from "path";

/**
 * env:    one X account from the X_API_* environment variables (default).
 * header: one X account per MCP session, from the X-Account request header
 *         (X_MCP_ACCOUNTS=header, streamable HTTP only).
 */
export type AccountsMode = "env" | "header";
export type TransportKind = "stdio" | "http";

export interface StartupConfig {
  accounts: AccountsMode;
  transport: TransportKind;
}

/** Read the accounts mode and transport; throws a message fit for the operator. */
export function resolveStartup(env: NodeJS.ProcessEnv): StartupConfig {
  const transportKind = (env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  const transport: TransportKind = transportKind === "http" || transportKind === "streamablehttp" ? "http" : "stdio";

  const accountsValue = (env.X_MCP_ACCOUNTS ?? "").trim();
  let accounts: AccountsMode;
  if (accountsValue === "") {
    accounts = "env";
  } else if (accountsValue === "header") {
    accounts = "header";
  } else {
    throw new Error(
      'Invalid X_MCP_ACCOUNTS. Leave it unset for one X account from the X_API_* environment variables, or set it to "header" for one X account per MCP session from the X-Account request header.',
    );
  }

  if (accounts === "header" && transport !== "http") {
    throw new Error(
      "X_MCP_ACCOUNTS=header takes each X account from the X-Account HTTP header of an MCP session, so it needs the streamable HTTP transport: set MCP_TRANSPORT=http. To serve one account over stdio, leave X_MCP_ACCOUNTS unset and set the X_API_* variables.",
    );
  }

  return { accounts, transport };
}

/** Single-account state file: X_MCP_STATE_FILE, or {cwd}/x-mcp-state.json (unchanged). */
export function singleStatePath(env: NodeJS.ProcessEnv): string {
  return env.X_MCP_STATE_FILE || path.resolve(process.cwd(), "x-mcp-state.json");
}

/**
 * Header-mode state directory; each account's file is <dir>/accounts/<user id>.json.
 * X_MCP_STATE_DIR, else the directory of X_MCP_STATE_FILE, else the working directory.
 */
export function headerStateDir(env: NodeJS.ProcessEnv): string {
  if (env.X_MCP_STATE_DIR) return path.resolve(env.X_MCP_STATE_DIR);
  if (env.X_MCP_STATE_FILE) return path.dirname(path.resolve(env.X_MCP_STATE_FILE));
  return process.cwd();
}

/** Header mode: seconds without a request before a session is closed (default 1800, 0 = never). */
export function sessionIdleMs(env: NodeJS.ProcessEnv): number {
  const raw = env.X_MCP_SESSION_IDLE_SECONDS;
  if (raw === undefined || raw.trim() === "") return 1800 * 1000;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error("Invalid X_MCP_SESSION_IDLE_SECONDS: give a number of seconds (0 = never close idle sessions).");
  }
  return Math.round(seconds * 1000);
}

/** The single-account credentials, which header mode ignores. */
export const ENV_CREDENTIAL_NAMES = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET", "X_BEARER_TOKEN"] as const;
