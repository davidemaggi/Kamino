import type {
  ForcedForDevice,
  ForceSyncRequest,
  ForceSyncRole,
  ForceSyncState,
} from "@kamino/protocol";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "../auth/tokens.js";
import type { Db } from "../db/client.js";
import { devices, forceSyncs, forceSyncTargets, journal, vaults } from "../db/schema.js";
import { ApiError, notFound } from "../http/errors.js";
import { NOTIFY_CHANNEL } from "../sync/commit.js";
import type { Tx, VaultService } from "../vaults/service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type DeviceRef = { id: string; vaultId: string };

/** Journal entries addressed to one device (`deviceId`), about a request (`fileId`). */
export const FORCE_ENTRY_TYPES = ["force_push", "realign"] as const;

/**
 * Forced sync (ADR-0019). The request goes to the source as a `force_push` journal entry; when the
 * source reports done, each target gets a `realign` entry. One request per vault: a new one
 * replaces the previous, finished or not.
 */
export class ForceSyncService {
  constructor(
    private readonly db: Db,
    private readonly vaults: VaultService,
    private readonly now: () => number = Date.now,
  ) {}

  async request(vaultId: string, r: ForceSyncRequest): Promise<ForceSyncState> {
    const ids = [r.sourceDeviceId, ...r.targetDeviceIds];
    const vault = await this.vaults.byId(vaultId);
    if (!vault || vault.status !== "active") throw notFound();
    const vc = this.vaults.cryptoOf(vault);
    await this.db.transaction(async (tx) => {
      const live = await tx
        .select({ id: devices.id })
        .from(devices)
        .where(
          and(eq(devices.vaultId, vaultId), inArray(devices.id, ids), isNull(devices.revokedAt)),
        );
      if (new Set(live.map((d) => d.id)).size !== new Set(ids).size)
        throw new ApiError("invalid_request", 400);
      await tx.delete(forceSyncs).where(eq(forceSyncs.vaultId, vaultId));
      const id = uuidv7(this.now());
      await tx.insert(forceSyncs).values({
        id,
        vaultId,
        sourceDeviceId: r.sourceDeviceId,
        createdAt: new Date(this.now()),
      });
      await tx
        .insert(forceSyncTargets)
        .values([...new Set(r.targetDeviceIds)].map((deviceId) => ({ forceSyncId: id, deviceId })));
      await this.entries(tx, vc, vaultId, "force_push", id, [r.sourceDeviceId]);
    });
    return this.state(vaultId);
  }

  /** The vault's current request, for the web app. */
  async state(vaultId: string): Promise<ForceSyncState> {
    const [f] = await this.db.select().from(forceSyncs).where(eq(forceSyncs.vaultId, vaultId));
    if (!f) return null;
    const targets = await this.db
      .select({
        id: forceSyncTargets.deviceId,
        doneAt: forceSyncTargets.doneAt,
        name: devices.name,
      })
      .from(forceSyncTargets)
      .innerJoin(devices, eq(devices.id, forceSyncTargets.deviceId))
      .where(eq(forceSyncTargets.forceSyncId, f.id))
      .orderBy(devices.name);
    const [src] = await this.db
      .select({ name: devices.name })
      .from(devices)
      .where(eq(devices.id, f.sourceDeviceId));
    return {
      id: f.id,
      createdAt: f.createdAt.toISOString(),
      source: { id: f.sourceDeviceId, name: src?.name ?? "—", done: f.sourceDoneAt !== null },
      targets: targets.map((t) => ({ id: t.id, name: t.name, done: t.doneAt !== null })),
    };
  }

  /** What this device has to do, asked before each cycle. */
  async pendingFor(d: DeviceRef): Promise<ForcedForDevice> {
    const [f] = await this.db.select().from(forceSyncs).where(eq(forceSyncs.vaultId, d.vaultId));
    if (!f) return null;
    if (f.sourceDeviceId === d.id)
      return f.sourceDoneAt ? null : { requestId: f.id, role: "source" };
    if (!f.sourceDoneAt) return null;
    const [t] = await this.db
      .select({ doneAt: forceSyncTargets.doneAt })
      .from(forceSyncTargets)
      .where(and(eq(forceSyncTargets.forceSyncId, f.id), eq(forceSyncTargets.deviceId, d.id)));
    return t && !t.doneAt ? { requestId: f.id, role: "target" } : null;
  }

  /** Idempotent. A request replaced meanwhile is simply gone: nothing to do. */
  async done(d: DeviceRef, requestId: string, role: ForceSyncRole): Promise<void> {
    if (!UUID.test(requestId)) return;
    const vault = await this.vaults.byId(d.vaultId);
    if (!vault || vault.status !== "active") throw notFound();
    const vc = this.vaults.cryptoOf(vault);
    await this.db.transaction(async (tx) => {
      const [f] = await tx
        .select()
        .from(forceSyncs)
        .where(and(eq(forceSyncs.id, requestId), eq(forceSyncs.vaultId, d.vaultId)))
        .for("update");
      if (!f) return;
      const at = new Date(this.now());
      if (role === "target") {
        await tx
          .update(forceSyncTargets)
          .set({ doneAt: at })
          .where(
            and(
              eq(forceSyncTargets.forceSyncId, f.id),
              eq(forceSyncTargets.deviceId, d.id),
              isNull(forceSyncTargets.doneAt),
            ),
          );
        return;
      }
      if (f.sourceDeviceId !== d.id || f.sourceDoneAt) return;
      await tx.update(forceSyncs).set({ sourceDoneAt: at }).where(eq(forceSyncs.id, f.id));
      const targets = await tx
        .select({ id: forceSyncTargets.deviceId })
        .from(forceSyncTargets)
        .where(eq(forceSyncTargets.forceSyncId, f.id));
      await this.entries(
        tx,
        vc,
        d.vaultId,
        "realign",
        f.id,
        targets.map((t) => t.id),
      );
    });
  }

  /** Same lock and sequence as commits: each entry gets the next seq. */
  private async entries(
    tx: Tx,
    vc: ReturnType<VaultService["cryptoOf"]>,
    vaultId: string,
    type: (typeof FORCE_ENTRY_TYPES)[number],
    requestId: string,
    to: string[],
  ): Promise<void> {
    if (to.length === 0) return;
    const [locked] = await tx
      .select({ head: vaults.headSeq })
      .from(vaults)
      .where(eq(vaults.id, vaultId))
      .for("update");
    let seq = locked?.head ?? 0;
    for (const deviceId of to) {
      seq++;
      await tx.insert(journal).values({
        vaultId,
        seq,
        type,
        fileId: requestId,
        kind: "file",
        pathEnc: vc.enc("journal", "path", `${vaultId}:${seq}`, requestId),
        deviceId,
        at: new Date(this.now()),
      });
    }
    await tx.update(vaults).set({ headSeq: seq }).where(eq(vaults.id, vaultId));
    await tx.execute(sql`select pg_notify(${NOTIFY_CHANNEL}, ${`${vaultId}:${seq}`})`);
  }
}
