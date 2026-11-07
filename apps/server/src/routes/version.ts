import { PROTOCOL_MIN_SUPPORTED, PROTOCOL_VERSION, type VersionInfo } from "@kamino/protocol";
import type { FastifyInstance } from "fastify";
import type { BuildInfo } from "../build-info.js";

export function versionRoutes(app: FastifyInstance, buildInfo: BuildInfo): void {
  const info: VersionInfo = {
    version: buildInfo.version,
    codename: buildInfo.codename,
    protocol: { min: PROTOCOL_MIN_SUPPORTED, max: PROTOCOL_VERSION },
    commit: buildInfo.commit,
    buildDate: buildInfo.buildDate,
  };
  app.get("/version", () => info);
}
