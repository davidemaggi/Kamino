CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"to_enc" "bytea" NOT NULL,
	"template" text NOT NULL,
	"locale" text NOT NULL,
	"params_enc" "bytea" NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"secret_enc" "bytea",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_outbox_due" ON "email_outbox" USING btree ("next_at") WHERE "email_outbox"."sent_at" is null;