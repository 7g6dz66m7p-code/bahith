import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

import { PipelineError } from './errors';

const storageConfigSchema = z.object({
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).optional(),
});

export interface StorageConfig {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/** Reads S3 settings; names missing variables, never their values. */
export function parseStorageConfig(env: Record<string, string | undefined>): StorageConfig {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = storageConfigSchema.safeParse(present);
  if (!parsed.success) throw new PipelineError('PIPELINE_CONFIG_MISSING');
  const value = parsed.data;
  return {
    ...(value.S3_ENDPOINT === undefined ? {} : { endpoint: value.S3_ENDPOINT }),
    region: value.S3_REGION,
    bucket: value.S3_BUCKET,
    accessKeyId: value.S3_ACCESS_KEY_ID,
    secretAccessKey: value.S3_SECRET_ACCESS_KEY,
    forcePathStyle: value.S3_FORCE_PATH_STYLE === 'true',
  };
}

export interface ObjectStorage {
  /** Stores bytes and verifies the server received exactly them (SHA-256 checksum). */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Reads an object fully, refusing anything larger than `maxBytes`. */
  getBytes(key: string, maxBytes: number): Promise<Uint8Array>;
  /** Streams an object (for serving a file to an authorized viewer). */
  getStream(key: string): Promise<{ body: Readable; contentLength: number | undefined }>;
  delete(key: string): Promise<void>;
  /** Creates the bucket when missing (local development and tests only). */
  ensureBucket(): Promise<void>;
}

function storageFailure(error: unknown): never {
  if (error instanceof PipelineError) throw error;
  if (error instanceof NoSuchKey || (error instanceof Error && error.name === 'NoSuchKey')) {
    throw new PipelineError('STORAGE_NOT_FOUND', { cause: error });
  }
  throw new PipelineError('STORAGE_UNAVAILABLE', { cause: error });
}

export function createStorage(config: StorageConfig): ObjectStorage {
  const client = new S3Client({
    region: config.region,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    forcePathStyle: config.forcePathStyle,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 3,
  });
  const Bucket = config.bucket;

  return {
    async put(key, bytes, contentType) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            ContentLength: bytes.byteLength,
            ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
          }),
        );
      } catch (error) {
        storageFailure(error);
      }
    },
    async getBytes(key, maxBytes) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (response.ContentLength !== undefined && response.ContentLength > maxBytes) {
          throw new PipelineError('STORAGE_TOO_LARGE');
        }
        const body = response.Body;
        if (body === undefined) throw new PipelineError('STORAGE_NOT_FOUND');
        const bytes = await body.transformToByteArray();
        if (bytes.byteLength > maxBytes) throw new PipelineError('STORAGE_TOO_LARGE');
        return bytes;
      } catch (error) {
        return storageFailure(error);
      }
    },
    async getStream(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (response.Body === undefined) throw new PipelineError('STORAGE_NOT_FOUND');
        return { body: response.Body as Readable, contentLength: response.ContentLength };
      } catch (error) {
        return storageFailure(error);
      }
    },
    async delete(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
      } catch (error) {
        storageFailure(error);
      }
    },
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket }));
      } catch {
        try {
          await client.send(new CreateBucketCommand({ Bucket }));
        } catch (error) {
          storageFailure(error);
        }
      }
    },
  };
}
