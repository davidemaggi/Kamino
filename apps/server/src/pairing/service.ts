import { PROTOCOL_ACTION } from "@kamino/brand";
import {
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_VERSION,
  type DevicePlatform,
  type PairingClaimRequest,
  type PairingClaimState,
  type PairingOffer,
  type PairingState,
} from "@kamino/protocol";
import { and, eq, gt, inArray, lt } from "drizzle-orm";
import { createHmac, randomInt } from "node:crypto";
import { hashToken, randomToken, uuidv7 } from "../auth/tokens.js";
import { hkdf, INFO } from "../crypto/kdf.js";
import type { Kek } from "../crypto/keyring.js";
import type { Db } from "../db/client.js";
import { pairings, users } from "../db/schema.js";
import type { Outbox } from "../email/outbox.js";
import { ApiError, notFound } from "../http/errors.js";
import type { Hub } from "../realtime/hub.js";
import type { Vault, VaultService } from "../vaults/service.js";

export const PAIRING_TTL_MS = 10 * 60_000;
/** No 0/O, 1/I: the code is read aloud or compared at a glance (03 §10). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type Pairing = typeof pairings.$inferSelect;
interface StoredRequest {
  deviceName: string;
  platform: DevicePlatform;
  pluginVersion: string;
  protocolVersion: number;
  code: string;
}

/** Who acts on a pairing: the signed-in owner (web) or one of the vault's devices. */
export type PairingActor = { userId: string; deviceVaultId?: string };

const closed = () => new ApiError("pairing_closed", 409);
const OPEN = ["waiting", "requested"] as const;

/** Rows are kept this long after their expiry, then swept. */
export const PAIRING_KEEP_MS = 24 * 3_600_000;

/** The key of `deviceTokenOf`, from the master key: the claim secret alone is not a credential. */
export function pairingKey(kek: Kek): Buffer {
  return hkdf(kek.key, INFO.pairing);
}

/**
 * The device token of a claim, derived (HMAC under a server key) from its secret: the server
 * stores only its hash, taken at claim time when the secret is known, and recomputes it when the
 * new device polls. It is handed out only within the flow's ten minutes.
 */
export function deviceTokenOf(key: Uint8Array, claimSecret: string): string {
  return createHmac("sha256", key)
    .update(`pairing-device-token\u0000${claimSecret}`)
    .digest("base64url");
}

/** Hourly (with the uploads' sweep): drops pairings a day past their expiry. */
export async function sweepPairings(db: Db, now: number): Promise<{ deleted: number }> {
  const r = await db
    .delete(pairings)
    .where(lt(pairings.expiresAt, new Date(now - PAIRING_KEEP_MS)))
    .returning({ id: pairings.id });
  return { deleted: r.length };
}

