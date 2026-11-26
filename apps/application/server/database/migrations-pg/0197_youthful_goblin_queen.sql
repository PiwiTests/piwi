CREATE TABLE "shard_splits" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"commit_sha" text NOT NULL,
	"shard_total" integer NOT NULL,
	"tests_hash" text NOT NULL,
	"split" jsonb NOT NULL,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shard_splits" ADD CONSTRAINT "shard_splits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_shard_splits_key" ON "shard_splits" USING btree ("project_id","commit_sha","shard_total","tests_hash");