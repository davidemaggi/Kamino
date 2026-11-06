import { defineConfig } from "vitest/config";

// Vitest 5 removed vitest.workspace.ts / defineWorkspace; projects live here.
// Only workspaces that ship code: packages/tsconfig holds JSON presets only.
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/!(tsconfig)"],
  },
});
