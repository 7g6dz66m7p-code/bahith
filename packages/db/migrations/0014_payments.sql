CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded');--> statement-breakpoint
CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" bigint,
	"currency" text,
	"outcome" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "payment_events_provider_event_id_key" UNIQUE("provider","event_id"),
	CONSTRAINT "payment_events_kind_valid" CHECK ("payment_events"."kind" IN ('succeeded', 'failed', 'refunded')),
	CONSTRAINT "payment_events_outcome_valid" CHECK ("payment_events"."outcome" IN ('applied', 'ignored', 'mismatch'))
);
--> statement-breakpoint
ALTER TABLE "payment_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"created_by" uuid,
	"provider" text NOT NULL,
	"provider_payment_id" text,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"period_days" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_workspace_id_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "payments_provider_payment_id_key" UNIQUE("provider","provider_payment_id"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_minor" > 0),
	CONSTRAINT "payments_currency_iso" CHECK ("payments"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_period_valid" CHECK ("payments"."period_days" BETWEEN 1 AND 366)
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "price_minor" bigint;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "period_days" integer;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_fk" FOREIGN KEY ("workspace_id","payment_id") REFERENCES "public"."payments"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_payment_id_idx" ON "payment_events" USING btree ("workspace_id","payment_id");--> statement-breakpoint
CREATE INDEX "payments_workspace_id_idx" ON "payments" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_price_complete" CHECK (("plans"."price_minor" IS NULL AND "plans"."currency" IS NULL AND "plans"."period_days" IS NULL) OR ("plans"."price_minor" > 0 AND "plans"."currency" ~ '^[A-Z]{3}$' AND "plans"."period_days" BETWEEN 1 AND 366));--> statement-breakpoint
CREATE POLICY "payment_events_tenant_isolation" ON "payment_events" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "payments_tenant_isolation" ON "payments" AS PERMISSIVE FOR ALL TO public USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid) WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);--> statement-breakpoint
-- Hand-written: privileges and forced RLS, as for every tenant table (see 0002_security).
-- Financial records are never deleted by the application; events are append-only.
GRANT SELECT, INSERT, UPDATE ON payments TO bahith_app;--> statement-breakpoint
GRANT SELECT, INSERT ON payment_events TO bahith_app;--> statement-breakpoint
ALTER TABLE payments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE payment_events FORCE ROW LEVEL SECURITY;
