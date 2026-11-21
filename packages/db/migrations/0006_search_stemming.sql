-- Lexical retrieval v2 (ADR-0010): index Arabic light stems and English stems next to
-- surface forms, and build per-term queries for minimum-should-match retrieval.
-- All functions are IMMUTABLE because app.search_document feeds a generated column;
-- any change to them must ship as a new migration that rewrites chunks.tsv.

-- Light stemmer for one normalised Arabic word (after app.normalize_arabic: no
-- tashkeel, hamza seats unified, ة → ه, ى → ي). Strips one conjunction و, one
-- definite article or proclitic, then pronoun/plural suffixes and the accusative alef,
-- never below two letters. Non-Arabic words are returned unchanged.
CREATE FUNCTION app.arabic_light_stem(word text) RETURNS text
  LANGUAGE plpgsql
  IMMUTABLE
  STRICT
  PARALLEL SAFE
AS $fn$
DECLARE
  w text := word;
BEGIN
  IF w !~ U&'^[\0621-\064A]+$' THEN
    RETURN w;
  END IF;
  -- و (and)
  IF char_length(w) >= 4 AND left(w, 1) = U&'\0648' THEN
    w := substr(w, 2);
  END IF;
  -- وال بال كال فال / ال لل / ب ل ك ف
  IF char_length(w) >= 5 AND left(w, 3) IN (
    U&'\0648\0627\0644', U&'\0628\0627\0644', U&'\0643\0627\0644', U&'\0641\0627\0644'
  ) THEN
    w := substr(w, 4);
  ELSIF char_length(w) >= 4 AND left(w, 2) IN (U&'\0627\0644', U&'\0644\0644') THEN
    w := substr(w, 3);
  ELSIF char_length(w) >= 5 AND left(w, 1) IN (U&'\0628', U&'\0644', U&'\0643', U&'\0641') THEN
    w := substr(w, 2);
  END IF;
  LOOP
    --          ها              ان              ات              ون              ين
    IF char_length(w) >= 5 AND right(w, 2) IN (
      U&'\0647\0627', U&'\0627\0646', U&'\0627\062A', U&'\0648\0646', U&'\064A\0646',
      --  يه            هم              هن              كم              نا
      U&'\064A\0647', U&'\0647\0645', U&'\0647\0646', U&'\0643\0645', U&'\0646\0627'
    ) THEN
      w := left(w, -2);
    --                                          ه         ي         ا
    ELSIF char_length(w) >= 4 AND right(w, 1) IN (U&'\0647', U&'\064A', U&'\0627') THEN
      w := left(w, -1);
    ELSE
      EXIT;
    END IF;
  END LOOP;
  RETURN w;
END
$fn$;
--> statement-breakpoint
-- Words that never decide relevance (normalised spellings).
CREATE FUNCTION app.search_stopwords() RETURNS text[]
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
AS $fn$
  SELECT ARRAY[
    -- في من على الى عن ان او ما لا هذا هذه ذلك التي الذي الذين كان كانت مع بين لدي عند ثم قد
    U&'\0641\064A', U&'\0645\0646', U&'\0639\0644\064A', U&'\0627\0644\064A', U&'\0639\0646',
    U&'\0627\0646', U&'\0627\0648', U&'\0645\0627', U&'\0644\0627', U&'\0647\0630\0627',
    U&'\0647\0630\0647', U&'\0630\0644\0643', U&'\0627\0644\062A\064A',
    U&'\0627\0644\0630\064A', U&'\0627\0644\0630\064A\0646', U&'\0643\0627\0646',
    U&'\0643\0627\0646\062A', U&'\0645\0639', U&'\0628\064A\0646', U&'\0644\062F\064A',
    U&'\0639\0646\062F', U&'\062B\0645', U&'\0642\062F',
    'the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'to', 'for', 'with', 'by', 'is', 'are',
    'was', 'were', 'be', 'at', 'from', 'as', 'that', 'this', 'these', 'those', 'it', 'its'
  ]
$fn$;
--> statement-breakpoint
CREATE FUNCTION app.search_document(input text) RETURNS tsvector
  LANGUAGE sql
  IMMUTABLE
  STRICT
  PARALLEL SAFE
AS $fn$
  SELECT to_tsvector('simple', n)
      || to_tsvector('english', n)
      || to_tsvector(
           'simple',
           coalesce(
             (SELECT string_agg(app.arabic_light_stem(lexeme), ' ')
                FROM unnest(tsvector_to_array(to_tsvector('simple', n))) AS lexeme),
             ''
           )
         )
    FROM (SELECT app.normalize_arabic(input) AS n) AS normalised
$fn$;
--> statement-breakpoint
-- One tsquery per distinct non-stopword term of the query: the term itself, its Arabic
-- light stem, or its English stem. Retrieval counts how many of them a passage matches.
CREATE FUNCTION app.search_term_queries(input text) RETURNS tsquery[]
  LANGUAGE sql
  IMMUTABLE
  STRICT
  PARALLEL SAFE
AS $fn$
  SELECT coalesce(
    array_agg(
      plainto_tsquery('simple', term)
        || plainto_tsquery('simple', app.arabic_light_stem(term))
        || plainto_tsquery('english', term)
      ORDER BY term
    ),
    ARRAY[]::tsquery[]
  )
    FROM unnest(tsvector_to_array(to_tsvector('simple', app.normalize_arabic(input)))) AS term
   WHERE term <> ALL (app.search_stopwords())
$fn$;
--> statement-breakpoint
ALTER TABLE "chunks" drop column "tsv";--> statement-breakpoint
ALTER TABLE "chunks" ADD COLUMN "tsv" "tsvector" GENERATED ALWAYS AS (app.search_document("chunks"."content")) STORED;--> statement-breakpoint
CREATE INDEX "chunks_tsv_gin" ON "chunks" USING gin ("tsv");
