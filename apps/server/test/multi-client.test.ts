import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compactJournal, INACTIVE_DEVICE_MS } from "../src/jobs/compact.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { ProtocolClient } from "./helpers/protocol-client.js";
import { linkDevice, uploadContent, user } from "./helpers/sync.js";

// Fixed seed by default, so the coverage checks below are stable in CI; MULTI_SEED explores.
const RUNS = Number(process.env["MULTI_RUNS"] ?? 40);
const SEED = Number(process.env["MULTI_SEED"] ?? 20261110);
const PATHS = ["a.md", "b.md", "c.md", "d/e.md"];

type Step =
  | { kind: "put"; client: number; path: number }
  | { kind: "edit"; client: number; pick: number; stale: boolean }
  | { kind: "move"; client: number; pick: number; path: number }
  | { kind: "delete"; client: number; pick: number }
  | { kind: "repeat"; client: number }
  | { kind: "drop" | "connect" | "pull" | "away"; client: number }
  | { kind: "compact" };

const client = fc.nat(2);
const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant("put" as const), client, path: fc.nat(3) }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("edit" as const),
      client,
      pick: fc.nat(),
      stale: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("move" as const),
      client,
      pick: fc.nat(),
      path: fc.nat(3),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ kind: fc.constant("delete" as const), client, pick: fc.nat() }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("repeat" as const), client }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constantFrom(
        "drop" as const,
        "connect" as const,
        "connect" as const,
        "pull" as const,
        "pull" as const,
        "away" as const,
      ),
      client,
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("compact" as const) }) },
);

