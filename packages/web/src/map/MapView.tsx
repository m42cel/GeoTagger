import { useEffect, useMemo, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet-polylinedecorator';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import type { ComputedPosition, FileRecord, FilesResponse, TimelineFile, TimelineResponse } from '@geotagger/shared';
import { api } from '../api.js';
import { errorText } from '../App.js';
import { DetailPanel } from './DetailPanel.js';

/**
 * The map view (SPEC §5, §6.3, §7, §6.5): every file plotted at its known or
 * interpolated position, clustered, with a path line and uncertainty circles.
 * Selecting a thumbnail shows the detail panel; dragging a marker or using the
 * panel's confirm/revert/reset buttons edits its position (SPEC §5.6). Re-dragging
 * an already-anchored file draws a ghost at its old position, connected by a thin
 * line to where it is now — that old position is still what anchors everyone else
 * until the drag is confirmed or reverted.
 *
 * Multi-select and status filters are not here yet — this is single-file editing
 * only, wired the same way the alignment view's mutations are: every edit posts to
 * the server and replaces local state with the response it sends back, rather than
 * predicting the recomputation (SPEC §5.5) itself.
 */

const THUMB_SIZE_PX = 48;

interface MapItem {
  file: FileRecord;
  position: ComputedPosition;
  timelineFile: TimelineFile | null;
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.files(), api.timeline()])
      .then(([f, t]) => {
        setFilesResp(f);
        setTimeline(t);
      })
      .catch((err: unknown) => setError(errorText(err)));
  }, []);

  /**
   * Every position edit follows the same shape: post it, adopt whatever
   * `FilesResponse` comes back (SPEC §5.5's recomputation of neighbouring
   * estimates already happened server-side), and surface a failure without
   * touching state — the caller is responsible for undoing any optimistic UI it
   * made, e.g. a dragged marker snapping back to where it started.
   */
  async function editPosition(run: () => Promise<FilesResponse>): Promise<boolean> {
    setBusy(true);
    try {
      setFilesResp(await run());
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function handleDragEnd(fileId: number, lat: number, lon: number, marker: L.Marker, revertTo: L.LatLng): void {
    void editPosition(() => api.dragPosition(fileId, lat, lon)).then((ok) => {
      if (ok) setSelectedId(fileId);
      else marker.setLatLng(revertTo);
    });
  }

  function handleConfirm(): void {
    if (selectedId !== null) void editPosition(() => api.confirmPosition(selectedId));
  }

  function handleRevert(): void {
    if (selectedId !== null) void editPosition(() => api.revertPosition(selectedId));
  }

  function handleReset(): void {
    if (selectedId !== null) void editPosition(() => api.resetPosition(selectedId));
  }

  const items = useMemo<MapItem[]>(() => {
    if (!filesResp || !timeline) return [];
    const positionById = new Map(filesResp.positions.map((p) => [p.fileId, p]));
    const timelineById = new Map(timeline.files.map((f) => [f.id, f]));
    return filesResp.files.map((file) => ({
      file,
      position: positionById.get(file.id) ?? {
        fileId: file.id,
        lat: null,
        lon: null,
        uncertaintyM: null,
        source: 'none',
        anchorLat: null,
        anchorLon: null,
      },
      timelineFile: timelineById.get(file.id) ?? null,
    }));
  }, [filesResp, timeline]);

  const onMap = useMemo(() => items.filter((i) => i.position.lat !== null && i.position.lon !== null), [items]);
  const tray = useMemo(() => items.filter((i) => i.position.source === 'none'), [items]);
  const selected = useMemo(() => items.find((i) => i.file.id === selectedId) ?? null, [items, selectedId]);

  // SPEC §6.3: the line connects anchors and the estimates between them, in
  // effective-time order. Files with no effective time cannot take a place in that
  // order, so they are left out of the line — they are on the map (an extrapolated
  // position needs no timestamp of its own to draw), just not on it. A file with a
  // pending drag and no anchor underneath is excluded the same way: it does not
  // anchor its neighbours (SPEC §5.5), so it should not bend the line toward it
  // either. A file being *re*-dragged still has its old anchor (`anchorLat`/`Lon`,
  // SPEC §5.6's ghost) doing that work, so the line runs through that point rather
  // than skipping the file or bending toward where it is being dragged to.
  const path = useMemo<[number, number][]>(
    () =>
      onMap
        .filter(
          (i) =>
            (i.position.anchorLat !== null || i.position.source !== 'manual') &&
            i.timelineFile?.effectiveMs !== null &&
            i.timelineFile?.effectiveMs !== undefined,
        )
        .sort((a, b) => (a.timelineFile?.effectiveMs as number) - (b.timelineFile?.effectiveMs as number))
        .map((i): [number, number] =>
          i.position.anchorLat !== null
            ? [i.position.anchorLat, i.position.anchorLon as number]
            : [i.position.lat as number, i.position.lon as number],
        ),
    [onMap],
  );

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayersRef = useRef<Record<BaseLayerId, L.TileLayer> | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const circlesRef = useRef<L.LayerGroup | null>(null);
  const ghostsRef = useRef<L.LayerGroup | null>(null);
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
    ghostsRef.current?.remove();
    pathRef.current?.remove();
    pathArrowsRef.current?.remove();

    const cluster = L.markerClusterGroup({
      maxClusterRadius: 44,
      iconCreateFunction: (c) => clusterIcon(c.getAllChildMarkers()),
    });
    const circles = L.layerGroup();
    const ghosts = L.layerGroup();
    const markers: MarkerWithFile[] = [];

    for (const item of onMap) {
      const borderClass = borderClassFor(item.position.source);
      const marker = L.marker([item.position.lat as number, item.position.lon as number], {
        icon: thumbIcon(item.file.id, borderClass, item.file.id === selectedId),
        draggable: true,
        autoPan: true,
      });
      const markerWithFile = marker as MarkerWithFile;
      markerWithFile.geotaggerFileId = item.file.id;
      markerWithFile.geotaggerBorderClass = borderClass;
      markerWithFile.geotaggerUncertaintyM = item.position.uncertaintyM;
      marker.bindTooltip(item.file.filename);
      marker.on('click', () => setSelectedId(item.file.id));
      // Dragging deliberately does not auto-confirm (SPEC §6.5): it only sets the
      // file's own position and stays unconfirmed (red) — it does not anchor its
      // neighbours until confirmed (§5.5).
      const startedAt = L.latLng(item.position.lat as number, item.position.lon as number);
      marker.on('dragstart', () => setSelectedId(item.file.id));
      marker.on('dragend', () => {
        const ll = marker.getLatLng();
        handleDragEnd(item.file.id, ll.lat, ll.lng, marker, startedAt);
      });
      cluster.addLayer(marker);
      markers.push(markerWithFile);

      // SPEC §5.6's ghost: a drag in progress over an existing anchor leaves that
      // anchor's old position marked (it is still what places everyone else) and
      // draws a thin line to where the file is now, so it is obvious which live
      // marker a ghost belongs to.
      if (item.position.anchorLat !== null && item.position.anchorLon !== null) {
        const anchorLatLng = L.latLng(item.position.anchorLat, item.position.anchorLon);
        const liveLatLng = L.latLng(item.position.lat as number, item.position.lon as number);
        L.polyline([anchorLatLng, liveLatLng], {
          color: '#666666',
          weight: 1.5,
          dashArray: '4 4',
          opacity: 0.8,
        }).addTo(ghosts);
        L.circleMarker(anchorLatLng, {
          radius: 8,
          color: '#666666',
          weight: 2,
          fillColor: '#ffffff',
          fillOpacity: 0.7,
        })
          .bindTooltip(`${item.file.filename} — previous position`)
          .addTo(ghosts);
      }
    }

    // SPEC §6.3's uncertainty circles are per file, but a stack collapsed into a
    // single cluster icon at low zoom shouldn't layer one circle per member on top
    // of each other — that's dozens of near-identical rings drawn at the stack's
    // thumbnail. Instead each *currently visible* icon (a lone marker or a cluster)
    // gets exactly one circle, sized to the largest uncertainty among the markers it
    // is currently standing in for and centered on that worst-case marker's own
    // position — not the cluster icon's position, which is a synthetic centroid no
    // single photo actually sits at and would jump the circle around as the cluster
    // icon moves on zoom. Zooming in splits the cluster and this recomputes, so
    // members eventually get their own individually-sized circles again.
    const rebuildCircles = () => {
      circles.clearLayers();
      if (!showCircles) return;
      const groups = new Map<L.Layer, { center: L.LatLng; maxUncertaintyM: number }>();
      for (const marker of markers) {
        if (marker.geotaggerUncertaintyM === null || marker.geotaggerUncertaintyM === undefined) continue;
        const visibleParent = cluster.getVisibleParent(marker);
        if (!visibleParent) continue;
        const existing = groups.get(visibleParent);
        if (!existing || marker.geotaggerUncertaintyM > existing.maxUncertaintyM) {
          groups.set(visibleParent, { center: marker.getLatLng(), maxUncertaintyM: marker.geotaggerUncertaintyM });
        }
      }
      for (const { center, maxUncertaintyM } of groups.values()) {
        circles.addLayer(
          L.circle(center, {
            radius: maxUncertaintyM,
            color: '#d1453b',
            weight: 1,
            fillOpacity: 0.08,
            opacity: 0.35,
          }),
        );
      }
    };

    cluster.on('animationend spiderfied unspiderfied', rebuildCircles);
    cluster.addTo(map);
    clusterRef.current = cluster;
    rebuildCircles();
    circles.addTo(map);
    circlesRef.current = circles;

    ghosts.addTo(map);
    ghostsRef.current = ghosts;

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
  }, [onMap, path, showCircles, selectedId]);

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
        {tray.length > 0 && <Tray items={tray} selectedId={selectedId} onSelect={setSelectedId} />}
        <DetailPanel
          file={selected?.file ?? null}
          position={selected?.position ?? null}
          timelineFile={selected?.timelineFile ?? null}
          onConfirm={handleConfirm}
          onRevert={handleRevert}
          onReset={handleReset}
          busy={busy}
        />
      </div>
    </section>
  );
}

