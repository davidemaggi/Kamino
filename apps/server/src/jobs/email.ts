import type { Outbox } from "../email/outbox.js";

/** F8: the outbox drain, run every minute and right after an enqueue. */
export function drainOutbox(outbox: Outbox): Promise<void> {
  return outbox.drain();
}
