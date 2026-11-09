import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger, redactUrl } from "./logger.js";

function capture(): { stream: Writable; output: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, output: () => chunks.join("") };
}

describe("createLogger", () => {
  it("redacts the master key, tokens, passwords and authorization headers", () => {
    const { stream, output } = capture();
    const log = createLogger("info", stream);
    log.info({
      masterKey: "SECRET-MASTER",
      headers: { authorization: "Bearer SECRET-BEARER", cookie: "sid=SECRET-COOKIE" },
      req: { headers: { authorization: "Bearer SECRET-REQ", cookie: "sid=SECRET-REQCOOKIE" } },
      token: "SECRET-TOPTOKEN",
      password: "SECRET-TOPPASSWORD",
      databaseUrl: "SECRET-TOPDB",
      config: { databaseUrl: "SECRET-DB" },
      session: { token: "SECRET-TOKEN", password: "SECRET-PASSWORD" },
    });
    const out = output();
    expect(out).not.toContain("SECRET-");
    expect(out).toContain("[Redacted]");
  });

  it("respects the configured level", () => {
    const { stream, output } = capture();
    createLogger("warn", stream).info("hidden");
    expect(output()).toBe("");
  });
});

describe("redactUrl", () => {
  it("removes tokens from invitation paths and token query parameters", () => {
    expect(redactUrl("/api/v1/invites/abc123")).toBe("/api/v1/invites/[token]");
    expect(redactUrl("/api/v1/invites/abc123/accept")).toBe("/api/v1/invites/[token]/accept");
    expect(redactUrl("/setup?token=xyz&x=1")).toBe("/setup?token=[token]&x=1");
    expect(redactUrl("/reset/abc123")).toBe("/reset/[token]");
    expect(redactUrl("/invite/abc123")).toBe("/invite/[token]");
    expect(redactUrl("/api/v1/me")).toBe("/api/v1/me");
  });
});
