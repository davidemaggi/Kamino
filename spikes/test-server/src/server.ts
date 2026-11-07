// Throwaway test server for spikes R-1 (chunked upload) and R-4 (WebSocket + catch-up).
// Plain node:http + ws. Usage: pnpm server [--port 8787] [--interval 1000]
//
// HTTP
//   GET  /health                          -> { ok, now, lastSeq }
//   POST /upload/start  {name,size}       -> { uploadId }
//   PUT  /upload/:id/chunk/:index  <bin>  -> { index, bytes }      (chunks in order)
//   POST /upload/:id/finish               -> { sha256, bytes, chunks, ms, sizeMatches }
//   POST /log  {text}                     -> 204 (lets the plugin echo lines to the server console)
// WebSocket /ws
//   server -> client  { type: "event", seq, ts } every --interval ms, only after the client's hello
//   client -> server  { type: "hello", lastSeq }  -> { type: "catchup", from, to, truncated, events }
//   client -> server  { type: "ping", t }         -> { type: "pong", t, serverTs }
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import { EventFeed } from "./feed.ts";
import { UploadError, UploadStore } from "./uploads.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: process.env.SPIKE_PORT ?? "8787" },
    interval: { type: "string", default: "1000" },
  },
});
const port = Number(values.port);
const intervalMs = Number(values.interval);

function log(...parts: unknown[]): void {
  console.log(new Date().toISOString(), ...parts);
}

const uploads = new UploadStore();
const feed = new EventFeed();

function send(res: ServerResponse, status: number, body?: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204);

  if (req.method === "GET" && path === "/health") {
    return send(res, 200, { ok: true, now: Date.now(), lastSeq: feed.lastSeq });
  }

  if (req.method === "POST" && path === "/log") {
    const { text } = JSON.parse((await readBody(req)).toString("utf8")) as { text?: string };
    log("[client]", text ?? "");
    return send(res, 204);
  }

  if (req.method === "POST" && path === "/upload/start") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}") as {
      name?: string;
      size?: number;
    };
    const session = uploads.start(body.name ?? "unnamed", body.size ?? null);
    log(`[R-1] upload ${session.id} started (${session.name}, declared ${body.size ?? "?"} B)`);
    return send(res, 200, { uploadId: session.id });
  }

  const chunk = /^\/upload\/([^/]+)\/chunk\/(\d+)$/.exec(path);
  if (req.method === "PUT" && chunk) {
    const data = await readBody(req);
    const session = uploads.chunk(chunk[1]!, Number(chunk[2]), data);
    if (session.nextIndex % 10 === 0) {
      log(`[R-1] upload ${session.id} chunk #${session.nextIndex} (${mb(session.bytes)} MB)`);
    }
    return send(res, 200, { index: session.nextIndex - 1, bytes: session.bytes });
  }

  const finish = /^\/upload\/([^/]+)\/finish$/.exec(path);
  if (req.method === "POST" && finish) {
    const done = uploads.finish(finish[1]!);
    const rate = done.ms > 0 ? (done.bytes / 1048576 / (done.ms / 1000)).toFixed(1) : "?";
    log(
      `[R-1] upload ${done.id} finished: ${mb(done.bytes)} MB in ${done.chunks} chunks, ` +
        `${done.ms} ms (${rate} MB/s), sha256 ${done.sha256}`,
    );
    return send(res, 200, done);
  }

  send(res, 404, { error: "not found" });
}

function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const status = err instanceof UploadError ? err.status : 500;
    log(`HTTP ${req.method} ${req.url} -> ${status}: ${String(err)}`);
    if (!res.headersSent) send(res, status, { error: String(err) });
  });
});

// --- R-4 WebSocket -----------------------------------------------------------
const wss = new WebSocketServer({ server, path: "/ws" });
let nextClientId = 1;
const alive = new WeakMap<WebSocket, boolean>();
// Sockets receive live events only after their hello/catch-up: the catch-up is
// always sent before any live event, so clients never see live-before-catch-up.
const subscribed = new Set<WebSocket>();

wss.on("connection", (ws, req) => {
  const id = nextClientId++;
  alive.set(ws, true);
  log(`[R-4] ws #${id} open from ${req.socket.remoteAddress} (lastSeq ${feed.lastSeq})`);
  ws.on("pong", () => alive.set(ws, true));
  ws.on("message", (raw) => {
    let msg: { type?: string; lastSeq?: number; t?: number };
    try {
      msg = JSON.parse(String(raw)) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "hello") {
      const from = typeof msg.lastSeq === "number" ? msg.lastSeq : feed.lastSeq;
      const { events, truncated } = feed.since(from);
      // Synchronous between since() and add(): no tick can interleave, so the
      // first live event this socket gets is exactly lastSeq+1 after the catch-up.
      ws.send(JSON.stringify({ type: "catchup", from, to: feed.lastSeq, truncated, events }));
      subscribed.add(ws);
      log(`[R-4] ws #${id} hello lastSeq=${from} -> catch-up ${events.length} events`);
    } else if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: msg.t, serverTs: Date.now() }));
    }
  });
  ws.on("close", (code, reason) => {
    subscribed.delete(ws);
    log(`[R-4] ws #${id} close code=${code} reason=${String(reason) || "-"}`);
  });
  ws.on("error", (err) => log(`[R-4] ws #${id} error ${String(err)}`));
});

// Protocol-level keepalive: drop sockets that miss a pong (half-open connections).
const keepalive = setInterval(() => {
  for (const ws of wss.clients) {
    if (alive.get(ws) === false) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
}, 15_000);

const ticker = setInterval(() => {
  const event = feed.next();
  const payload = JSON.stringify({ type: "event", ...event });
  for (const ws of subscribed) if (ws.readyState === ws.OPEN) ws.send(payload);
}, intervalMs);

server.listen(port, "0.0.0.0", () => {
  log(`spike test server listening on port ${port} (event interval ${intervalMs} ms)`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) log(`  LAN URL: http://${a.address}:${port}`);
    }
  }
  log(`  local URL: http://localhost:${port}`);
});

function shutdown(): void {
  clearInterval(keepalive);
  clearInterval(ticker);
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
