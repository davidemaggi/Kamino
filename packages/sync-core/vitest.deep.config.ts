import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/sim/**/*.test.ts"], env: { SIM_RUNS: "3000" }, testTimeout: 1_800_000 },
});
