# GeoTagger — Specification

A self-hosted web application for adding, correcting and confirming geo coordinates on
vacation photos and videos, by interpolating positions from timestamps and neighbouring
files that already carry GPS data.

Status: specification, agreed 2026-09-22. No code written yet.

---

## 1. Goals and context

Cameras that normally geotag occasionally fail to get a fix, leaving gaps in an otherwise
well-tagged set of media. Because the files around the gap *do* have coordinates and every
file has a timestamp, the missing positions can be estimated: a photo taken one minute after
a known point and nine minutes before another is very probably close to the first one.

The application makes those estimates visible on a map, lets the user correct them by hand,
requires explicit confirmation before anything is written, and keeps the original values so
every change can be reverted.

A second, equally important function is timestamp correction. Interpolation is only as good
as the timestamps it works from, and offline cameras routinely have wrong clocks — set
incorrectly, never updated across timezone borders, or reset after the battery was removed.

### Primary user and deployment

Single user, home network. Photos live on a NAS. The app runs **on the NAS**, so scanning,
thumbnailing and metadata writing all happen where the bytes are rather than across an SMB
mount — a difference of minutes versus hours on a few thousand files, and it removes the risk
of an interrupted write over the network corrupting a file. The same program can also be run
locally on the Mac against a local folder.

---

## 2. Technology decisions

| Area | Decision | Rationale |
| --- | --- | --- |
| Architecture | Headless backend serving a browser UI | One codebase serves both NAS and local use; no packaging, no native shell |
| Backend | Node 22 + TypeScript, Fastify | Shared types with the frontend; best metadata tooling |
| Frontend | TypeScript + React | Shares the domain model with the backend |
| Map | Leaflet, raster tiles | Mature draggable-HTML-marker, polyline, circle and clustering ecosystem; trivial file-based tile caching |
| Metadata | ExifTool via `exiftool-vendored` | Keeps ExifTool alive in `-stay_open` mode; normalises timestamp and GPS representations |
| Images | `sharp` (libvips), with ExifTool preview extraction first | Preview extraction avoids full decodes on weak CPUs |
| Video | `ffmpeg` (frame grab), ExifTool (metadata) | |
| Persistence | SQLite (`better-sqlite3`) | Per-folder edit store and file index |
| Packaging | Docker image, linux/arm64 + linux/amd64 | NAS deployment; all native dependencies baked in |

**Why not Electron or Tauri:** the map is inherently a web view, so a desktop shell would only
add a window frame and a native folder dialog. Running server-side is a genuine performance
requirement here, and a browser UI satisfies both deployment modes with one implementation.

**Why not Go:** since the image must contain ExifTool (Perl) and ffmpeg regardless, Go's single
static binary advantage largely evaporates. Node keeps one language and one set of domain types
across the whole stack, and `exiftool-vendored` already solves timestamp and GPS normalisation
— the exact area where silent errors are most expensive here.

### Target scale and environment

- 1,000–5,000 media files per folder, scanned recursively.
- Low-power ARM NAS. Design consequences: extract embedded previews instead of decoding full
  images wherever possible, cache thumbnails persistently, scan incrementally with visible
  progress, and block browsing until the scan and its thumbnails finish, so the folder is never
  shown half-indexed.
- LAN-only, no authentication. The server nevertheless confines all filesystem access to a
  configured root (see §11) — that is bug containment, not access control.

### Supported formats

In scope: **JPEG, HEIC, PNG, MP4, MOV, M4V**.

RAW is out of scope for the first version. The intended design is recorded in §9.5 so it can be
added later without rework: RAW files would get XMP sidecars rather than in-place writes.

---

## 3. Core concepts

**Anchor** — a file whose position is treated as known. A file is an anchor if it has GPS
coordinates from the camera, if the user dragged it to a position, or if the user confirmed it.

**Estimate** — a computed position for a non-anchor file, derived from the anchors around it in
time. Estimates are recomputed whenever anchors or timestamps change, and an *unconfirmed*
estimate is never stored.

**Materialisation** — confirming an estimate freezes it: the computed coordinates and their
uncertainty are written into the edit store as concrete values, and the file becomes an anchor.
From that moment it no longer tracks its neighbours. This is the point of confirming — a
position the user has vouched for must not silently move because some other anchor changed
later.

**Confirmation** — the user's explicit acceptance of a position. Only confirmed positions are
eligible to be written to files. Confirming promotes the file to anchor status.

**Edit store** — the application's SQLite database, which is the source of truth during work.
Nothing touches the media files until the user runs an explicit persist operation.

**Effective timestamp** — a file's capture time after clock corrections and UTC offset
resolution have been applied. All interpolation works on effective timestamps.

**Strip** — a contiguous set of files sharing one clock correction, shown as a horizontal
filmstrip on a shared time axis. Dragging a strip is how a clock is corrected. Every file
belongs to exactly one strip.

**Lane** — a horizontal row holding one or more strips. Strips in different lanes may overlap
in time; strips within a lane may not.

---

### 3.1 Data flow

The media files are read **once**, at scan time. Everything after that works on the application's
own model, and the files are not touched again until the user persists — at which point they are
read once more only to verify what was written.