function verificationCode(): string {
  let out = "";
  for (let i = 0; i < 4; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/**
 * 03 §10 / F11: QR and magic-link pairing. A one-time link token (only its hash stored) lets a new
 * device claim the pairing; the origin approves after comparing the code; the new device polls
 * with its claim secret and receives its device token once. Ten minutes for the whole flow.
 */
export class PairingService {
  constructor(
    private readonly db: Db,
    private readonly vaults: VaultService,
    private readonly hub: Hub,
    private readonly outbox: Outbox,
    private readonly publicUrl: string,
    private readonly key: Uint8Array,
    private readonly now: () => number = Date.now,
    /** During a key rotation: a claim made before the restart derived its token with this key. */
    private readonly previousKey?: Uint8Array,
  ) {}

  private deviceTokenFor(p: { deviceTokenHash: string | null }, claimSecret: string): string {
    const t = deviceTokenOf(this.key, claimSecret);
    if (this.previousKey && hashToken(t) !== p.deviceTokenHash)
      return deviceTokenOf(this.previousKey, claimSecret);
    return t;
  }

  async offer(
    vault: Vault,
    origin: { userId: string; deviceId?: string },
    opts: { email: boolean },
  ): Promise<PairingOffer> {
    const token = randomToken();
    const id = uuidv7(this.now());
    const expiresAt = new Date(this.now() + PAIRING_TTL_MS);
    const server = this.publicUrl.replace(/\/+$/, "");
    const link = `obsidian://${PROTOCOL_ACTION}?server=${encodeURIComponent(server)}&token=${token}`;
    await this.db.transaction(async (tx) => {
      await tx.insert(pairings).values({
        id,
        vaultId: vault.id,
        userId: origin.userId,
        originDeviceId: origin.deviceId ?? null,
        tokenHash: hashToken(token),
        expiresAt,
        createdAt: new Date(this.now()),
      });
      if (opts.email) {
        const [u] = await tx.select().from(users).where(eq(users.id, origin.userId));
        // Inside the transaction: without SMTP (409) no pairing is left behind.
        await this.outbox.enqueue(
          u!.email,
          "pairing_link",
          u!.locale === "en" ? "en" : "it",
          { link },
          { tx, userId: origin.userId },
        );
      }
    });
    return { pairingId: id, link, expiresAt: expiresAt.toISOString() };
  }

  /** The pairing if `actor` may act on it; anything else is the same 404. */
  private async mine(pairingId: string, actor: PairingActor): Promise<Pairing> {
    if (!/^[0-9a-f-]{36}$/.test(pairingId)) throw notFound();
    const [p] = await this.db.select().from(pairings).where(eq(pairings.id, pairingId));
    if (!p || p.userId !== actor.userId) throw notFound();
    if (actor.deviceVaultId !== undefined && actor.deviceVaultId !== p.vaultId) throw notFound();
    return p;
  }

  private expired(p: Pairing): boolean {
    return p.expiresAt.getTime() <= this.now();
  }

  private view(p: Pairing): PairingState {
    const open = (OPEN as readonly string[]).includes(p.status);
    const status =
      open && this.expired(p)
        ? "expired"
        : p.status === "consumed"
          ? "approved"
          : (p.status as PairingState["status"]);
    const r = p.request as StoredRequest | null;
    return {
      status,
      ...(r
        ? {
            request: {
              deviceName: r.deviceName,
              platform: r.platform,
              pluginVersion: r.pluginVersion,
              code: r.code,
            },
          }
        : {}),
      ...(p.reusedAt ? { reused: true } : {}),
    };
  }

  async state(pairingId: string, actor: PairingActor): Promise<PairingState> {
    return this.view(await this.mine(pairingId, actor));
  }

  async claim(
    token: string,
    r: PairingClaimRequest,
  ): Promise<{
    claimId: string;
    claimSecret: string;
    verificationCode: string;
    expiresAt: string;
  }> {
    const [p] = await this.db
      .select()
      .from(pairings)
      .where(eq(pairings.tokenHash, hashToken(token)));
    if (!p) throw new ApiError("token_invalid", 400);
    if (p.status === "cancelled" || p.status === "denied" || this.expired(p))
      throw new ApiError("token_expired", 410);
    // A plugin that couldn't sync once approved must not be paired at all.
    if (r.protocolVersion < PROTOCOL_MIN_SUPPORTED || r.protocolVersion > PROTOCOL_VERSION)
      throw new ApiError("protocol_unsupported", 426);
    const claimId = uuidv7(this.now());
    const claimSecret = randomToken();
    const request: StoredRequest = {
      deviceName: r.deviceName,
      platform: r.platform,
      pluginVersion: r.pluginVersion,
      protocolVersion: r.protocolVersion,
      code: verificationCode(),
    };
    const won = await this.db
      .update(pairings)
      .set({
        status: "requested",
        claimId,
        claimSecretHash: hashToken(claimSecret),
        deviceTokenHash: hashToken(deviceTokenOf(this.key, claimSecret)),
        request,
      })
      .where(and(eq(pairings.id, p.id), eq(pairings.status, "waiting")))
      .returning({ id: pairings.id });
    if (won.length === 0) {
      // The link was already used: while the request awaits an answer the origin is told, so it
      // doesn't approve a stranger blindly. A flow already answered has nothing left to warn of.
      const marked = await this.db
        .update(pairings)
        .set({ reusedAt: new Date(this.now()) })
        .where(and(eq(pairings.id, p.id), eq(pairings.status, "requested")))
        .returning({ id: pairings.id });
      if (marked.length > 0)
        this.hub.sendToVault(p.vaultId, { type: "pairing_reused", pairingId: p.id });
      throw new ApiError("pairing_already_claimed", 409);
    }
    this.hub.sendToVault(p.vaultId, {
      type: "pairing_request",
      pairingId: p.id,
      deviceName: request.deviceName,
      platform: request.platform,
      pluginVersion: request.pluginVersion,
      code: request.code,
      expiresAt: p.expiresAt.toISOString(),
    });
    return {
      claimId,
      claimSecret,
      verificationCode: request.code,
      expiresAt: p.expiresAt.toISOString(),
    };
  }

  /** Moves an open, unexpired pairing from one of `from` to `to`; otherwise 409 `pairing_closed`. */
  private async close(
    p: Pairing,
    from: readonly Pairing["status"][],
    to: Pairing["status"],
  ): Promise<void> {
    const r = await this.db
      .update(pairings)
      .set({ status: to })
      .where(
        and(
          eq(pairings.id, p.id),
          inArray(pairings.status, [...from]),
          gt(pairings.expiresAt, new Date(this.now())),
        ),
      )
      .returning({ id: pairings.id });
    if (r.length === 0) throw closed();
    this.hub.sendToVault(p.vaultId, { type: "pairing_closed", pairingId: p.id });
  }

  /** The new device is created now, with the token hash taken at claim time. */
  async approve(pairingId: string, actor: PairingActor): Promise<PairingState> {
    const p = await this.mine(pairingId, actor);
    await this.db.transaction(async (tx) => {
      const r = await tx
        .update(pairings)
        .set({ status: "approved" })
        .where(
          and(
            eq(pairings.id, p.id),
            eq(pairings.status, "requested"),
            gt(pairings.expiresAt, new Date(this.now())),
          ),
        )
        .returning();
      const row = r[0];
      if (!row) throw closed();
      const req = row.request as StoredRequest;
      const d = await this.vaults.addDevice(
        tx,
        row.userId,
        row.vaultId,
        {
          name: req.deviceName,
          platform: req.platform,
          pluginVersion: req.pluginVersion,
          protocolVersion: req.protocolVersion,
        },
        undefined,
        row.deviceTokenHash!,
      );
      await tx.update(pairings).set({ deviceId: d.deviceId }).where(eq(pairings.id, p.id));
    });
    this.hub.sendToVault(p.vaultId, { type: "pairing_closed", pairingId: p.id });
    return this.state(pairingId, actor);
  }

  async deny(pairingId: string, actor: PairingActor): Promise<PairingState> {
    const p = await this.mine(pairingId, actor);
    await this.close(p, ["requested"], "denied");
    return this.state(pairingId, actor);
  }

  async cancel(pairingId: string, actor: PairingActor): Promise<PairingState> {
    const p = await this.mine(pairingId, actor);
    await this.close(p, OPEN, "cancelled");
    return this.state(pairingId, actor);
  }

  private async claimOf(claimId: string, claimSecret: string): Promise<Pairing> {
    if (!/^[0-9a-f-]{36}$/.test(claimId) || claimSecret === "") throw notFound();
    const [p] = await this.db
      .select()
      .from(pairings)
      .where(
        and(eq(pairings.claimId, claimId), eq(pairings.claimSecretHash, hashToken(claimSecret))),
      );
    if (!p) throw notFound();
    return p;
  }

  /**
   * The new device's polling. On approval the device token is handed out, and again on later
   * polls within the flow's ten minutes, so a lost answer is recovered; after that, "consumed".
   */
  async poll(claimId: string, claimSecret: string): Promise<PairingClaimState> {
    const p = await this.claimOf(claimId, claimSecret);
    switch (p.status) {
      case "requested":
        return { status: this.expired(p) ? "expired" : "pending" };
      case "denied":
        return { status: "denied" };
      case "approved":
      case "consumed": {
        if (this.expired(p)) return { status: "consumed" };
        if (p.status === "approved")
          await this.db
            .update(pairings)
            .set({ status: "consumed" })
            .where(and(eq(pairings.id, p.id), eq(pairings.status, "approved")));
        const vault = await this.vaults.byId(p.vaultId);
        const [u] = await this.db
          .select({ username: users.username })
          .from(users)
          .where(eq(users.id, p.userId));
        if (!vault || !u) return { status: "expired" };
        return {
          status: "approved",
          deviceId: p.deviceId!,
          deviceToken: this.deviceTokenFor(p, claimSecret),
          username: u.username,
          vault: { id: vault.id, name: this.vaults.nameOf(vault) },
        };
      }
      default:
        // Cancelled by either side, or never claimed (can't happen with a claim id).
        return { status: "expired" };
    }
  }

  /** The new device gives up while waiting: the origin's request disappears. */
  async withdraw(claimId: string, claimSecret: string): Promise<void> {
    const p = await this.claimOf(claimId, claimSecret);
    try {
      await this.close(p, ["requested"], "cancelled");
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      // Already closed (answered, expired): nothing left to withdraw.
    }
  }
}
