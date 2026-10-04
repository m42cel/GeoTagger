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
| Backend | Node 26 + TypeScript, Fastify | Shared types with the frontend; best metadata tooling |
| Frontend | TypeScript + React | Shares the domain model with the backend |
| Map | Leaflet, raster tiles | Mature draggable-HTML-marker, polyline, circle and clustering ecosystem; trivial file-based tile caching |
| Metadata | ExifTool via `exiftool-vendored` | Keeps ExifTool alive in `-stay_open` mode; normalises timestamp and GPS representations |
| Images | ExifTool preview extraction first, `ffmpeg` to decode and resize | Preview extraction avoids full decodes on weak CPUs; ffmpeg's HEVC decoder covers HEIC (§14) |
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
- An offset that was only **assumed** — nothing inherited it, nothing overrode it, the user has
  not answered yet, so the file is placed on the timeline as if it were UTC — is **never
  written**, not even alongside a clock correction to the same file. Writing it would turn the
  guess into a fact: read back on the next scan it is indistinguishable from an offset the camera
  recorded, and it silently answers the question the app is still asking. Such a file keeps the
  ambiguous local time it already had, and its clock correction is written on its own.

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
- A live readout shows the exact offset while dragging (`+1h 02m 12s`), and every strip has an
  editable offset field in its lane header for exact entry.
- Keyboard nudging reaches precision the mouse cannot: `←`/`→` 1 second, `Shift` 1 minute,
  `Ctrl`/`Cmd` 1 hour.
- **Magnetic snapping** pulls a strip into alignment when its photos come close to lining up
  with photos in another lane, and additionally when the offset approaches a whole minute or a
  whole hour — timezone errors are exactly whole hours, so that snap is worth having. Holding
  `Alt` while dragging disables snapping entirely.

#### The correction itself

A strip carries **one correction**, applied to every file in it alike. Usually it is a plain
offset; a strip whose clock ran fast or slow also carries a **drift** (see *Pinning and
stretching* below):

```
shift(f)     = offset + drift · (t_f − drift_origin)
effective(f) = t_f + shift(f) + utc_offset_resolution
```

`t_f` is the file's raw wall-clock reading, so the line is laid along the camera's own clock;
`drift_origin` is a raw instant at which the drift term is zero. With `drift = 0` this is the
plain offset, which is what every strip has until it is stretched.

```
┌◀────────────────────▶┐   grab body → the whole strip shifts
│  ■  ■■  ■   ■■■  ■   │
└──────────────────────┘   offset +1h 02m 12s
```

One linear correction per strip is the entire model. A clock that was wrong by different amounts
at different times — reset, a battery swapped, a border crossed — is handled by cutting the strip,
not by deforming it: each segment is a strip in its own right with a correction of its own. Drift
is only for a clock that ran at the wrong *rate* throughout.

#### Locking and reset

A strip's correction is edited in its lane header, independent of selection: the offset field,
the drift (`0 s/day` until the strip is stretched), the strip's time zone override of §4.2 (`TZ`,
empty — `auto` — unless one is typed in), a reset (↺) beside each, and the lock with a pin count
beside it. A lane holding several
segments of a cut strip shows the selected segment's controls — the first segment's while none of
them is selected — with the segment numbers to switch between them.

**Lock** freezes a strip: no body drag, no stretch, no cut, no merge, no lane move, no keyboard
nudge, no pinning. Its purpose is the device whose clock is already correct — typically a phone —
which should never move by accident while you are dragging the strips around it. Lock is about
the whole strip; *pinning* (below) holds single photos and changes which gesture the strip
answers to.

A locked strip remains fully functional in every other respect: it is still selectable and
inspectable, and crucially it is **still a snap target**, so other strips continue to align
against it. Locking protects it from being changed; it does not remove it from the work.

The two halves of the correction **reset** separately, each from beside its own value. Neither
undoes cuts — segments are structure, not correction, and merging them is a separate action —
both are refused on a locked strip, and like every other change both are undoable.

- **Reset offset** zeroes the offset and keeps the stretch. It is refused while a photo is
  pinned: it would move a photo the user has said is right.
- **Reset stretch** zeroes the drift and keeps the offset: with one pinned photo, that photo
  stays exactly where it is and the strip straightens about it; with none, the strip keeps the
  shift it had where it was stretched about; with two pins it is refused, since one of them
  would move.

A **reset all** control in the view toolbar rebuilds every strip from the current grouping mode,
discarding cuts, offsets, drift, pins and locks together, with a confirmation.

#### Cutting — more than one offset

A strip can be **cut** at any point on the axis, producing two independently draggable segments.
This handles a camera whose clock changed partway through the trip — a timezone border crossed,
a battery removed, a manual correction made mid-holiday.

- The cut point splits membership by effective time; both segments inherit the parent's whole
  correction — offset, drift and its origin — so nothing jumps at the moment of cutting. Pinned
  photos go with the segment they fall in.
