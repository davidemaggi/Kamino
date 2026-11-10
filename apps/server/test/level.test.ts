import { describe, expect, it } from "vitest";
import { deviceLevel, vaultLevel, type DeviceFacts } from "../src/devices/level.js";

const synced: DeviceFacts = {
  cursor: 10,
  pending: 0,
  deferred: 0,
  lastSync: new Date(0),
  lastAck: new Date(0),
  error: null,
  revoked: false,
};

describe("device level", () => {
  it.each<[string, Partial<DeviceFacts>, string]>([
    ["caught up", {}, "safe"],
    ["behind the head", { cursor: 9 }, "working"],
    ["local changes queued", { pending: 2 }, "working"],
    ["files deferred", { deferred: 1 }, "working"],
    ["never synced", { lastSync: null, lastAck: null }, "working"],
    ["reports an error", { error: "quota_exceeded", cursor: 3 }, "attention"],
    ["revoked", { revoked: true, error: "x" }, "blocked"],
  ])("%s → %s", (_name, facts, level) => {
    expect(deviceLevel({ ...synced, ...facts }, 10)).toBe(level);
  });
});

describe("vault level", () => {
  it("decision > attention > working > safe; revoked devices don't count", () => {
    const err = { ...synced, error: "x" };
    expect(vaultLevel(1, [err], 10)).toBe("decision");
    expect(vaultLevel(0, [synced, err], 10)).toBe("attention");
    expect(vaultLevel(0, [synced, { ...synced, cursor: 1 }], 10)).toBe("working");
    expect(vaultLevel(0, [synced], 10)).toBe("safe");
    expect(vaultLevel(0, [], 10)).toBe("working");
    expect(vaultLevel(0, [{ ...err, revoked: true }], 10)).toBe("working");
    expect(vaultLevel(0, [synced, { ...err, revoked: true }], 10)).toBe("safe");
  });
});
