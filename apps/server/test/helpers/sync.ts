import { PROTOCOL_VERSION } from "@kamino/protocol";
import type { LightMyRequestResponse } from "fastify";
import { PROTOCOL_HEADER } from "../../src/devices/auth.js";
import type { TestApp } from "./app.js";

export const PW = "Qp7#vT2!mZx9-long";

export interface TestDevice {
  token: string;
  vaultId: string;
  deviceId: string;
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<LightMyRequestResponse>;
}

/** Plain JSON call with no cookies (devices authenticate with Bearer tokens). */
export async function raw(
  t: TestApp,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return t.app.inject({
    method: method as "GET",
    url: `/api/v1${path}`,
    headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), ...headers },
    ...(body === undefined
      ? {}
      : Buffer.isBuffer(body)
        ? { payload: body }
        : { payload: body as object }),
  });
}

/** An active user (via invitation), signed in through the device login. */
export async function user(t: TestApp, username: string): Promise<string> {
  const invite = await t.auth.invite(username, `${username}@example.com`, "test");
  await t.auth.acceptInvite(invite, PW, { ip: undefined, userAgent: undefined });
  const r = await raw(t, "POST", "/devices/login", { username, password: PW });
  return (r.json() as { enrollToken: string }).enrollToken;
}

export function deviceOf(t: TestApp, token: string, vaultId: string, deviceId: string): TestDevice {
  return {
    token,
    vaultId,
    deviceId,
    call: (method, path, body, headers = {}) =>
      raw(t, method, path, body, { authorization: `Bearer ${token}`, ...headers }),
  };
}

/** Enroll token → new or existing vault → linked device. */
export async function linkDevice(
  t: TestApp,
  enrollToken: string,
  vaultId?: string,
  name = "Mac",
): Promise<TestDevice> {
  const auth = { authorization: `Bearer ${enrollToken}` };
  const id =
    vaultId ??
    ((await raw(t, "POST", "/enroll/vaults", { name: "Note" }, auth)).json() as { id: string }).id;
  const r = await raw(
    t,
    "POST",
    `/enroll/vaults/${id}/devices`,
    { name, platform: "macos", pluginVersion: "0.1.0", protocolVersion: PROTOCOL_VERSION },
    auth,
  );
  const b = r.json() as { deviceId: string; deviceToken: string };
  return deviceOf(t, b.deviceToken, id, b.deviceId);
}

/** Uploads a content through the real API (session, chunks, complete); returns its hash. */
export async function uploadContent(d: TestDevice, content: Buffer): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(content).digest("hex");
  const base = `/vaults/${d.vaultId}`;
  const s = (
    await d.call("POST", `${base}/uploads`, { contentHash: hash, size: content.length })
  ).json() as { uploadId: string; chunkSize: number };
  const count = Math.max(1, Math.ceil(content.length / s.chunkSize));
  for (let i = 0; i < count; i++)
    await d.call(
      "PUT",
      `${base}/uploads/${s.uploadId}/chunks/${i}`,
      content.subarray(i * s.chunkSize, (i + 1) * s.chunkSize),
      {
        "content-type": "application/octet-stream",
      },
    );
  const done = await d.call("POST", `${base}/uploads/${s.uploadId}/complete`);
  if (done.statusCode !== 200) throw new Error(`upload failed: ${done.body}`);
  return hash;
}

/** Uploads `content` and commits it as a new file at `path`; returns the commit result. */
export async function putFile(d: TestDevice, path: string, content = Buffer.from(path)) {
  const hash = await uploadContent(d, content);
  const id = `${path}-${Math.random().toString(36).slice(2, 8)}`;
  const r = await d.call("POST", `/vaults/${d.vaultId}/commits`, {
    ops: [
      {
        type: "put",
        opId: `o-${id}`,
        fileId: `f-${id}`,
        versionId: `v-${id}`,
        path,
        baseVersionId: null,
        contentHash: hash,
        size: content.length,
        mtime: 1,
      },
    ],
  });
  return r.json() as { results: { status: string; seq?: number }[]; head: number };
}
