import type { Http, HttpRequest, HttpResponse } from "@kamino/sync-engine";
import { requestUrl } from "obsidian";

/** `Http` over Obsidian's `requestUrl` (no CORS, works on mobile); throws only on network errors. */
export class ObsidianHttp implements Http {
  private readonly base: string;

  constructor(
    serverUrl: string,
    private readonly opts: { mobile?: boolean } = {},
  ) {
    this.base = `${serverUrl.replace(/\/+$/, "")}/api/v1`;
  }

  async request(r: HttpRequest): Promise<HttpResponse> {
    // M5: on a phone only HTTPS, whatever path led here.
    if (this.opts.mobile && !this.base.startsWith("https://"))
      throw new Error("insecure_on_mobile");
    const headers: Record<string, string> = { ...r.headers };
    let body: string | ArrayBuffer | undefined;
    let contentType: string | undefined;
    if (r.json !== undefined) {
      body = JSON.stringify(r.json);
      contentType = "application/json";
    } else if (r.body) {
      body = r.body.buffer.slice(
        r.body.byteOffset,
        r.body.byteOffset + r.body.byteLength,
      ) as ArrayBuffer;
      contentType = headers["content-type"] ?? "application/octet-stream";
    }
    delete headers["content-type"];
    const res = await requestUrl({
      url: this.base + r.path,
      method: r.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(contentType ? { contentType } : {}),
      throw: false,
    });
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) lower[k.toLowerCase()] = v;
    let json: unknown;
    if ((lower["content-type"] ?? "").includes("json") || !lower["content-type"]) {
      try {
        json = res.json;
      } catch {
        json = undefined;
      }
    }
    return {
      status: res.status,
      ...(json !== undefined ? { json } : {}),
      body: new Uint8Array(res.arrayBuffer),
      headers: lower,
    };
  }
}
