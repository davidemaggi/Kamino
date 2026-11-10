import { PROTOCOL_VERSION, ServerMessage, type ClientMessage } from "@kamino/protocol";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

type Msg = ServerMessage;
export interface TestWs {
  socket: WebSocket;
  send(msg: ClientMessage | Record<string, unknown> | string): void;
  /** Next message of `type` (earlier ones of other types are skipped; pings are answered). */
  next<T extends Msg["type"]>(type: T, timeoutMs?: number): Promise<Extract<Msg, { type: T }>>;
  closed(): Promise<{ code: number }>;
  close(): void;
}

export async function openWs(app: FastifyInstance): Promise<TestWs> {
  await app.ready();
  const socket = await app.injectWS("/api/v1/ws");
  const queue: Msg[] = [];
  const waiters: (() => void)[] = [];
  let closedWith: { code: number } | undefined;
  const closeWaiters: ((c: { code: number }) => void)[] = [];
  socket.on("message", (data) => {
    const m = ServerMessage.parse(JSON.parse(String(data)));
    queue.push(m);
    for (const w of waiters.splice(0)) w();
  });
  socket.on("close", (code) => {
    closedWith = { code };
    for (const w of closeWaiters.splice(0)) w(closedWith);
    for (const w of waiters.splice(0)) w();
  });
  return {
    socket,
    send: (msg) => socket.send(typeof msg === "string" ? msg : JSON.stringify(msg)),
    async next(type, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = queue.findIndex((m) => m.type === type);
        if (i >= 0) return queue.splice(i, 1)[0] as never;
        if (closedWith) throw new Error(`socket closed (${closedWith.code}) waiting for ${type}`);
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${type}`);
        await new Promise<void>((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
    },
    closed: () =>
      closedWith ? Promise.resolve(closedWith) : new Promise((r) => closeWaiters.push(r)),
    close: () => socket.terminate(),
  };
}

export const hello = (deviceToken: string, cursor = 0, protocol = PROTOCOL_VERSION) => ({
  type: "hello" as const,
  deviceToken,
  protocol: { min: protocol, max: protocol },
  cursor,
  pluginVersion: "0.1.0",
  platform: "macos",
});
