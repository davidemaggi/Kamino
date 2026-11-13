import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackupError, BackupReader, createBackup, restoreBackup } from "../src/backup/archive.js";
import { verifyBackup } from "../src/backup/verify.js";
import { FsBlobStore } from "../src/blobs/fs-store.js";
import { main } from "../src/cli/index.js";
import { generateMasterKey, MasterKeyError, parseMasterKey } from "../src/crypto/keyring.js";
import { createDb } from "../src/db/client.js";
import { rootAdmin } from "./helpers/admin.js";
import { kek, testApp, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { deviceOf, linkDevice, putFile, PW, user, type TestDevice } from "./helpers/sync.js";

describe.skipIf(dockerUnavailable)("backup create / verify / restore (M7b B2–B4)", () => {
  let pg: TestPostgres;
  let t: TestApp | undefined;
  const root = mkdtempSync(join(tmpdir(), "kamino-backup-"));
  const dirsA = { blobs: join(root, "a/blobs"), staging: join(root, "a/staging") };
  const dirsB = { blobs: join(root, "b/blobs"), staging: join(root, "b/staging") };
  const file = join(root, "backup.zip");
  let urlA = "";
  let device: TestDevice;

  beforeAll(async () => {
    pg = await startPostgres();
    urlA = await pg.createDatabase("backup_src");
    t = await testApp(urlA, { dirs: dirsA });
    await rootAdmin(t);
    device = await linkDevice(t, await user(t, "mario"));
    await putFile(device, "notes/one.md", Buffer.from("first note"));
    await putFile(device, "two.md", Buffer.from("second note, a little longer"));
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  async function files(t: TestApp, d: TestDevice) {
    const dev = deviceOf(t, d.token, d.vaultId, d.deviceId);
    const snap = (await dev.call("GET", `/vaults/${d.vaultId}/snapshot`)).json() as {
      files: { path: string; contentHash: string }[];
    };
    const out: Record<string, string> = {};
    for (const f of snap.files) {
      const r = await dev.call("GET", `/vaults/${d.vaultId}/blobs/${f.contentHash}`);
      expect(r.statusCode).toBe(200);
      out[f.path] = r.body;
    }
    return out;
  }

  it("creates a backup without the key, verifies it, restores it into a new database", async () => {
    const before = await files(t!, device);
    expect(Object.keys(before).sort()).toEqual(["notes/one.md", "two.md"]);

    const m = await createBackup(t!.db, t!.blobStore, file);
    expect(m.kekIds).toEqual([kek.id]);
    expect(m.blobs).toBe(2);
    expect(m.missingBlobs).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const r = await BackupReader.open(file);
    // The master key is nowhere in the archive.
    for (const name of ["db/key_check.copy", "db/vaults.copy"]) {
      const parts: Buffer[] = [];
      for await (const c of await r.stream(name)) parts.push(c as Buffer);
      expect(Buffer.concat(parts).includes(Buffer.from(kek.key))).toBe(false);
    }
    r.close();

    const v = await verifyBackup(urlA, file, kek);
    expect(v).toMatchObject({ vaults: 1, blobsChecked: 2, blobsTotal: 2 });
    await expect(verifyBackup(urlA, file, parseMasterKey(generateMasterKey()))).rejects.toThrow(
      MasterKeyError,
    );

    // Restore into an empty database and an empty storage folder.
    const urlB = await pg.createDatabase("backup_dst");
    const dbB = createDb(urlB);
    const reader = await BackupReader.open(file);
    try {
      expect(await restoreBackup(dbB, new FsBlobStore(dirsB.blobs), reader, kek)).toMatchObject({
        blobs: 2,
      });
      // Never on top of existing data.
      await expect(restoreBackup(dbB, new FsBlobStore(dirsB.blobs), reader, kek)).rejects.toThrow(
        BackupError,
      );
    } finally {
      reader.close();
      await dbB.$client.end();
    }

    // The server on the restored copy: same files, same contents, same accounts.
    const b = await testApp(urlB, { dirs: dirsB });
    try {
      expect(await files(b, device)).toEqual(before);
      const login = await b.call({}, "POST", "/auth/login", { username: "mario", password: PW });
      expect(login.statusCode).toBe(200);
    } finally {
      await b.close();
    }
  });

  it("CLI: backup create, verify and restore", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io = { stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s) };
    const keyRaw = Buffer.from(kek.key).toString("base64");
    const env = {
      KAMINO_PUBLIC_URL: "http://localhost:8080",
      KAMINO_DATABASE_URL: urlA,
      KAMINO_MASTER_KEY: keyRaw,
      KAMINO_STORAGE_DIR: dirsA.blobs,
    };
    const cliFile = join(root, "cli.zip");
    expect(await main(["backup", "create"], env, io)).toBe(2);
    expect(await main(["backup", "create", cliFile], env, io)).toBe(0);
    expect(await main(["backup", "verify", cliFile], env, io)).toBe(0);
    const urlC = await pg.createDatabase("backup_cli");
    const dirC = join(root, "c/blobs");
    expect(
      await main(
        ["backup", "restore", cliFile],
        { ...env, KAMINO_DATABASE_URL: urlC, KAMINO_STORAGE_DIR: dirC },
        io,
      ),
    ).toBe(0);
    // A second restore onto the same database is refused.
    expect(
      await main(
        ["backup", "restore", cliFile],
        { ...env, KAMINO_DATABASE_URL: urlC, KAMINO_STORAGE_DIR: dirC },
        io,
      ),
    ).toBe(1);
    const all = out.join("") + err.join("");
    expect(all).toContain("backup written");
    expect(all).toContain("backup verified");
    expect(all).toContain("restored:");
    expect(all).toContain("the target database is not empty");
    expect(all).not.toContain(keyRaw);
  });
});
