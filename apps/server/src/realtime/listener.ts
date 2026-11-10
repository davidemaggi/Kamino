import type { Db } from "../db/client.js";
import { NOTIFY_CHANNEL } from "../sync/commit.js";
import type { Hub } from "./hub.js";

/**
 * One dedicated LISTEN connection per process (02 §110). postgres-js subscribes again after a
 * dropped connection and calls `onlisten` each time: notifications may have been missed
 * meanwhile, so every socket re-reads its journal.
 */
export async function startListener(db: Db, hub: Hub): Promise<{ stop(): Promise<void> }> {
  const sub = await db.$client.listen(
    NOTIFY_CHANNEL,
    (payload) => {
      const vaultId = payload.split(":")[0];
      if (vaultId) hub.notify(vaultId);
    },
    () => hub.wakeAll(),
  );
  return { stop: () => sub.unlisten() };
}
