import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests of the web app in hybrid mode against a real, seeded server
 * (apps/server/test/e2e-server.ts: throwaway Postgres via testcontainers, so Docker is needed).
 * Run with `pnpm --filter @kamino/web e2e`.
 */
const API_PORT = 8181;
const WEB_PORT = 5181;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  use: { ...devices["Desktop Chrome"], baseURL: `http://localhost:${WEB_PORT}`, locale: "it-IT" },
  webServer: [
    {
      command: "pnpm --filter @kamino/server exec tsx test/e2e-server.ts",
      env: { KAMINO_E2E_PORT: String(API_PORT) },
      url: `http://127.0.0.1:${API_PORT}/health/live`,
      timeout: 180_000,
      stdout: "pipe",
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      env: { VITE_KAMINO_API: "hybrid", KAMINO_DEV_SERVER: `http://127.0.0.1:${API_PORT}` },
      url: `http://localhost:${WEB_PORT}`,
      timeout: 60_000,
    },
  ],
});
