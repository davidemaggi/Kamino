import { describe, expect, it } from "vitest";
import {
  ConflictDetail,
  Device,
  ErrorCode,
  PairingState,
  Resolution,
  ResolveAllRequest,
  Vault,
  VaultPatch,
} from "./index.js";

const vault = {
  id: "v1",
  name: "Note",
  fileCount: 128,
  deviceCount: 3,
  level: "decision",
  conflicts: 2,
  usedBytes: 1,
  historyBytes: 1,
  trashBytes: 1,
  retentionDays: 30,
  maxRetentionDays: 90,
  historyFrom: "2026-10-09T00:00:00Z",
};
const base = {
  id: "c1",
  vaultId: "v1",
  vaultName: "Note",
  path: "Spesa.md",
  kind: "concurrent_edit",
  mine: { device: "Mac", at: "x" },
  incoming: { device: "iPhone", at: "y" },
};

describe("user area contract", () => {
  it("vaults and retention bounds", () => {
    expect(Vault.parse(vault).name).toBe("Note");
    expect(VaultPatch.safeParse({ retentionDays: 91 }).success).toBe(false);
    expect(VaultPatch.safeParse({ name: "  " }).success).toBe(false);
  });

  it("devices", () => {
    const d = {
      id: "d",
      vaultId: "v1",
      vaultName: "Note",
      name: "Mac",
      platform: "macOS",
      pluginVersion: "0.1.0",
      lastSeenAt: "x",
      lastSyncAt: null,
      lag: 0,
      pending: 0,
      lastError: null,
      level: "safe",
      revoked: false,
    };
    expect(Device.parse(d).revoked).toBe(false);
  });

  it("pairing state carries a 4-char code when requested", () => {
    expect(
      PairingState.safeParse({
        status: "requested",
        request: { deviceName: "Pixel", platform: "Android", pluginVersion: "0.1.0", code: "K7RX" },
      }).success,
    ).toBe(true);
    expect(
      PairingState.safeParse({
        status: "requested",
        request: { deviceName: "P", platform: "A", pluginVersion: "0", code: "K7" },
      }).success,
    ).toBe(false);
  });

  it("conflict detail: text or binary", () => {
    expect(
      ConflictDetail.parse({ ...base, binary: false, mineText: "a", incomingText: "b" }).binary,
    ).toBe(false);
    const meta = { size: 1, mime: "image/svg+xml", previewUrl: null };
    expect(
      ConflictDetail.parse({ ...base, binary: true, mineFile: meta, incomingFile: meta }).binary,
    ).toBe(true);
    expect(ConflictDetail.safeParse({ ...base, binary: false, mineFile: meta }).success).toBe(
      false,
    );
  });

  it("resolutions", () => {
    for (const r of ["keep_mine", "keep_incoming", "keep_both", { manual: "x" }])
      expect(Resolution.safeParse(r).success).toBe(true);
    expect(Resolution.safeParse("keep_all").success).toBe(false);
    expect(ResolveAllRequest.safeParse({ strategy: "keep_both", items: [] }).success).toBe(false);
  });

  it("new error codes", () => {
    for (const c of ["confirm_mismatch", "history_window", "pairing_closed"])
      expect(ErrorCode.options).toContain(c);
  });
});
