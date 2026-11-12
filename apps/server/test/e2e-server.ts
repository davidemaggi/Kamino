/**
 * Playwright's backend (apps/web/e2e): a real server on a throwaway Postgres (testcontainers),
 * seeded with a user ("mario", password PW) whose vault "Note" has a.md in two versions, a
 * conflict on it and gone.md in the trash. Listens on KAMINO_E2E_PORT (default 8181).
 */
import { testApp } from "./helpers/app.js";
import { startPostgres } from "./helpers/postgres.js";
import { linkDevice, uploadContent, user, type TestDevice } from "./helpers/sync.js";

const port = Number(process.env["KAMINO_E2E_PORT"] ?? 8181);
const pg = await startPostgres();
const t = await testApp(await pg.createDatabase("e2e"));

let op = 0;
async function commit(d: TestDevice, o: Record<string, unknown>) {
  t.clock.now += 60_000;
  await d.call("POST", `/vaults/${d.vaultId}/commits`, { ops: [{ opId: `o${++op}`, ...o }] });
}
async function put(
  d: TestDevice,
  fileId: string,
  ver: string,
  path: string,
  body: string,
  base: string | null,
) {
  const buf = Buffer.from(body);
  const contentHash = await uploadContent(d, buf);
  await commit(d, {
    type: "put",
    fileId,
    versionId: ver,
    path,
    baseVersionId: base,
    contentHash,
    size: buf.length,
    mtime: 1,
  });
}

const enroll = await user(t, "mario");
const mac = await linkDevice(t, enroll, undefined, "Mac");
const phone = await linkDevice(t, enroll, mac.vaultId, "iPhone");
await put(mac, "f1", "v1", "a.md", "first version\n", null);
await put(mac, "f1", "v2", "a.md", "second version\n", "v1");
await put(phone, "f1", "v3", "a.md", "from the phone\n", "v1");
await put(mac, "f2", "v4", "gone.md", "bye\n", null);
await commit(mac, { type: "delete", fileId: "f2", baseVersionId: "v4" });
// Real time from here on: sessions and timestamps the browser sees are current.
t.clock.now = Date.now();
Object.defineProperty(t.clock, "now", { get: () => Date.now() });

await t.app.listen({ port, host: "127.0.0.1" });
console.log(`e2e server on http://127.0.0.1:${port}`);

const stop = async () => {
  await t.close();
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
