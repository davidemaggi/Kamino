import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

// Paths owned by the API; they must never fall back to the SPA shell.
const API_PREFIXES = ["/api", "/health", "/version"];

export function isApiPath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Where the web build lives: `public/` next to the server's dist (Docker image),
 * else the monorepo build at apps/web/dist. Returns undefined when neither exists.
 */
export function resolveWebRoot(fromDir: string = dirname(fileURLToPath(import.meta.url))): string | undefined {
  const candidates = [resolve(fromDir, "../public"), resolve(fromDir, "../../web/dist")];
  return candidates.find((dir) => existsSync(resolve(dir, "index.html")));
}

export function webRoutes(app: FastifyInstance, webRoot: string | undefined): void {
  if (!webRoot || !existsSync(webRoot)) {
    app.log.warn("web root not found: the web app will not be served");
    return;
  }
  void app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !isApiPath(req.url)) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({
      message: `Route ${req.method}:${req.url} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });
}
