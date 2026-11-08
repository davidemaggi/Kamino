import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { buildConstants } from "./scripts/build-constants.js";

// The real `obsidian` package ships types only (no runtime JS): alias it to a mock.
export default defineConfig({
  define: buildConstants({ dev: true }),
  resolve: {
    alias: { obsidian: fileURLToPath(new URL("./src/__mocks__/obsidian.ts", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // The bundle test builds dist/ first.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
