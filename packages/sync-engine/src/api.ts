import { PRODUCT_SLUG } from "@kamino/brand";
import {
  BlobsCheckResponse,
  ChangesResponse,
  CommitResponse,
  DeviceLoginResponse,
  DeviceSettings,
  EnrollVault,
  EnrollVaultList,
  LinkDeviceResponse,
  PROTOCOL_VERSION,
  Snapshot,
  SyncSettings,
  UploadComplete,
  UploadSession,
  UploadStatus,
  type DeviceStatusReport,
  type LinkDeviceRequest,
  type Op,
} from "@kamino/protocol";
import type { Http, HttpRequest, HttpResponse } from "./ports.js";

export type ApiErrorKind =
  "network" | "revoked" | "blocked" | "protocol" | "cursor_too_old" | "http";

/** Never carries paths, names or tokens: safe to log by `kind`/`status`/`code`. */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(code ? `${kind}:${code}` : kind);
    this.name = "ApiError";
  }
}

export const PROTOCOL_HEADER = `${PRODUCT_SLUG}-protocol`;
/** The server accepts at most this many hashes per `blobs/check`. */
const CHECK_BATCH = 1000;

interface Schema<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false };
}

const codeOf = (res: HttpResponse): string | undefined => {
  const e = (res.json as { error?: { code?: unknown } } | undefined)?.error;
  return typeof e?.code === "string" ? e.code : undefined;
};

/** Typed client for the device routes of the server (M1c, 03 §4–7). */
export class Api {
  constructor(
    private readonly http: Http,
    private readonly token: () => string | null,
  ) {}

  /** Sends `r`; with `bearer` undefined the device token is used, null = no token. */
  async send(r: HttpRequest, bearer?: string | null): Promise<HttpResponse> {
    const tok = bearer === undefined ? this.token() : bearer;
    const headers: Record<string, string> = {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      ...r.headers,
    };
    if (tok) headers.authorization = `Bearer ${tok}`;
    let res: HttpResponse;
    try {
      res = await this.http.request({ ...r, headers });
    } catch {
      throw new ApiError("network");
    }
    if (res.status < 400) return res;
    const code = codeOf(res);
    if (res.status === 401 && code === "device_revoked")
      throw new ApiError("revoked", res.status, code);
    if (res.status === 403 && code === "user_blocked")
      throw new ApiError("blocked", res.status, code);
    if (res.status === 426) throw new ApiError("protocol", res.status, code);
    if (res.status === 410 && code === "cursor_too_old")
      throw new ApiError("cursor_too_old", res.status, code);
    throw new ApiError("http", res.status, code);
  }

  private async json<T>(schema: Schema<T>, r: HttpRequest, bearer?: string | null): Promise<T> {
    const res = await this.send(r, bearer);
    const p = schema.safeParse(res.json);
    if (!p.success) throw new ApiError("http", res.status, "invalid_response");
    return p.data;
  }

  // --- enrollment (03 §10, C5) ---

  login(username: string, password: string, totp?: string): Promise<DeviceLoginResponse> {
    const json = totp === undefined ? { username, password } : { username, password, totp };
    return this.json(DeviceLoginResponse, { method: "POST", path: "/devices/login", json }, null);
  }
  enrollVaults(enroll: string) {
    return this.json(EnrollVaultList, { method: "GET", path: "/enroll/vaults" }, enroll);
  }
  createVault(enroll: string, name: string) {
    return this.json(
      EnrollVault,
      { method: "POST", path: "/enroll/vaults", json: { name } },
      enroll,
    );
  }
  link(enroll: string, vaultId: string, d: LinkDeviceRequest): Promise<LinkDeviceResponse> {
    return this.json(
      LinkDeviceResponse,
      { method: "POST", path: `/enroll/vaults/${enc(vaultId)}/devices`, json: d },
      enroll,
    );
  }

  // --- this device ---

