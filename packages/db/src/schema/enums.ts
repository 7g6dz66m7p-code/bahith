import { pgEnum } from 'drizzle-orm/pg-core';

export const localeEnum = pgEnum('locale', ['ar', 'en']);

export const workspaceKindEnum = pgEnum('workspace_kind', ['personal']);

export const membershipRoleEnum = pgEnum('membership_role', [
  'owner',
  'editor',
  'viewer',
  'supervisor',
]);

export const citationStyleEnum = pgEnum('citation_style', ['apa-7', 'chicago', 'mla']);

export const projectStatusEnum = pgEnum('project_status', ['active', 'archived']);

export const researchPlanStatusEnum = pgEnum('research_plan_status', ['draft', 'approved']);

export const sourceOriginEnum = pgEnum('source_origin', ['upload', 'import', 'search', 'manual']);

/** A source may be cited only once its existence and metadata are `verified`. */
export const sourceVerificationStatusEnum = pgEnum('source_verification_status', [
  'unverified',
  'verified',
  'mismatch',
  'not_found',
]);

/** `abstract_only` sources must never be cited with a page number. */
export const sourceFullTextStatusEnum = pgEnum('source_full_text_status', [
  'none',
  'abstract_only',
  'full_text',
]);

export const fileStatusEnum = pgEnum('file_status', ['uploaded', 'processing', 'ready', 'failed']);

export const chunkKindEnum = pgEnum('chunk_kind', ['full_text', 'abstract']);

export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system']);

/** The governing principle: every claim is evidence-backed or explicitly labelled. */
export const claimSupportStatusEnum = pgEnum('claim_support_status', [
  'supported',
  'inference',
  'hypothesis',
  'unsupported',
]);

export const documentVersionKindEnum = pgEnum('document_version_kind', ['autosave', 'manual']);

export const citationStatusEnum = pgEnum('citation_status', ['unconfirmed', 'confirmed']);

export const agentRunStatusEnum = pgEnum('agent_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);

export const exportFormatEnum = pgEnum('export_format', ['docx', 'pdf']);

export const exportStatusEnum = pgEnum('export_status', [
  'pending',
  'processing',
  'ready',
  'failed',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'trialing',
  'past_due',
  'canceled',
]);
