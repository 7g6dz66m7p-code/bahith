import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { extractJobSchema, ingestJobSchema } from '../../src/contracts';
import { fileObjectKey, isWorkspaceKey, manifestObjectKey } from '../../src/keys';
import { sniffMimeType } from '../../src/sniff';
import { parseStorageConfig } from '../../src/storage';

const contract = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, '../../contracts', name), 'utf8'));

const ws = '5a1e2d3c-4b5a-4697-8e1f-0a2b3c4d5e6f';
const file = '1d2c3b4a-5f6e-4d8c-9b0a-1f2e3d4c5b6a';

describe('queue contracts', () => {
  it('accept the canonical examples shared with the Python worker', () => {
    expect(extractJobSchema.parse(contract('sanad-extract.json')).mimeType).toBe('application/pdf');
    expect(ingestJobSchema.parse(contract('sanad-ingest-extracted.json')).outcome).toBe(
      'extracted',
    );
    expect(ingestJobSchema.parse(contract('sanad-ingest-failed.json')).outcome).toBe('failed');
  });

  it('reject payloads carrying text or unknown fields', () => {
    const base = contract('sanad-extract.json') as Record<string, unknown>;
    expect(extractJobSchema.safeParse({ ...base, title: 'عنوان' }).success).toBe(false);
    expect(extractJobSchema.safeParse({ ...base, mimeType: 'application/zip' }).success).toBe(
      false,
    );
    const failed = contract('sanad-ingest-failed.json') as Record<string, unknown>;
    expect(ingestJobSchema.safeParse({ ...failed, code: 'parser said: <secret>' }).success).toBe(
      false,
    );
  });
});

describe('object keys', () => {
  it('are built from identifiers only and stay under the workspace prefix', () => {
    expect(fileObjectKey(ws, file)).toBe(`workspaces/${ws}/files/${file}`);
    expect(manifestObjectKey(ws, file, 'a'.repeat(64))).toBe(
      `workspaces/${ws}/files/${file}/manifests/${'a'.repeat(64)}.json`,
    );
    expect(isWorkspaceKey(ws, fileObjectKey(ws, file))).toBe(true);
    expect(isWorkspaceKey(ws, `workspaces/${ws}/../other`)).toBe(false);
    expect(() => fileObjectKey('../../etc', file)).toThrow();
  });
});

describe('sniffMimeType', () => {
  const utf8 = (text: string) => new TextEncoder().encode(text);

  it.each([
    ['PDF', utf8('%PDF-1.7\n...'), 'application/pdf'],
    ['PNG', Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'image/png'],
    ['JPEG', Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0]), 'image/jpeg'],
    ['TIFF (little endian)', Uint8Array.from([0x49, 0x49, 0x2a, 0x00, 1]), 'image/tiff'],
    ['Arabic UTF-8 text', utf8('الْبَحْثُ العلمي'), 'text/plain'],
  ])('recognises %s from its bytes', (_name, bytes, expected) => {
    expect(sniffMimeType(bytes)).toBe(expected);
  });

  it('recognises a DOCX by its archive entries', () => {
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('....[Content_Types].xml....word/document.xml....'),
    ]);
    expect(sniffMimeType(zip)).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it.each([
    ['an empty file', new Uint8Array()],
    ['a plain ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0])],
    ['binary data', Uint8Array.from([0x00, 0x01, 0xfe, 0xff, 0x00])],
    ['invalid UTF-8', Uint8Array.from([0xc3, 0x28, 0x41])],
  ])('rejects %s', (_name, bytes) => {
    expect(sniffMimeType(bytes)).toBeNull();
  });
});

describe('parseStorageConfig', () => {
  const env = {
    S3_ENDPOINT: 'http://localhost:9000',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'bahith-dev',
    S3_ACCESS_KEY_ID: 'placeholder-id',
    S3_SECRET_ACCESS_KEY: 'placeholder-secret',
    S3_FORCE_PATH_STYLE: 'true',
  };

  it('reads a complete configuration', () => {
    expect(parseStorageConfig(env)).toMatchObject({ bucket: 'bahith-dev', forcePathStyle: true });
  });

  it('fails with a stable code and no values when something is missing', () => {
    try {
      parseStorageConfig({ ...env, S3_SECRET_ACCESS_KEY: '' });
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: 'PIPELINE_CONFIG_MISSING' });
      expect(String(error)).not.toContain('placeholder');
    }
  });
});