```
  scan (once per file)
        │
        ▼
  raw metadata  ──▶  file index in .geotagger/edits.sqlite
                            │
                            ▼
                     working model (in memory, backed by SQLite)
                            │
              ┌─────────────┼──────────────┐
              │             │              │
        strips and      positions,     UTC offsets
        clock offsets   confirmations
              │             │              │
              └─────────────┼──────────────┘
                            ▼
                    effective timestamps
                    interpolated positions      ← derived while unconfirmed
                            │
                            ▼
                   persist (explicit, once)
                            │
                            ▼
            one write per file: time and GPS tags together
```

Consequences worth naming:

- **Timestamp corrections feed the map.** The alignment view changes effective timestamps in the
  working model; interpolation later reads those corrected values, not the camera's originals.
  This is why time correction is built first and why it needs no map.
- **Edits of both kinds accumulate side by side** and are committed together. A file that needs
  both a corrected timestamp and a new position is written **once**, with both payloads in a
  single ExifTool command — not rewritten twice.
- **Unconfirmed values are derived; confirmed ones are stored.** Effective timestamps and
  unconfirmed position estimates are recomputed from strips, offsets and anchors whenever
  anything changes. Confirming an estimate materialises it into stored coordinates (§5.6), which
  is what makes it an anchor and what makes it survive restarts.
- **In phase 1 the commit carries only time data**, because no position editing exists yet. It is
  the same writer, the same verification and the same original-preservation mechanism that phase
  4 extends to GPS tags — not a separate path.

---

## 4. Timestamps

Timestamp handling is the foundation; a wrong timestamp silently produces a plausible-looking
but wrong position.

### 4.1 Capture time resolution order

The first source that yields a valid value wins, and the winning source is recorded and
displayed per file:

1. `EXIF:DateTimeOriginal`
2. `EXIF:CreateDate` / `DateTimeDigitized`
3. `QuickTime:CreateDate` (video; stored as UTC)
4. `XMP:DateCreated`
5. `EXIF:GPSDateTime` (UTC, authoritative when present)
6. Filename patterns — `IMG_20240712_143210`, `20240712_143210`, `VID_20240712_143210`,
   `PXL_20240712_143210`, `2024-07-12 14.32.10`, and similar. Included because copying files
   through cloud services or network shares frequently destroys mtime while the filename
   survives.
7. `FileModifyDate` (last resort)

### 4.2 Local time versus UTC

Photos store naive local time with no zone; videos store UTC. Both must sit on a single
absolute timeline for interpolation to work at all, so every file needs a UTC offset.

The offset is **inherited from files that know it**: files carrying both real coordinates and a
trustworthy clock (typically a phone) establish the UTC offset over each period of the trip via
an offline timezone-boundary lookup from their coordinates. Local-time-only files in the same
period inherit that offset.

This is deliberately not derived from a file's *own* interpolated position — that would be
circular for exactly the files that need it most. It comes from the device that actually knows.

- Any strip's or selection's offset can be overridden manually.
- If no GPS-bearing file exists in the folder at all, the user is prompted for an offset once.
- Resolved offsets are written to files on persist as `OffsetTimeOriginal` and
  `OffsetTimeDigitized`, which turns an ambiguous local time into an unambiguous instant
  permanently.

### 4.3 Clock corrections — the alignment view

Corrections are made by **direct manipulation on a shared time axis**, not by selecting files
and typing numbers. Each device (or subfolder, or manual selection) becomes a horizontal
filmstrip, the strips are stacked vertically, and each one can be dragged left or right
independently — like the wheels of a combination padlock.

What the user is really doing is aligning *patterns of activity* between devices: the same
sunset, the same dinner, the same walk produce the same rhythm of shots on every camera that was
present. Dragging until those rhythms line up is exactly the correction, and photo content stays
visible throughout, so recognising a shared moment happens naturally instead of through a
separate pairing screen.

**The axis is proportional to real time** — thumbnails sit at their actual timestamps, never
evenly spaced. This is what makes the gesture meaningful: a drag of *n* pixels is a shift of a
definite number of seconds.

#### Dragging

- Grabbing a strip's **body** shifts every file in it by a constant offset.
- A live readout shows the exact offset while dragging (`+1h 02m 12s`), and the selected strip
  has an editable offset field for exact entry.
- Keyboard nudging reaches precision the mouse cannot: `←`/`→` 1 second, `Shift` 1 minute,
  `Ctrl`/`Cmd` 1 hour.
- **Magnetic snapping** pulls a strip into alignment when its photos come close to lining up
  with photos in another lane, and additionally when the offset approaches a whole minute or a
  whole hour — timezone errors are exactly whole hours, so that snap is worth having. Holding
  `Alt` while dragging disables snapping entirely.

#### The correction itself

A strip carries **one offset**, applied to every file in it alike:

```
effective(f) = t_f + offset + utc_offset_resolution
```

```
┌◀────────────────────▶┐   grab body → the whole strip shifts
│  ■  ■■  ■   ■■■  ■   │
└──────────────────────┘   offset +1h 02m 12s
```

One constant per strip is the entire model. A clock that was wrong by different amounts at
different times is handled by cutting the strip, not by deforming it: each segment is a strip in
its own right with an offset of its own. Gradual drift within one segment is deferred — see
below.

#### Locking and reset

Every strip carries two always-visible controls in its lane header, independent of selection.

**Lock** freezes a strip: no body drag, no cut, no merge, no lane move, no keyboard nudge. Its
purpose is the device whose clock is already correct — typically a phone — which should never
move by accident while you are dragging the strips around it.

