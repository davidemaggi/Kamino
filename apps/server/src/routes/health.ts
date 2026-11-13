import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/client.js";

export const PING_TIMEOUT_MS = 1000;

async function ping(db: Db): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS);
  });
  // The server side gives up too, so a stuck database doesn't pile up probe queries.
  const query = db
    .transaction(async (tx) => {
      await tx.execute(sql.raw(`set local statement_timeout = ${PING_TIMEOUT_MS}`));
      await tx.execute(sql`select 1`);
    })
    .then(
      () => true as const,
      () => false as const,
    );
  try {
    return await Promise.race([query, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function healthRoutes(app: FastifyInstance, db: Db): void {
  app.get("/health/live", () => ({ status: "ok" }));

  app.get("/health/ready", async (_req, reply) => {
    if (await ping(db)) return { status: "ok", checks: { database: "up" } };
    return reply.code(503).send({ status: "unavailable", checks: { database: "down" } });
  });
}
