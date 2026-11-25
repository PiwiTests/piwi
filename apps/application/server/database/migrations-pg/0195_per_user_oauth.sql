CREATE TABLE "credential_authorizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"state_hash" text NOT NULL,
	"credential_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"verifier" text NOT NULL,
	"return_to" text,
	"created_at" timestamp NOT NULL,
	"expires_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credential_user_tokens" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "credential_authorizations" ADD CONSTRAINT "credential_authorizations_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_authorizations" ADD CONSTRAINT "credential_authorizations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_credential_authorizations_state" ON "credential_authorizations" USING btree ("state_hash");--> statement-breakpoint
CREATE INDEX "idx_credential_authorizations_expires" ON "credential_authorizations" USING btree ("expires_at");