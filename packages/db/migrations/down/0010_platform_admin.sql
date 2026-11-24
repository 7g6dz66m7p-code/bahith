-- Reverts 0010_platform_admin.
DROP FUNCTION IF EXISTS app.set_plan_limit(text, text, integer);--> statement-breakpoint
DROP FUNCTION IF EXISTS app.platform_stats();
