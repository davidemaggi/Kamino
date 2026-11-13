import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { auditLog, blobs, emailOutbox, userExports, users, vaults } from "../src/db/schema.js";
import { purgeDeletedVaults } from "../src/jobs/purge.js";
import { DELETION_GRACE_MS } from "../src/users/deletion.js";
import { login, rootAdmin, secondAdmin } from "./helpers/admin.js";
import { testApp, type Agent, type TestApp } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";
import { linkDevice, PW, putFile, raw, user } from "./helpers/sync.js";

const SMTP = { smtp: { host: "smtp.example.com", from: "noreply@example.com" } };
const codeOf = (r: { json(): unknown }) => (r.json() as { error: { code: string } }).error.code;

function unzip(buf: Buffer): Promise<Record<string, string>> {
  return new Promise((ok, ko) =>
    yauzl.fromBuffer(buf, { lazyEntries: true }, (e, z) => {
      if (e) return ko(e);
      const out: Record<string, string> = {};
      z.on("entry", (en: yauzl.Entry) => {
        if (en.fileName.endsWith("/")) return z.readEntry();
        z.openReadStream(en, (err, s) => {
          if (err) return ko(err);
          const parts: Buffer[] = [];
          s.on("data", (c: Buffer) => parts.push(c));
          s.on("end", () => {
            out[en.fileName] = Buffer.concat(parts).toString();
            z.readEntry();
          });
        });
      });
      z.on("end", () => ok(out));
      z.on("error", ko);
      z.readEntry();
    }),
  );
}

