import {
  DEFAULT_SYNC_SETTINGS,
  SyncSettings,
  VAULT_EVENT_ID,
  type DeviceSettings,
} from "@kamino/protocol";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { devices, journal, vaults } from "../db/schema.js";
import { AuthError } from "../auth/service.js";
import { NOTIFY_CHANNEL } from "../sync/commit.js";
import type { VaultService } from "./service.js";

type DeviceRef = { id: string; vaultId: string };

/**
 * S-10…S-13: vault defaults and per-device overrides, encrypted with the vault's k_meta (patterns
 * can reveal the vault's structure). A change of the defaults is a journal entry, so it reaches
 * every device like any other change (WebSocket, `changes`).
 */
export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly vaults: VaultService,
    private readonly now: () => number = Date.now,
  ) {}

  private async crypto(vaultId: string) {
    const v = await this.vaults.byId(vaultId);
    if (!v || v.status !== "active") throw new AuthError("not_found", 404);
    return { v, vc: this.vaults.cryptoOf(v) };
  }

  async vaultSettings(vaultId: string): Promise<SyncSettings> {
    const { v, vc } = await this.crypto(vaultId);
    if (!v.settingsEnc) return DEFAULT_SYNC_SETTINGS;
    return SyncSettings.parse(JSON.parse(vc.dec("vaults", "settings", v.id, v.settingsEnc)));
  }

  async setVaultSettings(
    vaultId: string,
    deviceId: string,
    s: SyncSettings,
  ): Promise<{ seq: number }> {
    const { vc } = await this.crypto(vaultId);
    return this.db.transaction(async (tx) => {
      // Same lock and sequence as commits: the entry gets the next seq.
      const [locked] = await tx
        .select({ head: vaults.headSeq })
        .from(vaults)
        .where(eq(vaults.id, vaultId))
        .for("update");
      const seq = (locked?.head ?? 0) + 1;
      await tx
        .update(vaults)
        .set({
          settingsEnc: vc.enc("vaults", "settings", vaultId, JSON.stringify(s)),
          headSeq: seq,
        })
        .where(eq(vaults.id, vaultId));
      await tx.insert(journal).values({
        vaultId,
        seq,
        type: "vault_settings_changed",
        fileId: VAULT_EVENT_ID,
        kind: "file",
        pathEnc: vc.enc("journal", "path", `${vaultId}:${seq}`, VAULT_EVENT_ID),
        deviceId,
        at: new Date(this.now()),
      });
      await tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${`${vaultId}:${seq}`})`);
      return { seq };
    });
  }

  async deviceSettings(d: DeviceRef): Promise<DeviceSettings> {
    const { vc } = await this.crypto(d.vaultId);
    const [row] = await this.db
      .select({ o: devices.settingsOverrideEnc })
      .from(devices)
      .where(eq(devices.id, d.id));
    const override = row?.o
      ? SyncSettings.parse(JSON.parse(vc.dec("devices", "settings_override", d.id, row.o)))
      : null;
    return { override, effective: override ?? (await this.vaultSettings(d.vaultId)) };
  }

  async setDeviceOverride(d: DeviceRef, o: SyncSettings | null): Promise<DeviceSettings> {
    const { vc } = await this.crypto(d.vaultId);
    await this.db
      .update(devices)
      .set({
        settingsOverrideEnc:
          o === null ? null : vc.enc("devices", "settings_override", d.id, JSON.stringify(o)),
      })
      .where(eq(devices.id, d.id));
    return this.deviceSettings(d);
  }
}
