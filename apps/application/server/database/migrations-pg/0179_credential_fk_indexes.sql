CREATE INDEX "idx_credential_uses_user" ON "credential_uses" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_credential_uses_api_key" ON "credential_uses" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "idx_credentials_created_by" ON "credentials" USING btree ("created_by");