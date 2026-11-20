import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import path from "path";
import {
  parseAccountHeader,
  hashAccountHeader,
  sameAccountHash,
  parseAccountRef,
  accountMatches,
  checkAccountArg,
  accountStatePath,
  AccountRegistry,
} from "./accounts.js";

// Test credentials in the shape X issues (not real keys).
const KEY = "AbCdEfGhIjKlMnOpQrStUvWxY"; // 25
const SECRET = "s".repeat(25) + "S".repeat(25); // 50
const TOKEN = "1234567890-" + "t".repeat(40);
const TOKEN_SECRET = "u".repeat(45);
const VALID = `${KEY}:${SECRET}:${TOKEN}:${TOKEN_SECRET}`;

describe("parseAccountHeader", () => {
  it("accepts <api_key>:<api_secret>:<access_token>:<access_token_secret>", () => {
    const r = parseAccountHeader(VALID);
    expect(r).toEqual({
      ok: true,
      value: VALID,
      credentials: { apiKey: KEY, apiSecret: SECRET, accessToken: TOKEN, accessTokenSecret: TOKEN_SECRET },
    });
  });

  it("reports a missing header", () => {
    expect(parseAccountHeader(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(parseAccountHeader("")).toEqual({ ok: false, reason: "missing" });
  });

  it.each([
    ["three parts", `${KEY}:${SECRET}:${TOKEN}`],
    ["five parts", `${VALID}:extra`],
    ["an empty part", `${KEY}::${TOKEN}:${TOKEN_SECRET}`],
    ["a space inside", `${KEY}:${SECRET} :${TOKEN}:${TOKEN_SECRET}`],
    ["leading space", ` ${VALID}`],
    ["a repeated header joined by Node", `${VALID}, ${VALID}`],
    ["an access token without the user id", `${KEY}:${SECRET}:${"t".repeat(40)}:${TOKEN_SECRET}`],
    ["an access token with a letter in the user id", `${KEY}:${SECRET}:12a4-${"t".repeat(40)}:${TOKEN_SECRET}`],
    ["an access token with two dashes", `${KEY}:${SECRET}:123-456-${"t".repeat(40)}:${TOKEN_SECRET}`],
    ["a non-ASCII letter", `${KEY.slice(0, -1)}é:${SECRET}:${TOKEN}:${TOKEN_SECRET}`],
    ["base64 padding", `${KEY}:${SECRET}=:${TOKEN}:${TOKEN_SECRET}`],
    ["a short key", `abc:${SECRET}:${TOKEN}:${TOKEN_SECRET}`],
    ["a short secret", `${KEY}:short:${TOKEN}:${TOKEN_SECRET}`],
    ["an over-long value", `${KEY}:${"s".repeat(128)}:${TOKEN}:${"u".repeat(128)}${"x".repeat(200)}`],
    ["a Bearer value", `Bearer ${KEY}`],
  ])("rejects %s", (_label, value) => {
    expect(parseAccountHeader(value)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an array value", () => {
    expect(parseAccountHeader([VALID, VALID])).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("header hash", () => {
  const key = crypto.randomBytes(32);

  it("is stable for the same value and differs for another", () => {
    const a = hashAccountHeader(VALID, key);
    expect(sameAccountHash(a, hashAccountHeader(VALID, key))).toBe(true);
    const other = `${KEY}:${SECRET}:${TOKEN}:${"v".repeat(45)}`;
    expect(sameAccountHash(a, hashAccountHeader(other, key))).toBe(false);
  });

  it("depends on the process key", () => {
    const a = hashAccountHeader(VALID, key);
    expect(sameAccountHash(a, hashAccountHeader(VALID, crypto.randomBytes(32)))).toBe(false);
  });

  it("compares with crypto.timingSafeEqual", () => {
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    sameAccountHash(hashAccountHeader(VALID, key), hashAccountHeader(VALID, key));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("returns false for different lengths without throwing", () => {
    expect(sameAccountHash(Buffer.alloc(32), Buffer.alloc(16))).toBe(false);
  });
});

describe("parseAccountRef / accountMatches", () => {
  const account = { id: "1001", username: "AliceAcct" };

  it("reads handles with or without @ and numeric ids", () => {
    expect(parseAccountRef("@AliceAcct")).toEqual({ kind: "handle", handle: "aliceacct" });
    expect(parseAccountRef("AliceAcct")).toEqual({ kind: "handle", handle: "aliceacct" });
    expect(parseAccountRef("1001")).toEqual({ kind: "id", id: "1001" });
    expect(parseAccountRef("@1001")).toEqual({ kind: "handle", handle: "1001" });
  });

  it("refuses what is neither", () => {
    expect(parseAccountRef("a:b")).toBeNull();
    expect(parseAccountRef("@")).toBeNull();
    expect(parseAccountRef("way_too_long_handle_x")).toBeNull();
    expect(parseAccountRef("")).toBeNull();
  });

  it("matches handles case-insensitively and ids exactly", () => {
    expect(accountMatches({ kind: "handle", handle: "aliceacct" }, account)).toBe(true);
    expect(accountMatches({ kind: "handle", handle: "bobacct" }, account)).toBe(false);
    expect(accountMatches({ kind: "id", id: "1001" }, account)).toBe(true);
    expect(accountMatches({ kind: "id", id: "10011" }, account)).toBe(false);
  });

  it("never matches a handle when the username is unknown", () => {
    expect(accountMatches({ kind: "handle", handle: "aliceacct" }, { id: "1001", username: "" })).toBe(false);
  });
});

describe("checkAccountArg", () => {
  const getAccount = async () => ({ id: "1001", username: "AliceAcct" });

  it("lets the call run without the argument, without asking who the account is", async () => {
    const lookup = vi.fn(getAccount);
    expect(await checkAccountArg(undefined, lookup)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("lets a matching handle or id through", async () => {
    expect(await checkAccountArg("@aliceacct", getAccount)).toBeNull();
    expect(await checkAccountArg("AliceAcct", getAccount)).toBeNull();
    expect(await checkAccountArg("1001", getAccount)).toBeNull();
  });

  it("refuses another account and names both", async () => {
    const r = await checkAccountArg("@BobAcct", getAccount);
    expect(r).toContain("Account mismatch");
    expect(r).toContain("@AliceAcct (user id 1001)");
    expect(r).toContain("@bobacct");
    expect(r).toContain("Nothing was done");
  });

  it("refuses an invalid value without repeating it", async () => {
    const secretLike = `${KEY}:${SECRET}`;
    const r = await checkAccountArg(secretLike, getAccount);
    expect(r).toContain("Invalid 'account'");
    expect(r).not.toContain(KEY);
    expect(r).not.toContain(SECRET);
    expect(await checkAccountArg(42, getAccount)).toContain("Invalid 'account'");
  });

  it("refuses when the session's account cannot be confirmed", async () => {
    const r = await checkAccountArg("@AliceAcct", async () => {
      throw new Error("network down");
    });
    expect(r).toContain("Could not confirm");
  });
});

describe("accountStatePath", () => {
  it("puts each account under <dir>/accounts/<user id>.json", () => {
    expect(accountStatePath("/data", "1001")).toBe(path.join("/data", "accounts", "1001.json"));
  });

  it("refuses an id that is not numeric (no path tricks)", () => {
    expect(() => accountStatePath("/data", "../etc/passwd")).toThrow();
    expect(() => accountStatePath("/data", "")).toThrow();
  });
});

describe("AccountRegistry", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function stubUsersMe(id: string, username: string, status = 200) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => ({
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        text: async () => JSON.stringify(status === 200 ? { data: { id, username } } : { title: "Unauthorized", status }),
      })),
    );
  }

  const creds = { apiKey: KEY, apiSecret: SECRET, accessToken: TOKEN, accessTokenSecret: TOKEN_SECRET };
  const hash = hashAccountHeader(VALID, crypto.randomBytes(32));

  it("verifies against X on every call, even with a cached client", async () => {
    stubUsersMe("1001", "AliceAcct");
    const registry = new AccountRegistry({ stateDir: "/data" });
    const v1 = await registry.verify(creds, hash);
    const entry = registry.retain(v1);
    const v2 = await registry.verify(creds, hash);
    expect(v2.client).toBe(entry.client);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  });

  it("keeps the client while sessions use it and drops it with the last one", async () => {
    stubUsersMe("1001", "AliceAcct");
    const registry = new AccountRegistry({ stateDir: "/data" });
    const v = await registry.verify(creds, hash);
    const e1 = registry.retain(v);
    const e2 = registry.retain(await registry.verify(creds, hash));
    expect(e2).toBe(e1);
    expect(e1.sessions).toBe(2);
    expect(e1.statePath).toBe(path.join("/data", "accounts", "1001.json"));
    registry.release(e1);
    expect(registry.size).toBe(1);
    registry.release(e1);
    expect(registry.size).toBe(0);
  });

  it("throws X's status when X refuses the credentials", async () => {
    stubUsersMe("", "", 401);
    const registry = new AccountRegistry({ stateDir: "/data" });
    await expect(registry.verify(creds, hash)).rejects.toMatchObject({ status: 401 });
    expect(registry.size).toBe(0);
  });
});
