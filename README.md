# GeoTagger

Self-hosted geotagging for vacation photos and videos: it interpolates missing GPS
positions from timestamps and neighbouring files that already carry coordinates, and
corrects the camera clocks those timestamps depend on.

See [SPEC.md](SPEC.md) for the full design.

## Status — phase 1 (time correction)

**A usable release: a standalone timestamp-correction tool.** There is no map yet —
that is phase 2 — but phases 0 and 1 together are a complete application for putting a
folder's clocks right and writing the result back to the files.

Phase 0, the foundation:

- server-side folder browser rooted at `PHOTO_ROOT`, with recursive media counts and
  a recent-folders list
- recursive, incremental scan with live progress over SSE
- metadata extraction through a long-lived ExifTool process
- capture-time resolution by the precedence of SPEC §4.1, with the winning source
  recorded and shown per file
- device identification, and strip grouping by device or by subfolder
- thumbnails: embedded-preview extraction first, `sharp` second, ffmpeg for video
  frames and as the HEIC fallback — all rendered the right way up, including the
  embedded previews that carry no orientation of their own
- the per-folder SQLite edit store in `.geotagger/`, with size+mtime change detection

Phase 1, time correction:

- **the alignment view** — a shared, zoomable, proportional time axis with one lane per
  strip. Drag a strip's body to shift every file in it; drag the handles on a selected
  strip to stretch it, which is linear clock drift. Magnetic snapping pulls a strip onto
  the photos of other lanes and onto whole minutes and hours (hold `Alt` to disable it);
  `←`/`→` nudge by a second, `Shift` by a minute, `Ctrl`/`Cmd` by an hour. Strips show
  photo thumbnails at every zoom level; colliding thumbnails stack with a count and
  separate as you zoom in. Only the visible window is drawn.
- **cut, merge, lock and reset** — cut a strip where a camera's clock changed partway
  through the trip; segments stay in one lane until dragging makes them overlap, at
  which point the moved one is promoted to a lane of its own. Locking freezes a strip
  against every change while leaving it a snap target for the others.
- **set true time** — right-click a photo and enter the real time from a clock in the
  shot; its whole strip shifts so it lands there, correcting the files before it as
  well as after it.
- **UTC offset inheritance** — files carrying both coordinates and a trustworthy clock
  establish the offset over each period of the trip by an offline timezone lookup, and
  local-time-only files in that period inherit it. Overridable per strip; asked for once
  when the folder holds nothing to inherit from.
- **the file writer** — persist dialog and per-file progress, one ExifTool write per
  file, each one re-read and verified, originals preserved in a custom XMP namespace,
  staleness checks against files that changed on disk, per-file revert, and an
  operation log.

## Running it

### Docker (the NAS deployment)

```sh
docker compose up -d          # after pointing the volume at your photo folder
```

Then open `http://<nas>:8080`.

### Locally

```sh
npm install
npm run build
node packages/server/dist/cli.js ~/Pictures/Italy2025
```

The folder argument doubles as `PHOTO_ROOT` and is opened straight away, skipping the
picker. Without it, set `PHOTO_ROOT` and use the picker.

### Development

```sh
PHOTO_ROOT=~/Pictures npm run dev       # backend with reload on :8080
npm run dev:web                         # Vite on :5173, proxying /api to the backend
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PHOTO_ROOT` | *required* | All filesystem access is confined beneath it |
| `PORT` | `8080` | |
| `TILE_CACHE_DIR` | `/cache/tiles` | Map tiles (phase 2) |
| `PMTILES_DIR` | `/cache/pmtiles` | Offline archives (phase 5) |
| `STATE_DIR` | parent of `TILE_CACHE_DIR` | Recent-folders list, ExifTool config |
| `SCAN_CONCURRENCY` | `2` | Parallel metadata reads and thumbnail renders |
| `LOG_LEVEL` | `info` | |

## Layout

```
packages/shared   domain types, and the time arithmetic both ends need
packages/server   Fastify API, scanner, metadata, strips, writer, store
packages/web      React UI, including the alignment view
```

The clock arithmetic of SPEC §4.3 lives in `packages/shared` rather than on the server
because the browser recomputes it on every pointer move while a strip is being dragged,
where a round trip per frame is not an option.

## Tests

```sh
npm test
```

Focused on the places where a mistake is silent and expensive (SPEC §13): timestamp
parsing, strip grouping, change detection and path confinement.
