import { PROTOCOL_ACTION } from "@kamino/brand";
import { buildPairingLink, type PairingLink } from "./link.js";
import type {
  ClaimResult,
  ClaimStatus,
  ConnectionEvent,
  ConnectionService,
  InitialTransfer,
  LinkInfo,
  LoginResult,
  PairingOffer,
  PairingRequest,
  ServerCheck,
  Session,
  TransferProgress,
  VaultSummary,
} from "./types.js";

/** 4-character verification codes without ambiguous characters (no 0/O, 1/I/L, 2/Z, 5/S, 8/B). */
export const VERIFICATION_ALPHABET = "ACDEFGHJKMNPQRTUVWXY3479";
const PAIRING_TTL = 10 * 60_000;
const SESSION_TTL = 5 * 60_000;
const BYTES_PER_FILE = 24_000;
const DOWNLOAD_FILES = 128;
/** Distinct id prefix per instance: ids never collide across instances (like a real server). */
let instances = 0;

export interface LinkStore {
  load(): LinkInfo | null;
  save(link: LinkInfo | null): void;
}

export interface FakeServerOptions {
  isMobile: boolean;
  clock: () => number;
  delay: (ms: number) => Promise<void>;
  random: () => number;
  localFileCount: () => number;
  pluginVersion: string;
  platform: string;
  store: LinkStore;
  /** false in tests: the transfer advances only through advance(). */
  autoRun: boolean;
}

interface Offer {
  pairingId: string;
  token: string;
  expiresAt: number;
  claimId: string | null;
  open: boolean;
}

interface Claim {
  claimId: string;
  server: string;
  deviceName: string;
  status: Exclude<ClaimStatus, "expired">;
  expiresAt: number;
  pairingId: string | null;
}

const DEMO_VAULTS: VaultSummary[] = [
  { id: "v-notes", name: "Note", fileCount: 128, deviceCount: 2 },
  { id: "v-work", name: "Lavoro", fileCount: 512, deviceCount: 1 },
];

/**
 * In-memory stand-in for the server (until M1/M2). Test credentials: demo/demo,
 * demo2fa/demo + TOTP 123456, locked. Hosts containing "unreachable"/"old" simulate errors.
 */
export class FakeServer implements ConnectionService {
  readonly transfer: InitialTransfer;
  private current: LinkInfo | null;
  private readonly listeners = new Set<(e: ConnectionEvent) => void>();
  private readonly transferListeners = new Set<() => void>();
  private offers: Offer[] = [];
  private claims: Claim[] = [];
  private requests: PairingRequest[] = [];
  private createdVaults: VaultSummary[] = [];
  private seq = 0;
  private readonly prefix = `s${++instances}`;
  private progressState: TransferProgress | null = null;
  private running = false;

  constructor(private readonly o: FakeServerOptions) {
    this.current = o.store.load();
    // Separate object: InitialTransfer.onChange and ConnectionService.onChange have different signatures.
    this.transfer = {
      start: (direction) => this.startTransfer(direction),
      progress: () => (this.progressState ? structuredClone(this.progressState) : null),
      pause: () => this.setPhase("paused"),
      resume: () => {
        this.setPhase("running");
        this.run();
      },
      retry: () => {
        this.setPhase("running");
        this.run();
      },
      onChange: (cb) => {
        this.transferListeners.add(cb);
        return () => {
          this.transferListeners.delete(cb);
        };
      },
    };
  }

  link(): LinkInfo | null {
    return this.current;
  }

