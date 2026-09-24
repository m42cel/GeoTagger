# syntax=docker/dockerfile:1

# GeoTagger runs on the NAS, where the photos are, so this image is built for both
# linux/arm64 (typical NAS) and linux/amd64 (SPEC §12).
#
# The native module — better-sqlite3 — is installed in the builder on the same base
# image as the runtime, so its binary matches both the platform and the glibc of the
# image it ends up in. Changing one stage's base without the other breaks it.

FROM node:22-trixie-slim AS builder
WORKDIR /app

# perl is needed by the ExifTool that exiftool-vendored ships and unpacks at install.
RUN apt-get update \
 && apt-get install -y --no-install-recommends perl python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json    packages/web/
RUN npm ci

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm run build

# `tsc -b` is incremental and silently emits nothing when it believes the build is
# already done, so a stale .tsbuildinfo in the context would produce empty dist/
# directories and still exit 0. Fail the image here instead of at runtime.
RUN test -f packages/shared/dist/index.js \
 && test -f packages/server/dist/cli.js \
 && test -f packages/web/dist/index.html \
 || (echo 'build produced no output' >&2; exit 1)

# Drop dev dependencies from the tree that gets copied into the runtime image.
RUN npm prune --omit=dev


FROM node:22-trixie-slim AS runtime
WORKDIR /app

# perl   — ExifTool is a Perl program
# ffmpeg — thumbnail resizing (see packages/server/src/thumbs/generator.ts), video
#          frame grabs, and the HEIC decoder (see below)
#
# SPEC §14 risk 1, resolved: HEIC needs an HEVC decoder, which is why thumbnailing
# goes through ffmpeg rather than a bundled libvips (whose own HEIC support is
# typically built without one for licensing reasons). Debian trixie's ffmpeg 7.1
# decodes HEVC — bookworm's 5.1 cannot, which is why the base is trixie.
# Embedded-preview extraction still runs first and handles most HEIC files without
# decoding anything.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      perl ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    TILE_CACHE_DIR=/cache/tiles \
    PMTILES_DIR=/cache/pmtiles \
    STATE_DIR=/cache \
    SCAN_CONCURRENCY=2 \
    LOG_LEVEL=info

COPY --from=builder /app/node_modules              ./node_modules
COPY --from=builder /app/package.json              ./package.json
COPY --from=builder /app/packages/shared/dist      ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder /app/packages/server/dist      ./packages/server/dist
COPY --from=builder /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder /app/packages/web/dist         ./packages/web/dist

# The photo volume is mounted read-write: phase 0 only reads media, but it creates
# `.geotagger/` inside the folder, and later phases write tags back to the files.
VOLUME ["/photos", "/cache"]
EXPOSE 8080

# tini reaps the ExifTool and ffmpeg children, which would otherwise accumulate as
# zombies under PID 1 across a long scan.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/dist/cli.js"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
