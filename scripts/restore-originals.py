#!/usr/bin/env python3
"""TEMPORARY test helper — restores files GeoTagger has written to their pre-GeoTagger state,
from the XMP-geotagger:Original* block (SPEC §9.3), then strips that block.

    python3 scripts/restore-originals.py <folder> [--dry-run]

Needs `exiftool` on PATH. Does not touch <folder>/.geotagger — delete that yourself for a
clean slate, otherwise the app still remembers its edits and will propose them again.
"""

import json
import os
import subprocess
import sys
import tempfile

args = sys.argv[1:]
dry_run = "--dry-run" in args
folders = [a for a in args if not a.startswith("--")]
if not folders:
    print("usage: python3 scripts/restore-originals.py <folder> [--dry-run]", file=sys.stderr)
    sys.exit(1)
folder = folders[0]

# Same namespace declaration the app generates (packages/server/src/write/exiftool-config.ts).
TAGS = [
    "OriginalDateTimeOriginal", "OriginalCreateDate", "OriginalOffsetTimeOriginal",
    "OriginalOffsetTimeDigitized", "OriginalGPSLatitude", "OriginalGPSLatitudeRef",
    "OriginalGPSLongitude", "OriginalGPSLongitudeRef", "OriginalGPSCoordinates",
    "OriginalXMPGPSLatitude", "OriginalXMPGPSLongitude", "PositionSource",
    "PositionUncertaintyMeters", "TimeShiftSeconds", "ModifiedAt", "AppVersion",
]
tag_lines = "\n".join(f"    {t} => {{ }}," for t in TAGS)
CONFIG = f"""%Image::ExifTool::UserDefined::geotagger = (
    GROUPS    => {{ 0 => 'XMP', 1 => 'XMP-geotagger', 2 => 'Image' }},
    NAMESPACE => {{ 'geotagger' => 'http://ns.geotagger.local/1.0/' }},
    WRITABLE  => 'string',
{tag_lines}
);
%Image::ExifTool::UserDefined = (
    'Image::ExifTool::XMP::Main' => {{
        geotagger => {{ SubDirectory => {{ TagTable => 'Image::ExifTool::UserDefined::geotagger' }} }},
    }},
);
1;
"""

# Original* → the tag it preserves, per media kind (packages/server/src/write/tags.ts preservedTagsFor).
IMAGE = {
    "OriginalDateTimeOriginal": "EXIF:DateTimeOriginal",
    "OriginalCreateDate": "EXIF:CreateDate",
    "OriginalOffsetTimeOriginal": "EXIF:OffsetTimeOriginal",
    "OriginalOffsetTimeDigitized": "EXIF:OffsetTimeDigitized",
    "OriginalGPSLatitude": "EXIF:GPSLatitude",
    "OriginalGPSLatitudeRef": "EXIF:GPSLatitudeRef",
    "OriginalGPSLongitude": "EXIF:GPSLongitude",
    "OriginalGPSLongitudeRef": "EXIF:GPSLongitudeRef",
    "OriginalXMPGPSLatitude": "XMP:GPSLatitude",
    "OriginalXMPGPSLongitude": "XMP:GPSLongitude",
}
VIDEO = {
    "OriginalCreateDate": "QuickTime:CreateDate",
    "OriginalGPSCoordinates": "QuickTime:GPSCoordinates",
    "OriginalXMPGPSLatitude": "XMP:GPSLatitude",
    "OriginalXMPGPSLongitude": "XMP:GPSLongitude",
}
PREFIX = "XMP-geotagger:"


def main(config_path: str) -> None:
    def exiftool(argv: list[str]) -> str:
        return subprocess.run(
            ["exiftool", "-config", config_path, *argv],
            check=True, capture_output=True, text=True,
        ).stdout

    # Originals were read with -n when stamped, so read and write them unconverted too.
    out = exiftool(["-q", "-r", "-j", "-n", "-G1", "-charset", "filename=utf8", "-i", ".geotagger",
                    "-MIMEType", "-XMP-geotagger:all", folder])
    scanned = json.loads(out) if out.strip() else []

    restored = failed = 0
    for entry in scanned:
        block = [(k, v) for k, v in entry.items() if k.startswith(PREFIX)]
        if not block:
            continue

        mapping = VIDEO if str(entry.get("File:MIMEType", "")).startswith("video/") else IMAGE
        write_args: list[str] = []
        report: list[str] = []
        for key, value in block:
            target = mapping.get(key[len(PREFIX):])
            if target is None:
                continue  # provenance, or an Original* of the other kind
            if str(value) == "n/a":
                write_args.append(f"-{target}=")
                report.append(f"{target}: delete")
            else:
                write_args.append(f"-{target}#={value}")
                report.append(f"{target}: {value}")
        write_args.append("-XMP-geotagger:all=")

        print(entry["SourceFile"])
        print("  " + ("\n  ".join(report) or "(no Original* tags, removing block only)"))
        if dry_run:
            continue
        try:
            exiftool(["-P", "-overwrite_original", "-charset", "filename=utf8", *write_args, entry["SourceFile"]])
            restored += 1
        except subprocess.CalledProcessError as err:
            failed += 1
            print(f"  FAILED: {err.stderr or err}", file=sys.stderr)

    print("\nDry run, nothing written." if dry_run else f"\nRestored {restored} file(s), {failed} failed.")


with tempfile.TemporaryDirectory(prefix="geotagger-restore-") as tmp:
    config_path = os.path.join(tmp, "geotagger.config")
    with open(config_path, "w") as f:
        f.write(CONFIG)
    main(config_path)
