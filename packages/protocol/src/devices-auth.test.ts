import { describe, expect, it } from "vitest";
import {
  BlobsCheckRequest,
  DeviceLoginRequest,
  DeviceLoginResponse,
  LinkDeviceRequest,
} from "./index.js";

describe("device enrollment contract", () => {
  it("login with or without TOTP", () => {
    expect(DeviceLoginRequest.safeParse({ username: "a", password: "b" }).success).toBe(true);
    expect(
      DeviceLoginRequest.safeParse({ username: "a", password: "b", totp: "123456" }).success,
    ).toBe(true);
    expect(DeviceLoginRequest.safeParse({ username: "a", password: "b", totp: "12" }).success).toBe(
      false,
    );
    expect(DeviceLoginResponse.parse({ status: "totp_required" }).status).toBe("totp_required");
  });
  it("link and transfer limits", () => {
    const d = { name: "Mac", platform: "macos", pluginVersion: "0.1.0", protocolVersion: 1 };
    expect(LinkDeviceRequest.safeParse(d).success).toBe(true);
    expect(LinkDeviceRequest.safeParse({ ...d, platform: "beos" }).success).toBe(false);
    expect(BlobsCheckRequest.safeParse({ hashes: Array(1001).fill("a".repeat(64)) }).success).toBe(
      false,
    );
  });
});
