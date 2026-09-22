# GeoTagger

Self-hosted geotagging for vacation photos and videos: it interpolates missing GPS
positions from timestamps and neighbouring files that already carry coordinates, and
corrects the camera clocks those timestamps depend on.

See [SPEC.md](SPEC.md) for the full design.

## Status — phase 0 (foundation)

The scanning foundation is in place. There is no map and no time correction yet;
phase 1 adds the alignment view, phase 2 the map.

What works today:

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
| `STATE_DIR` | parent of `TILE_CACHE_DIR` | Recent-folders list |
| `SCAN_CONCURRENCY` | `2` | Parallel metadata reads and thumbnail renders |
| `LOG_LEVEL` | `info` | |

## Layout

```
packages/shared   domain types shared by both ends
packages/server   Fastify API, scanner, metadata, thumbnails, SQLite store
packages/web      React UI
```

## Tests

```sh
npm test
```

Focused on the places where a mistake is silent and expensive (SPEC §13): timestamp
parsing, strip grouping, change detection and path confinement.
