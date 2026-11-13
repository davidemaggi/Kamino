import { and, count, eq, isNull } from "drizzle-orm";
import { generateDek, wrapDek } from "../crypto/dek.js";
import type { Kek } from "../crypto/keyring.js";
import type { Db } from "../db/client.js";
import { devices, files, oneTimeTokens, users, vaults } from "../db/schema.js";
import { AuthError } from "../auth/service.js";
import { hashToken, randomToken, uuidv7 } from "../auth/tokens.js";
import { notFound } from "../http/errors.js";
import { VaultCrypto } from "./vault-crypto.js";

export const ENROLL_TTL_MS = 10 * 60_000;
export type Vault = typeof vaults.$inferSelect;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface DeviceRequest {
  name: string;
  platform: (typeof devices.$inferInsert)["platform"];
  pluginVersion: string;
  protocolVersion: number;
}

export class VaultService {
  private readonly crypto = new Map<string, VaultCrypto>();

  constructor(
    private readonly db: Db,
    private readonly kek: Kek,
    private readonly now: () => number = Date.now,
  ) {}

  cryptoOf(v: Vault): VaultCrypto {
    if (!v.dekWrapped || v.status !== "active") {
      this.crypto.delete(v.id);
      throw notFound();
    }
    let c = this.crypto.get(v.id);
    if (!c) {
      c = new VaultCrypto(v.id, this.kek, v.dekWrapped);
      this.crypto.set(v.id, c);
    }
    return c;
  }

  async byId(id: string): Promise<Vault | undefined> {
    return (await this.db.select().from(vaults).where(eq(vaults.id, id)))[0];
  }

  /** Drops the cached keys of a deleted vault. */
  forget(vaultId: string): void {
    this.crypto.delete(vaultId);
  }

  nameOf(v: Vault): string {
    return this.cryptoOf(v).dec("vaults", "name", v.id, v.nameEnc);
  }

  async create(ownerId: string, name: string): Promise<Vault> {
    const id = uuidv7();
    const dek = generateDek();
    const draft = { id, status: "active", dekWrapped: wrapDek(this.kek, id, dek) } as Vault;
    const nameEnc = this.cryptoOf(draft).enc("vaults", "name", id, name);
    const [v] = await this.db
      .insert(vaults)
      .values({
        id,
        ownerId,
        nameEnc,
        dekWrapped: draft.dekWrapped!,
        kekId: this.kek.id,
        createdAt: new Date(this.now()),
      })
      .returning();
    return v!;
  }

  /** Rename and/or change the history retention; the name is re-encrypted. */
  async update(v: Vault, patch: { name?: string | undefined; retentionDays?: number | undefined }) {
    const set: Partial<typeof vaults.$inferInsert> = {};
    if (patch.name !== undefined)
      set.nameEnc = this.cryptoOf(v).enc("vaults", "name", v.id, patch.name);
    if (patch.retentionDays !== undefined) set.retentionDays = patch.retentionDays;
    if (Object.keys(set).length === 0) return v;
    const [row] = await this.db.update(vaults).set(set).where(eq(vaults.id, v.id)).returning();
    return row!;
  }

  async listForUser(ownerId: string): Promise<Vault[]> {
    return this.db
      .select()
      .from(vaults)
      .where(and(eq(vaults.ownerId, ownerId), eq(vaults.status, "active")));
  }

  async counts(vaultId: string): Promise<{ fileCount: number; deviceCount: number }> {
    const [f] = await this.db
      .select({ n: count() })
      .from(files)
      .where(and(eq(files.vaultId, vaultId), eq(files.deleted, false), eq(files.kind, "file")));
    const [d] = await this.db
      .select({ n: count() })
      .from(devices)
      .where(and(eq(devices.vaultId, vaultId), isNull(devices.revokedAt)));
    return { fileCount: f?.n ?? 0, deviceCount: d?.n ?? 0 };
  }

  // ---------- enrollment (C5) ----------

  async createEnrollToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomToken();
    const expiresAt = new Date(this.now() + ENROLL_TTL_MS);
    await this.db.insert(oneTimeTokens).values({
      id: uuidv7(),
      kind: "device_enrollment",
      tokenHash: hashToken(token),
      userId,
      expiresAt,
    });
    return { token, expiresAt };
  }

  /** The active user behind a valid enrollment token (reusable for 10 minutes). */
  async enrollUser(token: string): Promise<string> {
    const row = (
      await this.db
        .select({
          userId: oneTimeTokens.userId,
          expiresAt: oneTimeTokens.expiresAt,
          status: users.status,
        })
        .from(oneTimeTokens)
        .innerJoin(users, eq(users.id, oneTimeTokens.userId))
        .where(
          and(
            eq(oneTimeTokens.tokenHash, hashToken(token)),
            eq(oneTimeTokens.kind, "device_enrollment"),
          ),
        )
    )[0];
    if (!row?.userId || row.expiresAt.getTime() <= this.now())
      throw new AuthError("token_expired", 401);
    if (row.status !== "active") throw new AuthError("user_blocked", 403);
    return row.userId;
  }

  async linkDevice(userId: string, vaultId: string, d: DeviceRequest, ip: string | undefined) {
    const token = randomToken();
    const r = await this.addDevice(this.db, userId, vaultId, d, ip, hashToken(token));
    return { ...r, deviceToken: token };
  }

  /**
   * A device of `vaultId` whose token hashes to `tokenHash` (the token itself is never seen here:
   * pairing derives it from the claim secret). 404 unless `userId` owns the active vault.
   */
  async addDevice(
    db: Db | Tx,
    userId: string,
    vaultId: string,
    d: DeviceRequest,
    ip: string | undefined,
    tokenHash: string,
  ): Promise<{ deviceId: string; vault: { id: string; name: string } }> {
    const v = await this.byId(vaultId);
    if (!v || v.ownerId !== userId || v.status !== "active") throw new AuthError("not_found", 404);
    const id = uuidv7();
    const insert = async (tx: Db | Tx) => {
      const [existing] = await tx
        .select({ n: count() })
        .from(devices)
        .where(eq(devices.vaultId, vaultId));
      await tx.insert(devices).values({
        id,
        userId,
        vaultId,
        ...d,
        tokenHash,
        isOrigin: (existing?.n ?? 0) === 0,
        lastIp: ip ?? null,
        lastSeenAt: new Date(this.now()),
        createdAt: new Date(this.now()),
      });
    };
    if (db === this.db) await this.db.transaction(insert);
    else await insert(db);
    return { deviceId: id, vault: { id: v.id, name: this.nameOf(v) } };
  }
}
