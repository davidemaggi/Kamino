import { defineConfig } from "vitest/config";

// Vitest 5 removed vitest.workspace.ts / defineWorkspace; projects live here.
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
