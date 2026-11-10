import { PROTOCOL_ACTION } from "@kamino/brand";
import {
  ResolveAllRequest,
  ResolveRequest,
  VaultDelete,
  VaultPatch,
  DevicePatch,
  type ErrorCode,
} from "@kamino/protocol";
import { http, HttpResponse } from "msw";
import { currentUser } from "./db.js";
import { nextUd, refreshVaults, ud } from "./userdata.js";

const API = "*/api/v1";
const fail = (status: number, code: ErrorCode) =>
  HttpResponse.json({ error: { code, message: code, retryable: false } }, { status });
const noContent = () => new HttpResponse(null, { status: 204 });
const unauthorized = () => (currentUser() ? null : fail(401, "unauthorized"));
async function json(req: Request): Promise<unknown> {
  return req.json().catch(() => undefined);
}

/** Served by the real server since M1c: hybrid mode leaves them out. */
export const vaultListHandlers = [
  http.get(
    `${API}/vaults/summary`,
    () =>
      unauthorized() ??
      HttpResponse.json({
        vaults: ud.vaults.map(({ id, name, level, conflicts }) => ({ id, name, level, conflicts })),
      }),
  ),
  http.get(
    `${API}/vaults`,
    () => unauthorized() ?? HttpResponse.json({ vaults: ud.vaults, quota: ud.quota }),
  ),
];