describe.skipIf(dockerUnavailable)("user deletion", () => {
  let pg: TestPostgres;
  let t: TestApp | undefined;
  let n = 0;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await t?.close();
    await pg?.stop();
  });

  async function fresh(smtp: boolean, log?: string[]) {
    await t?.close();
    t = await testApp(await pg.createDatabase(`deletion_${++n}`), {
      ...(smtp ? { system: SMTP } : {}),
      ...(log ? { log: { write: (l: string) => void log.push(l) } } : {}),
    });
    return { t, admin: await rootAdmin(t) };
  }
  const idOf = async (t: TestApp, username: string) => (await t.auth.byUsername(username))!.id;
  const del = (t: TestApp, admin: Agent, id: string, body: unknown) =>
    t.call(admin, "DELETE", `/admin/users/${id}`, body);

  it("refuses a wrong confirmation, yourself, and a zip without smtp", async () => {
    const { t, admin } = await fresh(false);
    await user(t, "mario");
    const id = await idOf(t, "mario");
    const wrong = await del(t, admin, id, { confirmUsername: "maria", sendZip: false });
    expect([wrong.statusCode, codeOf(wrong)]).toEqual([400, "confirm_mismatch"]);
    const bad = await del(t, admin, id, {});
    expect([bad.statusCode, codeOf(bad)]).toEqual([400, "confirm_mismatch"]);
    const self = await del(t, admin, await idOf(t, "root"), {
      confirmUsername: "root",
      sendZip: false,
    });
    expect(self.statusCode).toBe(403);
    const zip = await del(t, admin, id, { confirmUsername: "mario", sendZip: true });
    expect([zip.statusCode, codeOf(zip)]).toEqual([409, "smtp_not_configured"]);
    expect((await t.auth.byUsername("mario"))!.status).toBe("active");
  });

  it("stops the account at once, exports by email, then shreds everything", async () => {
    const log: string[] = [];
    const { t, admin } = await fresh(true, log);
    const d = await linkDevice(t, await user(t, "mario"));
    await putFile(d, "a.md", Buffer.from("alpha"));
    await putFile(d, "dir/b.md", Buffer.from("beta"));
    const marioWeb = await login(t, "mario");
    const id = await idOf(t, "mario");

    const r = await del(t, admin, id, { confirmUsername: " mario ", sendZip: true });
    expect(r.statusCode).toBe(204);
    const again = await del(t, admin, id, { confirmUsername: "mario", sendZip: true });
    expect(again.statusCode).toBe(409);

    // Grace period: nothing works for the user any more.
    expect((await t.call(marioWeb, "GET", "/account/sessions")).statusCode).toBe(401);
    const relog = await t.call({}, "POST", "/auth/login", { username: "mario", password: PW });
    expect(relog.statusCode).not.toBe(200);
    const dev = await d.call("GET", `/vaults/${d.vaultId}/changes?after=0`);
    expect(codeOf(dev)).toBe("user_blocked");
    const listed = (await t.call(admin, "GET", `/admin/users/${id}`)).json() as {
      status: string;
      deletionAt: string;
    };
    expect(listed.status).toBe("deleting");
    expect(Date.parse(listed.deletionAt)).toBe(t.clock.now + DELETION_GRACE_MS);

    // The export: built by the job, link by email to the user only.
    expect(await t.deletion.runExports()).toBe(1);
    expect(await t.deletion.runExports()).toBe(0);
    await t.outbox.drain();
    const mail = t.mail.filter((m) => m.to === "mario@example.com");
    expect(mail).toHaveLength(1);
    const link = /\/api\/v1\/exports\/([A-Za-z0-9_-]+)/.exec(mail[0]!.text)!;
    expect(link).not.toBeNull();
    expect(t.mail.filter((m) => m.text.includes(link[1]!))).toHaveLength(1);
    const got = await raw(t, "GET", `/exports/${link[1]}`);
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toContain("zip");
    expect(got.headers["cache-control"]).toContain("no-store");
    expect(await unzip(got.rawPayload)).toEqual({ "Note/a.md": "alpha", "Note/dir/b.md": "beta" });
    const unknown = await raw(t, "GET", "/exports/nope");
    expect([unknown.statusCode, codeOf(unknown)]).toEqual([410, "export_expired"]);

    // Not yet due: finalize does nothing.
    expect(await t.deletion.finalizeDue()).toBe(0);
    t.clock.now += DELETION_GRACE_MS;
    expect(await t.deletion.finalizeDue()).toBe(1);

    const [v] = await t.db.select().from(vaults).where(eq(vaults.id, d.vaultId));
    expect(v!.status).toBe("deleted");
    expect(v!.dekWrapped).toBeNull();
    const gone = await raw(t, "GET", `/exports/${link[1]}`);
    expect(gone.statusCode).toBe(410);
    await purgeDeletedVaults(t.db, t.blobStore);
    expect(await t.db.select().from(blobs).where(eq(blobs.vaultId, d.vaultId))).toEqual([]);

    const [u] = await t.db.select().from(users).where(eq(users.id, id));
    expect(u).toMatchObject({
      status: "deleted",
      username: `deleted-${id}`,
      email: `deleted-${id}@invalid`,
      passwordHash: null,
    });
    const list = (await t.call(admin, "GET", "/admin/users")).json() as { username: string }[];
    expect(list.map((x) => x.username)).toEqual(["root"]);
    expect((await t.call(admin, "GET", `/admin/users/${id}`)).statusCode).toBe(404);

    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, "user_deleted"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(link[1]);
    expect(log.join("\n")).not.toContain(link[1]);
    expect(log.join("\n")).not.toContain("mario@example.com");
  });

  it("the grace period runs from the delivery of the link; sent mail keeps no link", async () => {
    const { t, admin } = await fresh(true);
    const d = await linkDevice(t, await user(t, "mario"));
    await putFile(d, "a.md", Buffer.from("alpha"));
    const id = await idOf(t, "mario");
    await del(t, admin, id, { confirmUsername: "mario", sendZip: true });
    await t.deletion.runExports();
    // The email doesn't go out (SMTP down, outbox not drained): nothing is destroyed.
    t.clock.now += DELETION_GRACE_MS + 3600_000;
    expect(await t.deletion.finalizeDue()).toBe(0);
    expect((await t.auth.byUsername("mario"))!.status).toBe("pending_deletion");
    await t.outbox.drain();
    const sentAt = t.clock.now;
    const token = /\/exports\/([A-Za-z0-9_-]+)/.exec(t.mail.at(-1)!.text)![1]!;
    // Sent: the recipient and the link are wiped from the outbox.
    const [row] = await t.db.select().from(emailOutbox).where(eq(emailOutbox.userId, id));
    expect([row!.toEnc.length, row!.paramsEnc.length]).toEqual([0, 0]);
    // Seven full days from delivery, even before the job moves the date.
    t.clock.now = sentAt + DELETION_GRACE_MS - 60_000;
    expect((await raw(t, "GET", `/exports/${token}`)).statusCode).toBe(200);
    expect(await t.deletion.finalizeDue()).toBe(0);
    const [e] = await t.db.select().from(userExports).where(eq(userExports.userId, id));
    expect(e!.expiresAt.getTime()).toBe(sentAt + DELETION_GRACE_MS);
    t.clock.now = sentAt + DELETION_GRACE_MS;
    expect(await t.deletion.finalizeDue()).toBe(1);
    expect(await t.db.select().from(emailOutbox).where(eq(emailOutbox.userId, id))).toEqual([]);
    expect((await raw(t, "GET", `/exports/${token}`)).statusCode).toBe(410);
  });

  it("one user's broken export doesn't hold back the others", async () => {
    const { t, admin } = await fresh(true);
    const m = await linkDevice(t, await user(t, "mario"));
    await putFile(m, "a.md", Buffer.from("alpha"));
    const l = await linkDevice(t, await user(t, "luigi"));
    await putFile(l, "b.md", Buffer.from("beta"));
    for (const name of ["mario", "luigi"])
      await del(t, admin, await idOf(t, name), { confirmUsername: name, sendZip: true });
    const [b] = await t.db.select().from(blobs).where(eq(blobs.vaultId, m.vaultId));
    await t.blobStore.delete(`${m.vaultId}/${b!.blobId}`);
    await t.deletion.runExports();
    await t.outbox.drain();
    expect(t.mail.map((x) => x.to)).toEqual(["luigi@example.com"]);
    // Mario's export waits for a fix; it is retried by the next run.
    const pending = await t.db
      .select()
      .from(userExports)
      .where(eq(userExports.userId, await idOf(t, "mario")));
    expect(pending[0]!.readyAt).toBeNull();
  });

  it("an old reset link dies with the account", async () => {
    const { t, admin } = await fresh(false);
    await user(t, "mario");
    const token = await t.auth.resetLink("mario", "root");
    await del(t, admin, await idOf(t, "mario"), { confirmUsername: "mario", sendZip: false });
    const r = await t.call({}, "POST", "/auth/reset", { token, password: `${PW}-new` });
    expect(r.statusCode).toBe(400);
  });

  it("two admins deleting or blocking each other can't leave the server without one", async () => {
    const { t, admin } = await fresh(false);
    const anna = await secondAdmin(t, admin, "anna");
    const rootId = await idOf(t, "root");
    const annaId = await idOf(t, "anna");
    const results = await Promise.all([
      t.call(admin, "POST", `/admin/users/${annaId}/block`),
      del(t, anna, rootId, { confirmUsername: "root", sendZip: false }),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes[0]).toBeLessThan(300);
    expect(codes[1]).toBe(409);
    const active = await t.db.select().from(users).where(eq(users.role, "admin"));
    expect(active.filter((u) => u.status === "active" && !u.deletionScheduledAt)).toHaveLength(1);
  });

  it("without a zip, finalizes right away", async () => {
    const { t, admin } = await fresh(false);
    const d = await linkDevice(t, await user(t, "mario"));
    await putFile(d, "a.md");
    const id = await idOf(t, "mario");
    expect((await del(t, admin, id, { confirmUsername: "mario", sendZip: false })).statusCode).toBe(
      204,
    );
    expect(await t.deletion.finalizeDue()).toBe(1);
    expect((await t.db.select().from(users).where(eq(users.id, id)))[0]!.status).toBe("deleted");
    // The username can be used again.
    await user(t, "mario");
  });
});
