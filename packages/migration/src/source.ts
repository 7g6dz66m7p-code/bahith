import type { Entity } from './canonical';
import type { RawRecord } from './mapping';

export interface ReadOptions {
  /** Delta sync: only rows whose mapped `updatedAt` is at or after this instant. */
  since?: Date;
}

/**
 * Read-only view of the legacy platform. Each method yields rows projected onto
 * canonical field names (values still raw); the planner normalises and validates them.
 * Implementations must never write to the legacy system.
 */
export interface LegacySource {
  readonly kind: string;
  /** Entities this source has a mapping for. */
  entities(): readonly Entity[];
  read(entity: Entity, options?: ReadOptions): AsyncIterable<RawRecord>;
  close(): Promise<void>;
}
