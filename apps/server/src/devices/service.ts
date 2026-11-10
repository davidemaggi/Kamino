import type { Device as DeviceDto } from "@kamino/protocol";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { devices } from "../db/schema.js";
import type { Hub } from "../realtime/hub.js";
import type { Vault, VaultService } from "../vaults/service.js";
import { deviceLevel } from "./level.js";

type Row = typeof devices.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** D-06: what the user sees about devices; ownership is always checked by the caller's user id. */
export class DeviceService {
  constructor(
    private readonly db: Db,
    private readonly vaults: VaultService,
    private readonly hub: Hub,
    private readonly now: () => number = Date.now,
  ) {}

  toDto(d: Row, v: Vault): DeviceDto {
    return {
      id: d.id,
      vaultId: d.vaultId,
      vaultName: this.vaults.nameOf(v),
      name: d.name,
      platform: d.platform,
      pluginVersion: d.pluginVersion,
      lastSeenAt: (d.lastSeenAt ?? d.createdAt).toISOString(),
      lastSyncAt: d.lastSyncAt?.toISOString() ?? null,
      lag: Math.max(0, v.headSeq - d.cursorSeq),
      pending: d.pendingOps,
      lastError: d.lastErrorCode,
      level: deviceLevel(
        {
          cursor: d.cursorSeq,
          pending: d.pendingOps,
          deferred: d.deferredFiles,
          lastSync: d.lastSyncAt,
          lastAck: d.lastAckAt,
          error: d.lastErrorCode,
          revoked: d.revokedAt !== null,
        },
        v.headSeq,
      ),
      revoked: d.revokedAt !== null,
    };
  }

  private async dtos(rows: Row[]): Promise<DeviceDto[]> {
    const vaultIds = [...new Set(rows.map((r) => r.vaultId))];
    const byId = new Map<string, Vault>();
    for (const id of vaultIds) {
      const v = await this.vaults.byId(id);
      if (v && v.status === "active") byId.set(id, v);
    }
    return rows.flatMap((r) => {
      const v = byId.get(r.vaultId);
      return v ? [this.toDto(r, v)] : [];
    });
  }

  async list(userId: string): Promise<DeviceDto[]> {
    const rows = await this.db
      .select()
      .from(devices)
      .where(eq(devices.userId, userId))
      .orderBy(desc(devices.createdAt));
    return this.dtos(rows);
  }

  async ofVault(vaultId: string): Promise<DeviceDto[]> {
    const rows = await this.db
      .select()
      .from(devices)
      .where(eq(devices.vaultId, vaultId))
      .orderBy(desc(devices.createdAt));
    return this.dtos(rows);
  }

  async get(userId: string, id: string): Promise<DeviceDto | undefined> {
    if (!UUID.test(id)) return undefined;
    const rows = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.userId, userId)));
    return (await this.dtos(rows))[0];
  }

  async rename(userId: string, id: string, name: string): Promise<DeviceDto | undefined> {
    if (!UUID.test(id)) return undefined;
    await this.db
      .update(devices)
      .set({ name })
      .where(and(eq(devices.id, id), eq(devices.userId, userId)));
    return this.get(userId, id);
  }

  /** Idempotent; closes the device's sockets on this instance (others notice at their heartbeat). */
  async revoke(userId: string, id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const [row] = await this.db
      .select({ id: devices.id, revokedAt: devices.revokedAt })
      .from(devices)
      .where(and(eq(devices.id, id), eq(devices.userId, userId)));
    if (!row) return false;
    if (!row.revokedAt)
      await this.db
        .update(devices)
        .set({ revokedAt: new Date(this.now()) })
        .where(inArray(devices.id, [id]));
    this.hub.closeDevice(id, { type: "device_revoked" });
    return true;
  }
}
