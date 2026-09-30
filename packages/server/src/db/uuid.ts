import { randomUUIDv7 } from 'node:crypto';

/**
 * File id generation (SPEC §8.2): a UUIDv7 per file, unique across every folder
 * GeoTagger ever opens. Nothing reads meaning into the order two ids compare in, so
 * Node's own generator is used as-is rather than adding a monotonic wrapper around it.
 */
export const generateFileId = randomUUIDv7;
