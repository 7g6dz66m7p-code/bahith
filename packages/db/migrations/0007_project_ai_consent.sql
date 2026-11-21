ALTER TABLE "projects" ADD COLUMN "ai_consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ai_consent_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_ai_consent_by_users_id_fk" FOREIGN KEY ("ai_consent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;