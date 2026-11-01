import { readFileSync } from 'node:fs';

/**
 * Written into every file GeoTagger touches, as `geotagger:AppVersion` (SPEC §9.3),
 * so a file can be traced back to the build that changed it.
 *
 * Read from the root package.json, which holds `dev-local` in the repository; the Docker
 * build stamps the real version into it (SPEC §12). The path holds from both src/ and
 * dist/, and in the Docker image.
 */
export const APP_VERSION: string = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
).version;
