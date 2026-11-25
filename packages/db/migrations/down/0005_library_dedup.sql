-- Reverts 0005_library_dedup.
DROP INDEX IF EXISTS "files_workspace_id_sha256_key";
