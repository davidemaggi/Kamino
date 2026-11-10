import type { FastifyInstance } from "fastify";
import { DeviceSocket, type SocketDeps } from "../realtime/socket.js";

/** 03 §7: authentication is the first message (`hello`), never the URL or a cookie. */
export function wsRoutes(deps: SocketDeps) {
  return async (app: FastifyInstance) => {
    app.get("/ws", { websocket: true }, (socket) => {
      new DeviceSocket(socket, deps);
    });
  };
}
