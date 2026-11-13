import { PairingClaimRequest } from "@kamino/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { fail, requireUser } from "../auth/http.js";
import { RateLimiter } from "../auth/rate-limit.js";
import type { Db } from "../db/client.js";
import { deviceGuard } from "../devices/auth.js";
import type { PairingActor, PairingService } from "../pairing/service.js";
import { ownedVault } from "../vaults/access.js";
import type { VaultService } from "../vaults/service.js";
import { parse } from "./auth.js";

type Id = { Params: { id: string } };

/**
 * P3 (03 §10, F11): pairing. The origin is the signed-in owner (web) or a device of the vault
 * (Bearer); the new device has no account here: the link token, then the claim secret, are its proof.
 */
export function pairingRoutes(deps: {
  db: Db;
  vaults: VaultService;
  pairing: PairingService;
  now: () => number;
}) {
  const { pairing } = deps;
  const guard = deviceGuard(deps.db, deps.now);
  type Bucket = "claim" | "poll" | "offer";
  const limiter = new RateLimiter<Bucket>(
    {
      claim: { max: 20, windowMs: 15 * 60_000 },
      // Per user: an offer may send an email.
      offer: { max: 30, windowMs: 15 * 60_000 },
      // The plugin polls every 2 s for at most 10 minutes: 300 requests per claim.
      poll: { max: 900, windowMs: 15 * 60_000 },
    },
    deps.now,
  );
  const limited = (bucket: Bucket, req: FastifyRequest, reply: FastifyReply, key = req.ip) => {
    const r = limiter.hit(bucket, key);
    if (r.ok) return false;
    void fail(reply, 429, "rate_limited", r.retryAfterSec);
    return true;
  };

  /** Session (web) or device token (plugin); null = the reply has been sent. */
  const actor = async (req: FastifyRequest, reply: FastifyReply): Promise<PairingActor | null> => {
    if (req.headers.authorization?.startsWith("Bearer ")) {
      await guard(req, reply);
      if (reply.sent || !req.device) return null;
      return { userId: req.device.userId, deviceVaultId: req.device.vaultId };
    }
    const s = requireUser(req, reply);
    return s ? { userId: s.user.id } : null;
  };

  const claimSecret = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    return h?.startsWith("Claim ") ? h.slice(6) : "";
  };

  return async (app: FastifyInstance) => {
    app.post<Id & { Querystring: { email?: string } }>(
      "/vaults/:id/pairings",
      async (req, reply) => {
        const a = await actor(req, reply);
        if (!a) return reply;
        if (a.deviceVaultId !== undefined && a.deviceVaultId !== req.params.id)
          return fail(reply, 404, "not_found");
        const { vault } = await ownedVault(deps.vaults, a.userId, req.params.id);
        if (limited("offer", req, reply, a.userId)) return reply;
        return pairing.offer(
          vault,
          { userId: a.userId, ...(req.device ? { deviceId: req.device.id } : {}) },
          { email: req.query.email === "1" },
        );
      },
    );
    app.get<Id>("/pairings/:id", async (req, reply) => {
      const a = await actor(req, reply);
      if (!a) return reply;
      return pairing.state(req.params.id, a);
    });
    for (const action of ["approve", "deny", "cancel"] as const)
      app.post<Id>(`/pairings/:id/${action}`, async (req, reply) => {
        const a = await actor(req, reply);
        if (!a) return reply;
        return pairing[action](req.params.id, a);
      });

    app.post("/pairings/claim", async (req, reply) => {
      if (limited("claim", req, reply)) return reply;
      const b = parse(PairingClaimRequest, req, reply);
      if (!b) return reply;
      return pairing.claim(b.token, b);
    });
    app.get<{ Params: { claimId: string } }>("/pairings/claims/:claimId", async (req, reply) => {
      if (limited("poll", req, reply)) return reply;
      return pairing.poll(req.params.claimId, claimSecret(req));
    });
    app.post<{ Params: { claimId: string } }>(
      "/pairings/claims/:claimId/cancel",
      async (req, reply) => {
        if (limited("poll", req, reply)) return reply;
        await pairing.withdraw(req.params.claimId, claimSecret(req));
        return reply.code(204).send();
      },
    );
  };
}
