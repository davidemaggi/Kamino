import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.js";
import { startJobs } from "../src/jobs/boss.js";
import { dockerUnavailable, startPostgres, type TestPostgres } from "./helpers/postgres.js";

describe.skipIf(dockerUnavailable)("background jobs (pg-boss)", () => {
  let pg: TestPostgres;
  beforeAll(async () => {
    pg = await startPostgres();
  }, 120_000);
  afterAll(async () => pg?.stop());

  it("creates its schema, schedules both jobs and runs them on demand", async () => {
    const url = await pg.createDatabase("jobs");
    const ran: string[] = [];
    const jobs = await startJobs(
      url,
      {
        compact: async () => ran.push("compact"),
        sweep: async () => ran.push("sweep"),
        purge: async () => ran.push("purge"),
        email: async () => ran.push("email"),
        exports: async () => ran.push("exports"),
        finalize: async () => ran.push("finalize"),
        retention: async () => ran.push("retention"),
      },
      pino({ level: "silent" }),
      { pollingIntervalSeconds: 0.5 },
    );
    await jobs.runNow("compact");
    await jobs.runNow("sweep");
    await jobs.runNow("purge");
    await jobs.runNow("email");
    await jobs.runNow("exports");
    await jobs.runNow("finalize");
    await jobs.runNow("retention");
    expect(ran).toEqual(["compact", "sweep", "purge", "email", "exports", "finalize", "retention"]);
    const db = createDb(url);
    const schedules = await db.$client<
      { name: string }[]
    >`select name from pgboss.schedule order by name`;
    expect(schedules.map((s) => s.name)).toEqual([
      "email-outbox",
      "history-retention",
      "journal-compact",
      "upload-sweep",
      "user-deletion-finalize",
      "user-export",
      "vault-purge",
    ]);
    await db.$client.end();
    await jobs.stop();
  }, 60_000);

  it("logs a failing job with its name and error class only", async () => {
    const url = await pg.createDatabase("jobs_fail");
    const lines: Record<string, unknown>[] = [];
    const log = pino(
      { level: "info" },
      { write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>) },
    );
    const ok = async () => {};
    const jobs = await startJobs(
      url,
      {
        compact: async () => {
          throw new TypeError("secret note.md");
        },
        sweep: ok,
        purge: ok,
        email: ok,
        exports: ok,
        finalize: ok,
        retention: ok,
      },
      log,
      { pollingIntervalSeconds: 0.5 },
    );
    jobs.kick("compact");
    const deadline = Date.now() + 15_000;
    while (!lines.some((l) => l.msg === "job failed") && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 100));
    const failed = lines.find((l) => l.msg === "job failed");
    expect(failed).toMatchObject({ job: "compact", err: { name: "TypeError" } });
    expect(JSON.stringify(lines)).not.toContain("secret");
    await jobs.stop();
  }, 60_000);
});
