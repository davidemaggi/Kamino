import { PgBoss } from "pg-boss";
import type { Logger } from "../observability/logger.js";

/** Queues of the background jobs (ADR 0008). */
export const JOBS = {
  compact: "journal-compact",
  sweep: "upload-sweep",
  purge: "vault-purge",
  email: "email-outbox",
} as const;
export type JobName = keyof typeof JOBS;

const SCHEDULES: Record<JobName, string> = {
  compact: "17 3 * * *", // daily, at night
  sweep: "7 * * * *", // hourly (C10)
  purge: "37 * * * *", // hourly: blobs of deleted vaults (F5)
  email: "* * * * *", // every minute: retries with backoff (F8)
};

export interface Jobs {
  stop(): Promise<void>;
  /** Queues a job now and waits for it to finish (tests, CLI). */
  runNow(name: JobName, timeoutMs?: number): Promise<void>;
  /** Queues a job without waiting (an email just enqueued). */
  kick(name: JobName): void;
}

/**
 * Starts pg-boss after the migrations (so after the master key check): it creates and updates its
 * own `pgboss` schema. Errors are logged by name only.
 */
export async function startJobs(
  url: string,
  handlers: Record<JobName, () => Promise<unknown>>,
  log: Logger,
  opts: { pollingIntervalSeconds?: number } = {},
): Promise<Jobs> {
  const boss = new PgBoss({ connectionString: url, schema: "pgboss" });
  boss.on("error", (e: Error) => log.error({ err: e.name }, "background jobs error"));
  await boss.start();
  for (const name of Object.keys(JOBS) as JobName[]) {
    const queue = JOBS[name];
    await boss.createQueue(queue);
    await boss.work(
      queue,
      { pollingIntervalSeconds: opts.pollingIntervalSeconds ?? 2 },
      async () => {
        await handlers[name]();
      },
    );
    await boss.schedule(queue, SCHEDULES[name]);
  }
  return {
    stop: () => boss.stop({ graceful: true }),
    kick(name) {
      boss.send(JOBS[name]).catch((e: Error) => log.warn({ err: e.name }, "job not queued"));
    },
    async runNow(name, timeoutMs = 10_000) {
      const queue = JOBS[name];
      const id = await boss.send(queue);
      if (!id) throw new Error("job not queued");
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const job = await boss.getJobById(queue, id);
        if (job?.state === "completed") return;
        if (job?.state === "failed") throw new Error(`job ${queue} failed`);
        if (Date.now() > deadline) throw new Error(`job ${queue} timed out`);
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };
}
