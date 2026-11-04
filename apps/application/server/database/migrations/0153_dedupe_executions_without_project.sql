-- Custom SQL migration file, put your code below! --

-- An execution without a project (`browser_name` NULL or '') is unique per run, test, repetition and retry, as the
-- other executions are: of the rows that repeat one, the one with the highest id stays. The migrator runs with foreign
-- keys off, so the rows that reference a deleted execution are deleted here.
CREATE TEMP TABLE `repeated_executions` AS
SELECT `id` FROM `test_runs_cases`
WHERE COALESCE(`browser_name`, '') = ''
	AND EXISTS (
		SELECT 1 FROM `test_runs_cases` AS `later_attempt`
		WHERE COALESCE(`later_attempt`.`browser_name`, '') = ''
			AND `later_attempt`.`test_run_id` = `test_runs_cases`.`test_run_id`
			AND `later_attempt`.`test_case_id` = `test_runs_cases`.`test_case_id`
			AND `later_attempt`.`repeat_each_index` = `test_runs_cases`.`repeat_each_index`
			AND `later_attempt`.`retries` = `test_runs_cases`.`retries`
			AND `later_attempt`.`id` > `test_runs_cases`.`id`
	);
--> statement-breakpoint
DELETE FROM `failure_diagnosis_versions`
WHERE `test_runs_case_id` IN (SELECT `id` FROM `repeated_executions`)
	OR `diagnosis_id` IN (
		SELECT `id` FROM `failure_diagnoses` WHERE `test_runs_case_id` IN (SELECT `id` FROM `repeated_executions`)
	);
--> statement-breakpoint
DELETE FROM `failure_diagnoses` WHERE `test_runs_case_id` IN (SELECT `id` FROM `repeated_executions`);
--> statement-breakpoint
DELETE FROM `network_requests` WHERE `test_runs_case_id` IN (SELECT `id` FROM `repeated_executions`);
--> statement-breakpoint
DELETE FROM `files` WHERE `test_runs_case_id` IN (SELECT `id` FROM `repeated_executions`);
--> statement-breakpoint
DELETE FROM `entity_links` WHERE `test_runs_case_id` IN (SELECT `id` FROM `repeated_executions`);
--> statement-breakpoint
DELETE FROM `test_runs_cases` WHERE `id` IN (SELECT `id` FROM `repeated_executions`);
--> statement-breakpoint
DROP TABLE `repeated_executions`;
--> statement-breakpoint
-- A history built from those rows lists each attempt once: the first entry of each retry stays.
UPDATE `test_runs_cases`
SET `attempts` = (
	SELECT json_group_array(json(`entry`.`value`))
	FROM json_each(`test_runs_cases`.`attempts`) AS `entry`
	WHERE `entry`.`key` = (
		SELECT MIN(`first`.`key`) FROM json_each(`test_runs_cases`.`attempts`) AS `first`
		WHERE json_extract(`first`.`value`, '$.retry') IS json_extract(`entry`.`value`, '$.retry')
	)
)
WHERE COALESCE(`browser_name`, '') = ''
	AND `retries` > 0
	AND CASE WHEN json_valid(`attempts`) AND json_type(`attempts`) = 'array'
		THEN (SELECT COUNT(*) FROM json_each(`attempts`))
			> (SELECT COUNT(DISTINCT json_extract(`value`, '$.retry')) FROM json_each(`attempts`))
		ELSE 0 END;
