ALTER TABLE `test_runs_cases` ADD `stdout_payload_id` integer REFERENCES case_payloads(id);--> statement-breakpoint
ALTER TABLE `test_runs_cases` ADD `stderr_payload_id` integer REFERENCES case_payloads(id);--> statement-breakpoint
CREATE INDEX `idx_trc_stdout_payload` ON `test_runs_cases` (`stdout_payload_id`) WHERE stdout_payload_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_trc_stderr_payload` ON `test_runs_cases` (`stderr_payload_id`) WHERE stderr_payload_id IS NOT NULL;