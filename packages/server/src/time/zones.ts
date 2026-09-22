import tzlookup from 'tz-lookup';

/**
 * Offline timezone lookup (SPEC §4.2).
 *
 * `tz-lookup` answers from a compiled raster of zone boundaries, and the offset of a
 * zone at an instant comes from the ICU data Node already carries, so neither step
 * needs a network — which matters because this runs on a NAS that may well have none.
 */

/** The IANA zone a coordinate falls in, or null when the lookup cannot say. */
export function zoneForCoordinates(lat: number, lon: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  try {
    return tzlookup(lat, lon);
  } catch {
    // The raster covers the globe, but a value on a boundary can still throw.
    return null;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat | null {
  const cached = formatters.get(zone);
  if (cached) return cached;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, fmt);
    return fmt;
  } catch {
    return null;
  }
}

/**
 * The UTC offset of a zone at an instant, in minutes east of UTC.
 *
 * Derived by asking ICU what the wall clock reads there and subtracting — which gets
 * summer time and historical changes right without shipping a second copy of tzdata.
 */
export function zoneOffsetMinutes(zone: string, instantMs: number): number | null {
  const fmt = formatterFor(zone);
  if (!fmt) return null;
  const parts = fmt.formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const hour = get('hour');
  const wallMs = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // ICU can print midnight as hour 24 in the hour12:false locale.
    hour === 24 ? 0 : hour,
    get('minute'),
    get('second'),
  );
  if (!Number.isFinite(wallMs)) return null;
  return Math.round((wallMs - instantMs) / 60_000);
}

/**
 * The offset for a file that knows *where* it was but not *when* in absolute terms.
 *
 * Its reading is a wall clock, so the instant is unknown until the offset is, and the
 * offset is unknown until the instant is. One refinement settles it: the first guess
 * is only wrong for a reading within an hour or two of a daylight-saving change, and
 * applying the guess puts the second lookup on the right side of the boundary.
 */
export function offsetForNaiveReading(zone: string, naiveMs: number): number | null {
  const guess = zoneOffsetMinutes(zone, naiveMs);
  if (guess === null) return null;
  const refined = zoneOffsetMinutes(zone, naiveMs - guess * 60_000);
  return refined ?? guess;
}
