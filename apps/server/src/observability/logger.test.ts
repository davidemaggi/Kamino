import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

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