A locked strip remains fully functional in every other respect: it is still selectable and
inspectable, and crucially it is **still a snap target**, so other strips continue to align
against it. Locking protects it from being changed; it does not remove it from the work.

**Reset** returns a strip to zero offset in one click. It does not undo cuts — segments are
structure, not correction, and merging them is a separate action. Reset is refused on a locked
strip, and like every other change it is undoable.

A **reset all** control in the view toolbar rebuilds every strip from the current grouping mode,
discarding cuts, offsets and locks together, with a confirmation.

#### Cutting — more than one offset

A strip can be **cut** at any point on the axis, producing two independently draggable segments.
This handles a camera whose clock changed partway through the trip — a timezone border crossed,
a battery removed, a manual correction made mid-holiday.

- The cut point splits membership by effective time; both segments inherit the parent's offset,
  so nothing jumps at the moment of cutting.
- Segments stay in the same lane. If dragging makes two segments overlap in time, the moved
  segment is **automatically promoted to its own lane** — because strips in one lane must stay
  ordered. A segment can also be dragged vertically into another lane deliberately.
- Empty lanes collapse automatically.
- Two adjacent segments of the same origin can be **merged** again; the result takes the left
  segment's offset.

```
before cut   SONY │■■■■■■■■■■■■│
                         ✂
after cut    SONY │■■■■■│ │■■■■■■■│

drag the right segment left, past the first:
             SONY │■■■■■│
             SONY │   ■■■■■■■│        ← promoted to a new lane
```

#### Pinning a known time

Right-clicking a photo offers **set true time**: enter the real time of that one photo (from a
clock in the shot, a departure board, a receipt) and its whole strip shifts so that photo lands
there. This is the precision path when no other device was present to align against, and it
applies in both directions — an anchor found in the middle of a bad batch corrects the files
before it as well as after it.

#### Deferred — gradual clock drift

An earlier design let a selected strip be **stretched** by handles at its two ends, ramping the
offset linearly across it. That is exactly linear clock drift, but it is not worth what it cost:
modern camera clocks do not drift noticeably over the length of a trip, so the gesture is niche —
and it sat close enough to the strip body that it was easy to start a stretch when a move was
meant. A gesture that silently smears a correction across hundreds of files is a bad one to hit
by accident.

It may come back as a later feature, and if it does, the **reference-point problem has to be
solved first**. Stretching from one end holds the *other end* fixed, but the point the user has
actually aligned is usually somewhere in the middle — a shared sunset, a pinned true time — and
that point slides away from its reference the moment the strip is stretched from either end. The
honest form of the feature is a linear stretch **between two reference points**: two files whose
correct times are known, each held exactly in place, with everything between them scaled and
everything outside them extrapolated along the same line.

**The exact interaction has to be worked out and recorded here before any of it is
implemented** — how the two reference points are chosen, how they are shown, and how the whole
gesture is kept plainly distinct from a move.

### 4.4 How strips are built

The user chooses how the initial strips are formed:

| Mode | Basis |
| --- | --- |
| **By device** (default) | `Make` / `Model` / `SerialNumber` from EXIF |
| **By subfolder** | Directory structure — useful when files were already sorted by camera or by person |
| **Manual** | Select files and make a strip from them |

Strips can also be split and merged by hand regardless of mode, for cameras with missing or
unhelpful EXIF identification.

Switching grouping mode rebuilds the strips from scratch, discarding cuts and offsets. The user
is warned, and the change is undoable.

Grouping exists only in this view. The map treats all files as one collective timeline with no
per-device separation anywhere.

## 5. Position interpolation

All calculations use effective timestamps and great-circle geometry.

### 5.1 Between two anchors

For a file at time `t` between anchors `A` (at `tA`) and `C` (at `tC`), with
`d = distance(A, C)`:

```
f        = (t - tA) / (tC - tA)
position = point at fraction f along the great circle from A to C
```

### 5.2 Uncertainty — the reachability bound

The uncertainty radius answers "how far from this estimate could the true position plausibly
be", using travel time rather than raw distance. This is what makes the example case behave
correctly: a photo one minute after A gets a tight circle even when C is far away.

```
v_implied = d / (tC - tA)
v_ref     = clamp(2 × v_implied, v_floor, v_cap)      defaults: 5 km/h, 200 km/h
slack     = v_ref × (tC - tA) - d                      spare travel capacity

r = max( r_min, min( v_ref × min(t - tA, tC - t),      reachability from each anchor
                     slack / 2 ) )                     ellipse bound with foci A and C
```

`r_min` defaults to 10 m. The result is largest midway between anchors and shrinks towards
each one, and it collapses when the anchors are close in both time and space.

Displayed as a faint circle on every unconfirmed item, with a global toggle. Confirmed items
show no circle. The detail panel states the radius in metres and a plain-language rating
(excellent < 50 m, good < 250 m, fair < 1 km, poor < 5 km, very poor beyond).

### 5.3 Before the first and after the last anchor

Extrapolation uses the velocity implied by the two nearest anchors: continue in that bearing at
that speed. **Not limited by default** — every file gets a position so it is always on the map
and always draggable. Uncertainty grows as `v_ref × Δt` and quickly becomes visually obvious.

A configurable cap exists (`EXTRAPOLATION_MAX_MINUTES`) and **ships disabled**; beyond the cap a
file falls back to the nearest anchor's position with a very large circle.

