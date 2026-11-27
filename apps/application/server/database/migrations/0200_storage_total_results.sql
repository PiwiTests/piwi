-- The bytes of the results each run's reporter sent (`test_runs.results_bytes`) count in the running total of the
-- stored bytes. Every run holds 0 when the column is added, so the total needs no recount. Every statement can run
-- again on a database that already ran it.
CREATE TRIGGER IF NOT EXISTS `storage_totals_test_runs_insert` AFTER INSERT ON `test_runs` WHEN NEW.`results_bytes` <> 0 BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` + NEW.`results_bytes` WHERE `slot` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_test_runs_delete` AFTER DELETE ON `test_runs` WHEN OLD.`results_bytes` <> 0 BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` - OLD.`results_bytes` WHERE `slot` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_test_runs_update` AFTER UPDATE OF `results_bytes` ON `test_runs` WHEN NEW.`results_bytes` <> OLD.`results_bytes` BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` - OLD.`results_bytes` + NEW.`results_bytes` WHERE `slot` = 0;
END;
