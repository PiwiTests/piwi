-- The running total of the bytes Settings → Storage counts, as `getStorageAnalysis` counts them: a file's size unless
-- it is a trace blob's (`blob_id`), a trace blob's stored size (else its size), a pooled resource's size. Every
-- statement can run again on a database that already ran it.
INSERT INTO `storage_totals` (`slot`, `bytes`) VALUES (0,
  (SELECT coalesce(sum(CASE WHEN `blob_id` IS NULL THEN coalesce(`size`, 0) ELSE 0 END), 0) FROM `files`)
  + (SELECT coalesce(sum(coalesce(`stored_size`, `size`)), 0) FROM `trace_blobs`)
  + (SELECT coalesce(sum(`size`), 0) FROM `trace_resources`)
) ON CONFLICT (`slot`) DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_files_insert` AFTER INSERT ON `files` BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` + (CASE WHEN NEW.`blob_id` IS NULL THEN coalesce(NEW.`size`, 0) ELSE 0 END) WHERE `slot` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_files_delete` AFTER DELETE ON `files` BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` - (CASE WHEN OLD.`blob_id` IS NULL THEN coalesce(OLD.`size`, 0) ELSE 0 END) WHERE `slot` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_files_update` AFTER UPDATE OF `size`, `blob_id` ON `files` BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes`
    - (CASE WHEN OLD.`blob_id` IS NULL THEN coalesce(OLD.`size`, 0) ELSE 0 END)
    + (CASE WHEN NEW.`blob_id` IS NULL THEN coalesce(NEW.`size`, 0) ELSE 0 END) WHERE `slot` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_trace_blobs_insert` AFTER INSERT ON `trace_blobs` BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` + coalesce(NEW.`stored_size`, NEW.`size`) WHERE `slot` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_trace_blobs_delete` AFTER DELETE ON `trace_blobs` BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` - coalesce(OLD.`stored_size`, OLD.`size`) WHERE `slot` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_trace_blobs_update` AFTER UPDATE OF `size`, `stored_size` ON `trace_blobs` BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` - coalesce(OLD.`stored_size`, OLD.`size`) + coalesce(NEW.`stored_size`, NEW.`size`) WHERE `slot` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_trace_resources_insert` AFTER INSERT ON `trace_resources` BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` + NEW.`size` WHERE `slot` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_trace_resources_delete` AFTER DELETE ON `trace_resources` BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` - OLD.`size` WHERE `slot` = 0;
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `storage_totals_trace_resources_update` AFTER UPDATE OF `size` ON `trace_resources` BEGIN
  UPDATE `storage_totals` SET `bytes` = `bytes` - OLD.`size` + NEW.`size` WHERE `slot` = 0;
END;