### 5.4 Degenerate cases

- **One anchor in the whole folder** — every file takes that position with `r = v_ref × Δt`.
- **No anchors at all** — no honest estimate exists, so files go to the tray (§6.4) rather than
  being placed somewhere misleading. Dragging one onto the map makes it an anchor and everything
  else is interpolated from it immediately.
- **Identical timestamps** — files sharing an effective timestamp get the same position and are
  spread visually by clustering, not by fabricated coordinate jitter.

### 5.5 Recomputation

Estimates are recomputed whenever an anchor is added, moved, removed, or when any timestamp
changes. At 5,000 files this is a millisecond-scale operation, so it runs synchronously on every
change and the map always shows current values.

Per the original requirement, **both dragging and confirming** trigger recomputation of
neighbouring unconfirmed estimates.

### 5.6 Materialisation on confirmation

Confirmation converts a derived estimate into stored data:

| State | Coordinates | Stored? | Moves when neighbours change? |
| --- | --- | --- | --- |
| Camera GPS | from the file | yes, in the file | no |
| Unconfirmed estimate | computed | no | yes |
| Dragged, unconfirmed | placed by the user | yes, in the edit store | no |
| Confirmed | frozen at the value shown when confirmed | yes, in the edit store | no |

On confirmation the application records the coordinates, the uncertainty radius at that moment,
and whether the position originated from a drag or from an accepted estimate. The uncertainty is
kept because it is written to the file on persist as `geotagger:PositionUncertaintyMeters`, and
recomputing it later would give a different answer once the file itself has become an anchor.

Consequences:

- Confirmed positions survive restarts and rescans without recomputation.
- Recomputation after any change touches only unconfirmed estimates.
- Reverting a confirmed file discards the stored coordinates and it returns to being derived, or
  to having no position at all if the camera never recorded one.

---

## 6. User interface

### 6.1 Startup flow

1. **Folder picker** — a server-side folder browser rooted at the configured photo root, showing
   media counts per folder, plus a recent-folders list. The app can also be launched pointed
   straight at a folder via a command-line argument or URL, skipping the picker.
2. **Scan** — recursive, incremental, with live progress. Nothing past this step is reachable
   until the scan, including thumbnail generation, finishes; a rescan re-blocks the same way.
3. **Reopening a known folder** shows a summary before continuing:

   ```
   Italy2025 reopened
     1,428 known · 12 new · 1 changed · 0 missing
     34 confirmed changes still unpersisted        [ Continue ]
   ```

4. **Timestamp question** — always asked, without pre-analysis:

   ```
   Do you need to adjust timestamps for this folder?
   [ Fix timestamps first ]        [ Go to map ]
   ```

   The alignment view is reachable at any time afterwards.

### 6.2 Alignment view (time correction)

No map. A shared, zoomable time axis with one lane per strip.

```
 grouping: [ by device ▾ ]   zoom: [ trip · day · hour · minute ]   [ reset all ]

 iPhone 15 Pro  [locked] [reset] │  ■■ ■▅   ■▅█▃      ■■■▆   │   offset  0
                                 │                           │
 SONY ILCE-7M4  [ lock ] [reset] │    ■■ ■▅   ■▅█▃      ■■■▆ │   +1h 02m 12s
                                 │                           │
 DJI Mini 4     [ lock ] [reset] │        ■▅            ■■   │   +2h 00m
                                 ├───────────────────────────┤
                                 │+02:00 Berlin░░░+09:00 Tokyo│  ← UTC offset periods
                                 └───────────────────────────┘
                                  09:00    12:00    15:00  18:00

 selected: SONY ILCE-7M4 · 896 files · 12–21 Jul
   offset  [ +1h 02m 12s ]   UTC [ inherited ]   resolves to +02:00 · inherited from GPS
   [ ✂ cut at cursor ]  [ merge ]  [ reset ]
```

**The UTC offset periods of §4.2 are drawn as a ribbon** between the lanes and the axis. It sits
with the axis rather than in any lane, because a timezone is a property of where the trip *was*,
not of which camera was carried — so a strip that crossed a border needs no cut to show it, and
none to be corrected: the offset is resolved per file from where that file lands in time.

Periods are told apart by alternating tint rather than by colours of their own; the offset is
written in the band, and a palette would add something to learn without adding meaning. What the
drawing does encode is **confidence**. The rules deliberately do not tile the timeline: between
the last GPS fix in one zone and the first in the next, nothing observed the crossing, and a file
there simply takes the nearer period. So observed stretches are drawn solid and the gaps hatched
(`░` above), which makes a border crossing read as the interval of doubt it actually is instead
of a hard line at an instant nobody knows.

The selection panel states what the strip's files **resolved to**, beside the field that
overrides it — two offsets where a strip spans a crossing. The field holds what was typed,
usually nothing; the readout is what §4.2 settled on, and the two are otherwise easy to confuse.

**Zoom levels** run from whole trip down to minutes. Strips always render as photo thumbnails,
at every zoom level: aligning by hand means recognising the same moment on two devices, and an
abstract density bar cannot be recognised. Colliding thumbnails collapse into a stack with a
count and separate as you zoom in.

**Rendering is virtualised**: only files inside the visible time window are drawn, so a lane
holding thousands of files stays responsive.

Each file's timestamp **source** is shown on selection, and sources weaker than an explicit EXIF
capture tag — filename, mtime — are visibly flagged, because a wrong timestamp corrupts
interpolation invisibly.

