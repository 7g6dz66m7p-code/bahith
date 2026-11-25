-- Reverts 0008_document_review: the review table (its policy, grants, indexes and
-- constraints go with it) and its two enums.
DROP TABLE IF EXISTS "document_comments";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."document_comment_status";--> statement-breakpoint
DROP TYPE IF EXISTS "public"."document_comment_kind";
