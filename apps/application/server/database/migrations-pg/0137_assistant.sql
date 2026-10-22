CREATE TABLE "assistant_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer,
	"title" text DEFAULT '' NOT NULL,
	"extra_tools" jsonb,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"context" jsonb,
	"tool_calls" jsonb,
	"provider" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"status" text DEFAULT 'completed' NOT NULL,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistant_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer,
	"provider" text,
	"model" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_conversations" ADD CONSTRAINT "assistant_conversations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD CONSTRAINT "assistant_messages_conversation_id_assistant_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."assistant_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_assistant_conversations_owner" ON "assistant_conversations" USING btree ("owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_assistant_conversations_updated" ON "assistant_conversations" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_assistant_messages_conversation" ON "assistant_messages" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "idx_assistant_usage_created" ON "assistant_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_assistant_usage_owner" ON "assistant_usage" USING btree ("owner_id","created_at");