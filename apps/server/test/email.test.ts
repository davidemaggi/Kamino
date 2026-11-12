import { PRODUCT_NAME } from "@kamino/brand";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config/schema.js";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { emailOutbox } from "../src/db/schema.js";
import type { Message, Transport } from "../src/email/mailer.js";
import { MAX_ATTEMPTS, Outbox } from "../src/email/outbox.js";
import { render, TEMPLATES } from "../src/email/templates.js";
import { ApiError } from "../src/http/errors.js";
import { createLogger } from "../src/observability/logger.js";
import { SystemConfigService } from "../src/system/config.js";
import { kek } from "./helpers/app.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

const base: Config = {
  publicUrl: "http://localhost:8080",
  port: 0,
  databaseUrl: "",
  masterKey: "",
  logLevel: "debug",
  storage: { kind: "fs", dir: "/tmp/x" },
  stagingDir: "/tmp/y",
  maxFileBytes: 1_000_000,
};
const SMTP = {
  smtp: { host: "smtp.example.com", from: "noreply@example.com", password: "smtp-pw-123" },
};
const LINK = "https://sync.example.com/invite/tok-SECRET-123";
const TO = "mario.rossi@example.com";

describe("email templates", () => {
  it("every template exists in it and en, with the product name from @kamino/brand", () => {
    for (const t of TEMPLATES)
      for (const l of ["it", "en"] as const) {
        const r = render(t, l, { link: LINK, username: "mario", device: "Mac", expires: "x" });
        expect(r.subject).toContain(PRODUCT_NAME);
        expect(r.text).not.toMatch(/\{\w+\}/);
        expect(r.html).toContain(`lang="${l}"`);
      }
    expect(render("invite", "it", { link: LINK, username: "mario" }).text).toContain(LINK);
    expect(render("invite", "en", { link: LINK, username: "mario" }).subject).toBe(
      `Your invitation to ${PRODUCT_NAME}`,
    );
  });

  it("escapes parameters in the HTML version", () => {
    expect(render("new_device", "en", { device: "<b>x</b>" }).html).not.toContain("<b>x</b>");
  });
});

describe.skipIf(dockerUnavailable)("email outbox", () => {
  let pg: TestPostgres;
  let db: Db;
  let n = 0;
  let clock: { now: number };
  let sent: Message[];
  let failing: Error | null;
  let logs: string[];
  const transport = (): Transport => ({
    async send(m) {
      if (failing) throw failing;
      sent.push(m);
    },
  });
  const make = async (config: Config = { ...base, system: SMTP }) =>
    new Outbox(
      db,
      kek,
      new SystemConfigService(db, config, kek),
      transport,
      () => clock.now,
      createLogger("debug", { write: (l: string) => void logs.push(l) }),
    );

  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => {
    await db?.$client.end();
    await pg?.stop();
  });
  beforeEach(async () => {
    await db?.$client.end();
    db = createDb(await pg.createDatabase(`mail_${++n}`));
    await runMigrations(db, async () => undefined);
    clock = { now: Date.UTC(2026, 10, 12, 9) };
    sent = [];
    failing = null;
    logs = [];
  });

  it("enqueue + drain delivers; recipient and link are encrypted at rest", async () => {
    const o = await make();
    await o.enqueue(TO, "invite", "it", { link: LINK, username: "mario" });
    const [row] = await db.select().from(emailOutbox);
    expect(row!.toEnc.includes(TO)).toBe(false);
    expect(row!.paramsEnc.includes("tok-SECRET-123")).toBe(false);
    await o.drain();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(TO);
    expect(sent[0]!.text).toContain(LINK);
    expect(sent[0]!.subject).toBe(`Il tuo invito a ${PRODUCT_NAME}`);
    await o.drain();
    expect(sent).toHaveLength(1);
  });

  it("without SMTP, enqueue → 409 smtp_not_configured", async () => {
    const o = await make(base);
    const e = await o.enqueue(TO, "reset", "en", { link: LINK }).catch((x: unknown) => x);
    expect((e as ApiError).code).toBe("smtp_not_configured");
    expect((e as ApiError).status).toBe(409);
  });

  it("a transport error is retried with backoff and given up after the last attempt", async () => {
    const o = await make();
    await o.enqueue(TO, "reset", "en", { link: LINK });
    failing = Object.assign(new Error(`550 rejected ${TO} ${LINK}`), { code: "EENVELOPE" });
    await o.drain();
    let [row] = await db.select().from(emailOutbox);
    expect(row!.attempts).toBe(1);
    expect(row!.lastErrorCode).toBe("EENVELOPE");
    expect(row!.nextAt.getTime() - clock.now).toBe(60_000);
    await o.drain(); // not due yet
    expect((await db.select().from(emailOutbox))[0]!.attempts).toBe(1);
    clock.now += 60_000;
    await o.drain();
    [row] = await db.select().from(emailOutbox);
    expect(row!.attempts).toBe(2);
    expect(row!.nextAt.getTime() - clock.now).toBe(5 * 60_000);
    for (let i = 2; i < MAX_ATTEMPTS; i++) {
      clock.now += 6 * 3600_000;
      await o.drain();
    }
    [row] = await db.select().from(emailOutbox);
    expect(row!.attempts).toBe(MAX_ATTEMPTS);
    expect(row!.nextAt.getTime() - clock.now).toBe(6 * 3600_000);
    // Given up: no further attempt, even once the transport works again.
    failing = null;
    clock.now += 7 * 3600_000;
    await o.drain();
    expect(sent).toHaveLength(0);
    expect(row!.lastErrorCode).toBe("EENVELOPE");
    // Never the recipient, the link or the server's text in the logs.
    const all = logs.join("\n");
    expect(logs.length).toBeGreaterThan(0);
    expect(all).not.toContain(TO);
    expect(all).not.toContain("tok-SECRET-123");
    expect(all).not.toContain("rejected");
  });

  it("recovers after a failure once the transport works", async () => {
    const o = await make();
    await o.enqueue(TO, "pairing_link", "en", { link: LINK });
    failing = new Error("ECONNREFUSED");
    await o.drain();
    failing = null;
    clock.now += 60_000;
    await o.drain();
    expect(sent).toHaveLength(1);
    expect((await db.select().from(emailOutbox))[0]!.sentAt).not.toBeNull();
  });

  it("test() reports the technical error without the password", async () => {
    const o = await make();
    expect(await o.test(TO)).toEqual({ ok: true });
    expect(sent[0]!.to).toBe(TO);
    failing = Object.assign(new Error("Invalid login: 535 bad credentials for smtp-pw-123"), {
      code: "EAUTH",
      responseCode: 535,
    });
    const r = await o.test(TO);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("EAUTH");
      expect(r.error).toContain("535");
      expect(r.error).not.toContain("smtp-pw-123");
    }
    expect(logs.join("\n")).not.toContain("smtp-pw-123");
  });
});
