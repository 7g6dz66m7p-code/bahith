-- Reverts 0007_project_ai_consent.
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_ai_consent_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "ai_consent_by";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "ai_consent_at";
