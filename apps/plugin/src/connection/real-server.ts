import {
  negotiateProtocol,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  VersionInfo,
  type DevicePlatform,
} from "@kamino/protocol";
import { Api, ApiError, type Http } from "@kamino/sync-engine";
import type { LinkStore } from "./fake-server.js";
import type {
  ClaimResult,
  ClaimStatus,
  ConnectionEvent,
  ConnectionService,
  LinkInfo,
  LoginResult,
  PairingOffer,
  PairingRequest,
  ServerCheck,
  Session,
  VaultSummary,
} from "./types.js";

/** What data.json keeps about the link: the device token never leaves `credentials()`. */
export type StoredLink = LinkInfo & { deviceId: string; deviceToken: string };

/** QR pairing arrives with M6 (E1): the UI shows it as coming soon. */
export class ComingSoon extends Error {
  constructor() {
    super("coming_soon");
    this.name = "ComingSoon";
  }
}

export interface RealConnectionOptions {
  isMobile: boolean;
  store: LinkStore;
  pluginVersion: string;
  platform: DevicePlatform;
  /** An `Http` for a server URL (ObsidianHttp in the plugin). */
  http: (server: string) => Http;
}

const normalize = (url: string) => url.trim().replace(/\/+$/, "");

/** `ConnectionService` on the routes of M1c (E7). */
export class RealConnection implements ConnectionService {
  readonly pairingAvailable = false;
  private readonly listeners = new Set<(e: ConnectionEvent) => void>();

  constructor(private readonly o: RealConnectionOptions) {}

  private stored(): StoredLink | null {
    const l = this.o.store.load() as Partial<StoredLink> | null;
    return l && typeof l.deviceToken === "string" && typeof l.deviceId === "string"
      ? (l as StoredLink)
      : null;
  }

  private emit(e: ConnectionEvent): void {
    for (const cb of [...this.listeners]) cb(e);
  }

  private api(server: string, token: () => string | null = () => null): Api {
    return new Api(this.o.http(normalize(server)), token);
  }

  /** The device's credentials, for the sync engine. */
  credentials(): { deviceId: string; deviceToken: string } | null {
    const l = this.stored();
    return l ? { deviceId: l.deviceId, deviceToken: l.deviceToken } : null;
  }

  link(): LinkInfo | null {
    const l = this.stored();
    if (!l) return null;
    const { server, host, user, vaultId, vaultName, deviceName } = l;
    return { server, host, user, vaultId, vaultName, deviceName };
  }

  async checkServer(url: string): Promise<ServerCheck> {
    let u: URL;
    try {
      u = new URL(normalize(url));
    } catch {
      return { ok: false, reason: "invalid_url" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:")
      return { ok: false, reason: "invalid_url" };
    const insecure = u.protocol === "http:";
    if (insecure && this.o.isMobile) return { ok: false, reason: "insecure_on_mobile" };
    let res;
    try {
      res = await this.o.http(normalize(url)).request({ method: "GET", path: "/version" });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    const info = VersionInfo.safeParse(res.json);
    if (res.status !== 200 || !info.success) return { ok: false, reason: "unreachable" };
    const n = negotiateProtocol(
      { min: PROTOCOL_MIN_SUPPORTED, max: PROTOCOL_VERSION },
      info.data.protocol,
    );
    if (!n.ok) return { ok: false, reason: "incompatible" };
    return { ok: true, host: u.host, insecure };
  }

  async login(server: string, user: string, password: string, totp?: string): Promise<LoginResult> {
    try {
      const r = await this.api(server).login(user, password, totp);
      if (r.status === "totp_required")
        return { ok: false, reason: totp === undefined ? "totp_required" : "bad_totp" };
      return {
        ok: true,
        session: {
          server: normalize(server),
          user,
          expiresAt: Date.parse(r.expiresAt),
          token: r.enrollToken,
        },
      };
    } catch (e) {
      if (!(e instanceof ApiError) || e.kind === "network")
        return { ok: false, reason: "unreachable" };
      if (e.kind === "blocked") return { ok: false, reason: "locked" };
      if (e.kind === "protocol") return { ok: false, reason: "unreachable" };
      switch (e.code) {
        case "totp_invalid":
          return { ok: false, reason: "bad_totp" };
        case "totp_mandatory":
          return { ok: false, reason: "totp_mandatory" };
        case "rate_limited":
          return { ok: false, reason: "rate_limited" };
        case "user_blocked":
          return { ok: false, reason: "locked" };
        default:
          return { ok: false, reason: "bad_credentials" };
      }
    }
  }

  private token(session: Session): string {
    if (!session.token) throw new Error("session without token");
    return session.token;
  }

  async listVaults(session: Session): Promise<VaultSummary[]> {
    return (await this.api(session.server).enrollVaults(this.token(session))).vaults;
  }

  async createVault(session: Session, name: string): Promise<VaultSummary> {
    return this.api(session.server).createVault(this.token(session), name);
  }

  async linkDevice(session: Session, vaultId: string, deviceName: string): Promise<LinkInfo> {
    const server = normalize(session.server);
    const r = await this.api(server).link(this.token(session), vaultId, {
      name: deviceName,
      platform: this.o.platform,
      pluginVersion: this.o.pluginVersion,
      protocolVersion: PROTOCOL_VERSION,
    });
    const stored: StoredLink = {
      server,
      host: new URL(server).host,
      user: session.user,
      vaultId: r.vault.id,
      vaultName: r.vault.name,
      deviceName,
      deviceId: r.deviceId,
      deviceToken: r.deviceToken,
    };
    this.o.store.save(stored);
    this.emit({ type: "linked" });
    return this.link()!;
  }

  private deviceApi(): Api {
    const l = this.stored();
    if (!l) throw new Error("not linked");
    return this.api(l.server, () => l.deviceToken);
  }

  async renameDevice(name: string): Promise<void> {
    await this.deviceApi().renameDevice(name);
    const l = this.stored()!;
    this.o.store.save({ ...l, deviceName: name });
    this.emit({ type: "device_renamed" });
  }

  /** Forgets the link here even when the server can't be told (offline, already revoked). */
  async unlink(): Promise<void> {
    if (!this.stored()) return;
    try {
      await this.deviceApi().unlink();
    } catch {
      // Revoked or unreachable: the device token is dropped anyway.
    }
    this.o.store.save(null);
    this.emit({ type: "unlinked" });
  }

  startPairing(): Promise<PairingOffer> {
    return Promise.reject(new ComingSoon());
  }
  pairingRequests(): PairingRequest[] {
    return [];
  }
  approve(): Promise<void> {
    return Promise.reject(new ComingSoon());
  }
  deny(): Promise<void> {
    return Promise.reject(new ComingSoon());
  }
  cancelPairing(): Promise<void> {
    return Promise.resolve();
  }
  claim(): Promise<ClaimResult> {
    return Promise.reject(new ComingSoon());
  }
  claimStatus(): Promise<ClaimStatus> {
    return Promise.resolve("expired");
  }
  cancelClaim(): Promise<void> {
    return Promise.resolve();
  }

  onChange(cb: (event: ConnectionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
