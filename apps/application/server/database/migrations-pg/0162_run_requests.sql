CREATE TABLE "run_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"requester_id" integer NOT NULL,
	"target_id" integer,
	"kind" text NOT NULL,
	"tests" jsonb NOT NULL,
	"options" jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"state" text DEFAULT 'waiting' NOT NULL,
	"outcome" text,
	"detail" text,
	"stop_requested_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"claimed_at" timestamp,
	"answered_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_targets" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"api_key_id" integer NOT NULL,
	"kind" text NOT NULL,
	"device_name" text NOT NULL,
	"platform" text,
	"version" text,
	"project_ids" jsonb,
	"last_seen_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "client_kind" text;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "permissions" jsonb;--> statement-breakpoint
ALTER TABLE "extension_device_codes" ADD COLUMN "client_kind" text;--> statement-breakpoint
ALTER TABLE "run_requests" ADD CONSTRAINT "run_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_requests" ADD CONSTRAINT "run_requests_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_requests" ADD CONSTRAINT "run_requests_target_id_run_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."run_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_targets" ADD CONSTRAINT "run_targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_targets" ADD CONSTRAINT "run_targets_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_requests_requester" ON "run_requests" USING btree ("requester_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_run_requests_target" ON "run_requests" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_run_requests_project" ON "run_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_run_requests_state" ON "run_requests" USING btree ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_run_targets_api_key" ON "run_targets" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "idx_run_targets_user" ON "run_targets" USING btree ("user_id");