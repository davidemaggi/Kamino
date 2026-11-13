import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where the seeded server writes the TOTP secret of the admin "root". */
export const E2E_TOTP_FILE = join(tmpdir(), "kamino-e2e-totp");

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 6238 code for the current 30 s step (SHA-1, 6 digits), from the seeded secret. */
export function currentTotp(): string {
  let bits = "";
  for (const c of readFileSync(E2E_TOTP_FILE, "utf8").trim().replace(/=+$/, ""))
    bits += B32.indexOf(c.toUpperCase()).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
