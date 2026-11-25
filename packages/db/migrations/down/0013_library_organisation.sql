-- Reverts 0013_library_organisation: the three library-organisation tables (their
-- policies, grants, indexes and constraints go with them) and the highlight colour enum.
DROP TABLE IF EXISTS "highlights";--> statement-breakpoint
DROP TABLE IF EXISTS "collection_sources";--> statement-breakpoint
DROP TABLE IF EXISTS "collections";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."highlight_color";
