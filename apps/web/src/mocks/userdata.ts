import type {
  BinaryMeta,
  ConflictDetail,
  Device,
  ForceSyncState,
  SyncSettings,
  Vault,
} from "@kamino/protocol";

// Fake user-area data (dev/tests only), shared by every signed-in user.
const NOW = Date.UTC(2026, 10, 8, 10, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const GB = 1024 ** 3;
const MB = 1024 ** 2;

export interface FakeVersion {
  id: string;
  fileId: string;
  at: string;
  device: string;
  size: number;
  text: string | null;
  previewUrl: string | null;
  mime: string;
}
export interface FakeFile {
  fileId: string;
  vaultId: string;
  path: string;
  versions: FakeVersion[];
}
export interface FakeTrash {
  fileId: string;
  vaultId: string;
  path: string;
  deletedAt: string;
  expiresAt: string;
  size: number;
}
export interface FakePairing {
  id: string;
  vaultId: string;
  status: "waiting" | "requested" | "approved" | "denied" | "expired" | "cancelled";
  expiresAt: number;
  request?: { deviceName: string; platform: string; pluginVersion: string; code: string };
  reused?: boolean;
}

interface UserData {
  vaults: Vault[];
  baseLevel: Map<string, Vault["level"]>;
  quota: { usedBytes: number; limitBytes: number | null };
  devices: Device[];
  conflicts: ConflictDetail[];
  files: FakeFile[];
  trash: FakeTrash[];
  pairings: FakePairing[];
  staleNext: boolean;
  seq: number;
  syncSettings: Map<string, SyncSettings>;
  forceSyncs: Map<string, NonNullable<ForceSyncState>>;
}

export const ud: UserData = {
  vaults: [],
  baseLevel: new Map(),
  quota: { usedBytes: 0, limitBytes: null },
  devices: [],
  conflicts: [],
  files: [],
  trash: [],
  pairings: [],
  staleNext: false,
  seq: 0,
  syncSettings: new Map(),
  forceSyncs: new Map(),
};

const swatch = (color: string): BinaryMeta => ({
  size: 48_213,
  mime: "image/svg+xml",
  previewUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="${color}"/></svg>`)}`,
});

function longNote(incoming: boolean): string {
  const lines = ["# Piano", ""];
  for (let i = 1; i <= 120; i++)
    lines.push(
      `- Punto ${i}: descrizione del passo ${i}.${incoming && (i === 12 || i === 80) ? " (aggiornato)" : ""}`,
    );
  return `${lines.join("\n")}\n`;
}

export function seedUserData(preset: "default" | "quota-almost-full" = "default"): void {
  ud.seq = 0;
  ud.staleNext = false;
  ud.pairings = [];
  ud.syncSettings = new Map();
  ud.forceSyncs = new Map();
  const vault = (id: string, name: string, level: Vault["level"], o: Partial<Vault>): Vault => ({
    id,
    name,
    level,
    fileCount: 0,
    deviceCount: 0,
    conflicts: 0,
    usedBytes: 0,
    historyBytes: 0,
    trashBytes: 0,
    retentionDays: 30,
    maxRetentionDays: 90,
    historyFrom: iso(30 * DAY),
    ...o,
  });
  ud.vaults = [
    vault("v-notes", "Note", "decision", {
      fileCount: 128,
      deviceCount: 3,
      conflicts: 2,
      usedBytes: 1.2 * GB,
      historyBytes: 300 * MB,
      trashBytes: 12 * MB,
    }),
    vault("v-work", "Lavoro", "decision", {
      fileCount: 512,
      deviceCount: 1,
      conflicts: 1,
      usedBytes: 0.9 * GB,
      historyBytes: 120 * MB,
      trashBytes: 0,
    }),
  ];
  ud.baseLevel = new Map([
    ["v-notes", "attention"],
    ["v-work", "safe"],
  ]);
  ud.quota = {
    usedBytes: preset === "quota-almost-full" ? 9.4 * GB : 2.1 * GB,
    limitBytes: 10 * GB,
  };
  const dev = (
    o: Partial<Device> & Pick<Device, "id" | "vaultId" | "vaultName" | "name" | "platform">,
  ): Device => ({
    pluginVersion: "0.1.0",
    lastSeenAt: iso(2 * MIN),
    lastSyncAt: iso(2 * MIN),
    lag: 0,
    pending: 0,
    lastError: null,
    level: "safe",
    revoked: false,
    ...o,
  });
  ud.devices = [
    dev({ id: "d-mac", vaultId: "v-notes", vaultName: "Note", name: "MacBook", platform: "macOS" }),
    dev({
      id: "d-iphone",
      vaultId: "v-notes",
      vaultName: "Note",
      name: "iPhone",
      platform: "iOS",
      lastSeenAt: iso(2 * DAY),
      lastSyncAt: iso(2 * DAY),
      pending: 3,
      lag: 14,
      level: "attention",
    }),
    dev({
      id: "d-ipad",
      vaultId: "v-notes",
      vaultName: "Note",
      name: "iPad",
      platform: "iPadOS",
      lastError: "quota_exceeded",
      level: "blocked",
      pending: 2,
    }),
    dev({
      id: "d-pc",
      vaultId: "v-work",
      vaultName: "Lavoro",
      name: "PC ufficio",
      platform: "Windows",
    }),
    dev({
      id: "d-old",
      vaultId: "v-notes",
      vaultName: "Note",
      name: "Vecchio portatile",
      platform: "Linux",
      revoked: true,
      lastSeenAt: iso(40 * DAY),
      lastSyncAt: iso(40 * DAY),
    }),
  ];
  ud.conflicts = [
    {
      id: "c-shopping",
      vaultId: "v-notes",
      vaultName: "Note",
      path: "Spesa.md",
      kind: "concurrent_edit",
      binary: false,
      mine: { device: "MacBook", at: iso(20 * MIN) },
      incoming: { device: "iPhone", at: iso(15 * MIN) },
      mineText: "# Spesa\n\n- latte\n- pane\n- uova (6)\n- caffè\n",
      incomingText: "# Spesa\n\n- latte\n- pane\n- uova (12)\n- caffè\n- mele\n",
    },
    {
      id: "c-plan",
      vaultId: "v-notes",
      vaultName: "Note",
      path: "Progetti/Piano.md",
      kind: "concurrent_edit",
      binary: false,
      mine: { device: "MacBook", at: iso(26 * HOUR) },
      incoming: { device: "iPad", at: iso(25 * HOUR) },
      mineText: longNote(false),
      incomingText: longNote(true),
    },
    {
      id: "c-photo",
      vaultId: "v-work",
      vaultName: "Lavoro",
      path: "Foto/vacanza.svg",
      kind: "both_created",
      binary: true,
      mine: { device: "PC ufficio", at: iso(2 * HOUR) },
      incoming: { device: "iPhone", at: iso(HOUR) },
      mineFile: swatch("teal"),
      incomingFile: swatch("orange"),
    },
  ];
  const ver = (fileId: string, n: number, text: string): FakeVersion => ({
    id: `${fileId}-v${n}`,
    fileId,
    at: iso((5 - n) * DAY + HOUR),
    device: n % 2 ? "MacBook" : "iPhone",
    size: text.length,
    text,
    previewUrl: null,
    mime: "text/markdown",
  });
  ud.files = [
    {
      fileId: "f-idee",
      vaultId: "v-notes",
      path: "Idee.md",
      versions: [1, 2, 3, 4].map((n) => ver("f-idee", n, `# Idee\n\nVersione ${n} delle idee.\n`)),
    },
    {
      fileId: "f-diario",
      vaultId: "v-notes",
      path: "Diario/2026-11-07.md",
      versions: [1, 2, 3].map((n) => ver("f-diario", n, `Giornata, bozza ${n}.\n`)),
    },
    {
      fileId: "f-logo",
      vaultId: "v-work",
      path: "Loghi/logo.svg",
      versions: [1, 2].map((n) => ({
        ...ver("f-logo", n, ""),
        text: null,
        mime: "image/svg+xml",
        previewUrl: swatch(n === 1 ? "navy" : "teal").previewUrl,
      })),
    },
  ];
  ud.trash = [
    {
      fileId: "t-old",
      vaultId: "v-notes",
      path: "Vecchie note/bozza.md",
      deletedAt: iso(2 * DAY),
      expiresAt: iso(-5 * DAY),
      size: 2_048,
    },
    {
      fileId: "t-img",
      vaultId: "v-notes",
      path: "Allegati/scontrino.jpg",
      deletedAt: iso(DAY),
      expiresAt: iso(-6 * DAY),
      size: 340_000,
    },
    {
      fileId: "t-tmp",
      vaultId: "v-work",
      path: "tmp.md",
      deletedAt: iso(3 * HOUR),
      expiresAt: iso(-7 * DAY),
      size: 120,
    },
  ];
}

export const nextUd = (prefix: string) => `${prefix}-${++ud.seq}`;

/** Recomputes conflict counters and levels after a change. */
export function refreshVaults(): void {
  for (const v of ud.vaults) {
    v.conflicts = ud.conflicts.filter((c) => c.vaultId === v.id).length;
    v.deviceCount = ud.devices.filter((d) => d.vaultId === v.id && !d.revoked).length;
    v.level = v.conflicts > 0 ? "decision" : (ud.baseLevel.get(v.id) ?? "safe");
  }
}

/** Dev panel: the most recent waiting pairing receives a request from a new device. */
export function simulatePairingRequest(): void {
  const p = [...ud.pairings].reverse().find((x) => x.status === "waiting");
  if (!p) return;
  p.status = "requested";
  p.request = { deviceName: "Pixel", platform: "Android", pluginVersion: "0.1.0", code: "K7RX" };
}

/** Dev panel / tests: someone else tried the same link after the request. */
export function simulatePairingReuse(): void {
  const p = [...ud.pairings].reverse().find((x) => x.status === "requested");
  if (p) p.reused = true;
}

/** Dev panel / tests: the next conflict resolution answers stale_resolution. */
export function simulateStaleNext(): void {
  ud.staleNext = true;
}

seedUserData();
