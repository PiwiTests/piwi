-- An update of `test_runs` changes the running total by the change of each run's `results_bytes`, row by row: only an
-- update that sets the column, to another value, runs the trigger, so a heartbeat or any other update of a run builds
-- no transition table and writes no slot. Inserts and deletes keep their statement triggers. Every statement can run
-- again on a database that already ran it.
CREATE OR REPLACE FUNCTION "storage_totals_test_runs_update"() RETURNS trigger AS $$
BEGIN
  PERFORM "storage_totals_add"(NEW."results_bytes" - OLD."results_bytes");
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "storage_totals_test_runs_update" AFTER UPDATE OF "results_bytes" ON "test_runs" FOR EACH ROW WHEN (OLD."results_bytes" IS DISTINCT FROM NEW."results_bytes") EXECUTE FUNCTION "storage_totals_test_runs_update"();
