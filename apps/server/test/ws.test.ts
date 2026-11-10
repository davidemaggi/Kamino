import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { linkDevice, putFile, user, type TestDevice } from "./helpers/sync.js";
import { hello } from "./helpers/ws.js";

describe.skipIf(dockerUnavailable)("websocket", () => {
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
    t = await testApp(await pg.createDatabase(`ws_${++n}`), {
      // Short enough for the heartbeat tests; the test client answers pings, so slow steps are fine.
      realtime: { helloMs: 300, heartbeatMs: 400 },
    });
    const enroll = await user(t, "mario");
    a = await linkDevice(t, enroll);
    b = await linkDevice(t, enroll, a.vaultId, "iPhone");
  });

  const cursorOf = async (deviceId: string) =>
    Number(
      (
        await t.db.$client<
          { c: string }[]
        >`select cursor_seq as c from devices where id = ${deviceId}`
      )[0]!.c,
    );

  it("hello → welcome → catch-up from the cursor → live push; ack moves the cursor", async () => {
    for (const p of ["n1.md", "n2.md", "n3.md"]) await putFile(a, p);
    const ws = await t.ws();
    ws.send(hello(b.token, 1));
    const w = await ws.next("welcome");
    expect(w).toMatchObject({ head: 3, deviceId: b.deviceId, protocol: 1 });
    expect((await ws.next("changes")).entries.map((e) => [e.seq, e.path])).toEqual([
      [2, "n2.md"],
      [3, "n3.md"],
    ]);
    await putFile(a, "n4.md");
    const live = await ws.next("changes");
    expect(live.entries.map((e) => e.seq)).toEqual([4]);
    expect(live.head).toBe(4);
    ws.send({ type: "ack", seq: 4 });
    await expect.poll(() => cursorOf(b.deviceId)).toBe(4);
    ws.send({ type: "status", pendingOps: 2, pendingBytes: 5, deferredFiles: 1 });
    await expect
      .poll(
        async () =>
          (
            await t.db.$client<
              { p: number }[]
            >`select pending_ops as p from devices where id = ${b.deviceId}`
          )[0]!.p,
      )
      .toBe(2);
    ws.send({ type: "ping" });
    await ws.next("pong");
    ws.close();
  });

  it("catch-up is paged: more than one page arrives in order without gaps", async () => {
    // 600 entries through the service, faster than 600 HTTP round trips.
    const vc = t.vaults.cryptoOf((await t.vaults.byId(a.vaultId))!);
    for (let i = 0; i < 600; i++)
      await t.db
        .$client`insert into journal (vault_id, seq, type, file_id, kind, path_enc, device_id, at)
        values (${a.vaultId}, ${i + 1}, 'folder_created', ${`d${i}`}, 'folder',
                ${vc.enc("journal", "path", `${a.vaultId}:${i + 1}`, `d${i}`)}, ${a.deviceId}, now())`;
    await t.db.$client`update vaults set head_seq = 600 where id = ${a.vaultId}`;
    const ws = await t.ws();
    ws.send(hello(b.token, 0));
    await ws.next("welcome");
    const first = await ws.next("changes");
    const second = await ws.next("changes");
    expect(first.entries).toHaveLength(500);
    expect(first.hasMore).toBe(true);
    expect([...first.entries, ...second.entries].map((e) => e.seq)).toEqual(
      Array.from({ length: 600 }, (_, i) => i + 1),
    );
    ws.close();
  });

  it("no hello in time → 4401; bad token → unauthorized; wrong protocol → protocol_unsupported", async () => {
    const silent = await t.ws();
    expect((await silent.closed()).code).toBe(4401);
    const bad = await t.ws();
    bad.send(hello("nope"));
    expect((await bad.next("error")).code).toBe("unauthorized");
    expect((await bad.closed()).code).toBe(4401);
    const old = await t.ws();
    old.send(hello(b.token, 0, 99));
    expect((await old.next("error")).code).toBe("protocol_unsupported");
    expect((await old.closed()).code).toBe(4426);
  });

  it("only the first hello counts; frames pipelined behind it are handled after welcome", async () => {
    await putFile(a, "x.md");
    const ws = await t.ws();
    ws.send(hello(b.token, 0));
    ws.send({ type: "ack", seq: 1 });
    await ws.next("welcome");
    await ws.next("changes");
    await expect.poll(() => cursorOf(b.deviceId)).toBe(1);
    ws.close();
    const twice = await t.ws();
    twice.send(hello(b.token, 0));
    twice.send(hello(b.token, 0));
    expect((await twice.next("error")).code).toBe("invalid_request");
    expect((await twice.closed()).code).toBe(4400);
  });

  it("a cursor beyond the head (restored server) → cursor_too_old on REST and websocket", async () => {
    await putFile(a, "x.md");
    expect((await b.call("GET", `/vaults/${a.vaultId}/changes?after=9`)).statusCode).toBe(410);
    const ws = await t.ws();
    ws.send(hello(b.token, 9));
    await ws.next("welcome");
    expect((await ws.next("error")).code).toBe("cursor_too_old");
    expect((await ws.closed()).code).toBe(4410);
  });

  it("invalid JSON or an unknown message → invalid_request and 4400", async () => {
    const ws = await t.ws();
    ws.send("{not json");
    expect((await ws.next("error")).code).toBe("invalid_request");
    expect((await ws.closed()).code).toBe(4400);
  });

  it("a cursor below the journal floor → cursor_too_old and 4410", async () => {
    await t.db.$client`update vaults set journal_floor = 3, head_seq = 5 where id = ${a.vaultId}`;
    const ws = await t.ws();
    ws.send(hello(b.token, 1));
    await ws.next("welcome");
    expect((await ws.next("error")).code).toBe("cursor_too_old");
    expect((await ws.closed()).code).toBe(4410);
  });

  it("the hub closes a revoked device's sockets with device_revoked", async () => {
    const ws = await t.ws();
    ws.send(hello(b.token));
    await ws.next("welcome");
    t.hub.closeDevice(b.deviceId, { type: "device_revoked" });
    await ws.next("device_revoked");
    expect((await ws.closed()).code).toBe(4403);
    expect(t.hub.size()).toBe(0);
  });

  it("revocation or blocking done elsewhere is noticed at the next heartbeat", async () => {
    const ws = await t.ws();
    ws.send(hello(b.token));
    await ws.next("welcome");
    await t.db.$client`update users set status = 'blocked' where username = 'mario'`;
    expect((await ws.next("error", 5_000)).code).toBe("user_blocked");
    expect((await ws.closed()).code).toBe(4403);
    await t.db.$client`update users set status = 'active' where username = 'mario'`;
    const again = await t.ws();
    again.send(hello(b.token));
    await again.next("welcome");
    await t.db.$client`update devices set revoked_at = now() where id = ${b.deviceId}`;
    await again.next("device_revoked", 5_000);
    const late = await t.ws();
    late.send(hello(b.token));
    await late.next("device_revoked");
  });

  it("a silent client is dropped after two heartbeats; one that talks stays", async () => {
    const quiet = await t.ws({ autoPong: false });
    quiet.send(hello(b.token));
    await quiet.next("welcome");
    // Answers every ping (the default), so it stays.
    const chatty = await t.ws();
    chatty.send(hello(a.token));
    await chatty.next("welcome");
    expect((await quiet.closed()).code).toBe(4408);
    expect(t.hub.size()).toBe(1);
    chatty.close();
  });
});
