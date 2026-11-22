export { createDatabase } from './client';
export type {
  CreateDatabaseOptions,
  Database,
  Db,
  Schema,
  Tx,
  WithWorkspaceOptions,
} from './client';
export { DbError } from './errors';
export type { DbErrorCode } from './errors';
export { arabicTsQuery } from './search';
export * as schema from './schema/index';
export { canReview, canWriteContent, withSanadProject } from './sanad/access';
export type { MembershipRole, SanadAccess, SanadProjectContext } from './sanad/access';
export { SanadError } from './sanad/errors';
export type { SanadErrorCode } from './sanad/errors';
export { ingestExtraction } from './sanad/ingest';
export type { IngestExtractionInput } from './sanad/ingest';
export { parseExtractionManifest, extractionManifestSchema } from './sanad/manifest';
export type { ExtractionManifest } from './sanad/manifest';
export { retrieve, sanadRetrieveSchema } from './sanad/retrieve';
export type { SanadRetrieveInput, SanadRetrieveResult, SanadEvidence } from './sanad/retrieve';
export {
  createProject,
  createProjectSchema,
  getProjectForUser,
  listUserProjects,
  withWorkspaceMember,
} from './projects';
export {
  addReferenceSource,
  applySourceVerification,
  listProjectSourceMetadata,
  registryRecordSchema,
  getProjectFile,
  listProjectLibrary,
  markFileFailed,
  markFileQueued,
  MAX_UPLOAD_BYTES,
  recordProjectAudit,
  registerUpload,
  registerUploadSchema,
  titleFromFilename,
} from './library';
export type {
  LibraryEntry,
  RegisterUploadInput,
  RegisteredUpload,
  RegistryRecord,
  SourceMetadata,
} from './library';
export { EXTRACTABLE_MIME_TYPES, isPagedMimeType } from './sanad/manifest';
export type { ExtractableMimeType } from './sanad/manifest';
export {
  createDocument,
  createDocumentSchema,
  getDocument,
  listDocuments,
  listDocumentVersions,
  MAX_DOCUMENT_JSON_BYTES,
  resolveCitationTargets,
  saveDocument,
  saveDocumentSchema,
} from './documents';
export type { CitationTarget, DocumentSummary, DocumentVersion } from './documents';
export {
  AI_REQUESTS_METRIC,
  AssistantError,
  finishAssistantRun,
  getProjectAiConsent,
  saveAssistantExchange,
  setProjectAiConsent,
  startAssistantRun,
} from './assistant';
export type { AssistantErrorCode, ProjectAiConsent } from './assistant';
export {
  acceptSuggestion,
  acceptSuggestionSchema,
  addComment,
  addCommentSchema,
  addSuggestion,
  addSuggestionSchema,
  listComments,
  rejectSuggestion,
  resolveComment,
} from './review';
export type { AcceptedSuggestion, ReviewComment, ReviewContext } from './review';
