import { DeviceSettingsPut, SyncSettings } from "@kamino/protocol";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";
import { deviceGuard } from "../devices/auth.js";
import type { SettingsService } from "../vaults/settings.js";
import { parse } from "./auth.js";

/** Plugin routes for the vault defaults and this device's override (S-10…S-13). */
export function settingsRoutes(db: Db, svc: SettingsService) {
  const guard = deviceGuard(db);
  return async (app: FastifyInstance) => {
    app.get("/vault/settings", { preHandler: guard }, async (req) =>
      svc.vaultSettings(req.device!.vaultId),
    );

    app.put("/vault/settings", { preHandler: guard }, async (req, reply) => {
      const b = parse(SyncSettings, req, reply);
      if (!b) return reply;
      await svc.setVaultSettings(req.device!.vaultId, req.device!.id, b);
      return svc.vaultSettings(req.device!.vaultId);
    });

    app.get("/device/settings", { preHandler: guard }, async (req) =>
      svc.deviceSettings(req.device!),
    );

    app.put("/device/settings", { preHandler: guard }, async (req, reply) => {
      const b = parse(DeviceSettingsPut, req, reply);
      if (!b) return reply;
      return svc.setDeviceOverride(req.device!, b.override);
    });
  };
}
