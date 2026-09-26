/**
 * The tile providers of SPEC §7.1 that need no API key. MapTiler and Thunderforest
 * are configured with a key from the settings page (§11), which arrives in phase 5;
 * this registry is shaped so adding them later is a new entry, not a redesign.
 */
export interface TileProvider {
  id: string;
  label: string;
  /** Upstream URL for one tile. */
  url: (z: number, x: number, y: number) => string;
  /** Concurrent upstream requests this proxy allows itself for this provider. */
  concurrency: number;
  /**
   * What the upstream actually serves. The on-disk cache path is always
   * `<z>/<x>/<y>.png` regardless (SPEC §7.2's layout), but Esri's imagery is JPEG
   * bytes underneath, and serving those with a PNG content-type renders fine in an
   * `<img>` (browsers sniff) but is still the wrong thing to send.
   */
  contentType: string;
}

export const TILE_PROVIDERS: Readonly<Record<string, TileProvider>> = {
  osm: {
    id: 'osm',
    label: 'OpenStreetMap',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    // The OSMF tile usage policy forbids bulk/systematic downloading; this is the
    // proxy-side half of respecting it (SPEC §7.1). The other half — a proper
    // User-Agent — lives in proxy.ts, where the request is actually made.
    concurrency: 2,
    contentType: 'image/png',
  },
  esri: {
    id: 'esri',
    label: 'Esri World Imagery',
    // ArcGIS's tile REST endpoint takes level/row/column, i.e. z/y/x.
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    concurrency: 4,
    contentType: 'image/jpeg',
  },
};

export function getProvider(id: string): TileProvider | null {
  return Object.prototype.hasOwnProperty.call(TILE_PROVIDERS, id) ? TILE_PROVIDERS[id] ?? null : null;
}
