import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { PRODUCT_NAME } from "@kamino/brand";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Dev only: serves MSW's service worker from node_modules (never copied to public/ or dist/). */
function mswWorker(): Plugin {
  return {
    name: "msw-worker",
    apply: "serve",
    configureServer(server) {
      const file = createRequire(import.meta.url).resolve("msw/mockServiceWorker.js");
      server.middlewares.use("/mockServiceWorker.js", (_req, res) => {
        res.setHeader("content-type", "application/javascript");
        res.end(readFileSync(file));
      });
    },
  };
}

const SERVER = "http://localhost:8080";

/** Injects the product name from @kamino/brand into index.html. */
function brandHtml(): Plugin {
  return {
    name: "brand-html",
    transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", PRODUCT_NAME),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), brandHtml(), mswWorker()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    proxy: { "/api": SERVER, "/health": SERVER, "/version": SERVER },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "test/**/*.test.ts"],
    setupFiles: ["src/test/setup.ts"],
    testTimeout: 30_000,
  },
});
