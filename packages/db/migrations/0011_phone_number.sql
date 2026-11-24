ALTER TABLE "users" ADD COLUMN "phone_number" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "phone_number_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_number_key" ON "users" USING btree ("phone_number");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_number_e164" CHECK ("users"."phone_number" is null or "users"."phone_number" ~ '^\+[1-9][0-9]{6,14}$');