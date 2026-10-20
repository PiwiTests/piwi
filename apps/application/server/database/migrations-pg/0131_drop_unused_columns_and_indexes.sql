ALTER TABLE "scenario_gaps" DROP CONSTRAINT "scenario_gaps_feature_node_id_graph_nodes_id_fk";
--> statement-breakpoint
DROP INDEX "idx_markers_project_id";--> statement-breakpoint
DROP INDEX "idx_scenario_gaps_feature_node";--> statement-breakpoint
DROP INDEX "idx_test_cases_project_id";--> statement-breakpoint
DROP INDEX "idx_test_runs_project_id";--> statement-breakpoint
DROP INDEX "idx_test_runs_cases_test_run_id";--> statement-breakpoint
ALTER TABLE "project_integrations" DROP COLUMN "space_id";--> statement-breakpoint
ALTER TABLE "project_integrations" DROP COLUMN "parent_page_id";--> statement-breakpoint
ALTER TABLE "scenario_gaps" DROP COLUMN "feature_node_id";