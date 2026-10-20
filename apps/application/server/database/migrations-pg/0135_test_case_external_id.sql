ALTER TABLE "test_cases" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "test_cases" ADD COLUMN "display_title" text;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_test_cases_external_id" ON "test_cases" USING btree ("project_id","external_id") WHERE external_id IS NOT NULL;