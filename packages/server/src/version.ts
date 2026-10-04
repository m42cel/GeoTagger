import { readFileSync } from 'node:fs';

/**
 * Written into every file GeoTagger touches, as `geotagger:AppVersion` (SPEC §9.3),
 * so a file can be traced back to the release that changed it.
 *
 * Read from the root package.json, the one version the release workflow checks the git
 * tag against. The path holds from both src/ and dist/, and in the Docker image.
 */
export const APP_VERSION: string = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).version;
