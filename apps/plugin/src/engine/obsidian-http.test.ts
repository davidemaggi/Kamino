import { requestUrlMock } from "../__mocks__/obsidian.js";
import { beforeEach, describe, expect, it } from "vitest";
import { ObsidianHttp } from "./obsidian-http.js";

const response = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers,
    text,
    arrayBuffer: new TextEncoder().encode(text).buffer,
    get json(): unknown {
      return JSON.parse(text);
    },
  };
};

beforeEach(() => {
  requestUrlMock.calls = [];
});

describe("ObsidianHttp", () => {
  it("sends JSON under /api/v1 and never throws on HTTP errors", async () => {
    requestUrlMock.handler = async () => response(409, { error: { code: "x" } });
    const http = new ObsidianHttp("https://sync.example.org/");
    const res = await http.request({ method: "POST", path: "/vaults/v/ack", json: { seq: 1 } });
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: { code: "x" } });
    expect(requestUrlMock.calls[0]).toMatchObject({
      url: "https://sync.example.org/api/v1/vaults/v/ack",
      method: "POST",
      contentType: "application/json",
      body: '{"seq":1}',
      throw: false,
    });
  });

  it("sends and receives raw bytes", async () => {
    requestUrlMock.handler = async () => response(206, "abc", { "Content-Range": "bytes 0-2/3" });
    const http = new ObsidianHttp("https://s");
    const res = await http.request({
      method: "PUT",
      path: "/x",
      body: new Uint8Array([1, 2, 3]),
      headers: { "content-type": "application/octet-stream" },
    });
    const sent = requestUrlMock.calls[0]!;
    expect(Array.from(new Uint8Array(sent.body as ArrayBuffer))).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(res.body)).toBe("abc");
    expect(res.json).toBeUndefined();
    expect(res.headers).toEqual({ "content-range": "bytes 0-2/3" });
  });

  it("a network failure throws", async () => {
    requestUrlMock.handler = () => Promise.reject(new Error("ERR_CONNECTION_REFUSED"));
    await expect(
      new ObsidianHttp("https://s").request({ method: "GET", path: "/" }),
    ).rejects.toThrow();
  });
  it("on mobile, refuses plain http (M5)", async () => {
    requestUrlMock.handler = async () => response(200, {});
    const http = new ObsidianHttp("http://nas.local", { mobile: true });
    await expect(http.request({ method: "GET", path: "/version" })).rejects.toThrow();
    expect(requestUrlMock.calls).toHaveLength(0);
  });
});
