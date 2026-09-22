/**
 * `tz-lookup` ships no types. It is a single CommonJS function returning the IANA
 * zone name for a coordinate, from a compiled offline raster — no network, which is
 * what SPEC §4.2 requires of the timezone-boundary lookup.
 */
declare module 'tz-lookup' {
  function tzlookup(latitude: number, longitude: number): string;
  export = tzlookup;
}