/**
 * Files with no derivable position (SPEC §6.4): fewer than two anchors in the whole
 * folder, or no capture time of their own. Dragging one onto the map to place it —
 * confirming it is what then makes it an anchor (§5.5) — is not wired up yet; for
 * now this is a read-only list, but clicking one still shows it in the detail panel
 * like a thumbnail on the map would.
 */
function Tray({
  items,
  selectedId,
  onSelect,
}: {
  items: MapItem[];
  selectedId: number | null;
  onSelect: (fileId: number) => void;
}) {
  return (
    <aside className="tray-panel">
      <h2>Not on the map · {items.length}</h2>
      <ul className="tray-list">
        {items.map(({ file }) => (
          <li
            key={file.id}
            title={file.relPath}
            className={file.id === selectedId ? 'selected' : ''}
            onClick={() => onSelect(file.id)}
          >
            <img src={`/api/files/${file.id}/thumb`} alt="" loading="lazy" width={40} height={40} />
            <span>{file.filename}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

type MarkerWithFile = L.Marker & {
  geotaggerFileId?: number;
  geotaggerBorderClass?: 'known' | 'unconfirmed';
  geotaggerUncertaintyM?: number | null;
};

/** Green for a known position (camera GPS or confirmed), red for anything derived or not yet confirmed (SPEC §6.5). */
function borderClassFor(source: ComputedPosition['source']): 'known' | 'unconfirmed' {
  return source === 'camera-gps' || source === 'confirmed' ? 'known' : 'unconfirmed';
}

/** Selection highlight (SPEC §6.3) is a ring layered on top of the border colour, not a replacement for it. */
function thumbIcon(fileId: number, borderClass: 'known' | 'unconfirmed', selected: boolean): L.DivIcon {
  return L.divIcon({
    className: `map-thumb-icon ${borderClass}${selected ? ' selected' : ''}`,
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
