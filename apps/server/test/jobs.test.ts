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
    expect(ran).toEqual(["compact", "sweep", "purge", "email", "exports", "finalize"]);
    const db = createDb(url);
    const schedules = await db.$client<
      { name: string }[]
    >`select name from pgboss.schedule order by name`;
    expect(schedules.map((s) => s.name)).toEqual([
      "email-outbox",
      "journal-compact",
      "upload-sweep",
      "user-deletion-finalize",
      "user-export",
      "vault-purge",
    ]);
    await db.$client.end();
    await jobs.stop();
  }, 60_000);
});
