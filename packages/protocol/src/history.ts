import { z } from "zod";

export const FileList = z.object({
  files: z.array(
    z.object({
      fileId: z.string(),
      path: z.string(),
      versions: z.number().int().min(1),
      lastChangedAt: z.string(),
    }),
  ),
});
export type FileList = z.infer<typeof FileList>;

export const FileVersions = z.object({
  fileId: z.string(),
  path: z.string(),
  versions: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      device: z.string(),
      size: z.number().min(0),
      current: z.boolean(),
    }),
  ),
});
export type FileVersions = z.infer<typeof FileVersions>;

export const VersionContent = z.object({
  id: z.string(),
  path: z.string(),
  at: z.string(),
  mime: z.string(),
  size: z.number().min(0),
  text: z.string().nullable(),
  previewUrl: z.string().nullable(),
});
export type VersionContent = z.infer<typeof VersionContent>;

export const TrashList = z.object({
  items: z.array(
    z.object({
      fileId: z.string(),
      path: z.string(),
      deletedAt: z.string(),
      expiresAt: z.string(),
      size: z.number().min(0),
    }),
  ),
});
export type TrashList = z.infer<typeof TrashList>;
