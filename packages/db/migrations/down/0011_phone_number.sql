-- Reverts 0011_phone_number.
DROP INDEX IF EXISTS "users_phone_number_key";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_phone_number_e164";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "phone_number_verified";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN IF EXISTS "phone_number";