- Segments stay in the same lane. If dragging makes two segments overlap in time, the moved
  segment is **automatically promoted to its own lane** — because strips in one lane must stay
  ordered. A segment can also be dragged vertically into another lane deliberately.
- Empty lanes collapse automatically.
- The cut is made at the mark — the hairline left where the canvas was last clicked — with a
  **cut** button that floats beside the mark in the selected strip's lane whenever the mark
  falls inside that strip, or with `c`.
- Two adjacent segments of the same origin can be **merged** again; the result takes the left
  segment's correction. The selected segment shows a faint arrow just outside each end that has a
  neighbour to merge with, pointing at it; it firms up under the pointer, and a click merges in
  that direction. A merge that would move a pinned photo of the right segment — because
  the two corrections have since diverged — is refused.

```
before cut   SONY │■■■■■■■■■■■■│
                         ✂
after cut    SONY │■■■■■│ │■■■■■■■│

drag the right segment left, past the first:
             SONY │■■■■■│
             SONY │   ■■■■■■■│        ← promoted to a new lane
```

#### Setting a known time

Right-clicking a photo, or the edit button beside its corrected time in the photo card, offers
**set true time**: enter the real time of that one photo (from a clock in the shot, a departure
board, a receipt) and its whole strip shifts so that photo lands there. The photo card always
shows the corrected time, even where it equals what the file reads, since it is the field typed
over. This is the precision path when no other device was present to align against, and it
applies in both directions — an anchor found in the middle of a bad batch corrects the files
before it as well as after it. On a strip with one pinned photo it stretches instead, exactly
like the align buttons of §6.2. Setting the true time does not pin the photo.

#### Pinning and stretching — gradual clock drift

A clock that runs at the wrong rate is a line, not a constant: it can be right at one sunset and
a minute out at the next. Correcting it needs **two reference points** — two photos whose correct
times are known — each held exactly in place, with everything between them scaled and everything
outside them extrapolated along the same line. Stretching from a strip's end without a reference
does not work: it holds the *other end* fixed, while the point the user actually aligned is
usually somewhere in the middle and slides away the moment the strip is stretched.

So the reference points are explicit. Any photo can be **pinned** — "this photo's time is right
now" — and the number of pinned photos in a strip decides which gesture the strip answers to:

| Pinned photos | Body drag, nudge, offset field | Stretch handles | Align / set true time |
| --- | --- | --- | --- |
| none | shift the whole strip | hidden | shift |
| one | refused | shown, pivot on the pin | **stretch** about the pin |
| two or more | refused | hidden | refused |

- **One pin** holds that photo still and turns the strip into a lever. Handles appear at both
  ends of the strip while it is selected — a handle sitting on the pinned photo itself is not
  shown — and dragging one ramps the correction linearly about the pin. Because the body no longer moves, a handle cannot
  be mistaken for a move: there is no move to mistake it for. Without a pin there are no handles
  at all, so a stretch is only ever reached on purpose.
- The align buttons (§6.2) and set true time, applied to a photo of a one-pin strip, **stretch**
  the strip about its pin so that photo lands where it should, rather than shifting it. The button
  says so — `stretch` instead of `align` — so nobody is surprised by the difference. Neither pins
  the photo it just placed: pinning is always the user's own click, so a second pin is a
  deliberate "this one is right too", never a side effect.
- **Two pins** determine the line completely. The strip can no longer be moved or stretched;
  unpinning one of the two is how it is changed again.
- Pinning and unpinning never move anything. The correction is stored on the strip in its own
  right (§8.2); pins only decide which gestures change it.
- A pin only holds against clock corrections. A UTC offset typed in for the strip (§4.2) still
  applies, since a timezone is a different question from a clock.
- While stretching, the readout shows the drift as a rate (`+14 s/day`) beside the pinned file's
  unchanged offset. Snapping pulls towards the photos of other lanes as it does for a move; the
  whole-minute and whole-hour snaps do not apply, since drift is never a whole unit. `Alt`
  disables it.
- A drift beyond ±5 % (≈ ±72 min/day) is refused: no clock is that wrong, and a stretch that far
  is a handle grabbed a pixel from its pin.

```
one pin (▼) — handles at the ends, body fixed:
          ◀▶                 ▼                     ◀▶
          │■  ■■  ■   ■■■  ■ ■ ■■   ■  ■■■  ■   ■│      drift +14 s/day

stretched onto a second reference and that photo pinned too — the strip is now fixed:
          │■  ■■  ■   ■■■  ■ ▼ ■■   ■  ■■▼  ■   ■│
```

### 4.4 How strips are built

The user chooses how the initial strips are formed, asked once per folder at startup (§6.1 step
4) rather than picked silently — the choice is shown alongside what the scan actually found, so it
is not made blind:

