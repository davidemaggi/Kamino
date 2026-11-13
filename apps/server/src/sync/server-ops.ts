import type { ErrorCode, Op, OpResult } from "@kamino/protocol";
import { ApiError } from "../http/errors.js";
import type { VaultCrypto } from "../vaults/vault-crypto.js";
import type { SyncService } from "./commit.js";

const STATUS: Partial<Record<ErrorCode, number>> = {
  not_found: 404,
  invalid_request: 400,
  quota_exceeded: 413,
  file_too_large: 413,
};

/**
 * Commits one op built by the server for the web app (resolutions, restores): the same rules
 * and journal as a device's op, with no device. A rejection becomes the matching HTTP error.
 */
export async function commitForWeb(
  sync: SyncService,
  vc: VaultCrypto,
  op: Op,
): Promise<Exclude<OpResult, { status: "rejected" | "duplicate" }>> {
  const { results } = await sync.commit(vc, null, [op]);
  const r = results[0];
  if (!r) throw new Error("no result");
  if (r.status === "rejected") throw new ApiError(r.code, STATUS[r.code] ?? 409);
  if (r.status === "duplicate") throw new Error("server op ids are never reused");
  return r;
}