Applying is implicit: strip offsets live in the edit store as soon as they change, exactly like
positions, and reach the files only on persist.

### 6.3 Map view

```
┌─ map ──────────────────────────────────┐┌ detail ──────┐
│                                        ││              │
│        ■───■──□   □                    ││  (large      │
│              ╲                         ││   preview)   │
│               ■                        ││              │
│                                        ││ IMG_4471.JPG │
│                                        ││ 15:14:20     │
│                                        ││ 47.1234,     │
│                                        ││ 11.3456      │
│                                        ││ interpolated │
│                                        ││ ±180 m (good)│
│                                        ││ [✓] [revert] │
├─ filmstrip ────────────────────────────┤│              │
│■■□■ ■□□□  ■■■■ ││ ■□ ■■■■■■■           ││              │
│ 09:00    11:00  gap  14:00             ││              │
└────────────────────────────────────────┘└──────────────┘
```

**Thumbnails on the map** are fixed-size squares (48 px default, 32–96 px configurable) that do
not scale with zoom, keeping drag targets predictable. Selecting one shows a large preview in the
side panel.

**Border colours:**

| Border | Meaning |
| --- | --- |
| **Green** | Position known — camera GPS, or confirmed by the user |
| **Red** | Interpolated or extrapolated, not yet confirmed |

**Corner badge:** marks a file with changes held in the edit store but not yet written to disk.

Camera-original versus app-set provenance is shown in the detail panel only, not on the
thumbnail.

**Path line:** a single plain polyline connecting all files in effective-time order across all
devices — one collective timeline, no per-device separation, no colour gradient, and it is
never broken by time gaps. Optional direction arrowheads, off by default.

**Clustering:** Leaflet.markercluster; nearby thumbnails collapse into a badge showing the count
over a representative thumbnail and expand on zoom.

**Uncertainty circles:** drawn faintly on all unconfirmed items; global toggle.

**Filters:** by status — unconfirmed, app-modified, unpersisted, no position. (Time-range,
device and confidence filters are explicitly not in scope.)

**Filmstrip:** horizontal, time-ordered, every file with its status colour. Hover and selection
are synchronised with the map in both directions; visible time gaps make the shape of the day
readable in a way the map cannot show.

### 6.4 Tray

A panel beside the map holding files with no derivable position — only ever populated when the
folder contains no anchors at all. Dragging one onto the map sets its position and makes it an
anchor, which immediately places everything else.

### 6.5 Interactions

| Action | Result |
| --- | --- |
| Click thumbnail | Select; detail panel shows large preview, metadata, provenance, uncertainty |
| Drag thumbnail | Sets position; becomes an anchor so neighbours recompute; **stays unconfirmed (red)** |
| Checkmark on selected thumbnail | Confirms → green, anchor, eligible for persist |
| Multi-select (shift-click / rubber band) | Confirm together, or drag the whole group to a new position |
| Revert on selected thumbnail | Restores the original position, or removes it if there was none |
| Persist changes | Writes all confirmed changes to files (§9) |

Dragging deliberately does **not** auto-confirm: confirmation stays a single, explicit gesture
for everything that reaches the disk.

---

## 7. Map tiles

### 7.1 Providers

Served through a backend proxy so provider keys never reach the browser and every tile is cached
server-side, shared across all devices and folders.

| Provider | Key | Role |
| --- | --- | --- |
| OpenStreetMap standard | none | Default |
| Esri World Imagery | none | Satellite layer — markedly easier for placing a photo on the correct side of a building or trail |
| MapTiler / Thunderforest | yes | Optional, configured in settings |
| Local PMTiles | none | Offline (§7.3) |

The OSMF tile usage policy requires an identifying `User-Agent` and forbids bulk or systematic
downloading. The proxy sets a proper User-Agent and limits concurrency to 2 for OSM. Free tiers
and terms change; whichever provider is default should be re-verified before relying on it.

### 7.2 Cache

- Layout: `TILE_CACHE_DIR/<provider>/<z>/<x>/<y>.png`
- **Unbounded, never expires.** Map data ages, but disk is cheap and this maximises offline
  coverage.
- Manual purge available in settings.

### 7.3 Offline

Offline operation is a first-class requirement, implemented as **PMTiles**: a single file
containing map data for a region, read by the server with range requests and rendered in Leaflet
via `protomaps-leaflet`. A region extract (e.g. the Alps) can be produced with the `pmtiles` CLI
from a public planet build and dropped in a configured directory — no key, no limits, no network.

An explicit **"pre-download this area"** function exists but is restricted to providers whose
terms permit bulk caching. It is **disabled for OpenStreetMap**, whose policy forbids exactly
that; PMTiles is the sanctioned route for OSM-derived offline data.

---

## 8. Data storage

### 8.1 Location

Per photo folder, in `.geotagger/`:

```
Italy2025/
 ├─ .geotagger/
 │   ├─ edits.sqlite        index, corrections, edits, operation log
 │   └─ thumbs/             cached thumbnails and previews
 ├─ IMG_4471.JPG
 └─ VID_0033.MP4
```

Edits travel with the photos, so the same folder opened at `/volume1/photos/Italy2025` on the
NAS and `/Volumes/photos/Italy2025` on the Mac is recognised as the same project. Deleting the
directory removes all application state and nothing else.

