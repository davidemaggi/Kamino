import type { Me, SecurityEventType, SessionInfo } from "@kamino/protocol";
import { and, count, desc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import { systemKey } from "../crypto/dek.js";
import { decryptField, encryptField } from "../crypto/field.js";
import type { Kek } from "../crypto/keyring.js";
import type { Db } from "../db/client.js";
import {
  auditLog,
  oneTimeTokens,
  recoveryCodes,
  securityEvents,
  users,
  webSessions,
} from "../db/schema.js";
import { describeClient, ipPrefix } from "./client-info.js";
import { hashPassword, isWeakPassword, verifyPassword } from "./password.js";
import { hashToken, randomToken, recoveryCode, uuidv7 } from "./tokens.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";

export type User = typeof users.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type TokenKind = (typeof oneTimeTokens.$inferInsert)["kind"];

export interface Ctx {
  ip: string | undefined;
  userAgent: string | undefined;
}

export class AuthError extends Error {
  constructor(
    readonly code:
      | "invalid_credentials"
      | "user_blocked"
      | "totp_invalid"
      | "challenge_expired"
      | "setup_not_needed"
      | "setup_token_invalid"
      | "token_invalid"
      | "token_expired"
      | "password_weak"
      | "password_wrong"
      | "totp_mandatory"
      | "username_taken"
      | "email_taken"
      | "not_found"
      | "forbidden",
    readonly status: number,
  ) {
    super(code);
  }
}

const DAY = 86_400_000;
export const SESSION_IDLE_MS = 14 * DAY;
export const SESSION_ABSOLUTE_MS = 90 * DAY;
const CHALLENGE_MS = 5 * 60_000;
/** Wrong codes allowed per TOTP challenge before it is dropped (brute force needs a new login). */
export const CHALLENGE_ATTEMPTS = 5;
const MAX_CHALLENGES = 10_000;
const TTL: Record<"password_reset" | "invite", number> = {
  password_reset: 3_600_000,
  invite: 7 * DAY,
};
/** Arbitrary constant for the transaction-level advisory lock serializing the first setup. */
const SETUP_LOCK_ID = 7_243_650_068n;

/** Uniqueness keys for usernames and emails (no citext). */
export const keyOf = (s: string) => s.trim().normalize("NFC").toLowerCase();

/** Postgres unique violation (23505) on a users key → the catalogue code. */
function uniqueViolation(e: unknown): AuthError | null {
  for (let cur: unknown = e, i = 0; cur && typeof cur === "object" && i < 5; i++) {
    const c = cur as { code?: unknown; constraint_name?: unknown; cause?: unknown };
    if (c.code === "23505") {
      const name = String(c.constraint_name ?? "");
      if (name.includes("username")) return new AuthError("username_taken", 409);
      if (name.includes("email")) return new AuthError("email_taken", 409);
    }
    cur = c.cause;
  }
  return null;
}

async function mapUnique<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    throw uniqueViolation(e) ?? e;
  }
}

export class AuthService {
  private readonly totpKey: Buffer;
  private readonly challenges = new Map<
    string,
    { userId: string; expiresAt: number; attempts: number }
  >();

  constructor(
    private readonly db: Db,
    kek: Kek,
    private readonly issuer: string,
    private readonly now: () => number = Date.now,
  ) {
    this.totpKey = systemKey(kek);
  }

  private date(): Date {
    return new Date(this.now());
  }

  // ---------- users ----------

  async userCount(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(users);
    return row?.n ?? 0;
  }

  async byId(id: string): Promise<User | undefined> {
    return (await this.db.select().from(users).where(eq(users.id, id)))[0];
  }

  async byUsername(username: string): Promise<User | undefined> {
    return (
      await this.db
        .select()
        .from(users)
        .where(eq(users.usernameKey, keyOf(username)))
    )[0];
  }

