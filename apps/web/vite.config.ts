import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { PRODUCT_NAME } from "@kamino/brand";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const SERVER = "http://localhost:8080";

/** Injects the product name from @kamino/brand into index.html. */
function brandHtml(): Plugin {
  return {
    name: "brand-html",
    transformIndexHtml: (html) => html.replaceAll("%PRODUCT_NAME%", PRODUCT_NAME),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), brandHtml()],
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