The tile cache is global rather than per-folder (`TILE_CACHE_DIR`).

### 8.2 Schema (outline)

```
meta(schema_version, folder_id, created_at)

files(id, rel_path, filename, ext, kind, size_bytes, mtime, content_sig,
      device_id, width, height, duration_ms,
      capture_time_raw, capture_time_source, capture_utc_offset_minutes,
      orig_gps_present, orig_lat, orig_lon,
      first_seen_at, last_scanned_at, missing)

devices(id, make, model, serial, label, group_id)
device_groups(id, label)

strips(id, lane, ordinal, label, grouping_source, parent_strip_id,
       offset_seconds, locked, created_at)
strip_files(strip_id, file_id)        -- every file belongs to exactly one strip

utc_offset_rules(id, from_utc, to_utc, offset_minutes, source)

edits(file_id PK, lat, lon, position_source, uncertainty_m,
      placed_at, confirmed_at, utc_offset_override_minutes)
      -- position_source: manual | confirmed-estimate
      -- rows exist only for dragged or confirmed files; unconfirmed
      --   estimates are derived and never written here

persisted(file_id PK, persisted_at, wrote_gps, wrote_time,
          original_snapshot_json, exiftool_result)

oplog(id, ts, file_id, action, before_json, after_json, ok, error)
```

Unconfirmed estimates are not stored — they are derived. Dragged and confirmed positions are
stored in `edits` (§5.6).

### 8.3 Change detection

`size` + `mtime` are recorded per file. A rescan flags changed files and marks any pending edits
on them as stale. Before each write, the file is re-checked; if it changed underneath the app,
the user chooses:

```
⚠ IMG_4471.JPG changed on disk since you edited it
   [ Skip ]   [ Overwrite ]   [ Re-read and keep my GPS ]
```

Content hashing is deliberately avoided as too expensive across thousands of files on a slow
NAS.

---

## 9. Writing to files

### 9.1 The persist step

Nothing is written until the user runs **Persist changes**. This keeps metadata writes to a
minimum on slow storage, allows free experimentation, and makes the whole edit set reviewable
before it becomes permanent.

```
Persist changes
  128 GPS positions
   34 corrected timestamps
   96 UTC offsets added
                              [ Cancel ]  [ Write ]

✓ 257 written and verified
✗ 1 failed: VID_0201.MP4 (read-only)
```

- A file with both a timestamp and a position change is written **once**, both payloads in a
  single ExifTool command.
- Progress is shown per file.
- Each file is re-read after writing and compared against the intended values.
- A failure does not abort the run; the file keeps its pending state and can be retried.
- Failures are listed in the report and recorded in the operation log.

### 9.2 Tags written

**Position, photos:**
```
EXIF:GPSLatitude, EXIF:GPSLatitudeRef
EXIF:GPSLongitude, EXIF:GPSLongitudeRef
XMP:GPSLatitude, XMP:GPSLongitude
```

**Position, videos:**
```
QuickTime:GPSCoordinates      ISO 6709, e.g. +47.1234+011.3456/
XMP:GPSLatitude, XMP:GPSLongitude
```

**Timestamps:**
```
EXIF:DateTimeOriginal, EXIF:CreateDate
EXIF:OffsetTimeOriginal, EXIF:OffsetTimeDigitized
QuickTime:CreateDate          (video, UTC)
```

Filesystem mtime is **not** modified (`exiftool -P`).

### 9.3 Preserving originals

Original values are written into a custom XMP namespace registered through a shipped ExifTool
config file (`geotagger`, `http://ns.geotagger.local/1.0/`):

```
geotagger:OriginalGPSPresent        True | False
geotagger:OriginalGPSLatitude
geotagger:OriginalGPSLongitude
geotagger:OriginalDateTimeOriginal
geotagger:OriginalOffsetTimeOriginal
geotagger:PositionSource            manual | interpolated-confirmed
geotagger:PositionUncertaintyMeters
geotagger:TimeShiftSeconds
geotagger:ModifiedAt
geotagger:AppVersion
```

The same snapshot is stored in the edit store, so revert works whether the app database or the
file is the surviving copy.

### 9.4 Revert

- **Per file** — restores the original position, or removes GPS tags entirely if the file never
  had any, then clears the `geotagger` block.
- **Timestamps revert independently of positions**; they are separate edits with separate
  originals.
- Available before persisting (discard the pending edit) and after (rewrite from the stored
  original).

### 9.5 RAW (deferred)

Not implemented. When added: RAW files get `.xmp` sidecars rather than in-place writes — the
convention Lightroom and Capture One already follow — avoiding rewrites of proprietary
containers that ExifTool can only partially support. Everything else stays in place.

---

## 10. Backend

### 10.1 Scanning pipeline

1. Walk the folder recursively, filtering by extension.
2. Diff against the stored index by path, size and mtime; queue new and changed files.
3. Batch-read metadata through the persistent ExifTool process.
4. Resolve capture time (§4.1), device identity, dimensions, duration, original GPS.
5. Generate thumbnails in the background, lowest-cost path first:
   - extract an embedded preview (`-b -PreviewImage` / `-ThumbnailImage`) when present;
   - otherwise decode and downscale with `sharp`;
   - HEIC falls back to ffmpeg if the bundled libvips cannot decode it (to be verified at build
     time — see §14);
   - video: ffmpeg frame grab at ~10% of duration, clamped to 1–5 s.
