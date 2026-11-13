import { seedAdminData } from "./admindata.js";
import type { Lang, Role, SecurityEventType, Theme } from "@kamino/protocol";
import { seedUserData } from "./userdata.js";

// Fake server state for development and tests. Plain-text passwords exist ONLY here.

export const TEST_TOTP = "123456";
export const TEST_SECRET = "JBSWY3DPEHPK3PXP";
export const TEST_RECOVERY_CODES = Array.from({ length: 10 }, (_, i) => `AAAA-${String(1111 + i)}`);
export const SETUP_TOKEN = "setup-token";

export interface FakeUser {
  id: string;
  username: string;
  email: string;
  password: string;
  role: Role;
  lang: Lang;
  theme: Theme;
  totpEnabled: boolean;
  totpSetupRequired: boolean;
  adminResetAt: string | null;
  locked: boolean;
  recoveryCodes: string[];
}

export interface FakeSession {
  id: string;
  userId: string;
  client: string;
  ipPrefix: string;
  lastUsedAt: string;
}

export interface FakeEvent {
  id: string;
  userId: string;
  type: SecurityEventType;
  at: string;
  client?: string;
}

interface Db {
  users: FakeUser[];
  sessions: FakeSession[];
  /** The fake browser's session (MSW simulates a single browser; no cookie jar). */
  currentSessionId: string | null;
  challenges: Map<string, { userId: string; expiresAt: number }>;
  invites: Map<string, { username: string; email: string }>;
  resets: Map<string, string>;
  events: FakeEvent[];
  smtp: boolean;
  seq: number;
}

export const db: Db = {
  users: [],
  sessions: [],
  currentSessionId: null,
  challenges: new Map(),
  invites: new Map(),
  resets: new Map(),
  events: [],
  smtp: true,
  seq: 0,
};

export const nextId = (prefix: string): string => `${prefix}-${++db.seq}`;
const iso = (msAgo: number) => new Date(Date.UTC(2026, 10, 8, 10, 0) - msAgo).toISOString();

function user(over: Partial<FakeUser> & Pick<FakeUser, "username" | "password">): FakeUser {
  return {
    id: nextId("u"),
    email: `${over.username}@example.com`,
    role: "user",
    lang: "it",
    theme: "dark",
    totpEnabled: false,
    totpSetupRequired: false,
    adminResetAt: null,
    locked: false,
    recoveryCodes: [],
    ...over,
  };
}

export function resetDb(preset: "default" | "empty" = "default"): void {
  db.users = [];
  db.sessions = [];
  db.currentSessionId = null;
  db.challenges = new Map();
  db.invites = new Map();
  db.resets = new Map();
  db.events = [];
  db.smtp = true;
  db.seq = 0;
  seedUserData();
  if (preset === "empty") {
    seedAdminData(db.users);
    return;
  }

  const admin = user({
    username: "admin",
    password: "admin-password-1",
    role: "admin",
    totpEnabled: true,
    recoveryCodes: [...TEST_RECOVERY_CODES],
  });
  const demo = user({ username: "demo", password: "demo-password-1" });
  db.users.push(
    admin,
    demo,
    user({
      username: "newadmin",
      password: "newadmin-pass-1",
      role: "admin",
      totpSetupRequired: true,
    }),
    user({ username: "locked", password: "locked-password-1", locked: true }),
    user({ username: "reset", password: "reset-password-1", adminResetAt: iso(2 * 3_600_000) }),
  );
  db.sessions.push(
    {
      id: nextId("s"),
      userId: admin.id,
      client: "Safari · iPhone",
      ipPrefix: "10.0.0.x",
      lastUsedAt: iso(3_600_000),
    },
    {
      id: nextId("s"),
      userId: admin.id,
      client: "Firefox · Windows",
      ipPrefix: "192.168.1.x",
      lastUsedAt: iso(86_400_000),
    },
  );
  db.invites.set("invite-token", { username: "invited", email: "invited@example.com" });
  db.resets.set("reset-token", demo.id);
  const types: SecurityEventType[] = [
    "login",
    "login_failed",
    "device_linked",
    "password_changed",
    "totp_enabled",
  ];
  for (let i = 0; i < 30; i++) {
    db.events.push({
      id: nextId("e"),
      userId: admin.id,
      type: types[i % types.length]!,
      at: iso(i * 3_600_000),
      client: i % 2 === 0 ? "Firefox · macOS" : "Obsidian · iPhone",
    });
  }
  seedAdminData(db.users);
}

/** Opens a session for the fake browser. */
export function openSession(u: FakeUser): void {
  const s: FakeSession = {
    id: nextId("s"),
    userId: u.id,
    client: "Firefox · macOS",
    ipPrefix: "127.0.0.x",
    lastUsedAt: iso(0),
  };
  db.sessions.push(s);
  db.currentSessionId = s.id;
  addEvent(u.id, "login");
}

export function addEvent(userId: string, type: SecurityEventType): void {
  db.events.unshift({
    id: nextId("e"),
    userId,
    type,
    at: new Date().toISOString(),
    client: "Firefox · macOS",
  });
}

export function currentUser(): FakeUser | null {
  const s = db.sessions.find((x) => x.id === db.currentSessionId);
  return s ? (db.users.find((u) => u.id === s.userId) ?? null) : null;
}

/** Dev panel / tests: sign in directly, skipping the forms. */
export function signInAs(username: string): void {
  const u = db.users.find((x) => x.username === username);
  if (u) openSession(u);
}

resetDb();
