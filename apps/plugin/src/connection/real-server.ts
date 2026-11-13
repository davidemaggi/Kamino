import {
  negotiateProtocol,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  VersionInfo,
  type DevicePlatform,
  type PairingState,
} from "@kamino/protocol";
import { Api, ApiError, type Http, type PairingMessage } from "@kamino/sync-engine";
import type { LinkStore } from "./fake-server.js";
import type { PairingLink } from "./link.js";
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

export interface RealConnectionOptions {
  isMobile: boolean;
  store: LinkStore;
  pluginVersion: string;
  platform: DevicePlatform;
  /** An `Http` for a server URL (ObsidianHttp in the plugin). */
  http: (server: string) => Http;
  /** For the pairing fallback polling (defaults: Date.now, setTimeout). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A claim of this device: its secret stays in memory, never in data.json or the logs. */
interface OwnClaim {
  server: string;
  host: string;
  secret: string;
  deviceName: string;
  expiresAt: number;
  status: ClaimStatus | null;
  inflight: Promise<ClaimStatus> | null;
}

/** While an offer is open the origin polls it too: the realtime channel may be down (03 §10). */
export const PAIRING_POLL_MS = 3000;

const normalize = (url: string) => url.trim().replace(/\/+$/, "");

/** `ConnectionService` on the routes of M1c (E7). */
export class RealConnection implements ConnectionService {
  readonly pairingAvailable = true;
  private readonly listeners = new Set<(e: ConnectionEvent) => void>();
  private readonly claims = new Map<string, OwnClaim>();
  /** Requests waiting for this device's answer, by pairing id. */
  private readonly requests = new Map<string, PairingRequest>();
  /** Offers of this device still open (polled until closed or expired). */
  private readonly offers = new Map<string, number>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: RealConnectionOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

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
      if (e.kind === "protocol") return { ok: false, reason: "update_required" };
      // M7: a server error or a wrong address is not a wrong password.
      if ((e.status ?? 0) >= 500 || e.status === 404) return { ok: false, reason: "unreachable" };
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

  // ---- pairing, origin side (03 §10) -------------------------------------------------------

  async startPairing(): Promise<PairingOffer> {
    const l = this.stored();
    if (!l) throw new Error("not linked");
    const o = await this.deviceApi().startPairing(l.vaultId);
    const expiresAt = Date.parse(o.expiresAt);
    this.offers.set(o.pairingId, expiresAt);
    void this.watch(o.pairingId);
    return { pairingId: o.pairingId, link: o.link, expiresAt };
  }

  pairingRequests(): PairingRequest[] {
    const now = this.now();
    return [...this.requests.values()].filter((r) => r.expiresAt > now);
  }

  async approve(pairingId: string): Promise<void> {
    await this.answer(pairingId, "approve");
  }

  async deny(pairingId: string): Promise<void> {
    await this.answer(pairingId, "deny");
  }

  /** Withdraws an offer nobody answered yet; already closed or unreachable is fine. */
  async cancelPairing(pairingId: string): Promise<void> {
    this.offers.delete(pairingId);
    try {
      await this.deviceApi().answerPairing(pairingId, "cancel");
    } catch {
      // Closed already, or offline: it expires on its own in ten minutes.
    }
    this.closed(pairingId);
  }

  private async answer(pairingId: string, action: "approve" | "deny"): Promise<void> {
    try {
      await this.deviceApi().answerPairing(pairingId, action);
    } catch (e) {
      // Answered elsewhere, withdrawn or expired: the request is gone, the UI says so.
      if (e instanceof ApiError && e.status === 409) this.closed(pairingId);
      throw e;
    }
    this.offers.delete(pairingId);
    this.closed(pairingId);
  }

  /** News from the realtime channel (wired through the engine). */
  receive(msg: PairingMessage): void {
    if (msg.type === "pairing_request")
      this.requested(msg.pairingId, {
        deviceName: msg.deviceName,
        platform: msg.platform,
        pluginVersion: msg.pluginVersion,
        code: msg.code,
        expiresAt: Date.parse(msg.expiresAt),
      });
    else if (msg.type === "pairing_closed") {
      this.offers.delete(msg.pairingId);
      this.closed(msg.pairingId);
    } else this.emit({ type: "pairing_reused", pairingId: msg.pairingId });
  }

  private requested(pairingId: string, r: Omit<PairingRequest, "pairingId" | "at">): void {
    if (this.requests.has(pairingId)) return;
    const request: PairingRequest = { pairingId, ...r, at: this.now() };
    this.requests.set(pairingId, request);
    this.emit({ type: "pairing_request", request });
  }

