import { z } from "zod";

export const VersionInfo = z.object({
  version: z.string(),
  codename: z.string(),
  protocol: z.object({ min: z.number().int(), max: z.number().int() }),
  commit: z.string(),
  buildDate: z.string(),
});
export type VersionInfo = z.infer<typeof VersionInfo>;
