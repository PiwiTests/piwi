-- The bytes of the results each run's reporter sent (`test_runs.results_bytes`) count in the running total of the
-- stored bytes. Every run holds 0 when the column is added, so the total needs no recount. A statement trigger with
-- transition tables takes no column list: it runs on every update of `test_runs`, and `storage_totals_add` writes
-- nothing while the statement changed no run's bytes. Every statement can run again on a database that already ran it.
CREATE OR REPLACE FUNCTION "storage_totals_test_runs"() RETURNS trigger AS $$
DECLARE
  delta bigint := 0;
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    SELECT delta - coalesce(sum("results_bytes"), 0) INTO delta FROM old_rows;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT delta + coalesce(sum("results_bytes"), 0) INTO delta FROM new_rows;
  END IF;
  PERFORM "storage_totals_add"(delta);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_test_runs_insert" AFTER INSERT ON "test_runs" REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_test_runs"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_test_runs_update" AFTER UPDATE ON "test_runs" REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_test_runs"();
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_test_runs_delete" AFTER DELETE ON "test_runs" REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION "storage_totals_test_runs"();
