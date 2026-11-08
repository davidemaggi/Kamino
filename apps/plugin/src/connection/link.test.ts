import { describe, expect, it } from "vitest";
import { buildPairingLink, parsePairingLink, parsePairingUrl } from "./link.js";

describe("parsePairingLink", () => {
  it("accepts https and http servers and normalizes the trailing slash", () => {
    expect(parsePairingLink({ server: "https://sync.example/", token: "abc" })).toEqual({
      ok: true,
      link: { server: "https://sync.example", token: "abc" },
    });
    expect(parsePairingLink({ server: "http://10.0.0.2:8080/kamino/", token: "t" })).toEqual({
      ok: true,
      link: { server: "http://10.0.0.2:8080/kamino", token: "t" },
    });
  });

  it.each([
    [{ token: "abc" }, "missing_server"],
    [{ server: " ", token: "abc" }, "missing_server"],
    [{ server: "not a url", token: "abc" }, "invalid_server"],
    [{ server: "ftp://sync.example", token: "abc" }, "invalid_server"],
    [{ server: "https://sync.example" }, "missing_token"],
    [{ server: "https://sync.example", token: "  " }, "missing_token"],
  ])("%o -> %s", (params, reason) => {
    expect(parsePairingLink(params)).toEqual({ ok: false, reason });
  });
});

describe("parsePairingUrl / buildPairingLink", () => {
  it("round-trips", () => {
    const text = buildPairingLink("kamino", { server: "https://sync.example", token: "a b&c" });
    expect(text).toBe("obsidian://kamino?server=https%3A%2F%2Fsync.example&token=a%20b%26c");
    expect(parsePairingUrl(text, "kamino")).toEqual({
      ok: true,
      link: { server: "https://sync.example", token: "a b&c" },
    });
  });

  it.each([
    "",
    "hello",
    "https://sync.example?token=x",
    "obsidian://other?server=https%3A%2F%2Fa&token=x",
  ])("%s is not a pairing link", (text) => {
    expect(parsePairingUrl(text, "kamino")).toEqual({ ok: false, reason: "not_a_link" });
  });
});
