import { notFound } from "../http/errors.js";
import type { VaultCrypto } from "./vault-crypto.js";
import type { Vault, VaultService } from "./service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The vault `vaultId` if `userId` owns it and it is active. Anything else (malformed id, unknown,
 * someone else's, deleted) is the same 404: no admin bypass and nothing to learn about other users.
 */
export async function ownedVault(
  vaults: VaultService,
  userId: string,
  vaultId: string,
): Promise<{ vault: Vault; vc: VaultCrypto }> {
  if (!UUID.test(vaultId)) throw notFound();
  const vault = await vaults.byId(vaultId);
  if (!vault || vault.ownerId !== userId || vault.status !== "active") throw notFound();
  return { vault, vc: vaults.cryptoOf(vault) };
}
