import type { Lang } from "@kamino/status";
import type { PairingLink } from "../connection/link.js";
import type { ConnectionService, InitialTransfer, PairingRequest } from "../connection/types.js";
import type { SettingsStore } from "../settings/store.js";
import type { ConflictActions, SyncStateSource } from "../state/types.js";

export interface ConfirmOptions {
  title: string;
  text: string;
  /** null = information only ("Close"). */
  confirmText: string | null;
  cancelText: string;
  warning?: boolean;
}

/** Everything the views need: data, services, environment and navigation. */
export interface UiContext {
  source: SyncStateSource;
  actions: ConflictActions;
  connection: ConnectionService;
  transfer: InitialTransfer;
  settings: SettingsStore;
  /** false until the sync engine exists (M1): behaviour settings are saved but not applied. */
  engineAvailable: boolean;
  lang: Lang;
  isMobile: boolean;
  isIos: boolean;
  platformLabel: string;
  vaultName: string;
  configDir: string;
  now: () => number;
  available: ReadonlySet<string> | null;
  localFileCount(): number;
  openStatusPanel(): Promise<void>;
  openConflict(id: string): Promise<void>;
  openBulkResolve(): void;
  openWelcome(): Promise<void>;
  openTransfer(): Promise<void>;
  openConnect(mode: "create" | "join"): void;
  openClaim(link: PairingLink): void;
  openAddDevice(request?: PairingRequest): void;
  confirm(opts: ConfirmOptions): Promise<boolean>;
}
