CREATE TABLE "force_sync_targets" (
	"force_sync_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "force_sync_targets_force_sync_id_device_id_pk" PRIMARY KEY("force_sync_id","device_id")
);
--> statement-breakpoint
CREATE TABLE "force_syncs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_id" uuid NOT NULL,
	"source_device_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_done_at" timestamp with time zone,
	CONSTRAINT "force_syncs_vault_id_unique" UNIQUE("vault_id")
);
--> statement-breakpoint
ALTER TABLE "force_sync_targets" ADD CONSTRAINT "force_sync_targets_force_sync_id_force_syncs_id_fk" FOREIGN KEY ("force_sync_id") REFERENCES "public"."force_syncs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "force_sync_targets" ADD CONSTRAINT "force_sync_targets_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "force_syncs" ADD CONSTRAINT "force_syncs_vault_id_vaults_id_fk" FOREIGN KEY ("vault_id") REFERENCES "public"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "force_syncs" ADD CONSTRAINT "force_syncs_source_device_id_devices_id_fk" FOREIGN KEY ("source_device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;