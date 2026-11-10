import type { DeviceStatusReport } from "@kamino/protocol";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { devices } from "../db/schema.js";

/** 03 §12: what a device reports about itself (counts and error codes only, never paths). */
export async function recordStatus(
  db: Db,
  deviceId: string,
  r: DeviceStatusReport,
  now: () => number = Date.now,
): Promise<void> {
  await db
    .update(devices)
    .set({
      pendingOps: r.pendingOps,
      pendingBytes: r.pendingBytes,
      deferredFiles: r.deferredFiles,
      lastErrorCode: r.lastErrorCode ?? null,
      lastErrorAt: r.lastErrorCode ? new Date(now()) : null,
    })
    .where(eq(devices.id, deviceId));
}
