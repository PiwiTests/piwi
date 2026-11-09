-- Custom SQL migration file, put your code below! --

-- An attempt passed after a failure when it passed on a retry and an earlier attempt of its result failed or timed
-- out (`isFlakyExecution`): the entries of its attempt history before its own retry, else, for an attempt stored
-- without a history, the stored attempts of the same run, test, Playwright project and repetition with fewer retries.
-- An attempt with neither passed after a failure, as a pass on a retry with no earlier attempt at hand reads.
UPDATE "test_runs_cases" SET "passed_after_failure" = true
WHERE "status" = 'passed' AND COALESCE("retries", 0) > 0
	AND CASE
		WHEN EXISTS (
			SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof("test_runs_cases"."attempts") = 'array'
				THEN "test_runs_cases"."attempts" ELSE '[]'::jsonb END) AS "entry"("value")
			WHERE (CASE WHEN jsonb_typeof("entry"."value" -> 'retry') = 'number' THEN ("entry"."value" ->> 'retry')::numeric ELSE 0 END)
				< COALESCE("test_runs_cases"."retries", 0)
		) THEN EXISTS (
			SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof("test_runs_cases"."attempts") = 'array'
				THEN "test_runs_cases"."attempts" ELSE '[]'::jsonb END) AS "entry"("value")
			WHERE (CASE WHEN jsonb_typeof("entry"."value" -> 'retry') = 'number' THEN ("entry"."value" ->> 'retry')::numeric ELSE 0 END)
				< COALESCE("test_runs_cases"."retries", 0)
				AND "entry"."value" ->> 'status' IN ('failed', 'timedout', 'timedOut')
		)
		WHEN (jsonb_typeof("test_runs_cases"."attempts") IS DISTINCT FROM 'array'
				OR jsonb_array_length(CASE WHEN jsonb_typeof("test_runs_cases"."attempts") = 'array'
					THEN "test_runs_cases"."attempts" ELSE '[]'::jsonb END) = 0)
			AND EXISTS (
				SELECT 1 FROM "test_runs_cases" AS "earlier_attempt"
				WHERE "earlier_attempt"."test_run_id" = "test_runs_cases"."test_run_id"
					AND "earlier_attempt"."test_case_id" = "test_runs_cases"."test_case_id"
					AND "earlier_attempt"."repeat_each_index" = "test_runs_cases"."repeat_each_index"
					AND COALESCE("earlier_attempt"."browser_name", '') = COALESCE("test_runs_cases"."browser_name", '')
					AND COALESCE("earlier_attempt"."retries", 0) < COALESCE("test_runs_cases"."retries", 0)
			) THEN EXISTS (
				SELECT 1 FROM "test_runs_cases" AS "earlier_attempt"
				WHERE "earlier_attempt"."test_run_id" = "test_runs_cases"."test_run_id"
					AND "earlier_attempt"."test_case_id" = "test_runs_cases"."test_case_id"
					AND "earlier_attempt"."repeat_each_index" = "test_runs_cases"."repeat_each_index"
					AND COALESCE("earlier_attempt"."browser_name", '') = COALESCE("test_runs_cases"."browser_name", '')
					AND COALESCE("earlier_attempt"."retries", 0) < COALESCE("test_runs_cases"."retries", 0)
					AND "earlier_attempt"."status" IN ('failed', 'timedout', 'timedOut')
			)
		ELSE true
	END;
--> statement-breakpoint
-- A settled run's flaky count is the number of its results whose final attempt passed after a failure. A run with no
-- stored attempt, or one still taking results (a shard's finish adds its own count), keeps its counter.
UPDATE "test_runs" SET "flaky_tests" = (
	SELECT COUNT(*) FROM "test_runs_cases"
	WHERE "test_runs_cases"."test_run_id" = "test_runs"."id"
		AND "test_runs_cases"."final_attempt" = true
		AND "test_runs_cases"."passed_after_failure" = true
)
WHERE "status" NOT IN ('running', 'initializing', 'finalizing')
	AND EXISTS (SELECT 1 FROM "test_runs_cases" WHERE "test_runs_cases"."test_run_id" = "test_runs"."id");
