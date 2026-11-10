CREATE TYPE "public"."device_platform" AS ENUM('windows', 'macos', 'linux', 'ios', 'android', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."vault_status" AS ENUM('active', 'deleted');--> statement-breakpoint
ALTER TYPE "public"."token_kind" ADD VALUE 'device_enrollment';--> statement-breakpoint
CREATE TABLE "applied_ops" (
	"vault_id" uuid NOT NULL,
	"op_id" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "applied_ops_vault_id_op_id_pk" PRIMARY KEY("vault_id","op_id")
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"vault_id" uuid NOT NULL,
	"blob_id" text NOT NULL,
	"size" bigint NOT NULL,
	"stored_size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_vault_id_blob_id_pk" PRIMARY KEY("vault_id","blob_id")
);
--> statement-breakpoint
CREATE TABLE "conflict_candidates" (
	"vault_id" uuid NOT NULL,
	"conflict_id" text NOT NULL,
	"version_id" text NOT NULL,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conflict_candidates_vault_id_conflict_id_version_id_pk" PRIMARY KEY("vault_id","conflict_id","version_id")
);
--> statement-breakpoint
CREATE TABLE "conflicts" (
	"vault_id" uuid NOT NULL,
	"id" text NOT NULL,
	"file_id" text NOT NULL,
	"kind" text NOT NULL,
	"base_version_id" text,
	"head_version_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "conflicts_vault_id_id_pk" PRIMARY KEY("vault_id","id")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"vault_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"plugin_version" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"token_hash" text NOT NULL,
	"is_origin" boolean DEFAULT false NOT NULL,
	"cursor_seq" bigint DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_sync_at" timestamp with time zone,
	"last_ack_at" timestamp with time zone,
	"pending_ops" integer DEFAULT 0 NOT NULL,
	"pending_bytes" bigint DEFAULT 0 NOT NULL,
	"deferred_files" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"last_error_at" timestamp with time zone,
	"last_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "file_versions" (
	"vault_id" uuid NOT NULL,
	"id" text NOT NULL,
	"file_id" text NOT NULL,
	"base_version_id" text,
	"content_hash_enc" "bytea" NOT NULL,
	"blob_id" text NOT NULL,
	"size" bigint NOT NULL,
	"mtime" bigint NOT NULL,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_versions_vault_id_id_pk" PRIMARY KEY("vault_id","id")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"vault_id" uuid NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"path_enc" "bytea" NOT NULL,
	"path_mac" "bytea" NOT NULL,
	"head_version_id" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"mtime" bigint DEFAULT 0 NOT NULL,
	"deleted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_vault_id_id_pk" PRIMARY KEY("vault_id","id")
);
--> statement-breakpoint
CREATE TABLE "journal" (
	"vault_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"file_id" text NOT NULL,
	"kind" text NOT NULL,
	"op_id" text,
	"version_id" text,
	"path_enc" "bytea" NOT NULL,
	"content_hash_enc" "bytea",
	"size" bigint,
	"mtime" bigint,
	"conflict_id" text,
	"device_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "journal_vault_id_seq_pk" PRIMARY KEY("vault_id","seq")
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"content_hash_enc" "bytea" NOT NULL,
	"blob_id" text NOT NULL,
	"size" bigint NOT NULL,
	"chunk_size" integer NOT NULL,
	"salt" "bytea" NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vaults" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name_enc" "bytea" NOT NULL,
	"dek_wrapped" "bytea" NOT NULL,
	"kek_id" text NOT NULL,
	"dek_version" integer DEFAULT 1 NOT NULL,
	"head_seq" bigint DEFAULT 0 NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"status" "vault_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "applied_ops" ADD CONSTRAINT "applied_ops_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_candidates" ADD CONSTRAINT "conflict_candidates_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflicts" ADD CONSTRAINT "conflicts_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal" ADD CONSTRAINT "journal_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaults" ADD CONSTRAINT "vaults_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_live_path" ON "files" USING btree ("vault_id","path_mac") WHERE not "files"."deleted";