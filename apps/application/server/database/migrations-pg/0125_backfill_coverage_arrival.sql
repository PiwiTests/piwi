-- Custom SQL migration file, put your code below! --

-- How many files a report's stored inventory names; a payload that is not a
-- JSON array leaves the count to be read on the next listing.
DO $$
BEGIN
	UPDATE coverage_reports
	SET inventory_count = json_array_length(p.content::json)
	FROM case_payloads p
	WHERE p.id = coverage_reports.inventory_payload_id;
EXCEPTION WHEN others THEN
	NULL;
END $$;
--> statement-breakpoint
-- A commit's coverage arrived with its first report or its first run.
UPDATE coverage_totals
SET commit_seen_at = LEAST(
	(SELECT min(created_at) FROM coverage_reports r
	WHERE r.project_id = coverage_totals.project_id AND r.commit_sha = coverage_totals.commit_sha),
	(SELECT min(start_time) FROM test_runs t
	WHERE t.project_id = coverage_totals.project_id AND t.commit_sha = coverage_totals.commit_sha),
	computed_at
);
--> statement-breakpoint
UPDATE coverage_daily
SET commit_seen_at = coalesce(
	(SELECT t.commit_seen_at FROM coverage_totals t
	WHERE t.project_id = coverage_daily.project_id AND t.commit_sha = coverage_daily.commit_sha
		AND t.suite = 'combined' AND t.area = ''),
	computed_at
);
