import { z } from "zod";

export const VersionRef = z.object({ device: z.string(), at: z.string() });
export const ConflictSummary = z.object({
  id: z.string(),
  vaultId: z.string(),
  vaultName: z.string(),
  path: z.string(),
  kind: z.enum(["concurrent_edit", "both_created"]),
  binary: z.boolean(),
  mine: VersionRef,
  incoming: VersionRef,
});
export type ConflictSummary = z.infer<typeof ConflictSummary>;
export const ConflictList = z.array(ConflictSummary);

export const BinaryMeta = z.object({
  size: z.number().min(0),
  mime: z.string(),
  previewUrl: z.string().nullable(),
});
export type BinaryMeta = z.infer<typeof BinaryMeta>;

const base = ConflictSummary.omit({ binary: true });
export const ConflictDetail = z.discriminatedUnion("binary", [
  base.extend({ binary: z.literal(false), mineText: z.string(), incomingText: z.string() }),
  base.extend({ binary: z.literal(true), mineFile: BinaryMeta, incomingFile: BinaryMeta }),
]);
export type ConflictDetail = z.infer<typeof ConflictDetail>;

export const Resolution = z.union([
  z.literal("keep_mine"),
  z.literal("keep_incoming"),
  z.literal("keep_both"),
  z.object({ manual: z.string() }),
]);
export type Resolution = z.infer<typeof Resolution>;
/**
 * expectedIncomingAt / expectedMineAt: the incoming and current versions the user looked at
 * (protocol §9.3): if either changed meanwhile the server answers 409 stale_resolution.
 */
export const ResolveRequest = z.object({
  resolution: Resolution,
  expectedIncomingAt: z.string(),
  expectedMineAt: z.string().optional(),
});

export const BulkStrategy = z.enum(["keep_mine", "keep_incoming", "keep_both"]);
export type BulkStrategy = z.infer<typeof BulkStrategy>;
/** The conflicts the user saw, each with the versions shown: those changed meanwhile are skipped. */
export const ResolveAllRequest = z.object({
  strategy: BulkStrategy,
  items: z
    .array(
      z.object({
        id: z.string(),
        expectedIncomingAt: z.string(),
        expectedMineAt: z.string().optional(),
      }),
    )
    .min(1),
});
export type ResolveAllRequest = z.infer<typeof ResolveAllRequest>;
export const ResolveAllResponse = z.object({ resolved: z.number().int().min(0) });