6. Two cached tiers: `thumb` 160 px (eager) and `preview` 1280 px (on demand).

Concurrency is bounded and configurable; default 2 workers, appropriate for a low-power ARM CPU.

### 10.2 API (outline)

```
GET    /api/folders?path=              folder browser
POST   /api/session/open               open folder, start scan
GET    /api/session/scan-status        progress stream (SSE)
GET    /api/files                      index with effective times and computed positions
GET    /api/files/:id/thumb            cached thumbnail
GET    /api/files/:id/preview          large preview
POST   /api/edits/:id/position         set manual position
POST   /api/edits/:id/confirm          confirm
POST   /api/edits/:id/revert           revert
POST   /api/edits/bulk                 multi-select confirm / move
GET    /api/devices                    device groups
POST   /api/devices/regroup            split / merge
GET    /api/strips                     lanes, strips, offsets
POST   /api/strips/regroup             rebuild from device / subfolder / manual
POST   /api/strips/:id/offset          set the strip's offset
POST   /api/strips/:id/cut             split at a timestamp
POST   /api/strips/merge               merge two adjacent segments
POST   /api/strips/:id/lane            move to another lane
POST   /api/strips/:id/lock            lock / unlock
POST   /api/strips/:id/reset           zero the offset
POST   /api/strips/reset-all           rebuild every strip from the grouping mode
POST   /api/persist                    write, with progress stream
GET    /api/oplog
GET    /api/settings  ·  POST /api/settings
GET    /tiles/:provider/:z/:x/:y.png   cached proxy
GET    /pmtiles/:name                  range-served offline archive
```

### 10.3 Operation log

Every write is appended to `oplog` with before and after values, so changes can be audited or
reconstructed outside the application. Exportable as JSON.

---

## 11. Configuration

**Environment** (deployment; keeps the Docker command self-contained):

```
PHOTO_ROOT                 required; all filesystem access confined beneath it
PORT                       default 8080
TILE_CACHE_DIR             default /cache/tiles
PMTILES_DIR                default /cache/pmtiles
SCAN_CONCURRENCY           default 2
LOG_LEVEL                  default info
```

**Settings page** (behaviour; stored server-side):

- tile provider and optional API key, satellite layer toggle
- interpolation: `v_floor`, `v_cap`, `r_min`
- extrapolation cap (default off)
- map thumbnail size, uncertainty circle toggle, path arrowheads toggle
- RAW scanning (off, reserved)
- tile cache purge

**Path confinement:** every requested path is resolved with `realpath` and rejected unless it
lies beneath `PHOTO_ROOT`. This is not authentication — it is containment of path-traversal
mistakes, and it applies equally to reads and writes.

---

## 12. Deployment

```yaml
services:
  geotagger:
    image: geotagger:latest
    ports: ["8080:8080"]
    environment:
      PHOTO_ROOT: /photos
    volumes:
      - /volume1/photos:/photos
      - ./cache:/cache
    restart: unless-stopped
```

Image: `node:22-bookworm-slim` plus `exiftool` (and perl), `ffmpeg`, `libheif`. Built for
`linux/arm64` and `linux/amd64`.

Local use:

```
geotagger ~/Pictures/Italy2025     # opens http://localhost:8080 on that folder
```

---

## 13. Testing

Focused on the areas where a mistake is silent and expensive:

- **Timestamp parsing** — every tag variant in §4.1, filename patterns, QuickTime UTC
  conversion, missing and malformed values, mtime fallback.
- **Strip maths** — constant offsets, cutting at a point (both segments keep the parent's
  offset, nothing jumps), merging back, degenerate strips with one file or identical timestamps,
  UTC offset inheritance.
- **Lane management** — overlap detection after a drag, automatic promotion to a new lane,
  collapse of emptied lanes.
- **Locking** — a locked strip rejects drag, cut, merge, lane move, nudge and reset, while
  remaining a valid snap target for others.
- **Snapping** — snaps to neighbouring photo times and to whole minutes and hours; the modifier
  disables it.
- **Interpolation** — great-circle positions, the reachability bound including the documented
  worked example, extrapolation, one-anchor and zero-anchor cases, antimeridian crossing.
- **Metadata round-trip** — write then re-read against sample JPEG, HEIC, PNG, MP4 and MOV
  fixtures; revert restores byte-equivalent metadata; a file that never had GPS ends up with
  none again.
- **Materialisation** — a confirmed position does not move when a neighbouring anchor is later
  changed; an unconfirmed one does; revert returns a confirmed file to derived or to no position;
  confirmed values and their uncertainty survive a restart and a rescan.
- **Staleness** — a file modified between edit and persist is detected and not clobbered.

---

## 14. Risks and open questions

1. ~~**HEIC decoding in the container**~~ — **resolved in phase 0.** Confirmed: the libvips
   bundled with `sharp` carries a libheif with no HEVC decoding plugin, and it will not load
   the system one (the ABI does not match), so it cannot decode HEIC in the container at all.
   The designed mitigation holds — embedded preview extraction first, ffmpeg as fallback — but
   it needs **ffmpeg 7.1**, which decodes HEIF stills; bookworm's 5.1 does not. The image base
   is therefore `node:22-trixie-slim` rather than bookworm.
2. **OSM tile policy** — the default provider forbids bulk downloading, so "pre-download area"
   is disabled for it and PMTiles is the offline route. Terms should be re-checked before
   release.
