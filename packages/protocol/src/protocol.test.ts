import { describe, expect, it } from "vitest";
import { ErrorBody, ErrorCode, VersionInfo, negotiateProtocol } from "./index.js";

describe("negotiateProtocol", () => {
  it("picks the highest common version", () => {
    expect(negotiateProtocol({ min: 1, max: 3 }, { min: 2, max: 4 })).toEqual({
      ok: true,
      version: 3,
    });
  });
  it("reports client_too_old", () => {
    expect(negotiateProtocol({ min: 1, max: 1 }, { min: 2, max: 3 })).toEqual({
      ok: false,
      reason: "client_too_old",
    });
  });
  it("reports server_too_old", () => {
    expect(negotiateProtocol({ min: 4, max: 5 }, { min: 2, max: 3 })).toEqual({
      ok: false,
      reason: "server_too_old",
    });
  });
  it("treats an inverted range as no intersection", () => {
    expect(negotiateProtocol({ min: 3, max: 1 }, { min: 1, max: 3 }).ok).toBe(false);
  });
});

describe("ErrorCode", () => {
  it("contains the catalog codes", () => {
    for (const c of [
      "quota_exceeded",
      "device_revoked",
      "protocol_unsupported",
      "cursor_too_old",
      "not_implemented",
      "export_expired",
      "history_window",
      "confirm_mismatch",
    ]) {
      expect(ErrorCode.options).toContain(c);
    }
  });
});

describe("ErrorBody", () => {
  it("parses a valid body", () => {
    const body = { error: { code: "rate_limited", message: "slow down", retryable: true } };
    expect(ErrorBody.parse(body)).toEqual(body);
  });
  it("rejects unknown codes", () => {
    expect(() =>
      ErrorBody.parse({ error: { code: "nope", message: "x", retryable: false } }),
    ).toThrow();
  });
});

describe("VersionInfo", () => {
  const ok = {
    version: "0.1.0",
    codename: "Ash",
    protocol: { min: 1, max: 1 },
    commit: "abc",
    buildDate: "2026-11-06",
  };
  it("parses valid info", () => {
    expect(VersionInfo.parse(ok)).toEqual(ok);
  });
  it("rejects missing codename", () => {
    const rest: Record<string, unknown> = { ...ok };
    delete rest.codename;
    expect(() => VersionInfo.parse(rest)).toThrow();
  });
});
