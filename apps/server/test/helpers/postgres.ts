import { PostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";

export type TestPostgres = {
  /** Creates an empty database and returns its connection URL. */
  createDatabase(name: string): Promise<string>;
  stop(): Promise<void>;
};

export async function startPostgres(): Promise<TestPostgres> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const adminUrl = container.getConnectionUri();
  return {
    async createDatabase(name) {
      const admin = postgres(adminUrl, { max: 1 });
      try {
        await admin.unsafe(`create database "${name}"`);
      } finally {
        await admin.end();
      }
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      return url.toString();
    },
    async stop() {
      await container.stop();
    },
  };
}
