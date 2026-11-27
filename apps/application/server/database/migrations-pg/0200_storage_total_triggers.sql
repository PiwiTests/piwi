-- The running total of the bytes Settings → Storage counts, as `getStorageAnalysis` counts them: a file's size unless
-- it is a trace blob's (`blob_id`), a trace blob's stored size (else its size), a pooled resource's size. Spread over
-- 16 rows by session, so concurrent uploads do not wait on one; one statement adds its rows' bytes at once. Every
-- statement can run again on a database that already ran it.
INSERT INTO "storage_totals" ("slot", "bytes")
SELECT "slot", CASE WHEN "slot" = 0 THEN
    (SELECT coalesce(sum(CASE WHEN "blob_id" IS NULL THEN coalesce("size", 0) ELSE 0 END), 0) FROM "files")
    + (SELECT coalesce(sum(coalesce("stored_size", "size")), 0) FROM "trace_blobs")
    + (SELECT coalesce(sum("size"), 0) FROM "trace_resources")
  ELSE 0 END
FROM generate_series(0, 15) AS "slot"
ON CONFLICT ("slot") DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "storage_totals_add"(delta bigint) RETURNS void AS $$
BEGIN
  IF delta <> 0 THEN
    UPDATE "storage_totals" SET "bytes" = "bytes" + delta WHERE "slot" = pg_backend_pid() % 16;
  END IF;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "storage_totals_files"() RETURNS trigger AS $$
DECLARE
  delta bigint := 0;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    SELECT delta - coalesce(sum(CASE WHEN "blob_id" IS NULL THEN coalesce("size", 0) ELSE 0 END), 0) INTO delta FROM old_rows;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT delta + coalesce(sum(CASE WHEN "blob_id" IS NULL THEN coalesce("size", 0) ELSE 0 END), 0) INTO delta FROM new_rows;
  END IF;
  PERFORM "storage_totals_add"(delta);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "storage_totals_trace_blobs"() RETURNS trigger AS $$
DECLARE
  delta bigint := 0;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    SELECT delta - coalesce(sum(coalesce("stored_size", "size")), 0) INTO delta FROM old_rows;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT delta + coalesce(sum(coalesce("stored_size", "size")), 0) INTO delta FROM new_rows;
  END IF;
  PERFORM "storage_totals_add"(delta);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "storage_totals_trace_resources"() RETURNS trigger AS $$
DECLARE
  delta bigint := 0;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    SELECT delta - coalesce(sum("size"), 0) INTO delta FROM old_rows;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT delta + coalesce(sum("size"), 0) INTO delta FROM new_rows;
  END IF;
  PERFORM "storage_totals_add"(delta);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_files_insert" AFTER INSERT ON "files" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_files"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_files_update" AFTER UPDATE ON "files" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_files"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_files_delete" AFTER DELETE ON "files" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_files"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_trace_blobs_insert" AFTER INSERT ON "trace_blobs" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_trace_blobs"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_trace_blobs_update" AFTER UPDATE ON "trace_blobs" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_trace_blobs"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_trace_blobs_delete" AFTER DELETE ON "trace_blobs" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_trace_blobs"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_trace_resources_insert" AFTER INSERT ON "trace_resources" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_trace_resources"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_trace_resources_update" AFTER UPDATE ON "trace_resources" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_trace_resources"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_trace_resources_delete" AFTER DELETE ON "trace_resources" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_trace_resources"();
