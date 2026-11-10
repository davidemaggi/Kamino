import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { compactJournal, INACTIVE_DEVICE_MS } from "../src/jobs/compact.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { linkDevice, putFile, user, type TestDevice } from "./helpers/sync.js";

const DAY = 86_400_000;

describe.skipIf(dockerUnavailable)("journal compaction", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let a: TestDevice;
  let b: TestDevice;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`compact_${++n}`), { realtime: { listen: false } });
    const enroll = await user(t, "mario");
    a = await linkDevice(t, enroll);
    b = await linkDevice(t, enroll, a.vaultId, "iPhone");
    for (let i = 1; i <= 10; i++) await putFile(a, `n${i}.md`);
    await a.call("POST", `/vaults/${a.vaultId}/ack`, { seq: 8 });
    await b.call("POST", `/vaults/${a.vaultId}/ack`, { seq: 3 });
  });

  const seqs = async () =>
    (
      await t.db.$client<
        { seq: string }[]
      >`select seq from journal where vault_id = ${a.vaultId} order by seq`
    ).map((r) => Number(r.seq));
  const floor = async () =>
    Number(
      (
        await t.db.$client<
          { f: string }[]
        >`select journal_floor as f from vaults where id = ${a.vaultId}`
      )[0]!.f,
    );
  const setRetention = (days: number) =>
    t.db.$client`update vaults set retention_days = ${days} where id = ${a.vaultId}`;

  it("keeps everything the slowest active device still needs", async () => {
    await setRetention(0);
    expect(await compactJournal(t.db, t.clock.now)).toEqual({ vaults: 1, deleted: 3 });
    expect(await seqs()).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(await floor()).toBe(3);
    // Idempotent.
    expect((await compactJournal(t.db, t.clock.now)).deleted).toBe(0);
    // The REST contract follows the floor.
    const old = await b.call("GET", `/vaults/${a.vaultId}/changes?after=2`);
    expect(old.json().error.code).toBe("cursor_too_old");
    const ok = await b.call("GET", `/vaults/${a.vaultId}/changes?after=3`);
    expect(ok.json().entries.map((e: { seq: number }) => e.seq)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });

  it("devices idle for 90 days or revoked don't hold the journal", async () => {
    await setRetention(0);
    await t.db
      .$client`update devices set last_seen_at = ${new Date(t.clock.now - INACTIVE_DEVICE_MS - DAY).toISOString()}::timestamptz where id = ${b.deviceId}`;
    await compactJournal(t.db, t.clock.now);
    expect(await floor()).toBe(8);
    await t.db.$client`update devices set revoked_at = now() where id = ${a.deviceId}`;
    await compactJournal(t.db, t.clock.now);
    // No active device left: only retention limits compaction, up to the head.
    expect(await floor()).toBe(10);
    expect(await seqs()).toEqual([]);
  });

  it("history retention keeps recent entries even past every cursor", async () => {
    await setRetention(30);
    expect((await compactJournal(t.db, t.clock.now)).deleted).toBe(0);
    // 31 days later the same entries may go (still only up to the slowest cursor).
    expect((await compactJournal(t.db, t.clock.now + 31 * DAY)).deleted).toBe(3);
    expect(await floor()).toBe(3);
  });
});
