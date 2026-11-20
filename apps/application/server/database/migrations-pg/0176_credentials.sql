CREATE TABLE "credential_projects" (
	"credential_id" integer NOT NULL,
	"project_id" integer NOT NULL,
	CONSTRAINT "credential_projects_credential_id_project_id_pk" PRIMARY KEY("credential_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "credential_uses" (
	"id" serial PRIMARY KEY NOT NULL,
	"credential_id" integer,
	"credential_name" text NOT NULL,
	"feature" text NOT NULL,
	"project_id" integer,
	"user_id" integer,
	"api_key_id" integer,
	"subject_type" text,
	"subject_id" text,
	"destination" text,
	"result" text NOT NULL,
	"reason" text,
	"count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp NOT NULL,
	"last_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"service" text NOT NULL,
	"user_name" text,
	"destination" text NOT NULL,
	"secret" text,
	"all_projects" boolean DEFAULT false NOT NULL,
	"allowed_inputs" jsonb,
	"custom_requests" boolean DEFAULT false NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"managed_by" text DEFAULT 'db' NOT NULL,
	"created_by" integer,
	"created_at" timestamp NOT NULL,
	"rotated_at" timestamp NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "credential_projects" ADD CONSTRAINT "credential_projects_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_projects" ADD CONSTRAINT "credential_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_uses" ADD CONSTRAINT "credential_uses_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_uses" ADD CONSTRAINT "credential_uses_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_uses" ADD CONSTRAINT "credential_uses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_uses" ADD CONSTRAINT "credential_uses_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_credential_projects_project" ON "credential_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_credential_uses_credential" ON "credential_uses" USING btree ("credential_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_credential_uses_project" ON "credential_uses" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_credential_uses_created" ON "credential_uses" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_credentials_name" ON "credentials" USING btree ("name");