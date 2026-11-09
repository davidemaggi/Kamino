import { createHash, randomBytes } from "node:crypto";

/** 256-bit random token, URL-safe. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Tokens are long random values: SHA-256 is enough to store them. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** UUIDv7: time-ordered ids (05: UUIDv7 primary keys). */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Recovery codes: "XXXX-XXXX" from an unambiguous alphabet. */
export function recoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((x) => alphabet[x % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}
