-- Custom SQL migration file, put your code below! --

-- Only a result's final attempt carries its passed-after-failure verdict.
UPDATE `test_runs_cases` SET `passed_after_failure` = false
WHERE `passed_after_failure` = true AND `final_attempt` = false;
