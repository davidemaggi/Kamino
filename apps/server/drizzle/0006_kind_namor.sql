ALTER TABLE "files" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vaults" ADD COLUMN "journal_floor_at" timestamp with time zone;