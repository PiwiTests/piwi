-- Custom SQL migration file, put your code below! --

-- An execution without a project (`browser_name` NULL) is unique per run, test, repetition and retry, as the other
-- executions are: of the rows that repeat one, the one with the highest id stays.
DELETE FROM `test_runs_cases`
WHERE `browser_name` IS NULL
	AND EXISTS (
		SELECT 1 FROM `test_runs_cases` AS `later_attempt`
		WHERE `later_attempt`.`browser_name` IS NULL
			AND `later_attempt`.`test_run_id` = `test_runs_cases`.`test_run_id`
			AND `later_attempt`.`test_case_id` = `test_runs_cases`.`test_case_id`
			AND `later_attempt`.`repeat_each_index` = `test_runs_cases`.`repeat_each_index`
			AND `later_attempt`.`retries` = `test_runs_cases`.`retries`
			AND `later_attempt`.`id` > `test_runs_cases`.`id`
	);
