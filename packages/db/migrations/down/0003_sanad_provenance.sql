DROP TRIGGER chunks_sanad_set_guard ON chunks;
DROP FUNCTION app.guard_sanad_chunk_set();
DROP TRIGGER chunks_sanad_version_guard ON chunks;
DROP FUNCTION app.guard_sanad_chunk_version();
DROP TRIGGER files_sanad_version_guard ON files;
DROP FUNCTION app.guard_sanad_file_version();
ALTER TABLE chunks DROP CONSTRAINT chunks_provenance_has_file;
ALTER TABLE chunks DROP COLUMN provenance;
ALTER TABLE files DROP COLUMN extraction;
