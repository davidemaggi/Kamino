import { collisionKey } from "@kamino/sync-core";
import { unwrapDek, vaultKeys, type VaultKeys } from "../crypto/dek.js";
import { decryptField, encryptField } from "../crypto/field.js";
import type { Kek } from "../crypto/keyring.js";
import { blobId, pathMac } from "../crypto/mac.js";

/** Everything a request needs to read and write one vault's encrypted rows. */
export class VaultCrypto {
  readonly keys: VaultKeys;
  constructor(
    readonly vaultId: string,
    kek: Kek,
    dekWrapped: Uint8Array,
  ) {
    this.keys = vaultKeys(unwrapDek(kek, vaultId, dekWrapped));
  }
  enc(table: string, column: string, rowId: string, value: string): Buffer {
    return encryptField(this.keys.meta, { table, column, rowId }, value);
  }
  dec(table: string, column: string, rowId: string, sealed: Uint8Array): string {
    return decryptField(this.keys.meta, { table, column, rowId }, sealed).toString("utf8");
  }
  pathMac(path: string): Buffer {
    return pathMac(this.keys.pathmac, collisionKey(path));
  }
  macOfKey(key: string): Buffer {
    return pathMac(this.keys.pathmac, key);
  }
  blobId(contentHash: string): string {
    return blobId(this.keys.blobid, contentHash);
  }
}
