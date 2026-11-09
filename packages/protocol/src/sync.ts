import { z } from "zod";
import { ErrorCode } from "./errors.js";

/** Client-generated identifiers (UUIDv7 recommended, 03 §1.7). */
export const SyncId = z.string().min(1).max(64);
/** SHA-256 of the plaintext, lowercase hex. */
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/);
/** Canonical path: "/" separators, NFC, "{config}/" prefix for the configuration folder (03 §2). */
export const SyncPath = z.string().min(1).max(4096);
export const FileKind = z.enum(["file", "folder"]);

export const PutOp = z.object({
  type: z.literal("put"),
  opId: SyncId,
  fileId: SyncId,
  versionId: SyncId,
  path: SyncPath,
  baseVersionId: SyncId.nullable(),
  contentHash: ContentHash,
  size: z.number().int().min(0),
  mtime: z.number().int(),
});
export const MkdirOp = z.object({
  type: z.literal("mkdir"),
  opId: SyncId,
  fileId: SyncId,
  path: SyncPath,
});
export const MoveOp = z.object({
  type: z.literal("move"),
  opId: SyncId,
  fileId: SyncId,
  fromPath: SyncPath,
  toPath: SyncPath,
});
/** `baseVersionId` is null only for folders. */
export const DeleteOp = z.object({
  type: z.literal("delete"),
  opId: SyncId,
  fileId: SyncId,
  baseVersionId: SyncId.nullable(),
});
export const Op = z.discriminatedUnion("type", [PutOp, MkdirOp, MoveOp, DeleteOp]);
export type PutOp = z.infer<typeof PutOp>;
export type MkdirOp = z.infer<typeof MkdirOp>;
export type MoveOp = z.infer<typeof MoveOp>;
export type DeleteOp = z.infer<typeof DeleteOp>;
export type Op = z.infer<typeof Op>;

/** `seq` = journal entry of the op, or the current head when the op added none (e.g. delete of a deleted file). */
export const AcceptedResult = z.object({
  status: z.literal("accepted"),
  seq: z.number().int().min(0),
  fileId: SyncId,
  versionId: SyncId.optional(),
  path: SyncPath,
});
export const ConflictResult = z.object({
  status: z.literal("conflict"),
  conflictId: SyncId,
  headVersionId: SyncId,
});
/** Rejections are not recorded: the same opId may be sent again. */
export const RejectedResult = z.object({
  status: z.literal("rejected"),
  code: ErrorCode,
  path: SyncPath.optional(),
});
export const FinalResult = z.discriminatedUnion("status", [
  AcceptedResult,
  ConflictResult,
  RejectedResult,
]);
export const DuplicateResult = z.object({ status: z.literal("duplicate"), original: FinalResult });
export const OpResult = z.discriminatedUnion("status", [
  AcceptedResult,
  ConflictResult,
  RejectedResult,
  DuplicateResult,
]);
export type AcceptedResult = z.infer<typeof AcceptedResult>;
export type ConflictResult = z.infer<typeof ConflictResult>;
export type RejectedResult = z.infer<typeof RejectedResult>;
export type FinalResult = z.infer<typeof FinalResult>;
export type OpResult = z.infer<typeof OpResult>;

export const CommitRequest = z.object({ ops: z.array(Op).min(1).max(500) });
export const CommitResponse = z.object({
  results: z.array(OpResult),
  head: z.number().int().min(0),
});
export type CommitResponse = z.infer<typeof CommitResponse>;

export const JournalType = z.enum([
  "file_put",
  "file_moved",
  "file_deleted",
  "file_restored",
  "folder_created",
  "folder_deleted",
  "conflict_opened",
  "conflict_resolved",
  "vault_settings_changed",
]);
export type JournalType = z.infer<typeof JournalType>;
/** `type` is a free string: clients skip unknown types only when `ignorable` (03 §13). */
export const JournalEntry = z.object({
  seq: z.number().int().min(1),
  type: z.string(),
  fileId: SyncId,
  kind: FileKind.optional(),
  opId: SyncId.optional(),
  versionId: SyncId.optional(),
  path: SyncPath,
  contentHash: ContentHash.optional(),
  size: z.number().int().min(0).optional(),
  mtime: z.number().int().optional(),
  conflictId: SyncId.optional(),
  deviceId: SyncId,
  at: z.string(),
  ignorable: z.boolean().optional(),
});
export type JournalEntry = z.infer<typeof JournalEntry>;
export const ChangesResponse = z.object({
  entries: z.array(JournalEntry),
  head: z.number().int().min(0),
  hasMore: z.boolean(),
});
export type ChangesResponse = z.infer<typeof ChangesResponse>;

export const SnapshotFile = z.object({
  fileId: SyncId,
  kind: FileKind,
  path: SyncPath,
  versionId: SyncId.nullable(),
  contentHash: ContentHash.nullable(),
  size: z.number().int().min(0),
  mtime: z.number().int(),
});
export const Snapshot = z.object({
  head: z.number().int().min(0),
  files: z.array(SnapshotFile),
  openConflicts: z.array(z.object({ conflictId: SyncId, fileId: SyncId })),
});
export type SnapshotFile = z.infer<typeof SnapshotFile>;
export type Snapshot = z.infer<typeof Snapshot>;