| Mode | Basis |
| --- | --- |
| **By subfolder** (default) | Directory structure — useful when files were already sorted by camera or by person |
| **By device** | `Make` / `Model` / `SerialNumber` from EXIF |
| **Manual** | Select files and make a strip from them — not offered at startup, only from the alignment view |

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
  being placed somewhere misleading. Dragging one onto the map sets its own position; confirming
  it is what makes it an anchor and interpolates everything else from it (§5.5).
- **Identical timestamps** — files sharing an effective timestamp get the same position and are
  spread visually by clustering, not by fabricated coordinate jitter.

### 5.5 Recomputation

Estimates are recomputed whenever an anchor is added, moved, removed, or when any timestamp
changes. At 5,000 files this is a millisecond-scale operation, so it runs synchronously on every
change and the map always shows current values.

Only camera GPS and a **confirmed** position count as an anchor. Dragging places a file and
previews its own position, but does not itself move any other file's estimate — a placement in
progress must not disturb a track the user has not yet approved. Confirming is what promotes a
file to an anchor and triggers recomputation of neighbouring unconfirmed estimates.

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

**Re-dragging an already-anchored file.** A drag never touches the anchor underneath it (§5.5) —
so dragging a file that already has camera GPS or a confirmed position leaves that old position in
place, still anchoring everyone else, while the drag itself is held separately as a pending,
unconfirmed placement. The map shows the old position as a faint **ghost**, connected to the file's
new, live position by a thin line, so it is obvious which marker a ghost belongs to. The ghost
disappears once the drag is confirmed (the new position becomes the anchor) or reverted (the drag
is discarded and the old anchor is what the file shows again).

Consequences:

- Confirmed positions survive restarts and rescans without recomputation.
- Recomputation after any change touches only unconfirmed estimates.
- A dragged, unconfirmed position does not anchor other files either — only camera GPS and a
  confirmed position do (§5.5) — regardless of whether that same file also has an older anchor of
  its own still active underneath the drag.
- Two different depths of undo exist once a drag is in progress: discarding just the drag falls
  back to the anchor underneath it, if there is one; discarding the anchor too falls back further,
  to a derived estimate or no position at all if the camera never recorded one either. See §6.5.

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

4. **Grouping question** — asked once per folder, before any strip exists, showing what the scan
   actually found so the choice isn't blind:

   ```
   How should these files be grouped into strips?

   4 subfolders found                 3 devices found
   Day 1 · 340 files                  iPhone 15 Pro · 812 files
   Day 2 · 512 files                  SONY ILCE-7M4 · 896 files
   Drone · 220 files                  DJI Mini 4 · 220 files
   Day 3 · 856 files                  [ Group by device ]
   [ Group by subfolder ]
   ```

   Manual grouping is not offered here — it is built by hand afterwards, in the alignment view.
   The answer is recorded, so reopening the folder later does not ask again; the mode can still be
   changed at any time from the alignment view's grouping control (§4.4), which rebuilds the strips
   from scratch and warns before doing so.

5. **Timestamp question** — always asked, without pre-analysis:

   ```
   Do you need to adjust timestamps for this folder?
   [ Fix timestamps first ]        [ Go to map ]
   ```

   The alignment view is reachable at any time afterwards.

### 6.2 Alignment view (time correction)

No map. A shared, zoomable time axis with one lane per strip.

