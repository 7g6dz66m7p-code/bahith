-- Reverts 0014_payments: payment tables (policies, grants and constraints go with them),
-- the payment status enum and the plan price columns.
DROP TABLE IF EXISTS "payment_events";--> statement-breakpoint
DROP TABLE IF EXISTS "payments";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."payment_status";--> statement-breakpoint
ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "plans_price_complete";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN IF EXISTS "period_days";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN IF EXISTS "currency";--> statement-breakpoint
ALTER TABLE "plans" DROP COLUMN IF EXISTS "price_minor";
