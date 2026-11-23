ALTER TABLE "projects" ADD COLUMN "live_view_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "live_view_hold_minutes" integer DEFAULT 5 NOT NULL;