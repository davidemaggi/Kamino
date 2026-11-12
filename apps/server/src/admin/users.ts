import type { AdminUser, CreateUserRequest, UpdateUserRequest } from "@kamino/protocol";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { AuthService, User } from "../auth/service.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import type { Outbox } from "../email/outbox.js";
import { ApiError, notFound } from "../http/errors.js";
import type { Hub } from "../realtime/hub.js";
import type { SystemConfigService } from "../system/config.js";
import { userStats, type UserStats } from "./stats.js";

export const lastAdmin = () => new ApiError("last_admin", 409);
/** Acting on a user being deleted (or on yourself) is refused like the web app expects. */
const refused = (status: number) => new ApiError("forbidden", status);
const localeOf = (u: User) => (u.locale === "en" ? "en" : "it");
const bytes = (n: number | null) => (n === null ? "none" : String(n));

function statusOf(u: User): AdminUser["status"] {
  if (u.status === "pending_deletion" || u.deletionScheduledAt !== null) return "deleting";
  if (u.status === "blocked") return "blocked";
  if (u.status === "invited") return "invited";
  return "active";
}

function dto(u: User, s: UserStats, defaultQuota: number | null): AdminUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
    status: statusOf(u),
    totpEnabled: u.totpEnabledAt !== null,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: s.lastLoginAt?.toISOString() ?? null,
    // The limit that applies: the user's own, else the system default (Q-01).
    quotaBytes: u.quotaBytes ?? defaultQuota,
    usedBytes: s.usedBytes,
    vaultCount: s.vaultCount,
    deviceCount: s.deviceCount,
    syncLevel: s.syncLevel,
    deletionAt: u.deletionScheduledAt?.toISOString() ?? null,
  };
}

/**
 * U-03, U-10: user management. Only aggregates leave this class; the admin never sets a password
 * (invitation or reset link) and has no way into the users' vaults.
 */
export class AdminUsers {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly hub: Hub,
    private readonly config: SystemConfigService,
    private readonly outbox: Outbox,
    private readonly publicUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  private async dtos(rows: User[]): Promise<AdminUser[]> {
    const stats = await userStats(
      this.db,
      rows.map((u) => u.id),
    );
    const { defaultQuotaBytes } = await this.config.effective();
    return rows.map((u) => dto(u, stats.get(u.id)!, defaultQuotaBytes));
  }

  private async find(id: string): Promise<User> {
    const [u] = await this.db
      .select()
      .from(users)
      .where(and(sql`${users.id}::text = ${id}`, ne(users.status, "deleted")));
    if (!u) throw notFound();
    return u;
  }

  async list(): Promise<AdminUser[]> {
    const rows = await this.db
      .select()
      .from(users)
      .where(ne(users.status, "deleted"))
      .orderBy(asc(users.usernameKey));
    return this.dtos(rows);
  }

  async get(id: string): Promise<AdminUser> {
    return (await this.dtos([await this.find(id)]))[0]!;
  }

  async create(
    by: User,
    req: CreateUserRequest,
  ): Promise<{ user: AdminUser; link: string | null }> {
    const byEmail = req.delivery === "email";
    if (byEmail && !(await this.config.smtp())) throw new ApiError("smtp_not_configured", 409);
    const token = await this.auth.invite(
      req.username,
      req.email,
      by.username,
      req.role,
      byEmail ? "user_invited" : "user_created",
    );
    const link = `${this.publicUrl}/invite/${token}`;
    // The invitation is written in the language of whoever invites (the new user has none yet).
    if (byEmail)
      await this.outbox.enqueue(req.email, "invite", localeOf(by), {
        username: req.username,
        link,
      });
    const u = (await this.auth.byUsername(req.username))!;
    return { user: await this.get(u.id), link: byEmail ? null : link };
  }

  async update(by: User, id: string, req: UpdateUserRequest): Promise<AdminUser> {
    await this.db.transaction(async (tx) => {
      // Serializes role changes: two admins demoting each other can't both succeed.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('admin-roles'))`);
      const [u] = await tx
        .select()
        .from(users)
        .where(and(sql`${users.id}::text = ${id}`, ne(users.status, "deleted")));
      if (!u) throw notFound();
      if (req.role !== undefined && req.role !== u.role) {
        if (req.role === "user") {
          const others = await tx
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                eq(users.role, "admin"),
                eq(users.status, "active"),
                isNull(users.deletionScheduledAt),
                ne(users.id, u.id),
              ),
            );
          if (others.length === 0) throw lastAdmin();
        }
        await tx.update(users).set({ role: req.role }).where(eq(users.id, u.id));
        await this.auth.audit(
          by.username,
          "role_changed",
          `${u.username}: ${u.role} → ${req.role}`,
          tx,
        );
      }
      if (req.quotaBytes !== undefined && req.quotaBytes !== u.quotaBytes) {
        // Lowering a quota below the usage deletes nothing (Q-03): only new uploads are refused.
        await tx.update(users).set({ quotaBytes: req.quotaBytes }).where(eq(users.id, u.id));
        await this.auth.audit(
          by.username,
          "quota_changed",
          `${u.username}: ${bytes(u.quotaBytes)} → ${bytes(req.quotaBytes)}`,
          tx,
        );
      }
    });
    return this.get(id);
  }

  /** U-08: sessions end, sockets close and device tokens are refused until unblocked. */
  async block(by: User, id: string): Promise<AdminUser> {
    const u = await this.guarded(by, id);
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ status: "blocked", updatedAt: new Date(this.now()) })
        .where(eq(users.id, u.id));
      await this.auth.revokeOtherSessions(u.id, null, tx);
      await this.auth.audit(by.username, "user_blocked", u.username, tx);
    });
    this.hub.closeUser(u.id, { type: "error", code: "user_blocked", message: "user_blocked" });
    return this.get(id);
  }

  /** Back to where the user was: invited if they never set a password, active otherwise. */
  async unblock(by: User, id: string): Promise<AdminUser> {
    const u = await this.guarded(by, id);
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          status: u.passwordHash === null ? "invited" : "active",
          updatedAt: new Date(this.now()),
        })
        .where(eq(users.id, u.id));
      await this.auth.audit(by.username, "user_unblocked", u.username, tx);
    });
    return this.get(id);
  }

  /** U-09: always visible to the user (account page, security log, and by email when possible). */
  async resetLink(by: User, id: string): Promise<{ link: string }> {
    const u = await this.find(id);
    if (statusOf(u) === "deleting") throw refused(409);
    const token = await this.auth.resetLink(u.username, by.username);
    if (await this.config.smtp())
      await this.outbox.enqueue(u.email, "admin_reset", localeOf(u), { username: u.username });
    return { link: `${this.publicUrl}/reset/${token}` };
  }

  private async guarded(by: User, id: string): Promise<User> {
    const u = await this.find(id);
    if (u.id === by.id) throw refused(403);
    if (statusOf(u) === "deleting") throw refused(409);
    return u;
  }
}
