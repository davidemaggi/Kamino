CREATE TYPE "public"."pairing_status" AS ENUM('waiting', 'requested', 'approved', 'consumed', 'denied', 'cancelled');--> statement-breakpoint
CREATE TABLE "pairings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"origin_device_id" uuid,
	"token_hash" text NOT NULL,
	"status" "pairing_status" DEFAULT 'waiting' NOT NULL,
	"claim_id" uuid,
	"claim_secret_hash" text,
	"device_token_hash" text,
	"request" jsonb,
	"device_id" uuid,
	"reused_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pairings_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "pairings_claim_id_unique" UNIQUE("claim_id")
);
--> statement-breakpoint
ALTER TABLE "pairings" ADD CONSTRAINT "pairings_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pairings" ADD CONSTRAINT "pairings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;