  async checkServer(url: string): Promise<ServerCheck> {
    await this.o.delay(300);
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      return { ok: false, reason: "invalid_url" };
    }
    if (u.protocol !== "https:" && u.protocol !== "http:")
      return { ok: false, reason: "invalid_url" };
    if (u.host.includes("unreachable")) return { ok: false, reason: "unreachable" };
    if (u.host.includes("old")) return { ok: false, reason: "incompatible" };
    const insecure = u.protocol === "http:";
    if (insecure && this.o.isMobile) return { ok: false, reason: "insecure_on_mobile" };
    return { ok: true, host: u.host, insecure };
  }

  async login(server: string, user: string, password: string, totp?: string): Promise<LoginResult> {
    await this.o.delay(300);
    if (user === "locked") return { ok: false, reason: "locked" };
    if (!["demo", "demo2fa"].includes(user) || password !== "demo")
      return { ok: false, reason: "bad_credentials" };
    if (user === "demo2fa") {
      if (totp === undefined || totp === "") return { ok: false, reason: "totp_required" };
      if (totp !== "123456") return { ok: false, reason: "bad_totp" };
    }
    return { ok: true, session: { server, user, expiresAt: this.o.clock() + SESSION_TTL } };
  }

  async listVaults(session: Session): Promise<VaultSummary[]> {
    await this.o.delay(200);
    return session.user === "demo"
      ? [...DEMO_VAULTS, ...this.createdVaults]
      : [...this.createdVaults];
  }

  async createVault(session: Session, name: string): Promise<VaultSummary> {
    void session;
    await this.o.delay(200);
    const vault = { id: `v-new-${++this.seq}`, name, fileCount: 0, deviceCount: 0 };
    this.createdVaults.push(vault);
    return vault;
  }

  async linkDevice(session: Session, vaultId: string, deviceName: string): Promise<LinkInfo> {
    await this.o.delay(200);
    const vault = [...DEMO_VAULTS, ...this.createdVaults].find((v) => v.id === vaultId);
    this.setLink({
      server: session.server,
      host: new URL(session.server).host,
      user: session.user,
      vaultId,
      vaultName: vault?.name ?? vaultId,
      deviceName,
    });
    return this.current!;
  }

  async renameDevice(name: string): Promise<void> {
    await this.o.delay(100);
    if (this.current) {
      this.current = { ...this.current, deviceName: name };
      this.o.store.save(this.current);
      this.emit({ type: "device_renamed" });
    }
  }

  async unlink(): Promise<void> {
    await this.o.delay(100);
    this.progressState = null;
    this.running = false;
    this.current = null;
    this.o.store.save(null);
    this.emit({ type: "unlinked" });
    this.emitTransfer();
  }

  async startPairing(): Promise<PairingOffer> {
    await this.o.delay(100);
    const pairingId = `p-${this.prefix}-${++this.seq}`;
    const token = `t-${this.seq}-${Math.floor(this.o.random() * 1e9)}`;
    const expiresAt = this.o.clock() + PAIRING_TTL;
    this.offers.push({ pairingId, token, expiresAt, claimId: null, open: true });
    const server = this.current?.server ?? "https://sync.example";
    return { pairingId, link: buildPairingLink(PROTOCOL_ACTION, { server, token }), expiresAt };
  }

  pairingRequests(): PairingRequest[] {
    const now = this.o.clock();
    return this.requests.filter((r) => r.expiresAt > now);
  }

  async approve(pairingId: string): Promise<void> {
    await this.answer(pairingId, "approved");
  }

  async deny(pairingId: string): Promise<void> {
    await this.answer(pairingId, "denied");
  }

  async cancelPairing(pairingId: string): Promise<void> {
    await this.o.delay(50);
    this.closeOffer(pairingId);
  }

  async claim(link: PairingLink, deviceName: string): Promise<ClaimResult> {
    await this.o.delay(300);
    const now = this.o.clock();
    const host = new URL(link.server).host;
    if (link.token === "expired") return { ok: false, reason: "expired" };
    if (link.token === "used") return { ok: false, reason: "already_claimed" };
    if (link.token === "bad") return { ok: false, reason: "invalid" };
    const offer = this.offers.find((x) => x.token === link.token);
    if (offer) {
      if (offer.expiresAt <= now || !offer.open) return { ok: false, reason: "expired" };
      if (offer.claimId) {
        this.emit({ type: "pairing_reused", pairingId: offer.pairingId });
        return { ok: false, reason: "already_claimed" };
      }
    }
    const claimId = `c-${++this.seq}`;
    const code = this.code();
    const expiresAt = offer?.expiresAt ?? now + PAIRING_TTL;
    this.claims.push({
      claimId,
      server: link.server,
      deviceName,
      status: "pending",
      expiresAt,
      pairingId: offer?.pairingId ?? null,
    });
    if (offer) {
      offer.claimId = claimId;
      const request: PairingRequest = {
        pairingId: offer.pairingId,
        deviceName,
        platform: this.o.platform,
        pluginVersion: this.o.pluginVersion,
        code,
        at: now,
        expiresAt,
      };
      this.requests.push(request);
      this.emit({ type: "pairing_request", request });
    }
    return { ok: true, claimId, code, expiresAt, host };
  }

  async claimStatus(claimId: string): Promise<ClaimStatus> {
    await this.o.delay(50);
    const claim = this.claims.find((c) => c.claimId === claimId);
    if (!claim) return "expired";
    if (claim.status === "pending" && claim.expiresAt <= this.o.clock()) return "expired";
    return claim.status;
  }

  async cancelClaim(claimId: string): Promise<void> {
    await this.o.delay(50);
    this.claims = this.claims.filter((c) => c.claimId !== claimId);
  }

  onChange(cb: (event: ConnectionEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ---- Dev / test simulation -------------------------------------------------------------

  /** A new device claims the most recent open offer (creates one if none). */
  simulateIncomingClaim(deviceName = "iPhone", platform = "iOS"): void {
    const now = this.o.clock();
    let offer = [...this.offers].reverse().find((x) => x.open && !x.claimId && x.expiresAt > now);
    if (!offer) {
      offer = {
        pairingId: `p-${this.prefix}-${++this.seq}`,
        token: `t-${this.seq}`,
        expiresAt: now + PAIRING_TTL,
        claimId: null,
        open: true,
      };
      this.offers.push(offer);
    }
    offer.claimId = `c-${++this.seq}`;
    const request: PairingRequest = {
      pairingId: offer.pairingId,
      deviceName,
      platform,
      pluginVersion: this.o.pluginVersion,
      code: this.code(),
      at: now,
      expiresAt: offer.expiresAt,
    };
    this.requests.push(request);
    this.emit({ type: "pairing_request", request });
  }

  /** The (remote) origin answers the most recent pending claim of this device. */
  simulateClaimAnswer(answer: "approved" | "denied"): void {
    const claim = [...this.claims].reverse().find((c) => c.status === "pending");
    if (!claim) return;
    claim.status = answer;
    if (answer === "approved") this.linkFromClaim(claim);
  }

  simulateDeviceJoined(deviceName: string): void {
    this.emit({ type: "device_joined", deviceName });
  }

  interruptTransfer(): void {
    this.setPhase("interrupted");
    if (this.o.autoRun) {
      void this.o.delay(2000).then(() => {
        if (this.progressState?.phase === "interrupted") this.transfer.resume();
      });
    }
  }

  failTransfer(): void {
    this.setPhase("failed");
  }

  /** Advances the running transfer by some files (used by run() and by tests). */
  advance(files: number): void {
    const p = this.progressState;
    if (!p || p.phase !== "running") return;
    p.files.done = Math.min(p.files.total, p.files.done + files);
    p.bytes.done = p.files.done * BYTES_PER_FILE;
    if (p.files.done >= p.files.total) p.phase = "done";
    this.emitTransfer();
  }

  // ---- internals --------------------------------------------------------------------------

  private async answer(pairingId: string, status: "approved" | "denied"): Promise<void> {
    await this.o.delay(100);
    const offer = this.offers.find((x) => x.pairingId === pairingId);
    const claim = this.claims.find((c) => c.claimId === offer?.claimId);
    // Like the real server: an expired or already answered request cannot be approved or denied.
    if (claim && (claim.status !== "pending" || claim.expiresAt <= this.o.clock())) {
      this.closeOffer(pairingId);
      throw new Error("pairing request no longer pending");
    }
    if (claim) {
      claim.status = status;
      // Same instance on both sides (dev): the approved device is this one only if not linked yet.
      if (status === "approved" && !this.current) this.linkFromClaim(claim);
    }
    this.closeOffer(pairingId);
  }

  private closeOffer(pairingId: string): void {
    const offer = this.offers.find((x) => x.pairingId === pairingId);
    if (offer) offer.open = false;
    this.requests = this.requests.filter((r) => r.pairingId !== pairingId);
    this.emit({ type: "pairing_closed", pairingId });
  }

  private linkFromClaim(claim: Claim): void {
    this.setLink({
      server: claim.server,
      host: new URL(claim.server).host,
      user: "demo",
      vaultId: "v-notes",
      vaultName: "Note",
      deviceName: claim.deviceName,
    });
  }

  private setLink(link: LinkInfo): void {
    this.current = link;
    this.o.store.save(link);
    this.emit({ type: "linked" });
  }

  private code(): string {
    let out = "";
    for (let i = 0; i < 4; i++) {
      out +=
        VERIFICATION_ALPHABET[
          Math.floor(this.o.random() * VERIFICATION_ALPHABET.length) % VERIFICATION_ALPHABET.length
        ];
    }
    return out;
  }

  private startTransfer(direction: "upload" | "download"): void {
    const total = direction === "upload" ? this.o.localFileCount() : DOWNLOAD_FILES;
    this.progressState = {
      direction,
      phase: total === 0 ? "done" : "running",
      files: { done: 0, total },
      bytes: { done: 0, total: total * BYTES_PER_FILE },
    };
    this.emitTransfer();
    this.run();
  }

  private setPhase(phase: TransferProgress["phase"]): void {
    if (!this.progressState || this.progressState.phase === "done") return;
    this.progressState.phase = phase;
    this.emitTransfer();
  }

  private run(): void {
    if (!this.o.autoRun || this.running) return;
    this.running = true;
    const step = async () => {
      while (this.progressState?.phase === "running") {
        await this.o.delay(150);
        this.advance(1);
      }
      this.running = false;
    };
    void step();
  }

  private emit(e: ConnectionEvent): void {
    for (const cb of [...this.listeners]) cb(e);
  }

  private emitTransfer(): void {
    for (const cb of [...this.transferListeners]) cb();
  }
}
