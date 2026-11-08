// @vitest-environment jsdom
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request, requestVoid } from "./http.js";

function stub(status: number, body: unknown) {
  const fn = vi.fn<(url: string | URL, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("request", () => {
  it("parses a valid response and sends cookies", async () => {
    const fn = stub(200, { a: 1 });
    expect(await request(z.object({ a: z.number() }), "/x")).toEqual({ a: 1 });
    const [url, init] = fn.mock.calls[0]!;
    expect(String(url)).toBe(`${window.location.origin}/api/v1/x`);
    expect(init?.credentials).toBe("include");
    expect((init?.headers as Record<string, string>)["x-requested-with"]).toBeUndefined();
  });

  it("writes carry the anti-CSRF header and a JSON body", async () => {
    const fn = stub(200, { a: 1 });
    await request(z.object({ a: z.number() }), "/x", { method: "POST", body: { b: 2 } });
    const init = fn.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)["x-requested-with"]).toBe("kamino-web");
    expect(init.body).toBe('{"b":2}');
  });

  it("a non-conforming response is an internal error", async () => {
    stub(200, { a: "no" });
    await expect(request(z.object({ a: z.number() }), "/x")).rejects.toMatchObject({
      code: "internal",
      status: 200,
    });
  });

  it("error bodies become ApiError with their code", async () => {
    stub(401, { error: { code: "invalid_credentials", message: "x", retryable: false } });
    const err = await request(z.object({}), "/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "invalid_credentials", status: 401 });
  });

  it("a bare 401 is unauthorized", async () => {
    stub(401, undefined);
    await expect(requestVoid("/x")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("requestVoid accepts 204", async () => {
    stub(204, undefined);
    await expect(requestVoid("/x", { method: "DELETE" })).resolves.toBeUndefined();
  });
});
