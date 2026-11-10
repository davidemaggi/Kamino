import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { deviceOf, linkDevice, putFile, user } from "./helpers/sync.js";
import { hello } from "./helpers/ws.js";

describe.skipIf(dockerUnavailable)("fan-out across instances (N-08)", () => {
  let pg: TestPostgres;
  let one: TestApp;
  let two: TestApp;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await one?.close();
    await two?.close();
    await pg?.stop();
  });

  it("a commit on one instance reaches a socket on the other, also after LISTEN drops", async () => {
    const url = await pg.createDatabase("fanout");
    one = await testApp(url);
    two = await testApp(url);
    const enroll = await user(one, "mario");
    const a = await linkDevice(one, enroll);
    const b = await linkDevice(one, enroll, a.vaultId, "iPhone");

    const ws = await two.ws();
    ws.send(hello(b.token));
    await ws.next("welcome");
    await putFile(a, "first.md");
    expect((await ws.next("changes")).entries.map((e) => e.path)).toEqual(["first.md"]);

    // Every LISTEN connection is cut; postgres-js reconnects and every socket re-reads its
    // journal, so a commit landing meanwhile is not lost.
    const killed = await one.db.$client<{ ok: boolean }[]>`
      select pg_terminate_backend(pid) as ok from pg_stat_activity
      where query ilike 'listen%' and datname = current_database()`;
    expect(killed.length).toBeGreaterThanOrEqual(2);
    await putFile(a, "second.md");
    expect((await ws.next("changes", 10_000)).entries.map((e) => e.path)).toEqual(["second.md"]);
    await putFile(a, "third.md");
    expect((await ws.next("changes", 10_000)).entries.map((e) => e.path)).toEqual(["third.md"]);

    // The device works the same against either instance.
    const viaTwo = deviceOf(two, a.token, a.vaultId, a.deviceId);
    expect((await viaTwo.call("GET", `/vaults/${a.vaultId}/changes?after=0`)).json().head).toBe(3);
    ws.close();
  }, 60_000);
});