  /** This device still exists and may sync (401/403/404 → ApiError). */
  async device(): Promise<void> {
    await this.send({ method: "GET", path: "/device" });
  }
  async renameDevice(name: string): Promise<void> {
    await this.send({ method: "PATCH", path: "/device", json: { name } });
  }
  async unlink(): Promise<void> {
    await this.send({ method: "DELETE", path: "/device" });
  }
  vaultSettings(): Promise<SyncSettings> {
    return this.json(SyncSettings, { method: "GET", path: "/vault/settings" });
  }
  deviceSettings(): Promise<DeviceSettings> {
    return this.json(DeviceSettings, { method: "GET", path: "/device/settings" });
  }
  setDeviceOverride(override: SyncSettings | null): Promise<DeviceSettings> {
    return this.json(DeviceSettings, {
      method: "PUT",
      path: "/device/settings",
      json: { override },
    });
  }

  // --- sync (03 §5–6) ---

  async missing(vaultId: string, hashes: string[]): Promise<string[]> {
    const out: string[] = [];
    for (let i = 0; i < hashes.length; i += CHECK_BATCH) {
      const r = await this.json(BlobsCheckResponse, {
        method: "POST",
        path: `${vault(vaultId)}/blobs/check`,
        json: { hashes: hashes.slice(i, i + CHECK_BATCH) },
      });
      out.push(...r.missing);
    }
    return out;
  }
  commit(vaultId: string, ops: Op[]): Promise<CommitResponse> {
    return this.json(CommitResponse, {
      method: "POST",
      path: `${vault(vaultId)}/commits`,
      json: { ops },
    });
  }
  /** 410 → ApiError("cursor_too_old"): start again from the snapshot (03 §6.3). */
  changes(vaultId: string, after: number): Promise<ChangesResponse> {
    return this.json(ChangesResponse, {
      method: "GET",
      path: `${vault(vaultId)}/changes?after=${after}`,
    });
  }
  snapshot(vaultId: string): Promise<Snapshot> {
    return this.json(Snapshot, { method: "GET", path: `${vault(vaultId)}/snapshot` });
  }
  async ack(vaultId: string, seq: number): Promise<void> {
    await this.send({ method: "POST", path: `${vault(vaultId)}/ack`, json: { seq } });
  }
  async status(vaultId: string, r: DeviceStatusReport): Promise<void> {
    await this.send({ method: "POST", path: `${vault(vaultId)}/status`, json: r });
  }

  // --- transfers (C6, C7) ---

  createUpload(vaultId: string, contentHash: string, size: number) {
    return this.json(UploadSession, {
      method: "POST",
      path: `${vault(vaultId)}/uploads`,
      json: { contentHash, size },
    });
  }
  uploadStatus(vaultId: string, uploadId: string) {
    return this.json(UploadStatus, {
      method: "GET",
      path: `${vault(vaultId)}/uploads/${enc(uploadId)}`,
    });
  }
  async putChunk(vaultId: string, uploadId: string, index: number, body: Uint8Array) {
    await this.send({
      method: "PUT",
      path: `${vault(vaultId)}/uploads/${enc(uploadId)}/chunks/${index}`,
      body,
      headers: { "content-type": "application/octet-stream" },
    });
  }
  completeUpload(vaultId: string, uploadId: string) {
    return this.json(UploadComplete, {
      method: "POST",
      path: `${vault(vaultId)}/uploads/${enc(uploadId)}/complete`,
    });
  }
  /**
   * Plain bytes [start, end) of a blob, and its total size (from `content-range`). A 200 is the
   * whole blob (the server answers so for an empty one).
   */
  async blobRange(
    vaultId: string,
    hash: string,
    start: number,
    end: number,
  ): Promise<{ body: Uint8Array; total: number }> {
    const res = await this.send({
      method: "GET",
      path: `${vault(vaultId)}/blobs/${enc(hash)}`,
      headers: { range: `bytes=${start}-${end - 1}` },
    });
    const body = res.body ?? new Uint8Array(0);
    if (res.status === 200) {
      if (start !== 0) throw new ApiError("http", res.status, "short_body");
      return { body, total: body.length };
    }
    const header = Object.entries(res.headers ?? {}).find(
      ([k]) => k.toLowerCase() === "content-range",
    )?.[1];
    const m = header ? /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header) : null;
    if (!m || Number(m[1]) !== start || body.length !== Number(m[2]) - start + 1)
      throw new ApiError("http", res.status, "short_body");
    return { body, total: Number(m[3]) };
  }
}

const enc = encodeURIComponent;
const vault = (id: string) => `/vaults/${enc(id)}`;
