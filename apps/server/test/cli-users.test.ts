import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/service.js";
import { main } from "../src/cli/index.js";
import { ensureKeyCheck } from "../src/crypto/key-check.js";
import { generateMasterKey, parseMasterKey } from "../src/crypto/keyring.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

async function run(argv: string[], env: Record<string, string>) {
  let out = "";
  let err = "";
  const code = await main(argv, env, { stdout: (s) => (out += s), stderr: (s) => (err += s) });
  return { code, out, err };
}

describe.skipIf(dockerUnavailable)("cli users", () => {
  let pg: TestPostgres;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());

  it("invite, reset-link and reset-2fa", async () => {
    const url = await pg.createDatabase("cli_users");
    const key = generateMasterKey();
    const kek = parseMasterKey(key);
    const db = createDb(url);
    await runMigrations(db, async () => {
      await ensureKeyCheck(db, kek);
    });
    const env = {
      KAMINO_PUBLIC_URL: "https://kamino.example",
      KAMINO_DATABASE_URL: url,
      KAMINO_MASTER_KEY: key,
    };
    const auth = new AuthService(db, kek, "Kamino");

    const invite = await run(["users", "invite", "mario", "mario@example.com"], env);
    expect(invite.code).toBe(0);
    const token = /\/invite\/(\S+)/.exec(invite.out)![1]!;
    expect(invite.out.startsWith("https://kamino.example/invite/")).toBe(true);
    expect(await auth.inviteInfo(token)).toEqual({ username: "mario", email: "mario@example.com" });

    const reset = await run(["users", "reset-link", "mario"], env);
    expect(reset.code).toBe(0);
    expect(reset.out).toMatch(/^https:\/\/kamino\.example\/reset\/\S+\n$/);
    expect((await auth.byUsername("mario"))!.adminResetAt).not.toBeNull();

    expect(await run(["users", "reset-link", "ghost"], env)).toMatchObject({
      code: 1,
      err: "not_found\n",
    });
    expect((await run(["users", "reset-2fa", "mario"], env)).code).toBe(0);
    expect((await run(["users", "invite"], env)).code).toBe(2);
    await db.$client.end();
  });
});
