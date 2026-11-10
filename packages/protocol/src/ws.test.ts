import { describe, expect, it } from "vitest";
import { ClientMessage, DEFAULT_SYNC_SETTINGS, ServerMessage, SyncSettings } from "./index.js";

describe("websocket messages", () => {
  it("parses every client message and rejects unknown types", () => {
    const hello = {
      type: "hello",
      deviceToken: "t".repeat(43),
      protocol: { min: 1, max: 1 },
      cursor: 0,
      pluginVersion: "0.1.0",
      platform: "macos",
    };
    expect(ClientMessage.parse(hello).type).toBe("hello");
    expect(ClientMessage.parse({ type: "ack", seq: 3 }).type).toBe("ack");
    expect(
      ClientMessage.parse({ type: "status", pendingOps: 0, pendingBytes: 0, deferredFiles: 0 })
        .type,
    ).toBe("status");
    expect(ClientMessage.parse({ type: "pong" }).type).toBe("pong");
    expect(ClientMessage.safeParse({ type: "nope" }).success).toBe(false);
    expect(ClientMessage.safeParse({ ...hello, cursor: -1 }).success).toBe(false);
  });

  it("parses server messages", () => {
    expect(
      ServerMessage.parse({ type: "changes", entries: [], head: 0, hasMore: false }).type,
    ).toBe("changes");
    expect(ServerMessage.parse({ type: "error", code: "cursor_too_old", message: "x" }).type).toBe(
      "error",
    );
    expect(ServerMessage.parse({ type: "device_revoked" }).type).toBe("device_revoked");
  });
});

describe("sync settings", () => {
  it("S-10: by default no configuration category is synced", () => {
    expect(Object.values(DEFAULT_SYNC_SETTINGS.config).every((v) => !v)).toBe(true);
    expect(SyncSettings.parse(DEFAULT_SYNC_SETTINGS)).toEqual(DEFAULT_SYNC_SETTINGS);
  });

  it("patterns are bounded", () => {
    const long = { ...DEFAULT_SYNC_SETTINGS, patterns: ["x".repeat(501)] };
    expect(SyncSettings.safeParse(long).success).toBe(false);
    const many = { ...DEFAULT_SYNC_SETTINGS, patterns: Array.from({ length: 201 }, () => "a") };
    expect(SyncSettings.safeParse(many).success).toBe(false);
  });
});
