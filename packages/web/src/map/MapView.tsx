import { useEffect, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet-polylinedecorator';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import type { ComputedPosition, FileRecord, FilesResponse, TimelineResponse } from '@geotagger/shared';
import { api } from '../api.js';
import { errorText } from '../App.js';

/**
 * The map view (SPEC §5, §6.3, §7): every file plotted at its known or interpolated
 * position, clustered, with a path line and uncertainty circles.
 *
 * Nothing here edits a position — dragging, confirming and the detail panel are
 * phase 3. This view only shows where SPEC §5's interpolation currently places
 * everything, which is also why it fetches plainly on mount rather than subscribing
 * to anything live: nothing on this screen changes it.
 */

const THUMB_SIZE_PX = 48;

interface MapItem {
  file: FileRecord;
  position: ComputedPosition;
  effectiveMs: number | null;
}

type BaseLayerId = 'osm' | 'esri';

const BASE_LAYERS: Record<BaseLayerId, { label: string; url: string; attribution: string; maxZoom: number }> = {
  osm: {
    label: 'Map',
    url: '/tiles/osm/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  esri: {
    label: 'Satellite',
    url: '/tiles/esri/{z}/{x}/{y}.png',
    attribution: 'Imagery &copy; Esri',
    maxZoom: 19,
  },
};

export function MapView({ onBack }: { onBack: () => void }) {
  const [filesResp, setFilesResp] = useState<FilesResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCircles, setShowCircles] = useState(true);
  const [baseLayer, setBaseLayer] = useState<BaseLayerId>('osm');

  useEffect(() => {
    Promise.all([api.files(), api.timeline()])
      .then(([f, t]) => {
        setFilesResp(f);
        setTimeline(t);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  const items = useMemo<MapItem[]>(() => {
    if (!filesResp || !timeline) return [];
    const positionById = new Map(filesResp.positions.map((p) => [p.fileId, p]));
    const effectiveById = new Map(timeline.files.map((f) => [f.id, f.effectiveMs]));
    return filesResp.files.map((file) => ({
      file,
      position: positionById.get(file.id) ?? { fileId: file.id, lat: null, lon: null, uncertaintyM: null, source: 'none' },
      effectiveMs: effectiveById.get(file.id) ?? null,
    }));
  }, [filesResp, timeline]);

  const onMap = useMemo(() => items.filter((i) => i.position.lat !== null && i.position.lon !== null), [items]);
  const tray = useMemo(() => items.filter((i) => i.position.source === 'none'), [items]);

  // SPEC §6.3: "a single plain polyline connecting all files in effective-time
  // order across all devices". Files with no effective time cannot take a place
  // in that order, so they are left out of the line — they are on the map (an
  // extrapolated position needs no timestamp of its own to draw), just not on it.
  const path = useMemo<[number, number][]>(
    () =>
      onMap
        .filter((i) => i.effectiveMs !== null)
        .sort((a, b) => (a.effectiveMs as number) - (b.effectiveMs as number))
        .map((i) => [i.position.lat as number, i.position.lon as number]),
    [onMap],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayersRef = useRef<Record<BaseLayerId, L.TileLayer> | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const circlesRef = useRef<L.LayerGroup | null>(null);
  const pathRef = useRef<L.Polyline | null>(null);
  const pathArrowsRef = useRef<L.PolylineDecorator | null>(null);
  const didFitRef = useRef(false);

  // The map itself is created once and never torn down until the view unmounts;
  // everything drawn on it is rebuilt in the effect below instead of recreating
  // the map, which would otherwise reset the user's pan and zoom on every refetch.
  useEffect(() => {
    if (!containerRef.current) return;
    const map = L.map(containerRef.current, { center: [20, 0], zoom: 2 });
    const layers = {
      osm: L.tileLayer(BASE_LAYERS.osm.url, { attribution: BASE_LAYERS.osm.attribution, maxZoom: BASE_LAYERS.osm.maxZoom }),
      esri: L.tileLayer(BASE_LAYERS.esri.url, { attribution: BASE_LAYERS.esri.attribution, maxZoom: BASE_LAYERS.esri.maxZoom }),
    };
    layers.osm.addTo(map);
    mapRef.current = map;
    baseLayersRef.current = layers;
    return () => {
      map.remove();
      mapRef.current = null;
      baseLayersRef.current = null;
    };
  }, []);

  useEffect(() => {
    const layers = baseLayersRef.current;
    const map = mapRef.current;
    if (!layers || !map) return;
    for (const id of Object.keys(layers) as BaseLayerId[]) {
      if (id === baseLayer) layers[id].addTo(map);
      else map.removeLayer(layers[id]);
    }
  }, [baseLayer]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    clusterRef.current?.remove();
    circlesRef.current?.remove();
    pathRef.current?.remove();
    pathArrowsRef.current?.remove();

    const cluster = L.markerClusterGroup({
      maxClusterRadius: 44,
      iconCreateFunction: (c) => clusterIcon(c.getAllChildMarkers()),
    });
    const circles = L.layerGroup();

    for (const item of onMap) {
      const borderClass = borderClassFor(item.position.source);
      const marker = L.marker([item.position.lat as number, item.position.lon as number], {
        icon: thumbIcon(item.file.id, borderClass),
      });
      const markerWithFile = marker as MarkerWithFile;
      markerWithFile.geotaggerFileId = item.file.id;
      markerWithFile.geotaggerBorderClass = borderClass;
      marker.bindTooltip(item.file.filename);
      cluster.addLayer(marker);

      if (showCircles && item.position.uncertaintyM !== null) {
        circles.addLayer(
          L.circle([item.position.lat as number, item.position.lon as number], {
            radius: item.position.uncertaintyM,
            color: '#d1453b',
            weight: 1,
            fillOpacity: 0.08,
            opacity: 0.35,
          }),
        );
      }
    }

    cluster.addTo(map);
    clusterRef.current = cluster;
    if (showCircles) circles.addTo(map);
    circlesRef.current = circles;

    if (path.length > 1) {
      // Fixed rather than themed, like the marker borders: this sits on map imagery,
      // not the app background.
      const line = L.polyline(path, { color: '#333333', weight: 2, opacity: 0.7 });
      line.addTo(map);
      pathRef.current = line;

      // Direction arrowheads (SPEC §6.3), kept subtle enough to ship on by default
      // rather than behind a toggle: small and low-opacity so they read as a hint of
      // travel direction without competing with the thumbnails.
      //
      // `repeat` is a bare number of screen pixels, not a '%' string, so the spacing
      // is in on-screen pixels rather than a fraction of the path's total length —
      // the plugin redraws on every zoom/pan (it listens for `moveend`), so the same
      // pixel spacing means more arrows appear as the path stretches out on screen
      // while zooming in, instead of the whole trip's fixed handful going mostly
      // off-screen.
      const arrows = L.polylineDecorator(line, {
        patterns: [
          {
            repeat: 80,
            symbol: L.Symbol.arrowHead({
              pixelSize: 7,
              headAngle: 50,
              pathOptions: { color: '#333333', weight: 1, opacity: 0.5, fillOpacity: 0.5 },
            }),
          },
        ],
      });
      arrows.addTo(map);
      pathArrowsRef.current = arrows;
    } else {
      pathRef.current = null;
      pathArrowsRef.current = null;
    }

    if (!didFitRef.current && onMap.length > 0) {
      didFitRef.current = true;
      const bounds = L.latLngBounds(onMap.map((i) => [i.position.lat as number, i.position.lon as number]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    }
  }, [onMap, path, showCircles]);

  return (
    <section className="map-view">
      <div className="view-actions">
        <button type="button" className="ghost" onClick={onBack}>
          ← Back
        </button>
        <div className="chip-group">
          {(Object.keys(BASE_LAYERS) as BaseLayerId[]).map((id) => (
            <button
              key={id}
              type="button"
              className={`chip${baseLayer === id ? ' on' : ''}`}
              onClick={() => setBaseLayer(id)}
            >
              {BASE_LAYERS[id].label}
            </button>
          ))}
        </div>
        <label className="map-toggle">
          <input type="checkbox" checked={showCircles} onChange={(e) => setShowCircles(e.target.checked)} />
          Uncertainty circles
        </label>
        <div className="map-legend">
          <span className="legend-swatch known" /> known position
          <span className="legend-swatch unconfirmed" /> unconfirmed estimate
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="map-layout">
        <div className="map-container" ref={containerRef} />
        {tray.length > 0 && <Tray items={tray} />}
      </div>
    </section>
  );
}

/**
 * Files with no derivable position (SPEC §6.4): fewer than two anchors in the whole
 * folder, or no capture time of their own. Dragging one onto the map to place it and
 * make it an anchor is a phase 3 interaction; for now this is a read-only list.
 */
function Tray({ items }: { items: MapItem[] }) {
  return (
    <aside className="tray-panel">
      <h2>Not on the map · {items.length}</h2>
      <ul className="tray-list">
        {items.map(({ file }) => (
          <li key={file.id} title={file.relPath}>
            <img src={`/api/files/${file.id}/thumb`} alt="" loading="lazy" width={40} height={40} />
            <span>{file.filename}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

type MarkerWithFile = L.Marker & { geotaggerFileId?: number; geotaggerBorderClass?: 'known' | 'unconfirmed' };

/** Green for a known position (camera GPS or confirmed), red for anything derived or not yet confirmed (SPEC §6.5). */
function borderClassFor(source: ComputedPosition['source']): 'known' | 'unconfirmed' {
  return source === 'camera-gps' || source === 'confirmed' ? 'known' : 'unconfirmed';
}

function thumbIcon(fileId: number, borderClass: 'known' | 'unconfirmed'): L.DivIcon {
  return L.divIcon({
    className: `map-thumb-icon ${borderClass}`,
    html: `<img src="/api/files/${fileId}/thumb" loading="lazy" />`,
    iconSize: [THUMB_SIZE_PX, THUMB_SIZE_PX],
  });
}

/**
 * SPEC §6.3: "a badge showing the count over a representative thumbnail". The
 * border takes the worst of the cluster's members — green only if every one of them
 * is a known position, red if even one is an unconfirmed estimate — so collapsing a
 * mixed group never hides that some of it still needs confirming.
 */
function clusterIcon(markers: L.Marker[]): L.DivIcon {
  const withFile = markers as MarkerWithFile[];
  const first = withFile[0];
  const fileId = first?.geotaggerFileId;
  const borderClass = withFile.some((m) => m.geotaggerBorderClass === 'unconfirmed') ? 'unconfirmed' : 'known';
  return L.divIcon({
    className: `map-cluster-icon ${borderClass}`,
    html: `<img src="/api/files/${fileId}/thumb" loading="lazy" /><span class="cluster-count">${markers.length}</span>`,
    iconSize: [THUMB_SIZE_PX, THUMB_SIZE_PX],
  });
}
