ALTER TABLE "test_runs" ADD COLUMN "reporter_id" integer;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_test_runs_reporter" ON "test_runs" USING btree ("reporter_id");