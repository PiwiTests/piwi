-- Custom SQL migration file, put your code below! --

-- An execution without a project (`browser_name` NULL or '') is unique per run, test, repetition and retry, as the
-- other executions are: of the rows that repeat one, the one with the highest id stays, and the rows that reference
-- the others are deleted with them.
DELETE FROM "test_runs_cases"
WHERE COALESCE("browser_name", '') = ''
	AND EXISTS (
		SELECT 1 FROM "test_runs_cases" AS "later_attempt"
		WHERE COALESCE("later_attempt"."browser_name", '') = ''
			AND "later_attempt"."test_run_id" = "test_runs_cases"."test_run_id"
			AND "later_attempt"."test_case_id" = "test_runs_cases"."test_case_id"
			AND "later_attempt"."repeat_each_index" = "test_runs_cases"."repeat_each_index"
			AND "later_attempt"."retries" = "test_runs_cases"."retries"
			AND "later_attempt"."id" > "test_runs_cases"."id"
	);
--> statement-breakpoint
-- A history built from those rows lists each attempt once: the first entry of each retry stays.
UPDATE "test_runs_cases"
SET "attempts" = (
	SELECT jsonb_agg("entry"."value" ORDER BY "entry"."position")
	FROM jsonb_array_elements("test_runs_cases"."attempts") WITH ORDINALITY AS "entry"("value", "position")
	WHERE "entry"."position" = (
		SELECT MIN("first"."position")
		FROM jsonb_array_elements("test_runs_cases"."attempts") WITH ORDINALITY AS "first"("value", "position")
		WHERE "first"."value" -> 'retry' IS NOT DISTINCT FROM "entry"."value" -> 'retry'
	)
)
WHERE COALESCE("browser_name", '') = ''
	AND "retries" > 0
	AND CASE WHEN jsonb_typeof("attempts") = 'array'
		THEN jsonb_array_length("attempts")
			> (SELECT COUNT(DISTINCT "element"."value" -> 'retry') FROM jsonb_array_elements("attempts") AS "element"("value"))
		ELSE false END;
