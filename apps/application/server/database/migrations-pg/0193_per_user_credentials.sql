CREATE TABLE "credential_user_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"credential_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"remote_user" text NOT NULL,
	"secret" text NOT NULL,
	"state" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp NOT NULL,
	"tested_at" timestamp NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "credential_uses" ADD COLUMN "remote_user" text;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "per_user" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "token_help_url" text;--> statement-breakpoint
ALTER TABLE "credential_user_tokens" ADD CONSTRAINT "credential_user_tokens_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_user_tokens" ADD CONSTRAINT "credential_user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_credential_user_tokens_credential_user" ON "credential_user_tokens" USING btree ("credential_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_credential_user_tokens_user" ON "credential_user_tokens" USING btree ("user_id");