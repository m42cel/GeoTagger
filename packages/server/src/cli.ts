#!/usr/bin/env node
import { loadConfig } from './config.js';
import { buildServer } from './server.js';
import { shutdownExiftool } from './metadata/reader.js';
import { toRelPath } from './paths.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * `geotagger ~/Pictures/Italy2025` opens the server on that folder (SPEC §12).
 *
 * The argument doubles as PHOTO_ROOT for local use. When it points at a folder that
 * already holds media, that folder is opened directly and the picker is skipped.
 */
async function main(): Promise<void> {
  const arg = process.argv[2];
  const config = loadConfig(arg ? path.resolve(arg) : undefined);
  const { app, sessions } = buildServer(config);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`GeoTagger serving ${config.photoRoot} on http://localhost:${config.port}`);

  if (arg) {
    const abs = fs.realpathSync(path.resolve(arg));
    const relPath = toRelPath(config.photoRoot, abs);
    const session = sessions.open(relPath);
    void session.scanner.start().then(() => session.regroupIfNeeded());
    app.log.info(`opened ${relPath === '' ? '(root)' : relPath}`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    sessions.closeAll();
    await app.close();
    await shutdownExiftool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
