-- Custom SQL migration file, put your code below! --

-- An attempt is the final attempt of its result unless the same run, test, Playwright project and repetition holds a
-- later one: more retries, or as many and a higher id. Only a retry, or an attempt without a project, can be later.
UPDATE `test_runs_cases` SET `final_attempt` = false
WHERE EXISTS (
	SELECT 1 FROM `test_runs_cases` AS `later_attempt`
	WHERE (`later_attempt`.`retries` > 0 OR `later_attempt`.`browser_name` IS NULL)
		AND `later_attempt`.`test_run_id` = `test_runs_cases`.`test_run_id`
		AND `later_attempt`.`test_case_id` = `test_runs_cases`.`test_case_id`
		AND `later_attempt`.`repeat_each_index` = `test_runs_cases`.`repeat_each_index`
		AND COALESCE(`later_attempt`.`browser_name`, '') = COALESCE(`test_runs_cases`.`browser_name`, '')
		AND (COALESCE(`later_attempt`.`retries`, 0) > COALESCE(`test_runs_cases`.`retries`, 0)
			OR (COALESCE(`later_attempt`.`retries`, 0) = COALESCE(`test_runs_cases`.`retries`, 0)
				AND `later_attempt`.`id` > `test_runs_cases`.`id`))
);
