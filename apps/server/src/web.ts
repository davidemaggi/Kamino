import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

// Paths owned by the API; they must never fall back to the SPA shell.
const API_PREFIXES = ["/api", "/health", "/version"];

export function isApiPath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * SPA fallback rule: only GET/HEAD for non-API paths whose last segment has no file
 * extension (client routes). Paths like /assets/x.js or /favicon.png are missing files -> 404.
 * Trade-off: a client route whose last segment contains a dot (e.g. /vault/my.note) 404s on a hard reload.
 */
export function isSpaRoute(method: string, url: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (isApiPath(url)) return false;
  const path = url.split("?")[0] ?? url;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return !last.includes(".");
}

/**
 * Where the web build lives: `public/` next to the server's dist (Docker image),
 * else the monorepo build at apps/web/dist. Returns undefined when neither exists.
 */
export function resolveWebRoot(
  fromDir: string = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  const candidates = [resolve(fromDir, "../public"), resolve(fromDir, "../../web/dist")];
  return candidates.find((dir) => existsSync(resolve(dir, "index.html")));
}

export function webRoutes(app: FastifyInstance, webRoot: string | undefined): void {
  // Never echo or log the URL: some carry one-time tokens (/reset/…, /invite/…).
  const notFound = (reply: FastifyReply) =>
    reply.code(404).send({ error: { code: "not_found", message: "not_found", retryable: false } });
  if (!webRoot || !existsSync(webRoot)) {
    app.log.warn("web root not found: the web app will not be served");
    app.setNotFoundHandler((_req, reply) => notFound(reply));
    return;
  }
  void app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((req, reply) => {
    if (isSpaRoute(req.method, req.url)) {
      return reply.sendFile("index.html");
    }
    return notFound(reply);
  });
}
