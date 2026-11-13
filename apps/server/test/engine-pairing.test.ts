import { PROTOCOL_VERSION } from "@kamino/protocol";
import { Api, MemoryFs, type PairingMessage } from "@kamino/sync-engine";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deviceEngine, eventually, injectHttp, liveEngine } from "./helpers/engine.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { deviceOf, linkDevice, user, type TestDevice } from "./helpers/sync.js";

describe.skipIf(dockerUnavailable)("pairing with the real engine (M6)", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let app: FastifyInstance | null;
  let mac: TestDevice;

  beforeAll(async () => {
    pg = await startPostgres();
    t = await testApp(await pg.createDatabase("engine_pairing"));
    app = t.app;
    mac = await linkDevice(t, await user(t, "ada"), undefined, "Mac");
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  it("the origin hears the request over realtime; the paired device then syncs the vault", async () => {
    const fsMac = new MemoryFs();
    const heard: PairingMessage[] = [];
    const origin = await liveEngine(() => app, mac, fsMac, { onPairing: (m) => heard.push(m) });
    origin.start();
    await eventually(() => origin.realtimeConnected);
    fsMac.put("note.md", "from the Mac");
    await origin.syncNow();

    // The Mac offers; the new device, with no account here, claims with the link's token.
    const macApi = new Api(
      injectHttp(() => app),
      () => mac.token,
    );
    const offer = await macApi.startPairing(mac.vaultId);
    const token = new URL(offer.link).searchParams.get("token")!;
    const anon = new Api(
      injectHttp(() => app),
      () => null,
    );
    const claim = await anon.claim({
      token,
      deviceName: "iPhone",
      platform: "ios",
      pluginVersion: "0.2.0",
      protocolVersion: PROTOCOL_VERSION,
    });
    await eventually(() => heard.some((m) => m.type === "pairing_request"));
    expect(heard[0]).toMatchObject({
      type: "pairing_request",
      pairingId: offer.pairingId,
      deviceName: "iPhone",
      code: claim.verificationCode,
    });
    expect((await anon.claimState(claim.claimId, claim.claimSecret)).status).toBe("pending");

    // Same code on both sides: the Mac approves.
    await macApi.answerPairing(offer.pairingId, "approve");
    await eventually(() => heard.some((m) => m.type === "pairing_closed"));
    const got = await anon.claimState(claim.claimId, claim.claimSecret);
    if (got.status !== "approved") throw new Error(`not approved: ${got.status}`);

    // The new device syncs with the token it received: it gets the vault's files.
    const phone = deviceOf(t, got.deviceToken, got.vault.id, got.deviceId);
    const fsPhone = new MemoryFs();
    const engine = await deviceEngine(() => app, phone, fsPhone);
    await engine.syncNow();
    expect(fsPhone.text("note.md")).toBe("from the Mac");

    // And what it writes reaches the Mac.
    fsPhone.put("from-phone.md", "hello");
    engine.localChange();
    await engine.syncNow();
    await eventually(() => fsMac.text("from-phone.md") === "hello");
    await engine.stop();
    await origin.stop();
  }, 60_000);
});