  private closed(pairingId: string): void {
    const had = this.requests.delete(pairingId);
    if (had) this.emit({ type: "pairing_closed", pairingId });
  }

  /** Fallback for a missed realtime message: polls an open offer until it closes or expires. */
  private async watch(pairingId: string): Promise<void> {
    let reused = false;
    while (this.offers.has(pairingId)) {
      await this.sleep(PAIRING_POLL_MS);
      const expiresAt = this.offers.get(pairingId);
      if (expiresAt === undefined) return;
      if (expiresAt <= this.now()) {
        this.offers.delete(pairingId);
        this.closed(pairingId);
        return;
      }
      let s: PairingState;
      try {
        s = await this.deviceApi().pairing(pairingId);
      } catch {
        continue; // offline for a moment: try again
      }
      if (!this.offers.has(pairingId)) return;
      if (s.reused && !reused) {
        reused = true;
        this.emit({ type: "pairing_reused", pairingId });
      }
      if (s.status === "requested" && s.request)
        this.requested(pairingId, { ...s.request, expiresAt });
      else if (s.status !== "waiting") {
        this.offers.delete(pairingId);
        this.closed(pairingId);
      }
    }
  }

  // ---- pairing, new device side ------------------------------------------------------------

  async claim(link: PairingLink, deviceName: string): Promise<ClaimResult> {
    const server = normalize(link.server);
    const host = new URL(server).host;
    if (this.o.isMobile && !server.startsWith("https:"))
      return { ok: false, reason: "insecure_on_mobile" };
    try {
      const r = await this.api(server).claim({
        token: link.token,
        deviceName,
        platform: this.o.platform,
        pluginVersion: this.o.pluginVersion,
        protocolVersion: PROTOCOL_VERSION,
      });
      const expiresAt = Date.parse(r.expiresAt);
      this.claims.set(r.claimId, {
        server,
        host,
        secret: r.claimSecret,
        deviceName,
        expiresAt,
        status: null,
        inflight: null,
      });
      return { ok: true, claimId: r.claimId, code: r.verificationCode, expiresAt, host };
    } catch (e) {
      if (!(e instanceof ApiError) || e.kind === "network")
        return { ok: false, reason: "unreachable" };
      if (e.kind === "protocol") return { ok: false, reason: "incompatible" };
      if (e.status === 410) return { ok: false, reason: "expired" };
      if (e.status === 409) return { ok: false, reason: "already_claimed" };
      if (e.status === 400) return { ok: false, reason: "invalid" };
      return { ok: false, reason: "unreachable" };
    }
  }

  /**
   * One poll of the claim. On approval the device token (handed out once) is stored and
   * "linked" is emitted; calls in flight are shared so a second poll can't see "consumed".
   */
  claimStatus(claimId: string): Promise<ClaimStatus> {
    const c = this.claims.get(claimId);
    if (!c) return Promise.resolve("expired");
    if (c.status) return Promise.resolve(c.status);
    c.inflight ??= this.pollClaim(claimId, c).finally(() => (c.inflight = null));
    return c.inflight;
  }

  private async pollClaim(claimId: string, c: OwnClaim): Promise<ClaimStatus> {
    let s;
    try {
      s = await this.api(c.server).claimState(claimId, c.secret);
    } catch {
      // Offline for a moment: keep waiting until the flow's own expiry.
      return c.expiresAt <= this.now() ? this.settle(claimId, c, "expired") : "pending";
    }
    switch (s.status) {
      case "pending":
        return "pending";
      case "approved": {
        const stored: StoredLink = {
          server: c.server,
          host: c.host,
          user: s.username,
          vaultId: s.vault.id,
          vaultName: s.vault.name,
          deviceName: c.deviceName,
          deviceId: s.deviceId,
          deviceToken: s.deviceToken,
        };
        this.o.store.save(stored);
        this.emit({ type: "linked" });
        return this.settle(claimId, c, "approved");
      }
      case "denied":
        return this.settle(claimId, c, "denied");
      default:
        // Expired, withdrawn, or the token already went to a poll whose answer was lost.
        return this.settle(claimId, c, "expired");
    }
  }

  private settle(claimId: string, c: OwnClaim, status: ClaimStatus): ClaimStatus {
    c.status = status;
    c.secret = "";
    if (status !== "approved") this.claims.delete(claimId);
    return status;
  }

  async cancelClaim(claimId: string): Promise<void> {
    const c = this.claims.get(claimId);
    this.claims.delete(claimId);
    if (!c || c.status) return;
    try {
      await this.api(c.server).withdrawClaim(claimId, c.secret);
    } catch {
      // Offline: the origin's request expires on its own.
    }
  }

  onChange(cb: (event: ConnectionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
