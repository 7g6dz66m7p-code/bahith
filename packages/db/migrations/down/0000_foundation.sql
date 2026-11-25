-- Reverts 0000_foundation.
DROP FUNCTION IF EXISTS app.normalize_arabic(text);
DROP SCHEMA IF EXISTS app;
DROP EXTENSION IF EXISTS vector;
