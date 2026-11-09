CREATE TABLE "test_run_environment_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"kind" text NOT NULL,
	"scope" text DEFAULT '' NOT NULL,
	"snapshot" jsonb NOT NULL,
	"digest" text NOT NULL,
	"captured_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "test_run_environment_snapshots" ADD CONSTRAINT "test_run_environment_snapshots_run_id_test_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."test_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_test_run_environment_snapshots_run_kind_scope" ON "test_run_environment_snapshots" USING btree ("run_id","kind","scope");