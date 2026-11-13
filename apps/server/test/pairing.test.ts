import { PairingClaimState, PairingOffer, PairingState, PROTOCOL_VERSION } from "@kamino/protocol";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { devices, pairings } from "../src/db/schema.js";
import { PAIRING_TTL_MS } from "../src/pairing/service.js";
import { login } from "./helpers/admin.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { deviceOf, linkDevice, raw, user, type TestDevice } from "./helpers/sync.js";
import { hello } from "./helpers/ws.js";

const SMTP = { smtp: { host: "smtp.example.com", from: "noreply@example.com" } };
const NEW_DEVICE = {
  deviceName: "iPhone",
  platform: "ios",
  pluginVersion: "0.2.0",
  protocolVersion: PROTOCOL_VERSION,
};

describe.skipIf(dockerUnavailable)("pairing (03 §10)", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  let log: string[];
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  async function fresh(smtp = false): Promise<{ web: Agent; mac: TestDevice }> {
    await t?.close();
    log = [];
    t = await testApp(await pg.createDatabase(`pairing_${++n}`), {
      ...(smtp ? { system: SMTP } : {}),
      log: { write: (l: string) => void log.push(l) },
    });
    const mac = await linkDevice(t, await user(t, "mario"));
    return { web: await login(t, "mario"), mac };
  }
  const tokenOf = (link: string) => new URL(link).searchParams.get("token")!;
  const offer = async (web: Agent, vaultId: string, query = "") => {
    const r = await t.call(web, "POST", `/vaults/${vaultId}/pairings${query}`);
    return { status: r.statusCode, ...(r.statusCode === 200 ? PairingOffer.parse(r.json()) : {}) };
  };
  const claim = (token: string) =>
    raw(t, "POST", "/pairings/claim", { token, ...NEW_DEVICE }, { "x-requested-with": "" });
  const poll = (claimId: string, secret: string) =>
    raw(t, "GET", `/pairings/claims/${claimId}`, undefined, { authorization: `Claim ${secret}` });
  const state = async (web: Agent, id: string) =>
    PairingState.parse((await t.call(web, "GET", `/pairings/${id}`)).json());

  it("from the web: claim, same code on both sides, approve; the token is delivered once", async () => {
    const { web, mac } = await fresh();
    const o = await offer(web, mac.vaultId);
    expect(o.link).toMatch(/^obsidian:\/\/kamino\?server=.+&token=[A-Za-z0-9_-]{43}$/);
    expect((await state(web, o.pairingId!)).status).toBe("waiting");
    const ws = await t.ws();
    ws.send(hello(mac.token));
    await ws.next("welcome");

    const c = await claim(tokenOf(o.link!));
    expect(c.statusCode).toBe(200);
    const { claimId, claimSecret, verificationCode } = c.json() as {
      claimId: string;
      claimSecret: string;
      verificationCode: string;
    };
    expect(verificationCode).toMatch(/^[A-HJ-NP-Z2-9]{4}$/);
    // The vault's devices hear about it at once; the web app sees it on its next poll.
    const pushed = await ws.next("pairing_request");
    expect(pushed).toMatchObject({
      pairingId: o.pairingId,
      deviceName: "iPhone",
      code: verificationCode,
    });
    const s = await state(web, o.pairingId!);
    expect(s).toMatchObject({
      status: "requested",
      request: { deviceName: "iPhone", code: verificationCode },
    });
    expect(PairingClaimState.parse((await poll(claimId, claimSecret)).json()).status).toBe(
      "pending",
    );

    const ok = await t.call(web, "POST", `/pairings/${o.pairingId}/approve`);
    expect(PairingState.parse(ok.json()).status).toBe("approved");
    expect((await ws.next("pairing_closed")).pairingId).toBe(o.pairingId);
    const got = PairingClaimState.parse((await poll(claimId, claimSecret)).json());
    if (got.status !== "approved") throw new Error(`not approved: ${got.status}`);
    expect(got).toMatchObject({ username: "mario", vault: { id: mac.vaultId, name: "Note" } });
    // The new device signs in with it, and it is a device of the vault.
    const phone = deviceOf(t, got.deviceToken, mac.vaultId, got.deviceId);
    expect((await phone.call("GET", "/device")).statusCode).toBe(200);
    const [row] = await t.db.select().from(devices).where(eq(devices.id, got.deviceId));
    expect(row).toMatchObject({ name: "iPhone", platform: "ios", isOrigin: false });
    // Once: a second poll doesn't hand the token out again.
    expect(PairingClaimState.parse((await poll(claimId, claimSecret)).json())).toEqual({
      status: "consumed",
    });
    // Nothing secret at rest: neither the link token, nor the claim secret, nor the device token.
    const [p] = await t.db.select().from(pairings).where(eq(pairings.id, o.pairingId!));
    const stored = JSON.stringify(p);
    for (const secret of [tokenOf(o.link!), claimSecret, got.deviceToken])
      expect(stored).not.toContain(secret);
    // Nor in the logs.
    for (const secret of [tokenOf(o.link!), claimSecret, got.deviceToken])
      expect(log.join("\n")).not.toContain(secret);
    ws.close();
  });

  it("a device of the vault can offer and approve; another vault's device can't", async () => {
    const { mac } = await fresh();
    const r = await mac.call("POST", `/vaults/${mac.vaultId}/pairings`);
    const o = PairingOffer.parse(r.json());
    const other = await linkDevice(t, await user(t, "luigi"));
    expect((await other.call("GET", `/pairings/${o.pairingId}`)).statusCode).toBe(404);
    expect((await other.call("POST", `/vaults/${mac.vaultId}/pairings`)).statusCode).toBe(404);
    const c = (await claim(tokenOf(o.link))).json() as { claimId: string; claimSecret: string };
    expect((await other.call("POST", `/pairings/${o.pairingId}/approve`)).statusCode).toBe(404);
    const ok = await mac.call("POST", `/pairings/${o.pairingId}/approve`);
    expect(ok.statusCode).toBe(200);
    expect(PairingClaimState.parse((await poll(c.claimId, c.claimSecret)).json()).status).toBe(
      "approved",
    );
  });

  it("someone else's vault or pairing is a 404", async () => {
    const { web, mac } = await fresh();
    await user(t, "luigi");
    const luigi = await login(t, "luigi");
    expect((await offer(luigi, mac.vaultId)).status).toBe(404);
    const o = await offer(web, mac.vaultId);
    expect((await t.call(luigi, "GET", `/pairings/${o.pairingId}`)).statusCode).toBe(404);
    expect((await t.call(luigi, "POST", `/pairings/${o.pairingId}/cancel`)).statusCode).toBe(404);
  });

  it("deny and cancel close the flow; a closed flow answers 409", async () => {
    const { web, mac } = await fresh();
    const a = await offer(web, mac.vaultId);
    const ca = (await claim(tokenOf(a.link!))).json() as { claimId: string; claimSecret: string };
    expect(
      PairingState.parse((await t.call(web, "POST", `/pairings/${a.pairingId}/deny`)).json())
        .status,
    ).toBe("denied");
    expect(PairingClaimState.parse((await poll(ca.claimId, ca.claimSecret)).json()).status).toBe(
      "denied",
    );
    const again = await t.call(web, "POST", `/pairings/${a.pairingId}/approve`);
    expect([again.statusCode, again.json().error.code]).toEqual([409, "pairing_closed"]);

    const b = await offer(web, mac.vaultId);
    expect(
      PairingState.parse((await t.call(web, "POST", `/pairings/${b.pairingId}/cancel`)).json())
        .status,
    ).toBe("cancelled");
    const late = await claim(tokenOf(b.link!));
    expect([late.statusCode, late.json().error.code]).toEqual([410, "token_expired"]);
    expect((await t.call(web, "POST", `/pairings/${b.pairingId}/cancel`)).statusCode).toBe(409);

    // The new device withdraws while waiting: the origin's request is gone.
    const c = await offer(web, mac.vaultId);
    const cc = (await claim(tokenOf(c.link!))).json() as { claimId: string; claimSecret: string };
    const w = await raw(t, "POST", `/pairings/claims/${cc.claimId}/cancel`, undefined, {
      authorization: `Claim ${cc.claimSecret}`,
    });
    expect(w.statusCode).toBe(204);
    expect((await state(web, c.pairingId!)).status).toBe("cancelled");
    expect((await t.call(web, "POST", `/pairings/${c.pairingId}/approve`)).statusCode).toBe(409);
  });

  it("ten minutes for the whole flow", async () => {
    const { web, mac } = await fresh();
    const a = await offer(web, mac.vaultId);
    t.clock.now += PAIRING_TTL_MS;
    expect((await state(web, a.pairingId!)).status).toBe("expired");
    expect((await claim(tokenOf(a.link!))).statusCode).toBe(410);

    const b = await offer(web, mac.vaultId);
    const cb = (await claim(tokenOf(b.link!))).json() as { claimId: string; claimSecret: string };
    t.clock.now += PAIRING_TTL_MS;
    expect(PairingClaimState.parse((await poll(cb.claimId, cb.claimSecret)).json()).status).toBe(
      "expired",
    );
    expect((await t.call(web, "POST", `/pairings/${b.pairingId}/approve`)).statusCode).toBe(409);
    expect(await t.db.select().from(devices).where(eq(devices.name, "iPhone"))).toEqual([]);
  });

  it("the link is one-time: a second claim fails and the origin is told", async () => {
    const { web, mac } = await fresh();
    const o = await offer(web, mac.vaultId);
    const ws = await t.ws();
    ws.send(hello(mac.token));
    await ws.next("welcome");
    expect((await claim(tokenOf(o.link!))).statusCode).toBe(200);
    const second = await claim(tokenOf(o.link!));
    expect([second.statusCode, second.json().error.code]).toEqual([409, "pairing_already_claimed"]);
    expect((await ws.next("pairing_reused")).pairingId).toBe(o.pairingId);
    expect(await state(web, o.pairingId!)).toMatchObject({ status: "requested", reused: true });
    // A made-up token is not a pairing.
    expect((await claim("x".repeat(43))).statusCode).toBe(400);
    ws.close();
  });

  it("polling needs the claim secret", async () => {
    const { web, mac } = await fresh();
    const o = await offer(web, mac.vaultId);
    const c = (await claim(tokenOf(o.link!))).json() as { claimId: string; claimSecret: string };
    expect((await poll(c.claimId, "wrong")).statusCode).toBe(404);
    expect((await raw(t, "GET", `/pairings/claims/${c.claimId}`)).statusCode).toBe(404);
    expect((await poll("not-a-uuid", c.claimSecret)).statusCode).toBe(404);
  });

  it("?email=1 mails the link to the user; without SMTP nothing is left behind", async () => {
    const { web, mac } = await fresh();
    const r = await offer(web, mac.vaultId, "?email=1");
    expect(r.status).toBe(409);
    expect(await t.db.select().from(pairings)).toEqual([]);

    const s = await fresh(true);
    const o = await offer(s.web, s.mac.vaultId, "?email=1");
    await t.outbox.drain();
    expect(t.mail.map((m) => m.to)).toEqual(["mario@example.com"]);
    expect(t.mail[0]!.text).toContain(tokenOf(o.link!));
    expect(log.join("\n")).not.toContain(tokenOf(o.link!));
  });

  it("claims and polls are rate limited", async () => {
    await fresh();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await claim(`made-up-${i}`)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 400)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});