```
 grouping: [ by subfolder ▾ ]   zoom: [ trip · day · hour · minute ]   [ reset all ]

 iPhone 15 Pro · 412    [■]  │  ■■ ■▅   ■▅█▃      ■■■▆        │  ← [■] closed padlock: locked
 Offset [ 0 s         ] ↺    │                                │
 Drift  [ 0 s/day     ] ↺    │                                │
 TZ     [ auto        ] ↺    │                                │
 SONY ILCE-7… · 896 1 pin [□]│      ■■ ■▅  │✂ cut   ■■■▆      │  ← [□] open padlock
 [ 1 ][ 2 ]                  │    ◀ ■▅█▃   │                  │  ← segment 2 selected:
 Offset [ +1h 02m 12s ] ↺    │             │                  │    merge arrow, cut at the mark
 Drift  [ +14 s/day   ] ↺    │                                │
 TZ     [ +02:00      ] ↺    │                                │
                             ├────────────────────────────────┤
                             │+02:00 Berlin░░░░░+09:00 Tokyo  │  ← UTC offset periods
                             └────────────────────────────────┘
                              09:00    12:00    15:00   18:00

 ┌──────────────────────────────────────────────────────────────────────┐
 │ DSC04471.JPG  pinned                                                 │
 │ ┌──────────────┐  reads      2024-07-12 14:32:10  EXIF               │
 │ │   preview    │  corrected  2024-07-12 15:34:22 [✎] +02:00 · inh.   │
 │ │              │                                                     │
 │ └──────────────┘                                                     │
 └──────────────────────────────────────────────────────────────────────┘
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

Strip controls live on the lanes (§4.3), so a control always says by where it sits whether it acts
on a strip or on one photo. Under the lanes, the selected photo gets a card of its own, leading
with a large preview of it.

The strip's UTC offset override of §4.2 is the `TZ` field in its lane header. It is empty unless
typed into: each photo then takes the offset inferred for when it was taken, and the photo card
shows which one it got and where from.

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

**Comparing two photos.** Clicking a photo holds it in one of two preview panes beside the
lanes, stacked one above the other; clicking a photo in the other strip fills the second pane,
so the two reference photos an alignment is being judged against sit still side by side instead
of one click apart. Which strip is "upper" and which is "lower" follows the lanes, not click
order.

Between the panes, two buttons align the strips without the zoom-in, zoom-out, zoom-out-further
dance that finding a distant reference pair by hand otherwise costs: **align top to bottom**
shifts the upper strip so its pane's photo lands on the lower pane's photo's time, and **align
bottom to top** does the reverse. Each is disabled unless both panes hold a photo with a known
time, and again if the strip it would move is locked — the other pane's strip being locked does
not stop it. The view recentres on the now-shared instant, keeping the current zoom.

The pins of §4.3 change what a button does to the strip it would move. With one pinned photo in
that strip the button reads **stretch top to bottom** (or bottom to top) and stretches the strip
about its pin instead of shifting it; it is disabled when the pane's photo *is* the pin, or when
the strip already has two. A photo is pinned with a pin button at the bottom left of its
thumbnail, shown on the selected photo only — like the cut button, only where it acts — or with
`p`, and pinned photos carry a `pinned` badge on their thumbnails in the lanes.

A refused change — a merge that would move a pin, a stretch beyond the drift limit — is reported
in a message floating over the view rather than a banner that pushes the lanes down. It can be
dismissed, goes by itself after a few seconds, and is cleared by the next action.

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
│                                        ││              │
└────────────────────────────────────────┘└──────────────┘
```

**Thumbnails on the map** are fixed-size (long side 48 px default, 32–96 px configurable) and do
not scale with zoom, keeping drag targets predictable. Each takes its image's displayed aspect
ratio, clamped to 4:3 … 3:4: square, 4:3 and 3:4 images show whole, anything wider or taller
shows its centred 4:3 or 3:4 section. An image with unknown dimensions shows square. A cluster's
representative thumbnail follows the same rule. Selecting one shows a large preview in the
side panel.

**Border colours:**

| Border | Meaning |
| --- | --- |
| **Green** | Position known — camera GPS, or confirmed by the user |
| **Red** | Interpolated or extrapolated, not yet confirmed |

**Selection highlight:** the selected thumbnail gets a ring distinct from the border colour, so it
reads at a glance regardless of whether the border underneath is green or red. Multi-selected
thumbnails (§6.5) get a second, differently-coloured ring of their own — a thumbnail can carry
both at once. A cluster showing a stack's representative thumbnail carries whichever ring(s) apply
to any file inside it, so collapsing a stack never makes a selected file look deselected.

**Multi-select in the side panel:** while the multi-selection is non-empty, the side panel shows a
grid of small thumbnails in place of the single-file view (large preview, metadata, confirm/revert/
reset) — those controls don't apply to several files at once, and the confirm/clear actions for the
selection live in the map's own toolbar, not here. Clicking a thumbnail in the grid exits
multi-select and shows that one file normally, exactly as clicking it on the map would.

**Ghost:** re-dragging a file that already has camera GPS or a confirmed position leaves a faint
marker at the old position — still the active anchor for everyone else (§5.5, §5.6) — connected by
a thin line to the file's new, live position, so it is clear which marker the ghost belongs to.

**Corner badge:** marks a file with changes held in the edit store but not yet written to disk.

Camera-original versus app-set provenance is shown in the detail panel only, not on the
thumbnail.

**Path line:** a single plain polyline connecting every file that is currently an anchor or an
estimate between anchors — camera GPS, confirmed positions, and the interpolation between them —
in effective-time order across all devices, one collective timeline, no per-device separation, no
colour gradient, never broken by time gaps. A file with a pending drag and no anchor underneath
sits off to the side instead of bending the line toward it, the same way it does not anchor its
neighbours (§5.5). A file being *re*-dragged still has its old anchor doing that work (§5.6's
ghost), so the line runs through the ghost's position rather than skipping the file or bending
toward where it is being dragged to. Optional direction arrowheads, off by default.

**Clustering:** Leaflet.markercluster; nearby thumbnails collapse into a badge showing the count
over a representative thumbnail and expand on zoom.

**Uncertainty circles:** drawn faintly on all unconfirmed items; global toggle.

**Filters:** by status — unconfirmed, app-modified, unpersisted. Purely a marker-visibility
toggle: the path line is unaffected and always runs through the full track regardless of what is
currently hidden, and a filtered-out marker is simply hidden, not replaced with a ghost. (Time-range,
device and confidence filters are explicitly not in scope.)

