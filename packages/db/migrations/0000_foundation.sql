-- Foundation: extensions and helper functions that the table definitions depend on.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS app;
--> statement-breakpoint
-- Arabic search normalisation, applied identically to indexed text (chunks.tsv) and
-- to search queries:
--   * strips tashkeel (U+064B–U+065F, U+0670) and tatweel (U+0640);
--   * unifies alef forms (أ إ آ ٱ → ا) and hamza carriers (ؤ → و, ئ → ي);
--   * unifies ى → ي and ة → ه, and Persian ی/ک → ي/ك;
--   * maps Arabic-Indic and Persian digits to ASCII digits.
-- IMMUTABLE is required because it feeds a generated column: any change to the mapping
-- must ship as a new migration that also rewrites chunks.tsv.
CREATE FUNCTION app.normalize_arabic(input text) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  STRICT
  PARALLEL SAFE
AS $fn$
  -- Code points are spelled out (U&'\XXXX') so the mapping is unambiguous in
  -- right-to-left editors. Position N of the first list maps to position N of the second.
  SELECT translate(
    regexp_replace(input, '[ً-ٰٟـ]', '', 'g'),
    --  أ    إ    آ    ٱ    ؤ    ئ    ى    ة    ی    ک
    U&'\0623\0625\0622\0671\0624\0626\0649\0629\06CC\06A9'
      || U&'\0660\0661\0662\0663\0664\0665\0666\0667\0668\0669'  -- Arabic-Indic digits
      || U&'\06F0\06F1\06F2\06F3\06F4\06F5\06F6\06F7\06F8\06F9', -- Persian digits
    --  ا    ا    ا    ا    و    ي    ي    ه    ي    ك
    U&'\0627\0627\0627\0627\0648\064A\064A\0647\064A\0643'
      || '0123456789'
      || '0123456789'
  )
$fn$;
