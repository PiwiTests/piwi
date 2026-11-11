CREATE TABLE "entity_link_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"failure_cluster_id" integer NOT NULL,
	"key" text NOT NULL,
	"external_id" text,
	"removed_by" integer,
	"removed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "failure_clusters" ADD COLUMN "declared_issues_more" integer;--> statement-breakpoint
ALTER TABLE "entity_link_dismissals" ADD CONSTRAINT "entity_link_dismissals_failure_cluster_id_failure_clusters_id_fk" FOREIGN KEY ("failure_cluster_id") REFERENCES "public"."failure_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_link_dismissals" ADD CONSTRAINT "entity_link_dismissals_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_entity_link_dismissals_cluster_key" ON "entity_link_dismissals" USING btree ("failure_cluster_id","key");--> statement-breakpoint
CREATE INDEX "idx_entity_link_dismissals_removed_by" ON "entity_link_dismissals" USING btree ("removed_by");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_entity_links_cluster_declared_key" ON "entity_links" USING btree ("failure_cluster_id","key") WHERE origin IN ('annotation', 'tag');