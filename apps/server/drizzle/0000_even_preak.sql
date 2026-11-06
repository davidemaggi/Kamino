CREATE TABLE "key_check" (
	"kek_id" text PRIMARY KEY NOT NULL,
	"check_value" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
