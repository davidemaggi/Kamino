import type { FastifyInstance } from "fastify";
import { zipFileName } from "../history/zip.js";
import type { UserDeletion } from "../users/deletion.js";

/**
 * F6: the export of a user being deleted. No session (the account is already closed): the token
 * is the proof and the key. Unknown, expired or destroyed → 410 export_expired.
 */
export function exportRoutes(deletion: UserDeletion, now: () => number) {
  return async (app: FastifyInstance) => {
    app.get<{ Params: { token: string } }>("/exports/:token", async (req, reply) => {
      const { stream } = await deletion.openExport(req.params.token);
      return reply
        .header("content-type", "application/zip")
        .header(
          "content-disposition",
          `attachment; filename="${zipFileName(null, new Date(now()))}"`,
        )
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .send(stream);
    });
  };
}
