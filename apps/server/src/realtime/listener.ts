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

/**
 * Keeps trying in the background (backoff 1 s → 30 s): the server serves REST even while the
 * database is unreachable, and sockets catch up as soon as the listener is in place.
 */
export function keepListening(
  db: Db,
  hub: Hub,
  onError: (e: unknown) => void = () => undefined,
): { stop(): Promise<void> } {
  let stopped = false;
  let current: { stop(): Promise<void> } | undefined;
  let timer: NodeJS.Timeout | undefined;
  const attempt = (delay: number) => {
    startListener(db, hub).then(
      async (l) => {
        if (stopped) await l.stop();
        else current = l;
      },
      (e: unknown) => {
        if (stopped) return;
        onError(e);
        timer = setTimeout(() => attempt(Math.min(delay * 2, 30_000)), delay);
        timer.unref();
      },
    );
  };
  attempt(1_000);
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await current?.stop().catch(() => undefined);
    },
  };
}