Unconfirmed and app-modified ship in phase 3, since both read straight off the computed position
(`source`). Unpersisted has to wait for phase 4: nothing writes GPS to a file yet, so every
confirmed position is unpersisted right now — the filter would just restate "has a confirmed or
manual position," not a real third status. It becomes meaningful once phase 4 gives it an actual
on-disk-vs-edit-store distinction to filter on.

### 6.4 Tray

A panel beside the map holding files with no derivable position — only ever populated when the
folder contains no anchors at all. Dragging one onto the map sets its position; confirming it is
what makes it an anchor and places everything else (§5.5).

### 6.5 Interactions

| Action | Result |
| --- | --- |
| Click thumbnail | Select; detail panel shows large preview, metadata, provenance, uncertainty |
| Drag thumbnail | Sets its own position; **stays unconfirmed (red)** and does not anchor other files' estimates. Re-dragging an already-anchored file leaves a ghost at the old position (§5.6) |
| Checkmark on selected thumbnail | Confirms → green, anchor, neighbours recompute, eligible for persist |
| Multi-select (shift-click / rubber band) | Confirm the selection together |
| Revert on selected thumbnail | Cancels a drag in progress, falling back to the anchor underneath it (camera GPS or confirmed), if any. Only available when there is one — a plain interpolated estimate that has never been dragged or confirmed has nothing to revert to |
| Reset on selected thumbnail | Discards the position entirely — the pending drag and any confirmed anchor alike — back to a derived estimate or no position at all |
| Persist changes | Writes all confirmed changes to files (§9) |

Dragging deliberately does **not** auto-confirm: confirmation stays a single, explicit gesture
both for anchoring other files' estimates (§5.5) and for everything that reaches the disk.

Revert and reset are two different depths of undo (§5.6, §9.4), not the same action under
different names: a file dragged away from a confirmed position can be reverted back to that
confirmed position (the drag is cancelled, the confirmation still stands), or reset past it
entirely (the confirmation itself is discarded, falling back to camera GPS if the file has it, or
to a derived estimate otherwise). A third, deeper undo — back to what the file said before
GeoTagger ever touched it — is deferred; see §9.4.

---

## 7. Map tiles

### 7.1 Providers

Served through a backend proxy so provider keys never reach the browser and every tile is cached
server-side, shared across all devices and folders.

| Provider | Key | Role |
| --- | --- | --- |
| OpenStreetMap standard | none | Default |
| Esri World Imagery | none | Satellite layer — markedly easier for placing a photo on the correct side of a building or trail |
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
      -- id: UUIDv7 TEXT, unique across every folder GeoTagger opens, not just this one

devices(id, make, model, serial, label, group_id)
device_groups(id, label)

strips(id, lane, ordinal, label, grouping_source, parent_strip_id,
       offset_seconds, drift, drift_origin_ms, locked, created_at)
       -- shift(f) = offset_seconds + drift · (raw_f − drift_origin_ms) / 1000  (§4.3)
       -- drift: seconds gained per second of raw time, 0 unless stretched
       -- drift_origin_ms: a raw instant, NULL while drift is 0
strip_files(strip_id, file_id, pinned) -- every file belongs to exactly one strip

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

The same holds for time: a file's clock correction is never stored per file. The strip stores
its correction as a function, and each file's shift is evaluated from it wherever a time is
needed — the alignment view, interpolation, the write plan — so a stretch reaches all of them at
once. A pin is an explicit flag on the file's strip membership rather than anything inferred
from the correction, so pinning or unpinning never moves a photo, and a cut carries each pin
into the segment its photo falls in.

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

**What gets written is a per-tag difference.** For every tag GeoTagger writes (§9.2), the plan
compares what the file says with what it should say, and a tag that differs is written. "What the
file says" is the value GeoTagger last wrote to that tag, or — for a tag it has never written —
what the scan read. So a second Persist with nothing changed in between writes nothing at all,
and a Persist after one further nudge writes only the tags that moved. The tag is the unit
because the preserved original of §9.3 belongs to a tag rather than to a group of them.

The dialog is one scrollable, per-file review list — there is no separate summary-counts screen
and no separate post-write report; the same list becomes the report once writing starts.

```
Persist changes                                   [ ] thumbnails   [ ] raw EXIF values
┌──────────────────────────────────────────────────────────────────────────────────┐
│                position    47.0000, 11.0000          →   47.1234, 11.3456        │
│  IMG_4471.JPG  timestamp   2024-07-12 14:59:50       →   2024-07-12 15:14:20 +02:00│
│                UTC offset  (assumed) +00:00          →   +02:00                  │
│  VID_0201.MP4  position    —                         →   47.1300, 11.3400  ✗ failed│
│  IMG_4488.JPG  UTC offset  (assumed) +00:00          →   +02:00                ✓ │
│  ...                                                                              │
└──────────────────────────────────────────────────────────────────────────────────┘
257 changes across 194 files                             [ Cancel ]  [ Write ]
```

