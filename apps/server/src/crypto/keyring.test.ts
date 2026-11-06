import { describe, expect, it } from "vitest";
import { MasterKeyError, generateMasterKey, parseMasterKey } from "./keyring.js";

const key = Buffer.alloc(32, 7).toString("base64");

describe("parseMasterKey", () => {
  it("accepts a generated key", () => {
    expect(() => parseMasterKey(generateMasterKey())).not.toThrow();
    expect(parseMasterKey(generateMasterKey()).key).toHaveLength(32);
  });

  it("yields the same kek id with a trailing \n or \r\n (Docker secret files)", () => {
    const id = parseMasterKey(key).id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(parseMasterKey(key + "\n").id).toBe(id);
    expect(parseMasterKey(key + "\r\n").id).toBe(id);
    expect(parseMasterKey("  " + key + " \n").id).toBe(id);
  });

  it("accepts url-safe base64, padded or not", () => {
    const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => 250 - i));
    const std = raw.toString("base64");
    const url = std.replaceAll("+", "-").replaceAll("/", "_");
    expect(url).not.toBe(std);
    expect(Buffer.from(parseMasterKey(url).key)).toEqual(raw);
    expect(Buffer.from(parseMasterKey(url.replace(/=+$/, "")).key)).toEqual(raw);
  });

  it("rejects a 64-char hex key with an actionable message that never echoes the key", () => {
    const hex = "ab".repeat(32);
    let err: unknown;
    try {
      parseMasterKey(hex);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MasterKeyError);
    const msg = (err as Error).message;
    expect(msg).toContain("base64");
    expect(msg).toContain("32 bytes");
    expect(msg).toContain("kamino keys generate");
    expect(msg).not.toContain(hex);
  });

  it("rejects base64 of 16 bytes and non-base64 junk without echoing it", () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    expect(() => parseMasterKey(short)).toThrow(MasterKeyError);
    const junk = "not a key!!";
    expect(() => parseMasterKey(junk)).toThrow(MasterKeyError);
    expect(() => parseMasterKey("")).toThrow(MasterKeyError);
    try {
      parseMasterKey(short);
    } catch (e) {
      expect((e as Error).message).not.toContain(short);
    }
  });
});
