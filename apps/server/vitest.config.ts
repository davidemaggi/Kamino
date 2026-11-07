import { defineConfig } from "vitest/config";

// Container-backed tests pull and boot Postgres: generous timeouts.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
