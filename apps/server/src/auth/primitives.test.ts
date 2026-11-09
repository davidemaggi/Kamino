import { describe, expect, it } from "vitest";
import { describeClient, ipPrefix } from "./client-info.js";
import { hashPassword, isWeakPassword, verifyPassword } from "./password.js";
import { RateLimiter } from "./rate-limit.js";
import { hashToken, randomToken, uuidv7 } from "./tokens.js";
import { base32Decode, base32Encode, hotp, otpauthUrl, verifyTotp, totpCode } from "./totp.js";

describe("password", () => {
  it("argon2id round trip; unknown user still costs a verification", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
    expect(await verifyPassword(null, "anything")).toBe(false);
  });
  it("weak: too short or common", () => {
    expect(isWeakPassword("short")).toBe(true);
    expect(isWeakPassword("Unbelievable")).toBe(true); // in the common list (case-insensitive)
    expect(isWeakPassword("Qp7#vT2!mZx9")).toBe(false);
  });
});

describe("totp (RFC 6238 appendix B, SHA-1)", () => {
  const key = Buffer.from("12345678901234567890");
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
  ])("t=%i", (t, code) => {
    expect(hotp(key, Math.floor(t / 30), 8)).toBe(code);
  });
  it("window ±1 and anti-replay", () => {
    const secret = base32Encode(key);
    expect(base32Decode(secret).equals(key)).toBe(true);
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpCode(secret, step - 1), now, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 2), now, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), now, step)).toBeNull();
    expect(otpauthUrl("Kamino", "demo", secret)).toContain(`secret=${secret}`);
  });
});

describe("tokens and client info", () => {
  it("tokens are 256-bit, hashed with SHA-256", () => {
    const t = randomToken();
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it("client and IP are described, never stored raw in responses", () => {
    expect(
      describeClient("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Gecko/20100101 Firefox/131.0"),
    ).toBe("Firefox · macOS");
    expect(describeClient("obsidian/1.7 Android")).toBe("Obsidian · Android");
    expect(describeClient(undefined)).toBe("?");
    expect(ipPrefix("192.168.1.42")).toBe("192.168.1.x");
    expect(ipPrefix("2001:db8:85a3::8a2e:370:7334")).toBe("2001:db8:85a3:x");
    expect(ipPrefix("::ffff:10.0.0.5")).toBe("10.0.0.x");
  });
  it("rate limiter: fixed window per bucket and key", () => {
    let now = 0;
    const rl = new RateLimiter({ login: { max: 2, windowMs: 1000 } }, () => now);
    expect(rl.hit("login", "a").ok).toBe(true);
    expect(rl.hit("login", "a").ok).toBe(true);
    expect(rl.hit("login", "a")).toEqual({ ok: false, retryAfterSec: 1 });
    expect(rl.hit("login", "b").ok).toBe(true);
    now = 1000;
    expect(rl.hit("login", "a").ok).toBe(true);
  });
});
