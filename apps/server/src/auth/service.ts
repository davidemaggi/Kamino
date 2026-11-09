import type { Me, SecurityEventType, SessionInfo } from "@kamino/protocol";
import { and, count, desc, eq, gt, isNull, ne } from "drizzle-orm";
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
const TTL: Record<"password_reset" | "invite" | "activation", number> = {
  password_reset: 3_600_000,
  invite: 7 * DAY,
  activation: 7 * DAY,
};

/** Uniqueness keys for usernames and emails (no citext). */
export const keyOf = (s: string) => s.trim().normalize("NFC").toLowerCase();

export class AuthService {
  private readonly totpKey: Buffer;
  private readonly challenges = new Map<string, { userId: string; expiresAt: number }>();

  constructor(
    private readonly db: Db,
    kek: Kek,
    private readonly issuer: string,
    private readonly now: () => number = Date.now,
  ) {
    this.totpKey = systemKey(kek);
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
      totpSetupRequired: u.role === "admin" && u.totpEnabledAt === null,
      adminResetAt: u.adminResetAt?.toISOString() ?? null,
    };
  }

  private async event(userId: string, type: SecurityEventType, ctx?: Ctx): Promise<void> {
    await this.db.insert(securityEvents).values({
      id: uuidv7(),
      userId,
      type,
      ip: ctx?.ip ?? null,
      client: ctx ? describeClient(ctx.userAgent) : null,
    });
  }

  async audit(actor: string, action: string, target: string | null): Promise<void> {
    await this.db.insert(auditLog).values({ id: uuidv7(), actor, action, target });
  }

  // ---------- one-time tokens ----------

  async createToken(
    kind: (typeof oneTimeTokens.$inferInsert)["kind"],
    opts: { userId?: string; email?: string; ttlMs: number; createdBy?: string },
  ): Promise<string> {
    const token = randomToken();
    await this.db.insert(oneTimeTokens).values({
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

  private async findToken(kind: (typeof oneTimeTokens.$inferInsert)["kind"], token: string) {
    const row = (
      await this.db
        .select()
        .from(oneTimeTokens)
        .where(and(eq(oneTimeTokens.tokenHash, hashToken(token)), eq(oneTimeTokens.kind, kind)))
    )[0];
    if (!row || row.usedAt) throw new AuthError("token_invalid", 400);
    if (row.expiresAt.getTime() <= this.now()) throw new AuthError("token_expired", 400);
    return row;
  }

  // ---------- setup ----------

  /** Called at startup: when there are no users, a fresh setup token to print once in the logs. */
  async ensureSetupToken(): Promise<string | null> {
    if ((await this.userCount()) > 0) return null;
    await this.db.delete(oneTimeTokens).where(eq(oneTimeTokens.kind, "setup"));
    return this.createToken("setup", { ttlMs: 365 * DAY });
  }

  async setup(
    input: { token: string; username: string; email: string; password: string },
    ctx: Ctx,
  ): Promise<User> {
    if ((await this.userCount()) > 0) throw new AuthError("setup_not_needed", 409);
    const row = await this.findToken("setup", input.token).catch(() => {
      throw new AuthError("setup_token_invalid", 403);
    });
    if (isWeakPassword(input.password)) throw new AuthError("password_weak", 400);
    const user = await this.insertUser({
      username: input.username,
      email: input.email,
      role: "admin",
      status: "active",
      passwordHash: await hashPassword(input.password),
    });
    await this.db
      .update(oneTimeTokens)
      .set({ usedAt: new Date(this.now()) })
      .where(eq(oneTimeTokens.id, row.id));
    await this.audit(user.username, "setup", user.username);
    await this.event(user.id, "login", ctx);
    return user;
  }

  async insertUser(v: {
    username: string;
    email: string;
    role: "user" | "admin";
    status: User["status"];
    passwordHash: string | null;
  }): Promise<User> {
    const [u] = await this.db
      .insert(users)
      .values({ id: uuidv7(), ...v, usernameKey: keyOf(v.username), emailKey: keyOf(v.email) })
      .returning();
    return u!;
  }

  // ---------- login ----------

  async login(
    username: string,
    password: string,
    ctx: Ctx,
  ): Promise<{ status: "ok"; user: User } | { status: "totp_required"; challengeId: string }> {
    const u = await this.byUsername(username);
    const ok = await verifyPassword(u?.passwordHash ?? null, password);
    if (!u || !ok) {
      if (u) await this.event(u.id, "login_failed", ctx);
      throw new AuthError("invalid_credentials", 401);
    }
    if (u.status !== "active") throw new AuthError("user_blocked", 403);
    if (u.totpEnabledAt) {
      const challengeId = randomToken();
      this.challenges.set(challengeId, { userId: u.id, expiresAt: this.now() + CHALLENGE_MS });
      return { status: "totp_required", challengeId };
    }
    await this.event(u.id, "login", ctx);
    return { status: "ok", user: u };
  }

  /** TOTP code or a recovery code (consumed). The challenge is single-use. */
  async loginTotp(challengeId: string, code: string, ctx: Ctx): Promise<User> {
    const ch = this.challenges.get(challengeId);
    if (!ch || ch.expiresAt <= this.now()) throw new AuthError("challenge_expired", 401);
    const u = await this.byId(ch.userId);
    if (!u || u.status !== "active") throw new AuthError("user_blocked", 403);
    if (!(await this.checkSecondFactor(u, code))) {
      await this.event(u.id, "login_failed", ctx);
      throw new AuthError("totp_invalid", 401);
    }
    this.challenges.delete(challengeId);
    await this.event(u.id, "login", ctx);
    return u;
  }

  private async checkSecondFactor(u: User, code: string): Promise<boolean> {
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed) && u.totpSecret) {
      const secret = decryptField(
        this.totpKey,
        { table: "users", column: "totp_secret", rowId: u.id },
        u.totpSecret,
      ).toString();
      const step = verifyTotp(secret, trimmed, this.now(), u.totpLastStep);
      if (step === null) return false;
      await this.db.update(users).set({ totpLastStep: step }).where(eq(users.id, u.id));
      return true;
    }
    const codes = await this.db
      .select()
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, u.id), isNull(recoveryCodes.usedAt)));
    for (const rc of codes) {
      if (await verifyPassword(rc.codeHash, trimmed.toUpperCase())) {
        await this.db
          .update(recoveryCodes)
          .set({ usedAt: new Date(this.now()) })
          .where(eq(recoveryCodes.id, rc.id));
        return true;
      }
    }
    return false;
  }

  // ---------- sessions ----------

  async createSession(userId: string, ctx: Ctx): Promise<string> {
    const token = randomToken();
    await this.db.insert(webSessions).values({
      id: uuidv7(),
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(this.now() + SESSION_ABSOLUTE_MS),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return token;
  }

  /** Valid session → its user; idle (14 d), absolute (90 d) or revoked → null. */
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
      .set({ revokedAt: new Date(this.now()) })
      .where(and(eq(webSessions.id, sessionId), eq(webSessions.userId, userId)));
  }

  async revokeOtherSessions(userId: string, keep: string | null): Promise<void> {
    const cond = keep
      ? and(eq(webSessions.userId, userId), ne(webSessions.id, keep), isNull(webSessions.revokedAt))
      : and(eq(webSessions.userId, userId), isNull(webSessions.revokedAt));
    await this.db
      .update(webSessions)
      .set({ revokedAt: new Date(this.now()) })
      .where(cond);
  }

  async listSessions(userId: string, current: string): Promise<SessionInfo[]> {
    const t = new Date(this.now());
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
    const set: Partial<typeof users.$inferInsert> = { updatedAt: new Date(this.now()) };
    if (patch.email !== undefined)
      Object.assign(set, { email: patch.email, emailKey: keyOf(patch.email) });
    if (patch.lang !== undefined) set.locale = patch.lang;
    if (patch.theme !== undefined) set.theme = patch.theme;
    const [row] = await this.db.update(users).set(set).where(eq(users.id, u.id)).returning();
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
    await this.db
      .update(users)
      .set({
        passwordHash: await hashPassword(next),
        adminResetAt: null,
        updatedAt: new Date(this.now()),
      })
      .where(eq(users.id, u.id));
    await this.revokeOtherSessions(u.id, sessionId);
    await this.event(u.id, "password_changed", ctx);
  }

  async totpSetup(u: User): Promise<{ secret: string; otpauthUrl: string }> {
    const secret = generateTotpSecret();
    const sealed = encryptField(
      this.totpKey,
      { table: "users", column: "totp_secret", rowId: u.id },
      secret,
    );
    // Pending until confirmed: an enabled TOTP is never replaced here.
    if (u.totpEnabledAt) throw new AuthError("forbidden", 409);
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
    await this.db
      .update(users)
      .set({ totpEnabledAt: new Date(this.now()), totpLastStep: step })
      .where(eq(users.id, u.id));
    await this.event(u.id, "totp_enabled", ctx);
    return this.newRecoveryCodes(u.id);
  }

  async totpDisable(u: User, password: string, ctx: Ctx): Promise<void> {
    if (u.role === "admin") throw new AuthError("totp_mandatory", 403);
    if (!(await verifyPassword(u.passwordHash, password)))
      throw new AuthError("password_wrong", 400);
    await this.db
      .update(users)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
      .where(eq(users.id, u.id));
    await this.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id));
    await this.event(u.id, "totp_disabled", ctx);
  }

  async regenerateRecoveryCodes(u: User, password: string): Promise<string[]> {
    if (!(await verifyPassword(u.passwordHash, password)))
      throw new AuthError("password_wrong", 400);
    if (!u.totpEnabledAt) throw new AuthError("forbidden", 409);
    return this.newRecoveryCodes(u.id);
  }

  private async newRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: 10 }, recoveryCode);
    await this.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
    const hashed = await Promise.all(codes.map((c) => hashPassword(c)));
    await this.db
      .insert(recoveryCodes)
      .values(hashed.map((codeHash) => ({ id: uuidv7(), userId, codeHash })));
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

  async resetLink(username: string, by: string): Promise<string> {
    const u = await this.byUsername(username);
    if (!u) throw new AuthError("not_found", 404);
    const token = await this.createToken("password_reset", {
      userId: u.id,
      ttlMs: TTL.password_reset,
      createdBy: by,
    });
    await this.db
      .update(users)
      .set({ adminResetAt: new Date(this.now()) })
      .where(eq(users.id, u.id));
    await this.event(u.id, "admin_reset");
    await this.audit(by, "reset_link_created", u.username);
    return token;
  }

  async resetPassword(token: string, password: string, ctx: Ctx): Promise<User> {
    const row = await this.findToken("password_reset", token);
    if (isWeakPassword(password)) throw new AuthError("password_weak", 400);
    const u = row.userId ? await this.byId(row.userId) : undefined;
    if (!u) throw new AuthError("token_invalid", 400);
    await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(password), adminResetAt: null })
      .where(eq(users.id, u.id));
    await this.db
      .update(oneTimeTokens)
      .set({ usedAt: new Date(this.now()) })
      .where(eq(oneTimeTokens.id, row.id));
    await this.revokeOtherSessions(u.id, null);
    await this.event(u.id, "password_changed", ctx);
    return u;
  }

  async invite(username: string, email: string, by: string): Promise<string> {
    const u = await this.insertUser({
      username,
      email,
      role: "user",
      status: "invited",
      passwordHash: null,
    });
    await this.audit(by, "user_invited", username);
    return this.createToken("invite", { userId: u.id, email, ttlMs: TTL.invite, createdBy: by });
  }

  async inviteInfo(token: string): Promise<{ username: string; email: string }> {
    const row = await this.findToken("invite", token);
    const u = row.userId ? await this.byId(row.userId) : undefined;
    if (!u) throw new AuthError("token_invalid", 400);
    return { username: u.username, email: u.email };
  }

  async acceptInvite(token: string, password: string, ctx: Ctx): Promise<User> {
    const row = await this.findToken("invite", token);
    if (isWeakPassword(password)) throw new AuthError("password_weak", 400);
    const [u] = await this.db
      .update(users)
      .set({ passwordHash: await hashPassword(password), status: "active" })
      .where(and(eq(users.id, row.userId ?? ""), eq(users.status, "invited")))
      .returning();
    if (!u) throw new AuthError("token_invalid", 400);
    await this.db
      .update(oneTimeTokens)
      .set({ usedAt: new Date(this.now()) })
      .where(eq(oneTimeTokens.id, row.id));
    await this.event(u.id, "login", ctx);
    return u;
  }

  async resetTotp(username: string, by: string): Promise<void> {
    const u = await this.byUsername(username);
    if (!u) throw new AuthError("not_found", 404);
    await this.db
      .update(users)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null })
      .where(eq(users.id, u.id));
    await this.db.delete(recoveryCodes).where(eq(recoveryCodes.userId, u.id));
    await this.event(u.id, "totp_disabled");
    await this.audit(by, "totp_reset", u.username);
  }

  /** Test hook: the number of pending challenges never grows unbounded. */
  pruneChallenges(): void {
    const t = this.now();
    for (const [id, ch] of this.challenges) if (ch.expiresAt <= t) this.challenges.delete(id);
  }
}
