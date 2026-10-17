-- Custom SQL migration file, put your code below! --

-- Runs stored before the commit column read their commit from metadata, as
-- `runCommit` (shared/run-eligibility.ts) does: `scm.commit` when it is 7 to 64
-- hexadecimal characters, lowercased, else none.
UPDATE test_runs
SET commit_sha = lower(btrim(metadata->'scm'->>'commit'))
WHERE jsonb_typeof(metadata) = 'object'
	AND jsonb_typeof(metadata->'scm'->'commit') = 'string'
	AND btrim(metadata->'scm'->>'commit') ~ '^[0-9a-fA-F]{7,64}$';
--> statement-breakpoint
-- The executable lines run coverage stored per run move to one row per file
-- version, the newest run's first.
INSERT INTO coverage_executable (project_id, runtime, path, blob, lines, created_at)
SELECT DISTINCT ON (project_id, runtime, path, blob) project_id, runtime, path, blob, executable, now()
FROM run_coverage
WHERE executable IS NOT NULL AND blob IS NOT NULL AND project_id IN (SELECT id FROM projects)
ORDER BY project_id, runtime, path, blob, run_id DESC
ON CONFLICT DO NOTHING;
