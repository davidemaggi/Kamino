import { and, count, eq, isNull } from "drizzle-orm";
import { generateDek, wrapDek } from "../crypto/dek.js";
import type { Kek } from "../crypto/keyring.js";
import type { Db } from "../db/client.js";
import { devices, files, oneTimeTokens, users, vaults } from "../db/schema.js";
import { AuthError } from "../auth/service.js";
import { hashToken, randomToken, uuidv7 } from "../auth/tokens.js";
import { VaultCrypto } from "./vault-crypto.js";

export const ENROLL_TTL_MS = 10 * 60_000;
export type Vault = typeof vaults.$inferSelect;

export class VaultService {
  private readonly crypto = new Map<string, VaultCrypto>();

  constructor(
    private readonly db: Db,
    private readonly kek: Kek,
    private readonly now: () => number = Date.now,
  ) {}

  cryptoOf(v: Vault): VaultCrypto {
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

  nameOf(v: Vault): string {
    return this.cryptoOf(v).dec("vaults", "name", v.id, v.nameEnc);
  }

  async create(ownerId: string, name: string): Promise<Vault> {
    const id = uuidv7();
    const dek = generateDek();
    const draft = { id, dekWrapped: wrapDek(this.kek, id, dek) } as Vault;
    const nameEnc = this.cryptoOf(draft).enc("vaults", "name", id, name);
    const [v] = await this.db
      .insert(vaults)
      .values({
        id,
        ownerId,
        nameEnc,
        dekWrapped: draft.dekWrapped,
        kekId: this.kek.id,
        createdAt: new Date(this.now()),
      })
      .returning();
    return v!;
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

  async linkDevice(
    userId: string,
    vaultId: string,
    d: {
      name: string;
      platform: (typeof devices.$inferInsert)["platform"];
      pluginVersion: string;
      protocolVersion: number;
    },
    ip: string | undefined,
  ) {
    const v = await this.byId(vaultId);
    if (!v || v.ownerId !== userId || v.status !== "active") throw new AuthError("not_found", 404);
    const token = randomToken();
    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ n: count() })
        .from(devices)
        .where(eq(devices.vaultId, vaultId));
      await tx.insert(devices).values({
        id,
        userId,
        vaultId,
        ...d,
        tokenHash: hashToken(token),
        isOrigin: (existing?.n ?? 0) === 0,
        lastIp: ip ?? null,
        lastSeenAt: new Date(this.now()),
        createdAt: new Date(this.now()),
      });
    });
    return { deviceId: id, deviceToken: token, vault: { id: v.id, name: this.nameOf(v) } };
  }
}
