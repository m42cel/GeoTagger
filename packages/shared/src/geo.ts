/**
 * Great-circle geometry, the basis for position interpolation (SPEC §5: "All
 * calculations use effective timestamps and great-circle geometry").
 *
 * Lives in the shared package because both sides eventually need it: the server
 * computes the stored estimates, and the map view redraws the affected neighbours
 * live while a marker is being dragged (SPEC §5.5), where a round trip per frame is
 * not an option.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/** Mean Earth radius, metres. */
const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** Great-circle distance between two points, in metres (haversine). */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Initial bearing from `a` to `b`, degrees clockwise from north, in [0, 360). */
export function initialBearing(a: LatLon, b: LatLon): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The point reached from `start`, heading `bearingDeg`, after `distanceM` metres. */
export function destinationPoint(start: LatLon, bearingDeg: number, distanceM: number): LatLon {
  const delta = distanceM / EARTH_RADIUS_M;
  const theta = toRad(bearingDeg);
  const lat1 = toRad(start.lat);
  const lon1 = toRad(start.lon);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(delta) + Math.cos(lat1) * Math.sin(delta) * Math.cos(theta),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(theta) * Math.sin(delta) * Math.cos(lat1),
      Math.cos(delta) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: toDeg(lat2), lon: ((toDeg(lon2) + 540) % 360) - 180 };
}

/**
 * The point a fraction `f` of the way along the great circle from `a` to `b`
 * (SPEC §5.1). `f` is not clamped to [0, 1] — callers extrapolating past an anchor
 * pass a bearing and distance through `destinationPoint` instead, so this is only
 * ever called for the between-two-anchors case.
 */
export function greatCirclePoint(a: LatLon, b: LatLon, f: number): LatLon {
  const d = distanceMeters(a, b);
  if (d === 0) return a;
  return destinationPoint(a, initialBearing(a, b), d * f);
}
