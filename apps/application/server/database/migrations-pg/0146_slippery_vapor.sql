ALTER TABLE "test_runs_cases" ADD COLUMN "stdout_payload_id" integer;--> statement-breakpoint
ALTER TABLE "test_runs_cases" ADD COLUMN "stderr_payload_id" integer;--> statement-breakpoint
ALTER TABLE "test_runs_cases" ADD CONSTRAINT "test_runs_cases_stdout_payload_id_case_payloads_id_fk" FOREIGN KEY ("stdout_payload_id") REFERENCES "public"."case_payloads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_runs_cases" ADD CONSTRAINT "test_runs_cases_stderr_payload_id_case_payloads_id_fk" FOREIGN KEY ("stderr_payload_id") REFERENCES "public"."case_payloads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_trc_stdout_payload" ON "test_runs_cases" USING btree ("stdout_payload_id") WHERE stdout_payload_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_trc_stderr_payload" ON "test_runs_cases" USING btree ("stderr_payload_id") WHERE stderr_payload_id IS NOT NULL;