export const userHandlers = [
  ...vaultListHandlers,
  http.get(`${API}/vaults/:id`, ({ params }) => {
    const v = ud.vaults.find((x) => x.id === params["id"]);
    return unauthorized() ?? (v ? HttpResponse.json(v) : fail(404, "not_found"));
  }),
  http.patch(`${API}/vaults/:id`, async ({ request, params }) => {
    const deny = unauthorized();
    if (deny) return deny;
    const v = ud.vaults.find((x) => x.id === params["id"]);
    if (!v) return unauthorized() ?? fail(404, "not_found");
    const b = VaultPatch.safeParse(await json(request));
    if (!b.success) return fail(400, "internal");
    if (b.data.name !== undefined) v.name = b.data.name;
    if (b.data.retentionDays !== undefined)
      v.retentionDays = Math.min(b.data.retentionDays, v.maxRetentionDays);
    return unauthorized() ?? HttpResponse.json(v);
  }),
  http.delete(`${API}/vaults/:id`, async ({ request, params }) => {
    const deny = unauthorized();
    if (deny) return deny;
    const v = ud.vaults.find((x) => x.id === params["id"]);
    if (!v) return unauthorized() ?? fail(404, "not_found");
    const b = VaultDelete.safeParse(await json(request));
    if (!b.success || b.data.confirmName !== v.name) return fail(400, "confirm_mismatch");
    ud.vaults = ud.vaults.filter((x) => x !== v);
    ud.devices = ud.devices.filter((d) => d.vaultId !== v.id);
    ud.conflicts = ud.conflicts.filter((c) => c.vaultId !== v.id);
    return unauthorized() ?? noContent();
  }),
  http.get(`${API}/vaults/:id/zip`, ({ request, params }) => {
    const v = ud.vaults.find((x) => x.id === params["id"]);
    if (!v) return unauthorized() ?? fail(404, "not_found");
    const at = new URL(request.url).searchParams.get("at");
    if (at && Date.parse(at) < Date.parse(v.historyFrom)) return fail(410, "history_window");
    // String body: a jsdom Blob is not accepted by MSW under Node; the client reads it as a blob anyway.
    return new HttpResponse("PK\u0003\u0004 fake zip", {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${v.name}.zip"`,
      },
    });
  }),
  http.get(`${API}/devices`, () => unauthorized() ?? HttpResponse.json(ud.devices)),
  http.get(`${API}/devices/:id`, ({ params }) => {
    const d = ud.devices.find((x) => x.id === params["id"]);
    return unauthorized() ?? (d ? HttpResponse.json(d) : fail(404, "not_found"));
  }),
  http.patch(`${API}/devices/:id`, async ({ request, params }) => {
    const deny = unauthorized();
    if (deny) return deny;
    const d = ud.devices.find((x) => x.id === params["id"]);
    if (!d) return unauthorized() ?? fail(404, "not_found");
    const b = DevicePatch.safeParse(await json(request));
    if (!b.success) return fail(400, "internal");
    d.name = b.data.name;
    return unauthorized() ?? HttpResponse.json(d);
  }),
  http.post(`${API}/devices/:id/revoke`, ({ params }) => {
    const deny = unauthorized();
    if (deny) return deny;
    const d = ud.devices.find((x) => x.id === params["id"]);
    if (!d) return unauthorized() ?? fail(404, "not_found");
    d.revoked = true;
    d.level = "blocked";
    refreshVaults();
    return unauthorized() ?? HttpResponse.json(d);
  }),
  http.post(`${API}/vaults/:id/pairings`, ({ params }) => {
    const deny = unauthorized();
    if (deny) return deny;
    const v = ud.vaults.find((x) => x.id === params["id"]);
    if (!v) return unauthorized() ?? fail(404, "not_found");
    const p = {
      id: nextUd("p"),
      vaultId: v.id,
      status: "waiting" as const,
      expiresAt: Date.now() + 10 * 60_000,
    };
    ud.pairings.push(p);
    const link = `obsidian://${PROTOCOL_ACTION}?server=${encodeURIComponent(location.origin)}&token=${p.id}-token`;
    return (
      unauthorized() ??
      HttpResponse.json({ pairingId: p.id, link, expiresAt: new Date(p.expiresAt).toISOString() })
    );
  }),
  http.get(`${API}/pairings/:id`, ({ params }) => {
    const p = ud.pairings.find((x) => x.id === params["id"]);
    if (!p) return unauthorized() ?? fail(404, "not_found");
    if ((p.status === "waiting" || p.status === "requested") && Date.now() > p.expiresAt)
      p.status = "expired";
    return (
      unauthorized() ??
      HttpResponse.json({ status: p.status, ...(p.request ? { request: p.request } : {}) })
    );
  }),
  ...(["approve", "deny", "cancel"] as const).map((action) =>
    http.post(`${API}/pairings/:id/${action}`, ({ params }) => {
      const deny = unauthorized();
      if (deny) return deny;
      const p = ud.pairings.find((x) => x.id === params["id"]);
      if (!p) return unauthorized() ?? fail(404, "not_found");
      const open =
        action === "cancel"
          ? p.status === "waiting" || p.status === "requested"
          : p.status === "requested";
      if (!open) return fail(409, "pairing_closed");
      p.status = action === "approve" ? "approved" : action === "deny" ? "denied" : "cancelled";
      if (action === "approve" && p.request) {
        const v = ud.vaults.find((x) => x.id === p.vaultId)!;
        ud.devices.push({
          id: nextUd("d"),
          vaultId: v.id,
          vaultName: v.name,
          name: p.request.deviceName,
          platform: p.request.platform,
          pluginVersion: p.request.pluginVersion,
          lastSeenAt: new Date().toISOString(),
          lastSyncAt: null,
          lag: 0,
          pending: 0,
          lastError: null,
          level: "working",
          revoked: false,
        });
        refreshVaults();
      }
      return unauthorized() ?? noContent();
    }),
  ),
  http.get(
    `${API}/conflicts`,
    () =>
      unauthorized() ??
      HttpResponse.json(
        ud.conflicts.map(({ id, vaultId, vaultName, path, kind, binary, mine, incoming }) => ({
          id,
          vaultId,
          vaultName,
          path,
          kind,
          binary,
          mine,
          incoming,
        })),
      ),
  ),
  http.get(`${API}/conflicts/:id`, ({ params }) => {
    const c = ud.conflicts.find((x) => x.id === params["id"]);
    return unauthorized() ?? (c ? HttpResponse.json(c) : fail(404, "not_found"));
  }),
  http.post(`${API}/conflicts/resolve-all`, async ({ request }) => {
    const deny = unauthorized();
    if (deny) return deny;
    const b = ResolveAllRequest.safeParse(await json(request));
    if (!b.success) return fail(400, "internal");
    const before = ud.conflicts.length;
    ud.conflicts = ud.conflicts.filter((c) => !b.data.ids.includes(c.id));
    refreshVaults();
    return unauthorized() ?? HttpResponse.json({ resolved: before - ud.conflicts.length });
  }),
  http.post(`${API}/conflicts/:id/resolve`, async ({ request, params }) => {
    const deny = unauthorized();
    if (deny) return deny;
    const c = ud.conflicts.find((x) => x.id === params["id"]);
    if (!c) return unauthorized() ?? fail(404, "not_found");
    const b = ResolveRequest.safeParse(await json(request));
    if (!b.success) return fail(400, "internal");
    if (ud.staleNext || b.data.expectedIncomingAt !== c.incoming.at) {
      ud.staleNext = false;
      c.incoming = { ...c.incoming, at: new Date().toISOString() };
      if (!c.binary) c.incomingText = `${c.incomingText}- newer line\n`;
      return fail(409, "stale_resolution");
    }
    ud.conflicts = ud.conflicts.filter((x) => x !== c);
    refreshVaults();
    return unauthorized() ?? noContent();
  }),
  http.get(`${API}/vaults/:id/files`, ({ request, params }) => {
    const q = (new URL(request.url).searchParams.get("q") ?? "").toLowerCase();
    const files = ud.files
      .filter((f) => f.vaultId === params["id"] && f.path.toLowerCase().includes(q))
      .map((f) => ({
        fileId: f.fileId,
        path: f.path,
        versions: f.versions.length,
        lastChangedAt: f.versions.at(-1)!.at,
      }));
    return unauthorized() ?? HttpResponse.json({ files });
  }),
  http.get(`${API}/files/:id/versions`, ({ params }) => {
    const f = ud.files.find((x) => x.fileId === params["id"]);
    if (!f) return unauthorized() ?? fail(404, "not_found");
    const versions = [...f.versions]
      .reverse()
      .map((v, i) => ({ id: v.id, at: v.at, device: v.device, size: v.size, current: i === 0 }));
    return unauthorized() ?? HttpResponse.json({ fileId: f.fileId, path: f.path, versions });
  }),
  http.get(`${API}/versions/:id`, ({ params }) => {
    const v = ud.files
      .flatMap((f) => f.versions.map((x) => ({ ...x, path: f.path })))
      .find((x) => x.id === params["id"]);
    if (!v) return unauthorized() ?? fail(404, "not_found");
    return (
      unauthorized() ??
      HttpResponse.json({
        id: v.id,
        path: v.path,
        at: v.at,
        mime: v.mime,
        size: v.size,
        text: v.text,
        previewUrl: v.previewUrl,
      })
    );
  }),
  http.post(`${API}/versions/:id/restore`, ({ params }) => {
    const deny = unauthorized();
    if (deny) return deny;
    const f = ud.files.find((x) => x.versions.some((v) => v.id === params["id"]));
    const v = f?.versions.find((x) => x.id === params["id"]);
    if (!f || !v) return unauthorized() ?? fail(404, "not_found");
    f.versions.push({
      ...v,
      id: nextUd(`${f.fileId}-v`),
      at: new Date().toISOString(),
      device: "Web",
    });
    return unauthorized() ?? noContent();
  }),
  http.get(
    `${API}/vaults/:id/trash`,
    ({ params }) =>
      unauthorized() ??
      HttpResponse.json({
        items: ud.trash
          .filter((t) => t.vaultId === params["id"])
          .map(({ fileId, path, deletedAt, expiresAt, size }) => ({
            fileId,
            path,
            deletedAt,
            expiresAt,
            size,
          })),
      }),
  ),
  http.post(`${API}/trash/:id/restore`, ({ params }) => {
    const deny = unauthorized();
    if (deny) return deny;
    const t = ud.trash.find((x) => x.fileId === params["id"]);
    if (!t) return unauthorized() ?? fail(404, "not_found");
    ud.trash = ud.trash.filter((x) => x !== t);
    return unauthorized() ?? noContent();
  }),
];
