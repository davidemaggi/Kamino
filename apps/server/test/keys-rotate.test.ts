import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli/index.js";
import { systemKey } from "../src/crypto/dek.js";
import { decryptField } from "../src/crypto/field.js";
import { ensureKeyCheck } from "../src/crypto/key-check.js";
import {
  generateMasterKey,
  keyringOf,
  MasterKeyError,
  parseMasterKey,
} from "../src/crypto/keyring.js";
import { createDb } from "../src/db/client.js";
import { auditLog, keyCheck, users } from "../src/db/schema.js";
import { rotateKeys } from "../src/keys/rotate.js";
import { rootAdmin } from "./helpers/admin.js";
import { kek as oldKek, testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { deviceOf, linkDevice, putFile, raw, user, type TestDevice } from "./helpers/sync.js";

const SMTP = { host: "smtp.example.com", from: "noreply@example.com", password: "smtp-pw-123" };

describe.skipIf(dockerUnavailable)("master key rotation (M7b B1, 04 §5.2)", () => {
  let pg: TestPostgres;
  let t: TestApp | undefined;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  const newRaw = generateMasterKey();
  const newKek = parseMasterKey(newRaw);
  const both = keyringOf(newKek, oldKek);

  async function paths(t: TestApp, d: TestDevice): Promise<string[]> {
    const dev = deviceOf(t, d.token, d.vaultId, d.deviceId);
    const r = await dev.call("GET", `/vaults/${d.vaultId}/snapshot`);
    expect(r.statusCode).toBe(200);
    return (r.json() as { files: { path: string }[] }).files.map((f) => f.path).sort();
  }

  it("moves DEKs and system secrets to the new key, then the old key is no longer needed", async () => {
    const url = await pg.createDatabase("rotate_full");

    // Before: everything under the old key.
    // The same blob folders across the restarts (an app given `dirs` keeps them on close).
    const root = mkdtempSync(join(tmpdir(), "kamino-rotate-"));
    const dirs = { blobs: join(root, "blobs"), staging: join(root, "staging") };
    t = await testApp(url, { dirs });
    const admin = await rootAdmin(t);
    const d = await linkDevice(t, await user(t, "mario"));
    expect((await putFile(d, "notes/a.md")).results[0]!.status).toBe("accepted");
    const mario = (await t.auth.byUsername("mario"))!;
    await t.auth.totpSetup(mario);
    await t.config.patch({ smtp: SMTP }, "root");
    // A deletion export built under the old key (its token isn't stored: it can't be re-encrypted).
    await user(t, "luigi");
    const luigi = (await t.auth.byUsername("luigi"))!;
    await t.call(admin, "DELETE", `/admin/users/${luigi.id}`, {
      confirmUsername: "luigi",
      sendZip: true,
    });
    expect(await t.deletion.runExports()).toBe(1);
    // The export email is still queued: its recipient and link are under the old key too.
    await t.close();
    t = undefined;

    // The new key alone doesn't own this database yet.
    const db = createDb(url);
    await expect(ensureKeyCheck(db, newKek)).rejects.toThrow(MasterKeyError);
    await db.$client.end();

    // Restart with both keys: the old data still reads, the rotation is announced.
    t = await testApp(url, { kek: both, dirs });
    expect(await paths(t, d)).toEqual(["notes/a.md"]);
    expect((await t.config.smtp())?.password).toBe(SMTP.password);
    const checks = await t.db.select().from(keyCheck);
    expect(
      checks
        .filter((c) => c.retiredAt === null)
        .map((c) => c.kekId)
        .sort(),
    ).toEqual([newKek.id, oldKek.id].sort());
    // New vaults are wrapped with the new key straight away.
    const d2 = await linkDevice(t, await user(t, "anna"));
    await putFile(d2, "b.md");

    const r = await rotateKeys(t.db, both, "cli");
    expect(r).toMatchObject({ vaults: 1, unreadable: 0, done: true });
    // Two TOTP secrets (root admin, mario) + SMTP password + the queued export email.
    expect(r.secrets).toBe(4);
    expect(r.pendingExports.count).toBe(1);
    // Repeatable: nothing left to move.
    expect(await rotateKeys(t.db, both, "cli")).toMatchObject({
      vaults: 0,
      secrets: 0,
      done: true,
    });
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "master_key_rotated"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target).toBe(`${oldKek.id} → ${newKek.id}`);

    // The old export is still readable while the previous key is configured.
    await t.outbox.drain();
    const mail = t.mail.find((m) => m.to === "luigi@example.com")!;
    const token = /\/api\/v1\/exports\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    expect((await raw(t, "GET", `/exports/${token}`)).statusCode).toBe(200);
    await t.close();
    t = undefined;

    // The new key alone: every DEK, secret and email reads.
    t = await testApp(url, { kek: newKek, dirs });
    expect(await paths(t, d)).toEqual(["notes/a.md"]);
    expect(await paths(t, d2)).toEqual(["b.md"]);
    expect((await t.config.smtp())?.password).toBe(SMTP.password);
    const [row] = await t.db.select().from(users).where(eq(users.id, mario.id));
    expect(
      decryptField(
        systemKey(newKek),
        { table: "users", column: "totp_secret", rowId: mario.id },
        row!.totpSecret!,
      ).length,
    ).toBeGreaterThan(0);
    await t.close();
    t = undefined;

    rmSync(root, { recursive: true, force: true });

    // And the old key alone is refused.
    const db2 = createDb(url);
    await expect(ensureKeyCheck(db2, oldKek)).rejects.toThrow(MasterKeyError);
    await db2.$client.end();
  });

  it("CLI: needs both keys, reports counts, never prints a key", async () => {
    const url = await pg.createDatabase("rotate_cli");
    t = await testApp(url);
    await linkDevice(t, await user(t, "mario"));
    await t.close();
    t = undefined;
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) };
    const env = {
      KAMINO_PUBLIC_URL: "http://localhost:8080",
      KAMINO_DATABASE_URL: url,
      KAMINO_MASTER_KEY: newRaw,
    };
    expect(await main(["keys", "rotate"], env, io)).toBe(2);
    const oldRaw = Buffer.from(oldKek.key).toString("base64");
    expect(await main(["keys", "rotate"], { ...env, KAMINO_MASTER_KEY_PREVIOUS: oldRaw }, io)).toBe(
      0,
    );
    const all = out.join("") + err.join("");
    expect(all).toContain("re-wrapped 1 vault keys");
    expect(all).toContain("rotation complete");
    expect(all).not.toContain(newRaw);
    expect(all).not.toContain(oldRaw);
    // Afterwards the new key alone verifies.
    expect(await main(["keys", "verify"], env, io)).toBe(0);
  });
});
