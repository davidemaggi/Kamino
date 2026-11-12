import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { devices, vaults } from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import type { Hub } from "../realtime/hub.js";
import type { Vault, VaultService } from "./service.js";

/**
 * V-03 / F5: the name confirms the deletion. One transaction destroys the DEK (crypto-shredding:
 * every encrypted row and blob of the vault becomes unreadable at once) and revokes its devices;
 * then their sockets close. The ciphertext left behind is removed by the purge job.
 */
export async function deleteVault(
  db: Db,
  hub: Hub,
  vaultsSvc: VaultService,
  vault: Vault,
  confirmName: string,
  now: number,
): Promise<void> {
  if (confirmName.trim() !== vaultsSvc.nameOf(vault).trim())
    throw new ApiError("confirm_mismatch", 400);
  const at = new Date(now);
  const revoked = await db.transaction(async (tx) => {
    // Same row lock as commits and uploads: one in flight finishes first, later ones see "deleted".
    await tx.select({ id: vaults.id }).from(vaults).where(eq(vaults.id, vault.id)).for("update");
    await tx
      .update(vaults)
      .set({ status: "deleted", deletedAt: at, dekWrapped: null, settingsEnc: null })
      .where(eq(vaults.id, vault.id));
    return tx
      .update(devices)
      .set({ revokedAt: at })
      .where(and(eq(devices.vaultId, vault.id), isNull(devices.revokedAt)))
      .returning({ id: devices.id });
  });
  vaultsSvc.forget(vault.id);
  for (const d of revoked) hub.closeDevice(d.id, { type: "device_revoked" });
}
