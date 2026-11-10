ALTER TABLE "run_requests" ADD COLUMN "run_id" integer;--> statement-breakpoint
ALTER TABLE "run_requests" ADD COLUMN "run_token_digest" text;--> statement-breakpoint
ALTER TABLE "run_requests" ADD COLUMN "run_token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "test_runs" ADD COLUMN "requester_id" integer;--> statement-breakpoint
ALTER TABLE "test_runs" ADD CONSTRAINT "test_runs_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_run_requests_run" ON "run_requests" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_run_requests_run_token" ON "run_requests" USING btree ("run_token_digest");--> statement-breakpoint
CREATE INDEX "idx_test_runs_requester" ON "test_runs" USING btree ("requester_id");