  me(u: User): Me {
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.role,
      lang: u.locale === "en" ? "en" : "it",
      theme: u.theme,
      totpEnabled: u.totpEnabledAt !== null,
      totpSetupRequired: needsTotpSetup(u),
      adminResetAt: u.adminResetAt?.toISOString() ?? null,
    };
  }

  private async event(
    userId: string,
    type: SecurityEventType,
    ctx?: Ctx,
    db: Db | Tx = this.db,
  ): Promise<void> {
    await db.insert(securityEvents).values({
      id: uuidv7(),
      userId,
      type,
      ip: ctx?.ip ?? null,
      client: ctx ? describeClient(ctx.userAgent) : null,
      createdAt: this.date(),
    });
  }

  async audit(
    actor: string,
    action: string,
    target: string | null,
    db: Db | Tx = this.db,
  ): Promise<void> {
    await db
      .insert(auditLog)
      .values({ id: uuidv7(), actor, action, target, createdAt: this.date() });
  }

  // ---------- one-time tokens ----------

  async createToken(
    kind: TokenKind,
    opts: { userId?: string; email?: string; ttlMs: number; createdBy?: string },
    db: Db | Tx = this.db,
  ): Promise<string> {
    const token = randomToken();
    await db.insert(oneTimeTokens).values({
      id: uuidv7(),
      kind,
      tokenHash: hashToken(token),
      userId: opts.userId ?? null,
      email: opts.email ?? null,
      expiresAt: new Date(this.now() + opts.ttlMs),
      createdBy: opts.createdBy ?? null,
    });
    return token;
  }

  private async findToken(kind: TokenKind, token: string, db: Db | Tx = this.db) {
    const row = (
      await db
        .select()
        .from(oneTimeTokens)
        .where(and(eq(oneTimeTokens.tokenHash, hashToken(token)), eq(oneTimeTokens.kind, kind)))
    )[0];
    if (!row || row.usedAt) throw new AuthError("token_invalid", 400);
    if (row.expiresAt.getTime() <= this.now()) throw new AuthError("token_expired", 400);
    return row;
  }

  /** Marks a token used only if nobody did it first: concurrent uses can't both succeed. */
  private async consumeToken(tx: Tx, id: string): Promise<void> {
    const used = await tx
      .update(oneTimeTokens)
      .set({ usedAt: this.date() })
      .where(and(eq(oneTimeTokens.id, id), isNull(oneTimeTokens.usedAt)))
      .returning({ id: oneTimeTokens.id });
    if (used.length === 0) throw new AuthError("token_invalid", 400);
  }

  // ---------- setup ----------

  /** Called at startup: when there are no users, a fresh setup token to print once in the logs. */
  async ensureSetupToken(): Promise<string | null> {
    if ((await this.userCount()) > 0) return null;
    await this.db.delete(oneTimeTokens).where(eq(oneTimeTokens.kind, "setup"));
    return this.createToken("setup", { ttlMs: 365 * DAY });
  }

  /** One transaction under an advisory lock: two concurrent setups can't both create an admin. */
  async setup(
    input: { token: string; username: string; email: string; password: string },
    ctx: Ctx,
  ): Promise<User> {
    if (isWeakPassword(input.password)) throw new AuthError("password_weak", 400);
    const passwordHash = await hashPassword(input.password);
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK_ID.toString()}::bigint)`);
      const [row] = await tx.select({ n: count() }).from(users);
      if ((row?.n ?? 0) > 0) throw new AuthError("setup_not_needed", 409);
      const token = await this.findToken("setup", input.token, tx).catch(() => {
        throw new AuthError("setup_token_invalid", 403);
      });
      await this.consumeToken(tx, token.id);
      const user = await this.insertUser(
        {
          username: input.username,
          email: input.email,
          role: "admin",
          status: "active",
          passwordHash,
        },
        tx,
      );
      await this.audit(user.username, "setup", user.username, tx);
      await this.event(user.id, "login", ctx, tx);
      return user;
    });
  }

  async insertUser(
    v: {
      username: string;
      email: string;
      role: "user" | "admin";
      status: User["status"];
      passwordHash: string | null;
    },
    db: Db | Tx = this.db,
  ): Promise<User> {
    const t = this.date();
    const [u] = await mapUnique(
      db
        .insert(users)
        .values({
          id: uuidv7(),
          ...v,
          usernameKey: keyOf(v.username),
          emailKey: keyOf(v.email),
          createdAt: t,
          updatedAt: t,
        })
        .returning(),
    );
    return u!;
  }

  // ---------- login ----------

  async login(
    username: string,
    password: string,
    ctx: Ctx,
  ): Promise<{ status: "ok"; user: User } | { status: "totp_required"; challengeId: string }> {
    this.pruneChallenges();
    const u = await this.byUsername(username);
    const ok = await verifyPassword(u?.passwordHash ?? null, password);
    if (!u || !ok) {
      // Not awaited: an existing user must not answer measurably slower than an unknown one.
      if (u) void this.event(u.id, "login_failed", ctx).catch(() => undefined);
      throw new AuthError("invalid_credentials", 401);
    }
    if (u.status !== "active") throw new AuthError("user_blocked", 403);
    if (u.totpEnabledAt) {
      const challengeId = randomToken();
      if (this.challenges.size < MAX_CHALLENGES)
        this.challenges.set(challengeId, {
          userId: u.id,
          expiresAt: this.now() + CHALLENGE_MS,
          attempts: 0,
        });
      return { status: "totp_required", challengeId };
    }
    await this.event(u.id, "login", ctx);
    return { status: "ok", user: u };
  }

  /** Device login (C5): password, then TOTP in the same request when enabled. */
  async checkDeviceCredentials(
    username: string,
    password: string,
    totp: string | undefined,
    ctx: Ctx,
  ): Promise<{ status: "ok"; user: User } | { status: "totp_required" }> {
    const r = await this.login(username, password, ctx);
    if (r.status === "ok") {
      if (needsTotpSetup(r.user)) throw new AuthError("totp_mandatory", 403);
      await this.event(r.user.id, "device_linked", ctx);
      return r;
    }
    this.challenges.delete(r.challengeId);
    if (totp === undefined) return { status: "totp_required" };
    const u = await this.byUsername(username);
    if (!u || !(await this.checkSecondFactor(u, totp))) {
      if (u) await this.event(u.id, "login_failed", ctx);
      throw new AuthError("totp_invalid", 401);
    }
    await this.event(u.id, "device_linked", ctx);
    return { status: "ok", user: u };
  }

  /** TOTP code or a recovery code (consumed). A challenge allows a few wrong codes, then it's gone. */
  async loginTotp(challengeId: string, code: string, ctx: Ctx): Promise<User> {
    const ch = this.challenges.get(challengeId);
    if (!ch || ch.expiresAt <= this.now()) {
      this.challenges.delete(challengeId);
      throw new AuthError("challenge_expired", 401);
    }
    const u = await this.byId(ch.userId);
    if (!u || u.status !== "active") throw new AuthError("user_blocked", 403);
    if (!(await this.checkSecondFactor(u, code))) {
      ch.attempts++;
      if (ch.attempts >= CHALLENGE_ATTEMPTS) this.challenges.delete(challengeId);
      await this.event(u.id, "login_failed", ctx);
      throw new AuthError("totp_invalid", 401);
    }
    this.challenges.delete(challengeId);
    await this.event(u.id, "login", ctx);
    return u;
  }

  private async checkSecondFactor(u: User, code: string): Promise<boolean> {
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) {
      if (!u.totpSecret) return false;
      const secret = decryptField(
        this.totpKey,
        { table: "users", column: "totp_secret", rowId: u.id },
        u.totpSecret,
      ).toString();
      const step = verifyTotp(secret, trimmed, this.now(), u.totpLastStep);
      if (step === null) return false;
      // Conditional: two concurrent requests with the same code can't both pass (anti-replay).
      const won = await this.db
        .update(users)
        .set({ totpLastStep: step })
        .where(
          and(eq(users.id, u.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))),
        )
        .returning({ id: users.id });
      return won.length === 1;
    }
    const candidate = trimmed.toUpperCase();
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(candidate)) return false;
    const codes = await this.db
      .select()
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, u.id), isNull(recoveryCodes.usedAt)));
    for (const rc of codes) {
      if (await verifyPassword(rc.codeHash, candidate)) {
        const won = await this.db
          .update(recoveryCodes)
          .set({ usedAt: this.date() })
          .where(and(eq(recoveryCodes.id, rc.id), isNull(recoveryCodes.usedAt)))
          .returning({ id: recoveryCodes.id });
        return won.length === 1;
      }
    }
    return false;
  }

  // ---------- sessions ----------

  async createSession(userId: string, ctx: Ctx): Promise<string> {
    const token = randomToken();
    const t = this.date();
    await this.db.insert(webSessions).values({
      id: uuidv7(),
      userId,
      tokenHash: hashToken(token),
      createdAt: t,
      lastSeenAt: t,
      expiresAt: new Date(t.getTime() + SESSION_ABSOLUTE_MS),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return token;
  }

  /** Valid session → its user; idle (14 d), absolute (90 d), revoked or user not active → null. */
  async resolveSession(token: string): Promise<{ user: User; sessionId: string } | null> {
    const row = (
      await this.db
        .select()
        .from(webSessions)
        .where(eq(webSessions.tokenHash, hashToken(token)))
    )[0];
    const t = this.now();
    if (
      !row ||
      row.revokedAt ||
      row.expiresAt.getTime() <= t ||
      row.lastSeenAt.getTime() + SESSION_IDLE_MS <= t
    )
      return null;
    const user = await this.byId(row.userId);
    if (!user || user.status !== "active") return null;
    if (t - row.lastSeenAt.getTime() > 60_000)
      await this.db
        .update(webSessions)
        .set({ lastSeenAt: new Date(t) })
        .where(eq(webSessions.id, row.id));
    return { user, sessionId: row.id };
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.db
      .update(webSessions)
      .set({ revokedAt: this.date() })
      .where(and(eq(webSessions.id, sessionId), eq(webSessions.userId, userId)));
  }

  async revokeOtherSessions(
    userId: string,
    keep: string | null,
    db: Db | Tx = this.db,
  ): Promise<void> {
    const cond = keep
      ? and(eq(webSessions.userId, userId), ne(webSessions.id, keep), isNull(webSessions.revokedAt))
      : and(eq(webSessions.userId, userId), isNull(webSessions.revokedAt));
    await db.update(webSessions).set({ revokedAt: this.date() }).where(cond);
  }

  async listSessions(userId: string, current: string): Promise<SessionInfo[]> {
    const t = this.date();
    const rows = await this.db
      .select()
      .from(webSessions)
      .where(
        and(
          eq(webSessions.userId, userId),
          isNull(webSessions.revokedAt),
          gt(webSessions.expiresAt, t),
        ),
      )
      .orderBy(desc(webSessions.lastSeenAt));
    return rows
      .filter((r) => r.lastSeenAt.getTime() + SESSION_IDLE_MS > t.getTime())
      .map((r) => ({
        id: r.id,
        current: r.id === current,
        client: describeClient(r.userAgent ?? undefined),
        ipPrefix: ipPrefix(r.ip ?? undefined),
        lastUsedAt: r.lastSeenAt.toISOString(),
      }));
  }

  // ---------- account ----------

  async updateProfile(
    u: User,
    patch: {
      email?: string | undefined;
      lang?: "it" | "en" | undefined;
      theme?: "light" | "dark" | "system" | undefined;
    },
  ): Promise<User> {
    const set: Partial<typeof users.$inferInsert> = { updatedAt: this.date() };
    if (patch.email !== undefined)
      Object.assign(set, { email: patch.email, emailKey: keyOf(patch.email) });
    if (patch.lang !== undefined) set.locale = patch.lang;
    if (patch.theme !== undefined) set.theme = patch.theme;
    const [row] = await mapUnique(
      this.db.update(users).set(set).where(eq(users.id, u.id)).returning(),
    );
    return row!;
  }

  /** Revokes every other session and clears the admin-reset notice (04 §8). */
  async changePassword(
    u: User,
    current: string,
    next: string,
    sessionId: string,
    ctx: Ctx,
  ): Promise<void> {
    if (!(await verifyPassword(u.passwordHash, current)))
      throw new AuthError("password_wrong", 400);
    if (isWeakPassword(next)) throw new AuthError("password_weak", 400);
    const passwordHash = await hashPassword(next);
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, adminResetAt: null, updatedAt: this.date() })
        .where(eq(users.id, u.id));
      await this.revokeOtherSessions(u.id, sessionId, tx);
      await this.event(u.id, "password_changed", ctx, tx);
    });
  }

  async totpSetup(u: User): Promise<{ secret: string; otpauthUrl: string }> {
    // Pending until confirmed: an enabled TOTP is never replaced here.
    if (u.totpEnabledAt) throw new AuthError("forbidden", 409);
    const secret = generateTotpSecret();
    const sealed = encryptField(
      this.totpKey,
      { table: "users", column: "totp_secret", rowId: u.id },
      secret,
    );
    await this.db.update(users).set({ totpSecret: sealed }).where(eq(users.id, u.id));
    return { secret, otpauthUrl: otpauthUrl(this.issuer, u.username, secret) };
  }

  async totpConfirm(u: User, code: string, ctx: Ctx): Promise<string[]> {
    if (!u.totpSecret || u.totpEnabledAt) throw new AuthError("totp_invalid", 400);
    const secret = decryptField(
      this.totpKey,
      { table: "users", column: "totp_secret", rowId: u.id },
      u.totpSecret,
    ).toString();
    const step = verifyTotp(secret, code, this.now(), null);
    if (step === null) throw new AuthError("totp_invalid", 400);
    const won = await this.db
      .update(users)
      .set({ totpEnabledAt: this.date(), totpLastStep: step })
      .where(and(eq(users.id, u.id), isNull(users.totpEnabledAt)))
      .returning({ id: users.id });
    if (won.length === 0) throw new AuthError("totp_invalid", 400);
    await this.event(u.id, "totp_enabled", ctx);
    return this.newRecoveryCodes(u.id);
  }

  async totpDisable(u: User, password: string, ctx: Ctx): Promise<void> {
    if (u.role === "admin") throw new AuthError("totp_mandatory", 403);
    if (!(await verifyPassword(u.passwordHash, password)))
      throw new AuthError("password_wrong", 400);
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
        .where(eq(users.id, u.id));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id));
      await this.event(u.id, "totp_disabled", ctx, tx);
    });
  }

  async regenerateRecoveryCodes(u: User, password: string): Promise<string[]> {
    if (!(await verifyPassword(u.passwordHash, password)))
      throw new AuthError("password_wrong", 400);
    if (!u.totpEnabledAt) throw new AuthError("forbidden", 409);
    return this.newRecoveryCodes(u.id);
  }

  /** Replace-all in one transaction: never 20 valid codes after concurrent requests. */
  private async newRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, recoveryCode);
    const hashed = await Promise.all(codes.map((c) => hashPassword(c)));
    await this.db.transaction(async (tx) => {
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      await tx
        .insert(recoveryCodes)
        .values(hashed.map((codeHash) => ({ id: uuidv7(), userId, codeHash })));
    });
    return codes;
  }

  async securityLog(
    userId: string,
    page: number,
  ): Promise<{
    items: { id: string; type: SecurityEventType; at: string; client?: string }[];
    page: number;
    pages: number;
  }> {
    const [row] = await this.db
      .select({ n: count() })
      .from(securityEvents)
      .where(eq(securityEvents.userId, userId));
    const pages = Math.max(1, Math.ceil((row?.n ?? 0) / 20));
    const p = Math.min(pages, Math.max(1, page));
    const rows = await this.db
      .select()
      .from(securityEvents)
      .where(eq(securityEvents.userId, userId))
      .orderBy(desc(securityEvents.createdAt), desc(securityEvents.id))
      .limit(20)
      .offset((p - 1) * 20);
    return {
      items: rows.map((r) => ({
        id: r.id,
        type: r.type as SecurityEventType,
        at: r.createdAt.toISOString(),
        ...(r.client ? { client: r.client } : {}),
      })),
      page: p,
      pages,
    };
  }

  // ---------- reset and invitations ----------

  /** A new reset link invalidates the previous ones for that user. */
  async resetLink(username: string, by: string): Promise<string> {
    const u = await this.byUsername(username);
    if (!u) throw new AuthError("not_found", 404);
    return this.db.transaction(async (tx) => {
      await tx
        .update(oneTimeTokens)
        .set({ usedAt: this.date() })
        .where(
          and(
            eq(oneTimeTokens.userId, u.id),
            eq(oneTimeTokens.kind, "password_reset"),
            isNull(oneTimeTokens.usedAt),
          ),
        );
      const token = await this.createToken(
        "password_reset",
        { userId: u.id, ttlMs: TTL.password_reset, createdBy: by },
        tx,
      );
      await tx.update(users).set({ adminResetAt: this.date() }).where(eq(users.id, u.id));
      await this.event(u.id, "admin_reset", undefined, tx);
      await this.audit(by, "reset_link_created", u.username, tx);
      return token;
    });
  }

  /**
   * "Forgot password" by email: a one-hour reset link for an active user, null otherwise (the route
   * answers the same either way). Unlike `resetLink`, it is not shown as an admin reset.
   */
  async forgotLink(email: string): Promise<{ token: string; user: User } | null> {
    const u = (
      await this.db
        .select()
        .from(users)
        .where(eq(users.emailKey, keyOf(email)))
    )[0];
    if (!u || u.status !== "active") return null;
    return this.db.transaction(async (tx) => {
      await tx
        .update(oneTimeTokens)
        .set({ usedAt: this.date() })
        .where(
          and(
            eq(oneTimeTokens.userId, u.id),
            eq(oneTimeTokens.kind, "password_reset"),
            isNull(oneTimeTokens.usedAt),
          ),
        );
      const token = await this.createToken(
        "password_reset",
        { userId: u.id, ttlMs: TTL.password_reset },
        tx,
      );
      return { token, user: u };
    });
  }

  async resetPassword(token: string, password: string, ctx: Ctx): Promise<User> {
    if (isWeakPassword(password)) throw new AuthError("password_weak", 400);
    const passwordHash = await hashPassword(password);
    return this.db.transaction(async (tx) => {
      const row = await this.findToken("password_reset", token, tx);
      await this.consumeToken(tx, row.id);
      const [u] = await tx
        .update(users)
        .set({ passwordHash, adminResetAt: null, updatedAt: this.date() })
        .where(eq(users.id, row.userId ?? ""))
        .returning();
      if (!u) throw new AuthError("token_invalid", 400);
      await this.revokeOtherSessions(u.id, null, tx);
      await this.event(u.id, "password_changed", ctx, tx);
      return u;
    });
  }

  /** `action`: "user_invited" when the link goes by email, "user_created" when the admin hands it over. */
  async invite(
    username: string,
    email: string,
    by: string,
    role: User["role"] = "user",
    action: "user_invited" | "user_created" = "user_invited",
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const u = await this.insertUser(
        { username, email, role, status: "invited", passwordHash: null },
        tx,
      );
      await this.audit(by, action, username, tx);
      return this.createToken(
        "invite",
        { userId: u.id, email, ttlMs: TTL.invite, createdBy: by },
        tx,
      );
    });
  }

  async inviteInfo(token: string): Promise<{ username: string; email: string }> {
    const row = await this.findToken("invite", token);
    const u = row.userId ? await this.byId(row.userId) : undefined;
    if (!u || u.status !== "invited") throw new AuthError("token_invalid", 400);
    return { username: u.username, email: u.email };
  }

  async acceptInvite(token: string, password: string, ctx: Ctx): Promise<User> {
    if (isWeakPassword(password)) throw new AuthError("password_weak", 400);
    const passwordHash = await hashPassword(password);
    return this.db.transaction(async (tx) => {
      const row = await this.findToken("invite", token, tx);
      await this.consumeToken(tx, row.id);
      const [u] = await tx
        .update(users)
        .set({ passwordHash, status: "active", updatedAt: this.date() })
        .where(and(eq(users.id, row.userId ?? ""), eq(users.status, "invited")))
        .returning();
      if (!u) throw new AuthError("token_invalid", 400);
      await this.event(u.id, "login", ctx, tx);
      return u;
    });
  }

  /** CLI: removes TOTP and signs the user out everywhere (whoever took the phone loses the session). */
  async resetTotp(username: string, by: string): Promise<void> {
    const u = await this.byUsername(username);
    if (!u) throw new AuthError("not_found", 404);
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
        .where(eq(users.id, u.id));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id));
      await this.revokeOtherSessions(u.id, null, tx);
      await this.event(u.id, "totp_disabled", undefined, tx);
      await this.audit(by, "totp_reset", u.username, tx);
    });
  }

  /** Expired challenges are dropped on every login: the map can't grow without bound. */
  pruneChallenges(): void {
    const t = this.now();
    for (const [id, ch] of this.challenges) if (ch.expiresAt <= t) this.challenges.delete(id);
  }
}

/** U-07: an admin must enable TOTP before doing anything else (enforced by the server too). */
export function needsTotpSetup(u: User): boolean {
  return u.role === "admin" && u.totpEnabledAt === null;
}
