-- Reverts 0006_search_stemming: back to surface-form-only lexical search.
DROP INDEX IF EXISTS "chunks_tsv_gin";--> statement-breakpoint
ALTER TABLE "chunks" DROP COLUMN "tsv";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', app.normalize_arabic("chunks"."content"))) STORED;--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin" ON "chunks" USING gin ("tsv");--> statement-breakpoint
DROP FUNCTION app.search_term_queries(text);--> statement-breakpoint
DROP FUNCTION app.search_document(text);--> statement-breakpoint
DROP FUNCTION app.search_stopwords();--> statement-breakpoint
DROP FUNCTION app.arabic_light_stem(text);
