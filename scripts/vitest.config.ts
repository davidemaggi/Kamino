import { defineConfig } from "vitest/config";

// Standalone project: the root vitest.config.ts only covers apps/* and packages/*.
// Run with `vitest run --root scripts`.
export default defineConfig({
  test: { include: ["*.test.ts"] },
});
