import crypto from "crypto";
import path from "path";
import { XApiClient, type AuthenticatedUser } from "./x-api.js";

// ============================================================
// X-Account header (multi-account mode, X_MCP_ACCOUNTS=header)
// ============================================================

/** Lower-case name, as Node exposes it in req.headers. */
export const ACCOUNT_HEADER = "x-account";

export interface AccountCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

/**
 * Strict format of the X-Account header value:
 *
 *   <api_key>:<api_secret>:<access_token>:<access_token_secret>
 *
 * - api_key:             10-64 ASCII letters or digits (X issues 25)
 * - api_secret:          20-128 ASCII letters or digits (X issues 50)
 * - access_token:        <user id, 1-20 digits>-<10-64 ASCII letters or digits>
 * - access_token_secret: 20-128 ASCII letters or digits (X issues 45)
 *
 * Exactly four parts, nothing else: no spaces, no padding, no other
 * characters. A repeated header (which Node joins with ", ") fails too.
 */
const API_KEY_RE = /^[A-Za-z0-9]{10,64}$/;
const SECRET_RE = /^[A-Za-z0-9]{20,128}$/;
const ACCESS_TOKEN_RE = /^[0-9]{1,20}-[A-Za-z0-9]{10,64}$/;
const MAX_HEADER_LENGTH = 512;

export type AccountHeaderResult =
  | { ok: true; credentials: AccountCredentials; value: string }
  | { ok: false; reason: "missing" | "malformed" };

export function parseAccountHeader(raw: string | string[] | undefined): AccountHeaderResult {
  if (raw === undefined || raw === "") return { ok: false, reason: "missing" };
  if (typeof raw !== "string") return { ok: false, reason: "malformed" };
  if (raw.length > MAX_HEADER_LENGTH) return { ok: false, reason: "malformed" };
  const parts = raw.split(":");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [apiKey, apiSecret, accessToken, accessTokenSecret] = parts;
  if (
    !API_KEY_RE.test(apiKey) ||
    !SECRET_RE.test(apiSecret) ||
    !ACCESS_TOKEN_RE.test(accessToken) ||
    !SECRET_RE.test(accessTokenSecret)
  ) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, credentials: { apiKey, apiSecret, accessToken, accessTokenSecret }, value: raw };
}

/**
 * Keyed hash of the header value. The key is random per process, so the hash
 * means nothing outside this process and is never stored.
 */
export function hashAccountHeader(value: string, key: Buffer): Buffer {
  return crypto.createHmac("sha256", key).update(value, "utf8").digest();
}

/** Constant-time comparison of two header hashes. */
export function sameAccountHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ============================================================
// The `account` tool argument (every tool)
// ============================================================

export interface SessionAccount {
  id: string;
  username: string;
}

export type AccountRef = { kind: "id"; id: string } | { kind: "handle"; handle: string };

/** A handle with or without "@", or a numeric user id. Null when it is neither. */
export function parseAccountRef(value: string): AccountRef | null {
  const trimmed = value.trim();
  if (/^[0-9]{1,20}$/.test(trimmed)) return { kind: "id", id: trimmed };
  const match = trimmed.match(/^@?([A-Za-z0-9_]{1,15})$/);
  if (match) return { kind: "handle", handle: match[1].toLowerCase() };
  return null;
}

export function accountMatches(ref: AccountRef, account: SessionAccount): boolean {
  if (ref.kind === "id") return ref.id === account.id;
  return account.username !== "" && ref.handle === account.username.toLowerCase();
}

/**
 * The guard behind the optional `account` argument. Returns null when the
 * tool may run, or the refusal text. The refusal never repeats an argument
 * that is not a valid handle or id, so a misplaced secret is not echoed.
 */
export async function checkAccountArg(
  value: unknown,
  getAccount: () => Promise<SessionAccount>,
): Promise<string | null> {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    return "Invalid 'account': give a handle (with or without @) or a numeric user id. Nothing was done.";
  }
  const ref = parseAccountRef(value);
  if (!ref) {
    return "Invalid 'account': give a handle (with or without @) or a numeric user id. Nothing was done.";
  }
  let account: SessionAccount;
  try {
    account = await getAccount();
  } catch {
    return "Could not confirm which X account this session acts for, so 'account' cannot be checked. Nothing was done.";
  }
  if (accountMatches(ref, account)) return null;
  const shown = ref.kind === "id" ? ref.id : `@${ref.handle}`;
  const actual = account.username ? `@${account.username} (user id ${account.id})` : `user id ${account.id}`;
  return `Account mismatch: this session acts for ${actual}, not ${shown}. Nothing was done.`;
}

// ============================================================
// Per-account state and clients
// ============================================================

/** State file of one account in header mode: <stateDir>/accounts/<user id>.json */
export function accountStatePath(stateDir: string, userId: string): string {
  if (!/^[0-9]{1,20}$/.test(userId)) {
    throw new Error("Refusing a state path for a user id that is not numeric");
  }
  return path.join(stateDir, "accounts", `${userId}.json`);
}

export interface AccountEntry {
  /** Hex of the header hash: one entry per distinct X-Account value. */
  readonly key: string;
  readonly client: XApiClient;
  readonly statePath: string;
  userId: string;
  username: string;
  sessions: number;
}

export interface VerifiedAccount {
  key: string;
  client: XApiClient;
  user: AuthenticatedUser;
}

export interface AccountRegistryOptions {
  stateDir: string;
  apiBase?: string;
}

/**
 * One XApiClient per account (per distinct X-Account value), kept while at
 * least one MCP session uses it and dropped when its last session closes.
 * Two different accounts never share a client or a state file.
 */
export class AccountRegistry {
  private readonly entries = new Map<string, AccountEntry>();

  constructor(private readonly options: AccountRegistryOptions) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * Check the credentials against X (GET /2/users/me) on every call. Reuses
   * the cached client of the same header when one is live. Throws the
   * client's XApiError when X refuses or cannot be reached.
   */
  async verify(credentials: AccountCredentials, hash: Buffer): Promise<VerifiedAccount> {
    const key = hash.toString("hex");
    const client = this.entries.get(key)?.client ?? new XApiClient({ ...credentials, apiBase: this.options.apiBase });
    const user = await client.verifyCredentials();
    if (!/^[0-9]{1,20}$/.test(user.id)) {
      throw new Error("X returned a user id that is not numeric");
    }
    return { key, client, user };
  }

  /** Count one more session on the account; creates the entry on first use. */
  retain(verified: VerifiedAccount): AccountEntry {
    let entry = this.entries.get(verified.key);
    if (!entry) {
      entry = {
        key: verified.key,
        client: verified.client,
        statePath: accountStatePath(this.options.stateDir, verified.user.id),
        userId: verified.user.id,
        username: verified.user.username,
        sessions: 0,
      };
      this.entries.set(verified.key, entry);
    } else {
      entry.username = verified.user.username || entry.username;
    }
    entry.sessions++;
    return entry;
  }

  /** One session fewer; the client is dropped with the last one. */
  release(entry: AccountEntry): void {
    entry.sessions = Math.max(0, entry.sessions - 1);
    if (entry.sessions === 0 && this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
  }
}