- Rows are **grouped by file**, with one sub-row per changed field — position, timestamp, UTC
  offset, the same three categories the dialog used to just count. A file lists only the fields
  it actually changes. The filename (and thumbnail, when that toggle is on) sits in its own
  column on the left, spanning the height of that file's sub-rows — it is not a header row
  printed above them.
- Each sub-row shows the old value on the left and the new value on the right, side by side.
  A field with no prior value (a file that never had GPS, for instance) shows `—` on the old
  side.
- **Thumbnails toggle**, off by default: adds each file's thumbnail beside its filename, using
  the thumbnail pipeline (§10.1) that already ran at scan time — opening the dialog triggers no
  extra work.
- **Raw EXIF values toggle**, off by default: switches the list from one row per changed *field*
  in the app's own units (`47.1234, 11.3456`, `2024-07-12 15:14:20 +02:00`) to **one row per
  changed tag** — the plan as it really is: `EXIF:GPSLatitude` and `GPSLatitudeRef` separately,
  `DateTimeOriginal` in EXIF's own `YYYY:MM:DD HH:MM:SS` form, and the `geotagger:Original*` this
  write preserves (§9.3) appended, each showing the value it will hold.
- The three fields — position, timestamp, UTC offset — are a **display grouping over the tags**,
  not a unit of writing: a file changing all three is still written **once**, every tag in a
  single ExifTool command.
- Once **Write** is pressed the list stops being editable and each file's row fills in a status
  (✓ written and verified, or ✗ failed with a reason) as ExifTool finishes it, turning the same
  rows just reviewed into the report — progress is this filling-in, not a separate bar.
- Each file is re-read after writing and compared against the intended values; that comparison
  is what a row's ✓ or ✗ reflects.
- A failure does not abort the run; the file keeps its pending state and can be retried.
- Failures are recorded in the operation log in addition to showing in the row.

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
config file (`geotagger`, `http://ns.geotagger.local/1.0/`). There is **one `Original*` per tag
GeoTagger writes** (§9.2), so each tag's own prior value is recorded rather than one being derived
from another's:

```
geotagger:OriginalDateTimeOriginal
geotagger:OriginalCreateDate            EXIF:CreateDate, or QuickTime:CreateDate for a video
geotagger:OriginalOffsetTimeOriginal
geotagger:OriginalOffsetTimeDigitized
geotagger:OriginalGPSLatitude
geotagger:OriginalGPSLatitudeRef
geotagger:OriginalGPSLongitude
geotagger:OriginalGPSLongitudeRef
geotagger:OriginalGPSCoordinates        video
geotagger:OriginalXMPGPSLatitude
geotagger:OriginalXMPGPSLongitude
geotagger:PositionSource                manual | interpolated-confirmed
geotagger:PositionUncertaintyMeters
geotagger:TimeShiftSeconds
geotagger:ModifiedAt
geotagger:AppVersion
```

A tag the file **did not have** is preserved as the literal `n/a`, never left out: an absent
`Original*` would be indistinguishable from GeoTagger never having written that tag, whereas `n/a`
says plainly that there was nothing there. The values are read from the file itself immediately
before its first write, so they are the characters the file actually held.

**Each `Original*` is written exactly once and never touched again.** It is stamped by the first
write of *its own tag* — not of some group the tag belongs to — so a write only ever claims to have
overwritten what it actually overwrote. Adding the UTC offset of §4.2 on its own preserves the two
offset tags and nothing else; correcting the clock later preserves the two date tags then, with the
values still in the file because nothing had touched them. Every later write of a tag leaves its
`Original*` alone, so what the block holds always predates GeoTagger however many times a file is
re-persisted.

The rest of the block is **provenance**, not preservation: `TimeShiftSeconds` describes the current
correction, `PositionSource` and `PositionUncertaintyMeters` the current placement, and they are
rewritten whenever the field they describe is written. `ModifiedAt` and `AppVersion` are refreshed
by any write at all. None of them has an `Original*` — they are GeoTagger's own output, and there
was nothing there before.

The same snapshot is stored in the edit store, so the record survives whether the app database or
the file is the surviving copy. Nothing in the app reads it back yet — it is written for the
deferred revert of §9.4, and for anyone inspecting the file with `exiftool`.

### 9.4 Revert

Two depths of undo exist, shallowest to deepest (§6.5, §4.3):

1. **Revert** — cancels a drag in progress, falling back to the anchor underneath it. Edit-store
   only; never touches a file.
