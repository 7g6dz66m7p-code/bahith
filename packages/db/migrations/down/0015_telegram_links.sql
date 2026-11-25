-- Reverts 0015_telegram_links: the Telegram link table and the users.legacy_id column.
DROP TABLE IF EXISTS "telegram_links";--> statement-breakpoint
DROP INDEX IF EXISTS "users_legacy_id_key";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "legacy_id";
