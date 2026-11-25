-- Reverts 0012_notifications: the table (its policy, grants, indexes and constraints go
-- with it) and its enum.
DROP TABLE IF EXISTS "notifications";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."notification_kind";
