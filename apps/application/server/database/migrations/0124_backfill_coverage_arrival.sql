-- Custom SQL migration file, put your code below! --

-- How many files a report's stored inventory names.
UPDATE coverage_reports
SET inventory_count = (
	SELECT json_array_length(content) FROM case_payloads
	WHERE case_payloads.id = coverage_reports.inventory_payload_id AND json_valid(content)
)
WHERE inventory_payload_id IS NOT NULL;
--> statement-breakpoint
-- A commit's coverage arrived with its first report or its first run.
UPDATE coverage_totals
SET commit_seen_at = min(
	coalesce(
		(SELECT min(created_at) FROM coverage_reports r
		WHERE r.project_id = coverage_totals.project_id AND r.commit_sha = coverage_totals.commit_sha),
		computed_at
	),
	coalesce(
		(SELECT min(start_time) FROM test_runs t
		WHERE t.project_id = coverage_totals.project_id AND t.commit_sha = coverage_totals.commit_sha),
		computed_at
	)
);
--> statement-breakpoint
UPDATE coverage_daily
SET commit_seen_at = coalesce(
	(SELECT t.commit_seen_at FROM coverage_totals t
	WHERE t.project_id = coverage_daily.project_id AND t.commit_sha = coverage_daily.commit_sha
		AND t.suite = 'combined' AND t.area = ''),
	computed_at
);
