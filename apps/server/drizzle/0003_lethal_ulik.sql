ALTER TABLE "devices" ADD COLUMN "settings_override_enc" "bytea";--> statement-breakpoint
ALTER TABLE "vaults" ADD COLUMN "journal_floor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "vaults" ADD COLUMN "settings_enc" "bytea";