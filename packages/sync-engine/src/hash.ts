import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/** SHA-256 of a stream, piece by piece (never the whole file in memory). */
export async function sha256Hex(parts: AsyncIterable<Uint8Array>): Promise<string> {
  const h = sha256.create();
  for await (const p of parts) h.update(p);
  return bytesToHex(h.digest());
}

/** Hashes what flows through, for verifying a write while it streams. */
export function hashing(parts: AsyncIterable<Uint8Array>): {
  parts: AsyncIterable<Uint8Array>;
  digest(): string;
} {
  const h = sha256.create();
  let done = "";
  return {
    parts: (async function* () {
      for await (const p of parts) {
        h.update(p);
        yield p;
      }
      done = bytesToHex(h.digest());
    })(),
    digest: () => done,
  };
}
