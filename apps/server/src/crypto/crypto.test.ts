import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { open, seal } from "./aead.js";
import { generateDek, systemKey, unwrapDek, vaultKeys, wrapDek } from "./dek.js";
import { decryptField, encryptField } from "./field.js";
import { hkdf, INFO } from "./kdf.js";
import { parseMasterKey } from "./keyring.js";
import { blobId, pathMac } from "./mac.js";
import { decryptBlob, decryptRange, encryptBlob, HEADER_BYTES, TAG_BYTES } from "./stream.js";

const kek = parseMasterKey(Buffer.alloc(32, 7).toString("base64"));
const key = Buffer.alloc(32, 9);
const ids = { vaultId: "v1", blobId: "b1" };

describe("crypto", () => {
  it("hkdf: fixed labels, distinct subkeys", () => {
    expect(hkdf(key, INFO.meta).toString("hex")).toMatchInlineSnapshot(
      `"5034b01f7ea4ba5d03109c8a2993ddd1137feb79859719538c795241a3042ef2"`,
    );
    const k = vaultKeys(key);
    expect(
      new Set([k.content, k.meta, k.pathmac, k.blobid].map((b) => b.toString("hex"))).size,
    ).toBe(4);
    expect(systemKey(kek).equals(hkdf(kek.key, INFO.system))).toBe(true);
  });

  it("aead: tampering and wrong AAD fail", () => {
    const s = seal(key, Buffer.from("hello"), Buffer.from("aad"));
    expect(open(key, s, Buffer.from("aad")).toString()).toBe("hello");
    expect(() => open(key, s, Buffer.from("other"))).toThrow();
    const t = Buffer.from(s);
    t[t.length - 1]! ^= 1;
    expect(() => open(key, t, Buffer.from("aad"))).toThrow();
  });

  it("DEK wrap is bound to vault and KEK", () => {
    const dek = generateDek();
    const w = wrapDek(kek, "vault-a", dek);
    expect(unwrapDek(kek, "vault-a", w).equals(dek)).toBe(true);
    expect(() => unwrapDek(kek, "vault-b", w)).toThrow();
    const other = parseMasterKey(Buffer.alloc(32, 8).toString("base64"));
    expect(() => unwrapDek(other, "vault-a", w)).toThrow();
  });

  it("fields are bound to table, column and row", () => {
    const ref = { table: "users", column: "totp_secret", rowId: "u1" };
    const s = encryptField(key, ref, "SECRET");
    expect(decryptField(key, ref, s).toString()).toBe("SECRET");
    expect(() => decryptField(key, { ...ref, rowId: "u2" }, s)).toThrow();
    expect(() => decryptField(key, { ...ref, column: "x" }, s)).toThrow();
    expect(encryptField(key, ref, "SECRET").equals(s)).toBe(false); // random nonce
  });

  it("deterministic MACs per key", () => {
    expect(pathMac(key, "a.md").equals(pathMac(key, "a.md"))).toBe(true);
    expect(pathMac(key, "a.md").equals(pathMac(Buffer.alloc(32, 1), "a.md"))).toBe(false);
    expect(blobId(key, "ab")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("stream: fixed vector", () => {
    const blob = encryptBlob(Buffer.from("kamino"), key, ids, {
      segmentSize: 4,
      salt: Buffer.alloc(32, 1),
    });
    expect(blob.toString("hex")).toMatchInlineSnapshot(
      `"0101010101010101010101010101010101010101010101010101010101010101010000000474e9e44dd79ca2baa8566a887614780de451d69786c013b1a368613187d5a425e4c9ab8a4691"`,
    );
  });

  it("stream: round trip and ranges for any size and segment size", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 200 }),
        fc.integer({ min: 1, max: 40 }),
        fc.nat(),
        fc.nat(),
        (data, seg, a, b) => {
          const content = Buffer.from(data);
          const blob = encryptBlob(content, key, ids, { segmentSize: seg });
          expect(decryptBlob(blob, key, ids).equals(content)).toBe(true);
          const offset = content.length === 0 ? 0 : a % content.length;
          const length = b % (content.length - offset + 1);
          expect(
            decryptRange(blob, key, ids, offset, length).equals(
              content.subarray(offset, offset + length),
            ),
          ).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("stream: any flipped byte, truncation, extension, reorder or wrong ids fail", () => {
    const content = Buffer.from("0123456789abcdefghij");
    const blob = encryptBlob(content, key, ids, { segmentSize: 6 });
    for (let i = 0; i < blob.length; i++) {
      const t = Buffer.from(blob);
      t[i]! ^= 0x80;
      expect(() => decryptBlob(t, key, ids), `byte ${i}`).toThrow();
    }
    const segLen = 6 + TAG_BYTES;
    expect(() => decryptBlob(blob.subarray(0, blob.length - 1), key, ids)).toThrow();
    expect(() => decryptBlob(blob.subarray(0, HEADER_BYTES + 3 * segLen), key, ids)).toThrow(); // last segment dropped
    expect(() => decryptBlob(Buffer.concat([blob, Buffer.alloc(1)]), key, ids)).toThrow();
    const swapped = Buffer.concat([
      blob.subarray(0, HEADER_BYTES),
      blob.subarray(HEADER_BYTES + segLen, HEADER_BYTES + 2 * segLen),
      blob.subarray(HEADER_BYTES, HEADER_BYTES + segLen),
      blob.subarray(HEADER_BYTES + 2 * segLen),
    ]);
    expect(() => decryptBlob(swapped, key, ids)).toThrow();
    expect(() => decryptBlob(blob, key, { ...ids, blobId: "b2" })).toThrow();
    expect(() => decryptBlob(blob, key, { ...ids, vaultId: "v2" })).toThrow();
  });
});