3. **ARM scan performance** — 5,000 files on a low-power NAS may take a while on first scan.
   Mitigated by preview extraction, persistent caching and incremental rescans; worth measuring
   early against a real folder.
4. **Alignment view rendering** — a proportional time axis with thousands of thumbnails needs
   virtualisation and thumbnail stacking to stay smooth; and at trip zoom one pixel covers
   minutes, so the numeric field and keyboard nudge are not optional conveniences but the only
   way to reach second-level precision. Both are specified, both need measuring.
5. **Leaflet with thousands of DOM markers** — clustering should keep the rendered count low
   enough, but this needs measuring at 5,000 files before the design is considered settled.
6. **QuickTime GPS compatibility** — which players and libraries honour `GPSCoordinates` varies;
   XMP is written alongside for breadth.
7. **Confirmation promotes to anchor**, so a chain of confirmed estimates can in principle drift
   away from reality. This was a deliberate choice; provenance is recorded per file so a
   confirmed estimate remains distinguishable from camera GPS, and revert is always available.
8. **Unlimited extrapolation** can place a file implausibly far away. Also deliberate: every file
   must be on the map to be draggable, and the uncertainty circle conveys the doubt. The cap
   exists if it ever becomes a nuisance.

---

## 15. Build order

Timestamp correction is built and finished **before any map or interpolation code is written**.
It is the precondition for everything else — an interpolated position is only as good as the
timestamps behind it — and it stands on its own as a useful tool, so phases 0 and 1 together
form a complete, shippable application with no map in it at all.

| Phase | Scope |
| --- | --- |
| **0 — Foundation** | Project setup, config, folder picker, recursive scan, metadata extraction, capture-time resolution, strip grouping, thumbnail pipeline, SQLite store, Docker image |
| **1 — Time correction** | Alignment view: shared zoomable axis, lanes and strips, drag, snap, numeric entry, cut and merge, lock and reset, grouping modes, pin-true-time, UTC offset inheritance, startup question. The general file writer — verification, original preservation, staleness checks, revert, operation log — carrying only the time payload, since position editing does not exist yet. **Usable release: a standalone timestamp-correction tool.** |
| **2 — Map and interpolation** | Leaflet map, tile proxy and cache, thumbnail markers, clustering, path line, interpolation, uncertainty circles, tray |
| **3 — Editing** | Selection, detail panel, drag, confirm, revert, multi-select, filmstrip, status filters |
| **4 — Persisting positions** | Extends the phase 1 writer to GPS tags, so time and position commit together in one write per file: persist dialog and report, position provenance, per-file revert. *Feature-complete release.* |
| **5 — Offline and polish** | PMTiles support, area pre-download for permitted providers, settings page, performance tuning against a real 5,000-file folder |

---

## Appendix A — Decisions taken, with rejected alternatives

| Decision | Rejected alternative | Reason |
| --- | --- | --- |
| Browser app on the NAS | Electron / Tauri desktop app | Processing must happen where the files are; the map is a web view regardless |
| Node/TypeScript | Go | Shared types across the stack; `exiftool-vendored` already solves timestamp normalisation |
| Leaflet raster | MapLibre vector | Better draggable-marker, clustering and polyline ecosystem; trivial tile caching |
| Edit store, explicit persist | Immediate write on confirm | Far fewer metadata writes on slow storage; whole edit set reviewable first |
| `.geotagger/` inside the photo folder | Central app data directory | Survives being opened at a different mount path from NAS and Mac |
| Two border colours | Four-state colour scheme | Simpler; unwritten state carried by a corner badge instead |
| Read once, commit once | Re-reading or writing per change | One scan, one working model, one write per file carrying both time and GPS |
| Time correction shipped before any map code | Building both in parallel | Interpolation is worthless on wrong timestamps, and the correction tool stands alone |
| Per-strip lock | A single designated reference lane | Any strip may need protecting once it is correct, not just one |
| Drag-to-align strips on a shared axis | Selecting files and typing an offset | Aligning activity patterns is a visual task; one gesture replaces grouping, selection and numeric entry |
| Proportional time axis | Evenly spaced thumbnails | A drag must correspond to a definite number of seconds, or the metaphor breaks |
| One constant offset per strip | Stretch handles for linear drift | Modern camera clocks barely drift, and a handle beside the strip body was too easy to grab when a move was meant; deferred to §4.3 with its UI unresolved |
| Cut in place, auto-promote on overlap | Every cut opens a new lane | Keeps vertical space compact until overlap actually requires separation |
| Automatic detection stays advisory | One-click auto-align | The user knows which device is wrong; the app cannot |
| UTC offset inherited from GPS-bearing files | Derived from a file's own interpolated position | That would be circular for exactly the files that need it |
| One UTC offset ribbon on the axis, tinted by confidence | A colour per zone, applied to the strips | The zone belongs to the trip, not to a device; and hatching the unobserved gaps says the one thing a hue cannot — where the crossing is merely inferred |
| Reachability-bound uncertainty | Time-gap tiers, distance-based radius | Correctly reflects that one minute of walking covers little ground |
| Single plain path, all devices | Time gradient, per-device colours | Simplicity; the collection is one timeline |
| Unlimited extrapolation | Refusing beyond a threshold | Every file must be on the map to be draggable |
| Drag does not auto-confirm | Drag implies confirmation | One explicit gesture guards everything that reaches disk |
