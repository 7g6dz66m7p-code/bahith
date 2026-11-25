ALTER TABLE "chunks" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "extraction" jsonb;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_provenance_has_file" CHECK ("chunks"."provenance" is null or "chunks"."file_id" is not null);

-- Once published, a SANAD file is a source version, never an in-place replacement.
-- Existing pre-SANAD records keep their original behaviour.
CREATE FUNCTION app.guard_sanad_file_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.extraction IS NOT NULL AND
     ROW(NEW.extraction, NEW.sha256, NEW.source_id, NEW.storage_key, NEW.mime_type, NEW.size_bytes)
     IS DISTINCT FROM
     ROW(OLD.extraction, OLD.sha256, OLD.source_id, OLD.storage_key, OLD.mime_type, OLD.size_bytes)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SANAD_VERSION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER files_sanad_version_guard BEFORE UPDATE ON files
FOR EACH ROW EXECUTE FUNCTION app.guard_sanad_file_version();

CREATE FUNCTION app.guard_sanad_chunk_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.provenance IS NOT NULL AND
     ROW(NEW.content, NEW.provenance, NEW.source_id, NEW.file_id, NEW.chunk_index,
         NEW.page_start, NEW.page_end, NEW.kind, NEW.locator, NEW.token_count)
     IS DISTINCT FROM
     ROW(OLD.content, OLD.provenance, OLD.source_id, OLD.file_id, OLD.chunk_index,
         OLD.page_start, OLD.page_end, OLD.kind, OLD.locator, OLD.token_count)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SANAD_VERSION_IMMUTABLE';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chunks_sanad_version_guard BEFORE UPDATE ON chunks
FOR EACH ROW EXECUTE FUNCTION app.guard_sanad_chunk_version();

-- Lock the file so concurrent inserts cannot race publication. Cascaded cleanup of
-- a deleted file/source/workspace is allowed; direct edits to a published set are not.
CREATE FUNCTION app.guard_sanad_chunk_set() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  published jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT extraction INTO published FROM files
    WHERE workspace_id = NEW.workspace_id AND id = NEW.file_id FOR SHARE;
    IF published IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SANAD_VERSION_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  SELECT extraction INTO published FROM files
  WHERE workspace_id = OLD.workspace_id AND id = OLD.file_id;
  IF published IS NOT NULL AND
     EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id) AND
     EXISTS (SELECT 1 FROM sources WHERE workspace_id = OLD.workspace_id AND id = OLD.source_id)
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'SANAD_VERSION_IMMUTABLE';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER chunks_sanad_set_guard BEFORE INSERT OR DELETE ON chunks
FOR EACH ROW EXECUTE FUNCTION app.guard_sanad_chunk_set();
