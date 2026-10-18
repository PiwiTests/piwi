CREATE TABLE "run_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"delivery_key" text NOT NULL,
	"run_id" integer NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "run_deliveries" ADD CONSTRAINT "run_deliveries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_deliveries" ADD CONSTRAINT "run_deliveries_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_run_deliveries_project_key" ON "run_deliveries" USING btree ("project_id","delivery_key");--> statement-breakpoint
CREATE INDEX "idx_run_deliveries_run_id" ON "run_deliveries" USING btree ("run_id");