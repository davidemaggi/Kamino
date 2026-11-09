CREATE TYPE "public"."role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."theme" AS ENUM('light', 'dark', 'system');--> statement-breakpoint
CREATE TYPE "public"."token_kind" AS ENUM('invite', 'activation', 'password_reset', 'setup', 'export_download', 'email_change');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'blocked', 'pending_deletion', 'deleted');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "one_time_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "token_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" uuid,
	"email" text,
	"payload" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by" text,
	CONSTRAINT "one_time_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "recovery_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"ip" text,
	"client" text,
	"seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"username_key" text NOT NULL,
	"email" text NOT NULL,
	"email_key" text NOT NULL,
	"password_hash" text,
	"role" "role" DEFAULT 'user' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"locale" text DEFAULT 'it' NOT NULL,
	"theme" "theme" DEFAULT 'system' NOT NULL,
	"totp_secret" "bytea",
	"totp_enabled_at" timestamp with time zone,
	"totp_last_step" bigint,
	"admin_reset_at" timestamp with time zone,
	"deletion_scheduled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_key_unique" UNIQUE("username_key"),
	CONSTRAINT "users_email_key_unique" UNIQUE("email_key")
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "web_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "one_time_tokens" ADD CONSTRAINT "one_time_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_events_user" ON "security_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "web_sessions_user" ON "web_sessions" USING btree ("user_id");