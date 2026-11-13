import type { UserDeletion } from "../users/deletion.js";

/** F6: builds the pending exports of users being deleted. */
export function runExports(deletion: UserDeletion): Promise<number> {
  return deletion.runExports();
}

/** F6: finalizes the users whose grace period is over (DEKs, export and personal data destroyed). */
export function finalizeDeletions(deletion: UserDeletion): Promise<number> {
  return deletion.finalizeDue();
}
