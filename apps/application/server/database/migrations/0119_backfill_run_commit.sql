-- Custom SQL migration file, put your code below! --

-- Runs stored before the commit column read their commit from metadata, as
-- `runCommit` (shared/run-eligibility.ts) does: `scm.commit` when it is 7 to 64
-- hexadecimal characters, lowercased, else none.
UPDATE test_runs
SET commit_sha = lower(trim(json_extract(metadata, '$.scm.commit')))
WHERE metadata IS NOT NULL
	AND json_valid(metadata)
	AND json_type(metadata) = 'object'
	AND json_type(metadata, '$.scm.commit') = 'text'
	AND length(trim(json_extract(metadata, '$.scm.commit'))) BETWEEN 7 AND 64
	AND lower(trim(json_extract(metadata, '$.scm.commit'))) NOT GLOB '*[^0-9a-f]*';
--> statement-breakpoint
-- The executable lines run coverage stored per run move to one row per file
-- version, the newest run's first.
INSERT OR IGNORE INTO coverage_executable (project_id, runtime, path, blob, lines, created_at)
SELECT project_id, runtime, path, blob, executable, CAST(strftime('%s', 'now') AS integer)
FROM run_coverage
WHERE executable IS NOT NULL AND blob IS NOT NULL AND project_id IN (SELECT id FROM projects)
ORDER BY run_id DESC;
