import type { PairingLink } from "./link.js";

export type ServerCheck =
  | { ok: true; host: string; insecure: boolean }
  | { ok: false; reason: "invalid_url" | "unreachable" | "incompatible" | "insecure_on_mobile" };

export interface Session {
  server: string;
  user: string;
  expiresAt: number;
  /** Enrollment token of the real server (absent with the fake one). */
  token?: string;
}

export type LoginResult =
  | { ok: true; session: Session }
  | {
      ok: false;
      reason:
        | "bad_credentials"
        | "totp_required"
        | "bad_totp"
        | "locked"
        | "totp_mandatory"
        | "rate_limited"
        | "unreachable"
        | "update_required";
    };

export interface VaultSummary {
  id: string;
  name: string;
  fileCount: number;
  deviceCount: number;
}

export interface LinkInfo {
  server: string;
  host: string;
  user: string;
  vaultId: string;
  vaultName: string;
  deviceName: string;
}

export interface PairingOffer {
  pairingId: string;
  link: string;
  expiresAt: number;
}

export interface PairingRequest {
  pairingId: string;
  deviceName: string;
  platform: string;
  pluginVersion: string;
  code: string;
  at: number;
  expiresAt: number;
}

export type ClaimResult =
  | { ok: true; claimId: string; code: string; expiresAt: number; host: string }
  | {
      ok: false;
      reason:
        | "invalid"
        | "expired"
        | "already_claimed"
        | "unreachable"
        | "incompatible"
        | "insecure_on_mobile";
    };

export type ClaimStatus = "pending" | "approved" | "denied" | "expired";

export type ConnectionEvent =
  | { type: "linked" }
  | { type: "unlinked" }
  | { type: "pairing_request"; request: PairingRequest }
  | { type: "pairing_closed"; pairingId: string }
  | { type: "pairing_reused"; pairingId: string }
  | { type: "device_joined"; deviceName: string }
  | { type: "device_renamed" };

export interface ConnectionService {
  /** false = QR pairing not available: the UI says it is coming. */
  readonly pairingAvailable: boolean;
  link(): LinkInfo | null;
  checkServer(url: string): Promise<ServerCheck>;
  login(server: string, user: string, password: string, totp?: string): Promise<LoginResult>;
  listVaults(session: Session): Promise<VaultSummary[]>;
  createVault(session: Session, name: string): Promise<VaultSummary>;
  linkDevice(session: Session, vaultId: string, deviceName: string): Promise<LinkInfo>;
  renameDevice(name: string): Promise<void>;
  unlink(): Promise<void>;
  startPairing(): Promise<PairingOffer>;
  pairingRequests(): PairingRequest[];
  approve(pairingId: string): Promise<void>;
  deny(pairingId: string): Promise<void>;
  cancelPairing(pairingId: string): Promise<void>;
  claim(link: PairingLink, deviceName: string): Promise<ClaimResult>;
  claimStatus(claimId: string): Promise<ClaimStatus>;
  cancelClaim(claimId: string): Promise<void>;
  onChange(cb: (event: ConnectionEvent) => void): () => void;
}

export interface TransferProgress {
  direction: "upload" | "download";
  phase: "running" | "paused" | "interrupted" | "failed" | "done";
  files: { done: number; total: number };
  bytes: { done: number; total: number };
  /** M9: files left waiting (Wi-Fi, size, unreadable) when the rest is done. */
  waiting?: number;
}

export interface InitialTransfer {
  start(direction: "upload" | "download"): void;
  progress(): TransferProgress | null;
  pause(): void;
  resume(): void;
  retry(): void;
  onChange(cb: () => void): () => void;
}
