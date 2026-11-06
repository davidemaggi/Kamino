import { generated } from "./build-info.generated.js";

export type BuildInfo = {
  version: string;
  codename: string;
  commit: string;
  buildDate: string;
};

/** Values baked at build time by scripts/gen-build-info.ts. */
export const buildInfo: BuildInfo = { ...generated };
