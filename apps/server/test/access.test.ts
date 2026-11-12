import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { testApp, type TestApp } from "./helpers/app.js";
import { linkDevice, user } from "./helpers/sync.js";
import { ownedVault } from "../src/vaults/access.js";
import { ApiError } from "../src/http/errors.js";

describe.skipIf(dockerUnavailable)("owned vault access", () => {
  let pg: TestPostgres;
  let t: TestApp;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });
  beforeEach(async () => {
    await t?.close();
    t = await testApp(await pg.createDatabase(`access_${++n}`));
  });

  const missing = async (p: Promise<unknown>) => {
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: "not_found", status: 404 });
  };

  it("returns the owner's vault and the same 404 for everything else", async () => {
    const a = await linkDevice(t, await user(t, "mario"));
    await user(t, "luigi");
    const mario = (await t.auth.byUsername("mario"))!.id;
    const luigi = (await t.auth.byUsername("luigi"))!.id;

    const { vault, vc } = await ownedVault(t.vaults, mario, a.vaultId);
    expect(vault.id).toBe(a.vaultId);
    expect(vc.vaultId).toBe(a.vaultId);

    await missing(ownedVault(t.vaults, luigi, a.vaultId));
    await missing(ownedVault(t.vaults, mario, "not-a-uuid"));
    await missing(ownedVault(t.vaults, mario, "00000000-0000-4000-8000-000000000000"));
  });
});
