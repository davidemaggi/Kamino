import type { FastifyInstance } from "fastify";
import { isApiPath } from "../web.js";

/**
 * M7a A1 (T-10, T-11): security headers on every answer.
 * - Scripts only from this origin, nothing inline (the theme bootstrap is a file on purpose).
 * - Styles allow inline: CodeMirror (diff and merge views) injects its own <style> elements.
 *   Style injection can't run code; the trade-off is noted in 04 (T-11).
 * - HSTS only when the public URL is HTTPS: in the LAN scenario it would lock browsers out.
 * - API answers are never cached (they carry private data and one-time tokens).
 */
export function securityHeaders(app: FastifyInstance, publicUrl: string): void {
  const https = publicUrl.startsWith("https://");
  let ws = "";
  try {
    const u = new URL(publicUrl);
    ws = ` ${https ? "wss" : "ws"}://${u.host}`;
  } catch {
    // No usable public URL: 'self' alone.
  }
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self'${ws}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    if (https) reply.header("strict-transport-security", "max-age=31536000");
    if (isApiPath(req.url)) reply.header("cache-control", "no-store");
    else reply.header("content-security-policy", csp);
    return payload;
  });
}
