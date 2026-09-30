# GeoTagger

Self-hosted geotagging for vacation photos and videos.

Cameras that normally record GPS sometimes miss a fix, leaving gaps in an otherwise
well-tagged trip. Because the files around a gap *do* have coordinates, and every file
has a timestamp, the missing positions can be estimated: a photo taken one minute after
a known point and nine minutes before the next is very probably close to the first.
GeoTagger shows those estimates on a map, lets you correct them by hand, and writes
only what you have confirmed back into the files.

Estimates are only as good as the timestamps behind them, and offline cameras keep bad
time: never set, not moved across a timezone border, reset with the battery. So
GeoTagger's first job is putting every camera's clock right.

It runs as a web app, meant for the NAS where the photos already live, so scanning,
thumbnailing and writing happen next to the files instead of across a network share.
It works just as well locally on a laptop.

Supported formats: **JPEG, HEIC, PNG, MP4, MOV, M4V**.

## Features

### Time correction

- **Alignment view.** Every camera gets its own filmstrip on a shared, zoomable time
  axis. Drag a strip to shift all of its files by one offset. It snaps onto photos in
  other strips and onto whole minutes and hours (hold `Alt` to turn snapping off). Arrow
  keys nudge by a second, a minute with `Shift`, or an hour with `Ctrl`/`Cmd`.
- **Side-by-side comparison.** The last two photos you clicked are shown next to each
  other. One click aligns their strips so both photos land on the same instant, for
  example two cameras that shot the same moment.
- **Set the true time.** Right-click a photo that shows a clock and enter the time on
  it. Its whole strip shifts to match.
- **Cut, merge, lock and reset.** Cut a strip where a camera's clock changed partway
  through the trip, merge segments back together, lock a strip that is already right,
  or reset one back to no correction.
- **UTC offsets.** Files with both GPS and a trustworthy clock set the UTC offset for
  their stretch of the trip (by an offline timezone lookup). Files with only local time
  from the same stretch take that offset. You can override it per strip.

### Positions

- **Map.** Every file appears as a thumbnail marker, clustered when zoomed out and
  joined by a path line in time order. Switch between map and satellite imagery.
- **Interpolation.** Files without GPS are placed along the great circle between the
  known positions before and after them, and extrapolated beyond the first and last.
- **Uncertainty.** Each estimate gets a circle that answers "how far off could this
  be?". It is based on travel time, so a photo one minute from a known point gets a
  tight circle even when the next known point is far away.
- **Confirm before anything counts.** Estimates are red and known positions are
  green. Drag a marker to correct it, then confirm it. Only confirmed positions are
  used to place other files, and only they get written to disk. Shift-click or
  shift-drag selects several files so you can confirm them together.
- **Revert and reset.** Revert cancels a drag and returns to the position underneath.
  Reset discards the position entirely and goes back to the estimate.
- **Filters** show or hide markers that are unconfirmed, app-modified or not yet
  written to disk.

### Writing to files

- Nothing touches a file until you **persist**. Until then, edits live in a small
  SQLite database in a `.geotagger/` folder inside the photo folder.
- The persist dialog lists exactly which tags will change in which file. Each file
  is written once, time and position together, then re-read and checked.
- **Originals are kept.** Before a tag is overwritten for the first time, its old
  value is saved in the file itself under a `geotagger:` XMP namespace, along with
  what GeoTagger changed and which version did it. Files modified on disk since the
  scan are skipped instead of overwritten. File modification times are left alone.

## Running it

### Docker (on a NAS)

Images for `linux/amd64` and `linux/arm64` are published to
`ghcr.io/m42cel/geotagger`. Tags: `latest`, `1`, `1.0` or `1.0.0` for releases, `dev`
for the current `main` branch.

```yaml
services:
  geotagger:
    image: ghcr.io/m42cel/geotagger:latest
    ports: ["8080:8080"]
    environment:
      PHOTO_ROOT: /photos
      SCAN_CONCURRENCY: 2
    volumes:
      - /volume1/photos:/photos   # your photo folder; must be writable
      - ./cache:/cache            # tile cache and app state
    restart: unless-stopped
```

Save this as `docker-compose.yml` (or use the one in this repository), run
`docker compose up -d`, and open `http://<nas>:8080`.

GeoTagger has **no authentication**. Run it on a trusted home network only. All file
access is confined beneath `PHOTO_ROOT`, but that guards against bugs, not against
people.

### Locally

Needs Node 26, plus `ffmpeg` and `perl` on the `PATH`.

```sh
npm install
npm run build
node packages/server/dist/cli.js ~/Pictures/Italy2025
```

Then open `http://localhost:8080`. The folder argument is also used as `PHOTO_ROOT`
and opens straight away, without the folder picker.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PHOTO_ROOT` | *required* | Folder to work in; nothing outside it is ever read or written |
| `PORT` | `8080` | |
| `HOST` | `0.0.0.0` | Address to listen on |
| `TILE_CACHE_DIR` | `/cache/tiles` | Map tile cache. Never expires, shared by all folders |
| `STATE_DIR` | parent of `TILE_CACHE_DIR` | Recent-folders list, ExifTool config |
| `SCAN_CONCURRENCY` | `2` | Parallel metadata reads and thumbnail renders; raise on a stronger machine |
| `LOG_LEVEL` | `info` | |

## Development

```sh
PHOTO_ROOT=~/Pictures npm run dev       # backend with reload on :8080
npm run dev:web                         # Vite on :5173, proxying /api to the backend
npm test
npm run typecheck
```

```
packages/shared   domain types, and the time arithmetic both ends need
packages/server   Fastify API, scanner, metadata, interpolation, writer, edit store
packages/web      React UI: alignment view, map, persist dialog
```

[SPEC.md](SPEC.md) describes the full design and the reasoning behind it.

### Releasing

Set `version` in the root `package.json` and the three under `packages/`, run
`npm install` to update the lockfile, and merge. Then tag `main` and push the tag:

```sh
git tag v1.0.0 && git push origin v1.0.0
```

The release workflow checks the tag against `package.json` and runs the tests. It then
publishes the Docker image as `1.0.0`, `1.0`, `1` and `latest` and creates a GitHub
release with generated notes.

## License

[AGPL-3.0-or-later](LICENSE)
