import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { Hub, type Conn } from "../src/realtime/hub.js";
import { startListener } from "../src/realtime/listener.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

const conn = (vaultId: string, deviceId: string, log: string[], userId = "u"): Conn => ({
  vaultId,
  deviceId,
  userId,
  wake: () => log.push(`wake ${deviceId}`),
  close: (code) => log.push(`close ${deviceId} ${code}`),
});

describe("hub", () => {
  it("wakes only the vault's connections", () => {
    const hub = new Hub();
    const log: string[] = [];
    hub.add(conn("v1", "d1", log));
    hub.add(conn("v2", "d2", log));
    hub.notify("v1");
    expect(log).toEqual(["wake d1"]);
    hub.wakeAll();
    expect(log).toEqual(["wake d1", "wake d1", "wake d2"]);
  });

  it("caps sockets per device, closing the oldest", () => {
    const hub = new Hub();
    const log: string[] = [];
    const first = conn("v1", "d1", log);
    hub.add(first);
    for (let i = 0; i < 5; i++) hub.add(conn("v1", "d1", log));
    expect(log).toEqual(["close d1 4409"]);
    expect(hub.size()).toBe(5);
    log.length = 0;
    hub.notify("v1");
    expect(log).toHaveLength(5);
  });

  it("closes a device's or a user's sockets and forgets them", () => {
    const hub = new Hub();
    const log: string[] = [];
    hub.add(conn("v1", "d1", log, "mario"));
    hub.add(conn("v1", "d2", log, "mario"));
    hub.add(conn("v2", "d3", log, "luigi"));
    hub.closeDevice("d1", { type: "device_revoked" });
    expect(log).toEqual(["close d1 4403"]);
    hub.closeUser("mario", { type: "error", code: "user_blocked", message: "user_blocked" });
    expect(log).toEqual(["close d1 4403", "close d2 4403"]);
    expect(hub.size()).toBe(1);
  });
});

describe.skipIf(dockerUnavailable)("notify listener", () => {
  let pg: TestPostgres;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());

  it("wakes everyone on connect, then the notified vault", async () => {
    const db = createDb(await pg.createDatabase("listener"));
    const hub = new Hub();
    const log: string[] = [];
    hub.add(conn("v1", "d1", log));
    hub.add(conn("v2", "d2", log));
    const l = await startListener(db, hub);
    await expect.poll(() => log).toEqual(["wake d1", "wake d2"]);
    log.length = 0;
    await db.$client`select pg_notify('kamino_vault', 'v2:7')`;
    await expect.poll(() => log).toEqual(["wake d2"]);
    await l.stop();
    await db.$client.end();
  });
});
