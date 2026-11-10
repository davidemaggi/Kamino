import { PRODUCT_SLUG } from "@kamino/brand";
import { PROTOCOL_MIN_SUPPORTED, PROTOCOL_VERSION } from "@kamino/protocol";
import { eq } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import { fail } from "../auth/http.js";
import { hashToken } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import { devices, users } from "../db/schema.js";

export const PROTOCOL_HEADER = `${PRODUCT_SLUG}-protocol`;
export type Device = typeof devices.$inferSelect;

declare module "fastify" {
  interface FastifyRequest {
    device: Device | null;
  }
}

/** The device behind a token, with its user's status (shared by REST and WebSocket). */
export async function findDeviceByToken(
  db: Db,
  token: string,
): Promise<{ d: Device; status: string } | undefined> {
  return (
    await db
      .select({ d: devices, status: users.status })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(eq(devices.tokenHash, hashToken(token)))
  )[0];
}

/** The same, by device id (the WebSocket re-checks revocation and blocking at each heartbeat). */
export async function findDeviceById(
  db: Db,
  id: string,
): Promise<{ d: Device; status: string } | undefined> {
  return (
    await db
      .select({ d: devices, status: users.status })
      .from(devices)
      .innerJoin(users, eq(users.id, devices.userId))
      .where(eq(devices.id, id))
  )[0];
}

/** Bearer device token → its device; revoked 401, blocked user 403, wrong protocol 426. */
export function deviceGuard(db: Db, now: () => number = Date.now) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const proto = Number(req.headers[PROTOCOL_HEADER]);
    if (!Number.isInteger(proto) || proto < PROTOCOL_MIN_SUPPORTED || proto > PROTOCOL_VERSION)
      return fail(reply, 426, "protocol_unsupported");
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (!token) return fail(reply, 401, "unauthorized");
    const row = await findDeviceByToken(db, token);
    if (!row) return fail(reply, 401, "unauthorized");
    if (row.d.revokedAt) return fail(reply, 401, "device_revoked");
    if (row.status !== "active") return fail(reply, 403, "user_blocked");
    const params = req.params as { vaultId?: string };
    if (params.vaultId !== undefined && params.vaultId !== row.d.vaultId)
      return fail(reply, 404, "not_found");
    req.device = row.d;
    if (!row.d.lastSeenAt || now() - row.d.lastSeenAt.getTime() > 60_000)
      await db
        .update(devices)
        .set({ lastSeenAt: new Date(now()), lastIp: req.ip })
        .where(eq(devices.id, row.d.id));
  };
}