2. **Reset** (a file's position) / a strip's own **Reset** (time) — discards the edit entirely:
   a position falls back to whatever the app would derive next — camera GPS, or an interpolated
   estimate; an offset falls back to zero. This is not guaranteed to match the file's original
   value, only incidentally so when nothing else ever overrode it.

Neither writes to disk immediately — nothing does outside Persist (§9.1). Both are edit-store
operations, so the next Persist simply writes whatever the edit now says, exactly as it would for
any other edit.

**Reset to original — deferred.** A third, deepest undo belongs here: taking an already-written
file back to what it said before GeoTagger touched it, guaranteed rather than incidentally, defined
against the stored `Original*` snapshot rather than against whatever the app would derive next.
It was implemented once, driven by a flag per strip (time) and per file (position) that the persist
plan turned into a tag-by-tag restore. That implementation was **removed**: the flag's lifetime
against a per-file persist history had too many states that were wrong in ways only visible after
the fact (a spent flag re-applying itself, a restore immediately undone by the UTC offset of §4.2,
an explicit offset override swallowed while a reset stood). A different design will be specified
before it is built again.

What remains, and what a future implementation is meant to build on, is the record itself: the
`Original*` block of §9.3 and the same snapshot in the edit store. Each tag's original is written
by that tag's first persist and never touched again, so the information a revert needs keeps
accumulating while the feature is absent.

### 9.5 RAW (deferred)

Not implemented. When added: RAW files get `.xmp` sidecars rather than in-place writes — the
convention Lightroom and Capture One already follow — avoiding rewrites of proprietary
containers that ExifTool can only partially support. Everything else stays in place.

---

## 10. Backend

### 10.1 Scanning pipeline

1. Walk the folder recursively, filtering by extension.
2. Diff against the stored index by path, size and mtime, for the added/changed/missing
   summary. Two scan depths: a **quick** scan (opening a folder) trusts that diff and
   only reads a changed file's metadata; a **deep** scan (the explicit rescan) reads
   every file's metadata regardless, since size and mtime cannot prove a file's tags are
   unchanged — and GeoTagger's own writes pin mtime on purpose (§9.2), so its writes are
   exactly the kind of change that diff alone would miss.
3. Batch-read metadata through the persistent ExifTool process.
4. Resolve capture time (§4.1), device identity, dimensions, duration, original GPS. A
   file GeoTagger has already persisted to keeps these as first established — a deep
   scan's read would otherwise see GeoTagger's own corrected values and mistake them for
   the camera's (§9.3).
5. Generate thumbnails in the background, lowest-cost path first:
   - extract an embedded preview (`-b -PreviewImage` / `-ThumbnailImage`) when present;
   - otherwise decode and downscale the whole file with ffmpeg;
   - a still that fails that is decoded by ffmpeg from the file itself and downscaled again
     (HEIC — see §14);
   - video: ffmpeg frame grab at ~10% of duration, clamped to 1–5 s.
6. Two cached tiers: `thumb` 160 px (eager) and `preview` 1280 px (on demand).

Concurrency is bounded and configurable; default 2 workers, appropriate for a low-power ARM CPU.

### 10.2 API (outline)

`:id` is a file UUID on every `/api/files/...` and `/api/edits/...` route; on every
`/api/strips/...` route it is a strip's integer id.

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
POST   /api/edits/bulk                 multi-select confirm
GET    /api/devices                    device groups
POST   /api/devices/regroup            split / merge
GET    /api/strips                     lanes, strips, offsets
POST   /api/strips/regroup             rebuild from device / subfolder / manual
POST   /api/strips/:id/offset          set the strip's offset
POST   /api/strips/:id/cut             split at a timestamp
POST   /api/strips/merge               merge two adjacent segments
POST   /api/strips/:id/lane            move to another lane
POST   /api/strips/:id/lock            lock / unlock
POST   /api/strips/:id/reset           zero the offset, the drift, or both
POST   /api/strips/:id/stretch         stretch about the pin so a file lands on an instant
POST   /api/strips/pin                 pin / unpin a file
POST   /api/strips/set-true-time       shift (or stretch) so a file lands on a true time
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

- tile provider, satellite layer toggle
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
    image: ghcr.io/m42cel/geotagger:latest
    ports: ["8080:8080"]
    environment:
      PHOTO_ROOT: /photos
    volumes:
      - /volume1/photos:/photos
      - ./cache:/cache
    restart: unless-stopped
```

Image: `node:26-trixie-slim` plus perl (for the ExifTool that `exiftool-vendored` ships) and
`ffmpeg`, whose trixie build decodes HEVC and so covers HEIC. Built for `linux/arm64` and
`linux/amd64`, and published to GHCR: `dev` from `main`, and `x.y.z`, `x.y`, `x` and `latest`
from each `vx.y.z` tag.

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
  correction, nothing jumps), merging back, degenerate strips with one file or identical timestamps,
  UTC offset inheritance.
- **Lane management** — overlap detection after a drag, automatic promotion to a new lane,
  collapse of emptied lanes.
- **Locking** — a locked strip rejects drag, cut, merge, lane move, nudge and reset, while
  remaining a valid snap target for others.
- **Pinning and stretching** — a stretch leaves the pinned file exactly in place and lands the
  stretched file exactly on its target; files between scale and files beyond extrapolate; a
  one-pin strip refuses shifts, a two-pin strip refuses stretches too; pinning never moves a file;
  cut and merge carry the correction and the pins without anything jumping; the per-file shift
  reaches the write plan.
- **Snapping** — snaps to neighbouring photo times and to whole minutes and hours; the modifier
  disables it.
- **Interpolation** — great-circle positions, the reachability bound including the documented
  worked example, extrapolation, one-anchor and zero-anchor cases, antimeridian crossing.
- **Metadata round-trip** — write then re-read against sample JPEG, HEIC, PNG, MP4 and MOV
  fixtures; the `Original*` block records what each tag held before the first write, `n/a` where
  the file had nothing, and is unchanged by every later write.
- **Materialisation** — a confirmed position does not move when a neighbouring anchor is later
  changed; an unconfirmed one does; reset returns a confirmed file to derived or to no position;
  confirmed values and their uncertainty survive a restart and a rescan.
- **Staleness** — a file modified between edit and persist is detected and not clobbered.

---

## 14. Risks and open questions

1. ~~**HEIC decoding in the container**~~ — **resolved in phase 0.** Confirmed: the libvips
   bundled with `sharp` carries a libheif with no HEVC decoding plugin, and it will not load
   the system one (the ABI does not match), so it cannot decode HEIC in the container at all.
   The designed mitigation holds — embedded preview extraction first, ffmpeg as fallback — but
   it needs **ffmpeg 7.1**, which decodes HEIF stills; bookworm's 5.1 does not. The image base
   is therefore `node:26-trixie-slim` rather than bookworm.
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
| **1 — Time correction** | Alignment view: shared zoomable axis, lanes and strips, drag, snap, numeric entry, cut and merge, lock and reset, grouping modes, set true time, pinning and stretching, UTC offset inheritance, startup question. The general file writer — verification, original preservation, staleness checks, revert, operation log — carrying only the time payload, since position editing does not exist yet. **Usable release: a standalone timestamp-correction tool.** |
| **2 — Map and interpolation** | Leaflet map, tile proxy and cache, thumbnail markers, clustering, path line, interpolation, uncertainty circles, tray. Also shipped early: selection and a read-only detail panel (large preview, corrected timestamp, lat/lon, altitude when the file has one, position status) — pulled forward from phase 3 since it needs nothing phase 3 adds. |
| **3 — Editing** | Drag (including from the tray, §6.4), confirm, revert, reset, multi-select confirm, status filters (unconfirmed, app-modified — unpersisted waits for phase 4, see §6.3). Extends phase 2's detail panel with the confirm/revert/reset controls. |
| **4 — Persisting positions** | Extends the phase 1 writer to GPS tags, so time and position commit together in one write per file: persist dialog and report, position provenance, per-file revert, the map view's "unpersisted" filter (§6.3). *Feature-complete release.* |
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
| Linear drift only about a pinned photo | Free stretch handles at the strip's ends | An end handle holds the wrong point fixed — the aligned photo is usually mid-strip — and sat beside the body where a move was meant; with a pin, the body cannot move, so the handles cannot be mistaken for it |
| Correction stored per strip, pins as flags | A shift stored per file, or a line derived from the pins | A per-file shift loses that the correction is one line; deriving it from pins would make unpinning move photos |
| Cut in place, auto-promote on overlap | Every cut opens a new lane | Keeps vertical space compact until overlap actually requires separation |
| Automatic detection stays advisory | One-click auto-align | The user knows which device is wrong; the app cannot |
| UTC offset inherited from GPS-bearing files | Derived from a file's own interpolated position | That would be circular for exactly the files that need it |
| One UTC offset ribbon on the axis, tinted by confidence | A colour per zone, applied to the strips | The zone belongs to the trip, not to a device; and hatching the unobserved gaps says the one thing a hue cannot — where the crossing is merely inferred |
| Reachability-bound uncertainty | Time-gap tiers, distance-based radius | Correctly reflects that one minute of walking covers little ground |
| Single plain path, all devices | Time gradient, per-device colours | Simplicity; the collection is one timeline |
| Unlimited extrapolation | Refusing beyond a threshold | Every file must be on the map to be draggable |
| Drag does not auto-confirm | Drag implies confirmation | One explicit gesture guards everything that reaches disk, and is also what lets a placement anchor other files' estimates |
| Multi-select is confirm-only, no group drag | Drag the whole selection as a rigid group | Confirming the two ends of a bad cluster and letting recomputation (§5.5) reshape the estimates between them fits the true time-proportional path; a rigid translation would only carry the cluster's existing, possibly wrong shape to a new offset |
