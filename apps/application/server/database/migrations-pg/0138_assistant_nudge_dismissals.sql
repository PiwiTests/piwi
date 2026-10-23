CREATE TABLE "assistant_nudge_dismissals" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer,
	"nudge_id" text NOT NULL,
	"dismissed_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_nudge_dismissals" ADD CONSTRAINT "assistant_nudge_dismissals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_assistant_nudge_dismissals_owner" ON "assistant_nudge_dismissals" USING btree ("owner_id","nudge_id") WHERE owner_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_assistant_nudge_dismissals_shared" ON "assistant_nudge_dismissals" USING btree ("nudge_id") WHERE owner_id IS NULL;