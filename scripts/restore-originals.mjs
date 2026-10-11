#!/usr/bin/env node
// TEMPORARY test helper — restores files GeoTagger has written to their pre-GeoTagger state,
// from the XMP-geotagger:Original* block (SPEC §9.3), then strips that block.
//
//   node scripts/restore-originals.mjs <folder> [--dry-run]
//
// Needs `exiftool` on PATH. Does not touch <folder>/.geotagger — delete that yourself for a
// clean slate, otherwise the app still remembers its edits and will propose them again.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const folder = args.find((a) => !a.startsWith('--'));
if (!folder) {
  console.error('usage: node scripts/restore-originals.mjs <folder> [--dry-run]');
  process.exit(1);
}

// Same namespace declaration the app generates (packages/server/src/write/exiftool-config.ts).
const TAGS = [
  'OriginalDateTimeOriginal', 'OriginalCreateDate', 'OriginalOffsetTimeOriginal',
  'OriginalOffsetTimeDigitized', 'OriginalGPSLatitude', 'OriginalGPSLatitudeRef',
  'OriginalGPSLongitude', 'OriginalGPSLongitudeRef', 'OriginalGPSCoordinates',
  'OriginalXMPGPSLatitude', 'OriginalXMPGPSLongitude', 'PositionSource',
  'PositionUncertaintyMeters', 'TimeShiftSeconds', 'ModifiedAt', 'AppVersion',
];
const configPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'geotagger-restore-')), 'geotagger.config');
fs.writeFileSync(configPath, `%Image::ExifTool::UserDefined::geotagger = (
    GROUPS    => { 0 => 'XMP', 1 => 'XMP-geotagger', 2 => 'Image' },
    NAMESPACE => { 'geotagger' => 'http://ns.geotagger.local/1.0/' },
    WRITABLE  => 'string',
${TAGS.map((t) => `    ${t} => { },`).join('\n')}
);
%Image::ExifTool::UserDefined = (
    'Image::ExifTool::XMP::Main' => {
        geotagger => { SubDirectory => { TagTable => 'Image::ExifTool::UserDefined::geotagger' } },
    },
);
1;
`);

// Original* → the tag it preserves, per media kind (packages/server/src/write/tags.ts preservedTagsFor).
const IMAGE = {
  OriginalDateTimeOriginal: 'EXIF:DateTimeOriginal',
  OriginalCreateDate: 'EXIF:CreateDate',
  OriginalOffsetTimeOriginal: 'EXIF:OffsetTimeOriginal',
  OriginalOffsetTimeDigitized: 'EXIF:OffsetTimeDigitized',
  OriginalGPSLatitude: 'EXIF:GPSLatitude',
  OriginalGPSLatitudeRef: 'EXIF:GPSLatitudeRef',
  OriginalGPSLongitude: 'EXIF:GPSLongitude',
  OriginalGPSLongitudeRef: 'EXIF:GPSLongitudeRef',
  OriginalXMPGPSLatitude: 'XMP:GPSLatitude',
  OriginalXMPGPSLongitude: 'XMP:GPSLongitude',
};
const VIDEO = {
  OriginalCreateDate: 'QuickTime:CreateDate',
  OriginalGPSCoordinates: 'QuickTime:GPSCoordinates',
  OriginalXMPGPSLatitude: 'XMP:GPSLatitude',
  OriginalXMPGPSLongitude: 'XMP:GPSLongitude',
};

function exiftool(argv) {
  return execFileSync('exiftool', ['-config', configPath, ...argv], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

// Originals were read with -n when stamped, so read and write them unconverted too.
const scanned = JSON.parse(
  exiftool(['-q', '-r', '-j', '-n', '-G1', '-charset', 'filename=utf8', '-i', '.geotagger',
    '-MIMEType', '-XMP-geotagger:all', folder]) || '[]',
);

let restored = 0;
let failed = 0;
for (const entry of scanned) {
  const block = Object.entries(entry).filter(([k]) => k.startsWith('XMP-geotagger:'));
  if (block.length === 0) continue;

  const map = String(entry['File:MIMEType'] ?? '').startsWith('video/') ? VIDEO : IMAGE;
  const writeArgs = [];
  const report = [];
  for (const [key, value] of block) {
    const target = map[key.slice('XMP-geotagger:'.length)];
    if (target === undefined) continue; // provenance, or an Original* of the other kind
    if (String(value) === 'n/a') {
      writeArgs.push(`-${target}=`);
      report.push(`${target}: delete`);
    } else {
      writeArgs.push(`-${target}#=${value}`);
      report.push(`${target}: ${value}`);
    }
  }
  writeArgs.push('-XMP-geotagger:all=');

  console.log(`${entry.SourceFile}\n  ${report.join('\n  ') || '(no Original* tags, removing block only)'}`);
  if (dryRun) continue;
  try {
    exiftool(['-P', '-overwrite_original', '-charset', 'filename=utf8', ...writeArgs, entry.SourceFile]);
    restored++;
  } catch (err) {
    failed++;
    console.error(`  FAILED: ${err.stderr || err.message}`);
  }
}

fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
console.log(dryRun ? '\nDry run, nothing written.' : `\nRestored ${restored} file(s), ${failed} failed.`);
