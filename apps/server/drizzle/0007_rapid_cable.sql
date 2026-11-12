CREATE TABLE "system_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"secret_enc" "bytea",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