describe.skipIf(dockerUnavailable)("multi-client protocol convergence", () => {
  let pg: TestPostgres;
  let n = 0;
  const total = { pushes: 0, pulls: 0, snapshots: 0, compactions: 0 };
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());

  async function scenario(steps: Step[]): Promise<void> {
    const t: TestApp = await testApp(await pg.createDatabase(`multi_${++n}`));
    try {
      const enroll = await user(t, "mario");
      const first = await linkDevice(t, enroll, undefined, "c0");
      const devices = [
        first,
        await linkDevice(t, enroll, first.vaultId, "c1"),
        await linkDevice(t, enroll, first.vaultId, "c2"),
      ];
      const vault = first.vaultId;
      await t.db.$client`update vaults set retention_days = 0 where id = ${vault}`;
      const clients = devices.map((d, i) => new ProtocolClient(t, d, `c${i}`));
      const last: (object | undefined)[] = [undefined, undefined, undefined];
      let counter = 0;

      const commit = async (c: ProtocolClient, i: number, op: object) => {
        last[i] = op;
        const r = await c.device.call("POST", `/vaults/${vault}/commits`, { ops: [op] });
        c.check(r.statusCode, "commit");
      };
      const known = (c: ProtocolClient, pick: number) => {
        const ids = [...c.state.keys()].sort();
        return ids.length ? ids[pick % ids.length]! : undefined;
      };

      for (const s of steps) {
        if (s.kind === "compact") {
          if ((await compactJournal(t.db, t.clock.now)).deleted > 0) total.compactions++;
          continue;
        }
        const c = clients[s.client]!;
        const id = `${++counter}`;
        switch (s.kind) {
          case "put": {
            const content = Buffer.from(`new ${id}`);
            const contentHash = await uploadContent(c.device, content);
            await commit(c, s.client, {
              type: "put",
              opId: `o${id}`,
              fileId: `f${id}`,
              versionId: `v${id}`,
              path: PATHS[s.path]!,
              baseVersionId: null,
              contentHash,
              size: content.length,
              mtime: counter,
            });
            break;
          }
          case "edit": {
            const fileId = known(c, s.pick);
            if (!fileId) break;
            const f = c.state.get(fileId)!;
            const content = Buffer.from(`edit ${id}`);
            const contentHash = await uploadContent(c.device, content);
            await commit(c, s.client, {
              type: "put",
              opId: `o${id}`,
              fileId,
              versionId: `v${id}`,
              path: f.path,
              baseVersionId: s.stale ? "stale-base" : f.versionId,
              contentHash,
              size: content.length,
              mtime: counter,
            });
            break;
          }
          case "move": {
            const fileId = known(c, s.pick);
            if (!fileId) break;
            await commit(c, s.client, {
              type: "move",
              opId: `o${id}`,
              fileId,
              baseVersionId: c.state.get(fileId)!.versionId,
              path: `moved/${PATHS[s.path]}`,
            });
            break;
          }
          case "delete": {
            const fileId = known(c, s.pick);
            if (!fileId) break;
            await commit(c, s.client, {
              type: "delete",
              opId: `o${id}`,
              fileId,
              baseVersionId: c.state.get(fileId)!.versionId,
            });
            break;
          }
          case "repeat":
            // The response was lost: the same op again (same opId).
            if (last[s.client]) await commit(c, s.client, last[s.client]!);
            break;
          case "drop":
            c.drop();
            break;
          case "connect":
            await c.connect();
            break;
          case "pull":
            await c.pull();
            break;
          case "away":
            // Away for months while the others go on: it no longer holds the journal back, and
            // the nightly compaction runs before it comes back.
            if (!c.connected) {
              await t.db
                .$client`update devices set last_seen_at = ${new Date(t.clock.now - INACTIVE_DEVICE_MS - 86_400_000).toISOString()}::timestamptz where id = ${c.device.deviceId}`;
              const r = await compactJournal(t.db, t.clock.now);
              if (r.deleted > 0) total.compactions++;
            }
            break;
        }
      }

      // Everyone comes back online and catches up.
      for (const c of clients) await c.connect();
      const head = async () =>
        Number(
          (
            await t.db.$client<
              { h: string }[]
            >`select head_seq as h from vaults where id = ${vault}`
          )[0]!.h,
        );
      const h = await head();
      await expect
        .poll(
          async () => {
            for (const c of clients) await c.settle();
            return clients.map((c) => c.cursor);
          },
          { timeout: 15_000, interval: 50 },
        )
        .toEqual([h, h, h]);

      const snap = (await first.call("GET", `/vaults/${vault}/snapshot`)).json() as {
        files: {
          fileId: string;
          kind: string;
          path: string;
          versionId: string;
          contentHash: string;
        }[];
      };
      const expected = new Map(
        snap.files
          .filter((f) => f.kind === "file")
          .map((f) => [
            f.fileId,
            { path: f.path, versionId: f.versionId, contentHash: f.contentHash },
          ]),
      );
      for (const c of clients) {
        expect(c.serverErrors).toEqual([]);
        expect(c.violations).toEqual([]);
        expect(new Map([...c.state].sort())).toEqual(new Map([...expected].sort()));
      }
      for (const c of clients) {
        total.pushes += c.stats.pushes;
        total.pulls += c.stats.pulls;
        total.snapshots += c.stats.snapshots;
        c.drop();
      }
    } finally {
      await t.close();
    }
  }

  it("fixed: a device away for months recovers from the snapshot", async () => {
    const before = { ...total };
    await scenario([
      { kind: "put", client: 0, path: 0 },
      { kind: "connect", client: 1 },
      { kind: "pull", client: 2 },
      { kind: "put", client: 0, path: 1 },
      { kind: "pull", client: 0 },
      { kind: "pull", client: 2 },
      { kind: "away", client: 2 },
      { kind: "put", client: 0, path: 2 },
      { kind: "pull", client: 0 },
      { kind: "away", client: 2 },
    ]);
    expect(total.compactions).toBeGreaterThan(before.compactions);
    expect(total.snapshots).toBeGreaterThan(before.snapshots);
  }, 60_000);

  it("clients that only see pushed entries converge to the server snapshot", async () => {
    await fc.assert(fc.asyncProperty(fc.array(step, { minLength: 10, maxLength: 40 }), scenario), {
      numRuns: RUNS,
      seed: SEED,
    });
    // The runs must have gone through every path, or the property proves little.
    if (process.env["MULTI_DEBUG"]) console.log(total);
    expect(total.pushes).toBeGreaterThan(0);
    expect(total.pulls).toBeGreaterThan(0);
    expect(total.compactions).toBeGreaterThan(0);
    expect(total.snapshots).toBeGreaterThan(0);
  }, 600_000);
});
