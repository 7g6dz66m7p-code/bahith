import { z } from 'zod';

const uuid = z.uuid();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Object keys are built from server-generated identifiers only, never from a file name,
 * so a key can neither escape its workspace prefix nor leak a title.
 */
export function fileObjectKey(workspaceId: string, fileId: string): string {
  return `workspaces/${uuid.parse(workspaceId)}/files/${uuid.parse(fileId)}`;
}

/** Extraction manifests are kept next to the file for re-verification and audit. */
export function manifestObjectKey(workspaceId: string, fileId: string, fileSha256: string): string {
  return `${fileObjectKey(workspaceId, fileId)}/manifests/${sha256.parse(fileSha256)}.json`;
}

/** True when `key` lies under the given workspace's prefix. */
export function isWorkspaceKey(workspaceId: string, key: string): boolean {
  return key.startsWith(`workspaces/${uuid.parse(workspaceId)}/`) && !key.includes('..');
}
