import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import * as L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet-polylinedecorator';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import type { ComputedPosition, FileId, FileRecord, FilesResponse, TimelineFile, TimelineResponse } from '@geotagger/shared';
import { api } from '../api.js';
import { errorText } from '../App.js';
import { DetailPanel } from './DetailPanel.js';
import { markerSize } from './marker-size.js';

/**
 * The map view (SPEC §5, §6.3, §7, §6.5): every file plotted at its known or
 * interpolated position, clustered, with a path line and uncertainty circles.
 * Selecting a thumbnail shows the detail panel; dragging a marker or using the
 * panel's confirm/revert/reset buttons edits its position (SPEC §5.6). Re-dragging
 * an already-anchored file draws a ghost at its old position, connected by a thin
 * line to where it is now — that old position is still what anchors everyone else
 * until the drag is confirmed or reverted.
 *
 * Editing is wired the same way the alignment view's mutations are: every edit posts
 * to the server and replaces local state with the response it sends back, rather
 * than predicting the recomputation (SPEC §5.5) itself.
 *
 * Multi-select (SPEC §6.5) is shift-click to toggle one marker at a time, or a
 * shift+drag rubber band to select every marker inside the box, independent of the
 * single `selectedId` the detail panel shows — it exists only to batch-confirm a
 * selection at once (§6.5's "confirm the selection together"), not to drag or revert
 * a group, so it carries no per-file detail of its own.
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

export function MapView({ onBack, onOpenPersist }: { onBack: () => void; onOpenPersist: () => void }) {
  const [filesResp, setFilesResp] = useState<FilesResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCircles, setShowCircles] = useState(true);
  // SPEC §6.3 filters: visibility-only, on by default.
  const [showUnconfirmed, setShowUnconfirmed] = useState(true);
  const [showAppModified, setShowAppModified] = useState(true);
  const [showUnpersisted, setShowUnpersisted] = useState(true);
  const [baseLayer, setBaseLayer] = useState<BaseLayerId>('osm');
  const [selectedId, setSelectedId] = useState<FileId | null>(null);
  const [multiSelected, setMultiSelected] = useState<Set<FileId>>(new Set());
  const [busy, setBusy] = useState(false);

  // Kept in sync with the state above on every render so the marker-rebuild effect
  // (below) can read the latest selection without depending on it — that effect only
  // needs to depend on the *data*, since selection highlighting is applied in place
  // by a separate, cheap effect further down instead of by rebuilding every marker.
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const multiSelectedRef = useRef(multiSelected);
  multiSelectedRef.current = multiSelected;

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

  function handleDragEnd(fileId: FileId, lat: number, lon: number, marker: L.Marker, revertTo: L.LatLng): void {
    void editPosition(() => api.dragPosition(fileId, lat, lon)).then((ok) => {
      if (ok) {
        setSelectedId(fileId);
        clearMultiSelected();
      } else marker.setLatLng(revertTo);
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

  // Tray drag-onto-map (SPEC §6.4): dragging a tray item onto the map sets its
  // position, same as dragging an existing marker — it goes through the same
  // `dragPosition` route and stays unconfirmed (red) until the user confirms it,
  // which is what actually makes it an anchor (§5.5).
  function handleTrayDrop(e: DragEvent<HTMLDivElement>): void {
    e.preventDefault();
    const map = mapRef.current;
    if (!map) return;
    const fileId = e.dataTransfer.getData('text/plain') as FileId;
    if (!fileId) return;
    const { lat, lng } = map.mouseEventToLatLng(e.nativeEvent);
    void editPosition(() => api.dragPosition(fileId, lat, lng)).then((ok) => {
      if (ok) setSelectedId(fileId);
    });
  }

  function toggleMultiSelected(fileId: FileId): void {
    setMultiSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  // A clear that hands back a genuinely new `Set` even when there was nothing to
  // clear still triggers the selection-highlight effect and `confirmableSelected` to
  // redo their work for no reason on every no-op clear (e.g. every `dragend`).
  // Handing back the same reference when already empty makes React bail out instead.
  function clearMultiSelected(): void {
    setMultiSelected((prev) => (prev.size === 0 ? prev : new Set()));
  }

  function handleBulkConfirm(): void {
    if (confirmableSelected.length === 0) return;
    void editPosition(() => api.bulkConfirm(confirmableSelected)).then((ok) => {
      if (ok) clearMultiSelected();
    });
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

  const unpersistedIds = useMemo(() => new Set(filesResp?.unpersistedFileIds ?? []), [filesResp]);

  // SPEC §6.3 filters: visibility only — `onMap` (and `path`, derived from it below)
  // stay the full set, so the path line and anything else built from `onMap` are
  // unaffected by what's currently hidden. This is what markers actually get drawn
  // from.
  const visibleOnMap = useMemo(
    () =>
      onMap.filter((i) => {
        const isUnconfirmed = i.position.source === 'manual' || i.position.source === 'estimate';
        const isAppModified = i.position.source !== 'camera-gps';
        const isUnpersisted = unpersistedIds.has(i.file.id);
        return (
          (showUnconfirmed || !isUnconfirmed) &&
          (showAppModified || !isAppModified) &&
          (showUnpersisted || !isUnpersisted)
        );
      }),
    [onMap, showUnconfirmed, showAppModified, showUnpersisted, unpersistedIds],
  );

  const tray = useMemo(() => items.filter((i) => i.position.source === 'none'), [items]);
  const selected = useMemo(() => items.find((i) => i.file.id === selectedId) ?? null, [items, selectedId]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.file.id, i])), [items]);

  // Same eligibility as the single-file confirm button (SPEC §6.5): camera GPS and
  // an already-confirmed position are already anchors, with nothing to confirm.
  // Filtering here — not just on the server — means the bar can hide the button
  // entirely when the selection has nothing confirmable in it, rather than showing
  // a button that would silently no-op on every selected file.
  const confirmableSelected = useMemo(
    () =>
      [...multiSelected].filter((id) => {
        const source = itemById.get(id)?.position.source;
        return source === 'estimate' || source === 'manual';
      }),
    [multiSelected, itemById],
  );

  // The detail panel's thumbnail grid (SPEC §6.3) while a multi-selection is active.
  const multiSelectedItems = useMemo(
    () =>
      [...multiSelected]
        .map((id) => itemById.get(id))
        .filter((item): item is MapItem => item !== undefined)
        .map((item) => ({ file: item.file, position: item.position })),
    [multiSelected, itemById],
  );

  function handleSelectOne(fileId: FileId): void {
    setSelectedId(fileId);
    clearMultiSelected();
  }

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
  const markersRef = useRef<MarkerWithFile[]>([]);

  // The map itself is created once and never torn down until the view unmounts;
  // everything drawn on it is rebuilt in the effect below instead of recreating
  // the map, which would otherwise reset the user's pan and zoom on every refetch.
  useEffect(() => {
    if (!containerRef.current) return;
    // boxZoom is Leaflet's own shift+drag gesture; multi-select's rubber band (below)
    // repurposes shift+drag for selection instead, so the built-in one has to go.
    const map = L.map(containerRef.current, { center: [20, 0], zoom: 2, boxZoom: false });
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

  // Multi-select (SPEC §6.5): shift+drag starting on empty map draws a rubber band
  // and replaces the selection with everything inside it once released. A marker's
  // own mousedown stops propagation before this ever sees it (Leaflet's default for
  // interactive layers), so starting the drag on a marker instead falls through to
  // its own click handler below — shift-click toggles just that one. Hit-testing
  // uses each marker's real geographic position from `markersRef`, so it still finds
  // members hidden inside a collapsed cluster, not just what's visibly on screen.
  //
  // A plain click on the map that hits no marker clears both the detail panel's
  // single selection and the multi-selection; a shift-click that hits no marker is
  // left alone rather than treated as an empty rubber band — it usually means the
  // user was aiming for a marker and missed by a pixel, not that they meant to
  // deselect everything.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    let anchor: L.Point | null = null;
    let box: HTMLDivElement | null = null;

    const paint = (a: L.Point, b: L.Point) => {
      if (!box) return;
      box.style.left = `${Math.min(a.x, b.x)}px`;
      box.style.top = `${Math.min(a.y, b.y)}px`;
      box.style.width = `${Math.abs(a.x - b.x)}px`;
      box.style.height = `${Math.abs(a.y - b.y)}px`;
    };

    const onMouseMove = (event: Event) => {
      if (!anchor) return;
      paint(anchor, map.mouseEventToContainerPoint(event as MouseEvent));
    };

    const onMouseUp = (event: Event) => {
      if (!anchor) return;
      const endPoint = map.mouseEventToContainerPoint(event as MouseEvent);
      // Below Leaflet's own click-tolerance (the same 3px it uses to tell a click
      // from a drag elsewhere), this was a shift-click that missed every marker, not
      // a rubber band drawn over empty space — leave the selection as it was.
      if (anchor.distanceTo(endPoint) > 3) {
        const bounds = L.latLngBounds(map.containerPointToLatLng(anchor), map.containerPointToLatLng(endPoint));
        const inside = markersRef.current
          .filter((m) => bounds.contains(m.getLatLng()))
          .map((m) => m.geotaggerFileId)
          .filter((id): id is FileId => id !== undefined);
        setMultiSelected(new Set(inside));
      }

      anchor = null;
      box?.remove();
      box = null;
      map.dragging.enable();
      L.DomEvent.off(document.body, 'mousemove', onMouseMove);
      L.DomEvent.off(document.body, 'mouseup', onMouseUp);
    };

    // preventDefault on the mousedown, not just disabling Leaflet's own pan-drag
    // handler, is what stops the browser's native text/image-drag selection from
    // also kicking in — without it the gesture doubles as an ordinary text-select
    // the moment the cursor leaves the map. Listening on `document.body` rather
    // than the map itself keeps the box (and the final hit test) working even when
    // the drag continues past the map's own edge.
    const onMouseDown = (e: L.LeafletMouseEvent) => {
      if (!e.originalEvent.shiftKey) return;
      L.DomEvent.preventDefault(e.originalEvent);
      anchor = map.mouseEventToContainerPoint(e.originalEvent);
      map.dragging.disable();
      box = document.createElement('div');
      box.className = 'map-select-box';
      map.getContainer().appendChild(box);
      paint(anchor, anchor);
      L.DomEvent.on(document.body, 'mousemove', onMouseMove);
      L.DomEvent.on(document.body, 'mouseup', onMouseUp);
    };

    // A marker's own click never bubbles up to this (same stopPropagation as
    // mousedown above), so this only ever sees clicks that hit no marker. Leaflet
    // still synthesizes this map-level click right after a rubber-band mouseup even
    // though `dragging` was disabled for the gesture — the shiftKey check above
    // doubles as the guard against that, since the physical shift key is still down
    // at that instant.
    const onMapClick = (e: L.LeafletMouseEvent) => {
      if (e.originalEvent.shiftKey) return;
      clearMultiSelected();
      setSelectedId(null);
    };

    map.on('mousedown', onMouseDown);
    map.on('click', onMapClick);
    return () => {
      map.off('mousedown', onMouseDown);
      map.off('click', onMapClick);
      L.DomEvent.off(document.body, 'mousemove', onMouseMove);
      L.DomEvent.off(document.body, 'mouseup', onMouseUp);
      box?.remove();
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    clusterRef.current?.remove();
    circlesRef.current?.remove();
    ghostsRef.current?.remove();
    pathRef.current?.remove();
    pathArrowsRef.current?.remove();

    // zoomToBoundsOnClick is off so a shift-click on a stack can multi-select its
    // members instead of also zooming in; a plain click zooms manually below,
    // reproducing the library's own default for that case.
    const cluster = L.markerClusterGroup({
      maxClusterRadius: 44,
      zoomToBoundsOnClick: false,
      iconCreateFunction: (c) => clusterIcon(c.getAllChildMarkers(), selectedIdRef.current, multiSelectedRef.current),
    });
    // Shift-click on a stack (SPEC §6.5) toggles every file in it at once — all in
    // if any are missing from the selection, all out if every one is already
    // selected — the same "extend to the next photo" gesture a lone marker gets,
    // just applied to the whole stack it collapsed into.
    cluster.on('clusterclick', (e) => {
      const event = e as L.LeafletMouseEvent & { layer: L.MarkerCluster };
      const memberIds = (event.layer.getAllChildMarkers() as MarkerWithFile[])
        .map((m) => m.geotaggerFileId)
        .filter((id): id is FileId => id !== undefined);
      if (!event.originalEvent.shiftKey) {
        event.layer.zoomToBounds();
        return;
      }
      const allSelected = memberIds.every((id) => multiSelectedRef.current.has(id));
      setMultiSelected((prev) => {
        const next = new Set(prev);
        for (const id of memberIds) {
          if (allSelected) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    });
    const circles = L.layerGroup();
    const ghosts = L.layerGroup();
    const markers: MarkerWithFile[] = [];

    for (const item of visibleOnMap) {
      const borderClass = borderClassFor(item.position.source);
      const size = markerSize(item.file.width, item.file.height, THUMB_SIZE_PX);
      const marker = L.marker([item.position.lat as number, item.position.lon as number], {
        icon: thumbIcon(
          item.file.id,
          size,
          borderClass,
          item.file.id === selectedIdRef.current,
          multiSelectedRef.current.has(item.file.id),
        ),
        draggable: true,
        autoPan: true,
      });
      const markerWithFile = marker as MarkerWithFile;
      markerWithFile.geotaggerFileId = item.file.id;
      markerWithFile.geotaggerBorderClass = borderClass;
      markerWithFile.geotaggerSize = size;
      markerWithFile.geotaggerUncertaintyM = item.position.uncertaintyM;
      marker.bindTooltip(item.file.filename);
      // Shift-click toggles multi-select (SPEC §6.5) without touching the detail
      // panel's single selection; a plain click does the opposite — replaces the
      // detail panel's selection and clears whatever was multi-selected.
      marker.on('click', (e) => {
        if (e.originalEvent.shiftKey) toggleMultiSelected(item.file.id);
        else handleSelectOne(item.file.id);
      });
      // Dragging deliberately does not auto-confirm (SPEC §6.5): it only sets the
      // file's own position and stays unconfirmed (red) — it does not anchor its
      // neighbours until confirmed (§5.5). Deliberately no state changes on
      // `dragstart`/`drag` (selecting the file, clearing multi-select): that would
      // rebuild the marker layer mid-gesture and abort the drag — see `handleDragEnd`,
      // which does both once the drag has actually finished instead.
      const startedAt = L.latLng(item.position.lat as number, item.position.lon as number);

      // SPEC §5.6's ghost: re-dragging a file that already has a known position
      // (camera GPS or confirmed) leaves that old position marked — it is still what
      // places everyone else — with a thin line to where the file is now. A file
      // already mid-drag from an *earlier* gesture (source 'manual', `anchorLat` set)
      // already has this ghost drawn below from server state; this branch instead
      // covers the *first* drag of an already-known file, where the server hasn't
      // been told about the pending drag yet — the ghost has to appear locally, the
      // instant the drag starts, rather than waiting on that round trip.
      if (item.position.source === 'camera-gps' || item.position.source === 'confirmed') {
        let ghost: { line: L.Polyline; dot: L.CircleMarker } | null = null;
        marker.on('dragstart', () => {
          ghost = createGhost(ghosts, startedAt, startedAt, item.file.filename);
        });
        marker.on('drag', () => ghost?.line.setLatLngs([startedAt, marker.getLatLng()]));
        marker.on('dragend', () => {
          ghost?.line.remove();
          ghost?.dot.remove();
          ghost = null;
        });
      }

      marker.on('dragend', () => {
        const ll = marker.getLatLng();
        handleDragEnd(item.file.id, ll.lat, ll.lng, marker, startedAt);
      });
      cluster.addLayer(marker);
      markers.push(markerWithFile);

      if (item.position.anchorLat !== null && item.position.anchorLon !== null) {
        const anchorLatLng = L.latLng(item.position.anchorLat, item.position.anchorLon);
        const liveLatLng = L.latLng(item.position.lat as number, item.position.lon as number);
        const ghost = createGhost(ghosts, anchorLatLng, liveLatLng, item.file.filename);
        // Follow the marker while it's being re-dragged so the line doesn't point at
        // the file's old (pre-drag) spot until the state update on `dragend` catches
        // up — Leaflet fires 'drag' continuously during the gesture, same as it does
        // for the marker's own live position.
        marker.on('drag', () => ghost.line.setLatLngs([anchorLatLng, marker.getLatLng()]));
      }
    }

    markersRef.current = markers;

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
  }, [visibleOnMap, path, showCircles]);

  // Selection highlighting is applied in place, not by rebuilding the marker layer
  // above: `Marker.setIcon`/`DivIcon.createIcon` reuse the existing DOM node instead
  // of replacing it, so this is cheap and — critically — doesn't touch the node
  // Leaflet's own Draggable has live listeners on, which a full rebuild does. That
  // full rebuild used to run on every click (both `selectedId` and `multiSelected`
  // were in the effect above's dependency array), which caused two different bugs:
  // starting a drag from an unselected marker tore the marker out from under its own
  // in-progress drag (it would move a pixel, then the rebuild would replace it and
  // the gesture died), and repeated selection changes on clustered stacks left
  // visual artifacts from destroying and recreating the whole cluster group rapidly.
  // `refreshClusters()` is the library's own supported way to refresh a cluster's
  // icon without tearing the group down.
  useEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster) return;
    for (const marker of markersRef.current) {
      const fileId = marker.geotaggerFileId;
      const borderClass = marker.geotaggerBorderClass;
      const size = marker.geotaggerSize;
      if (fileId === undefined || borderClass === undefined || size === undefined) continue;
      marker.setIcon(thumbIcon(fileId, size, borderClass, fileId === selectedId, multiSelected.has(fileId)));
    }
    cluster.refreshClusters();
  }, [selectedId, multiSelected]);

  return (
    <section className="map-view">
      <div className="view-actions">
        <button type="button" className="ghost" onClick={onBack}>
          ← Back
        </button>
        <button type="button" className="ghost" onClick={onOpenPersist}>
          Persist changes…
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
        <label className="map-toggle">
          <input type="checkbox" checked={showUnconfirmed} onChange={(e) => setShowUnconfirmed(e.target.checked)} />
          Unconfirmed
        </label>
        <label className="map-toggle">
          <input type="checkbox" checked={showAppModified} onChange={(e) => setShowAppModified(e.target.checked)} />
          App-modified
        </label>
        <label className="map-toggle">
          <input type="checkbox" checked={showUnpersisted} onChange={(e) => setShowUnpersisted(e.target.checked)} />
          Unpersisted
        </label>
        {multiSelected.size > 0 && (
          <div className="multi-select-bar">
            <span>{multiSelected.size} selected</span>
            {confirmableSelected.length > 0 && (
              <button type="button" className="confirm" disabled={busy} onClick={handleBulkConfirm}>
                Confirm selection
              </button>
            )}
            <button type="button" className="ghost" disabled={busy} onClick={clearMultiSelected}>
              Clear
            </button>
          </div>
        )}
        <div className="map-legend">
          <span className="legend-swatch known" /> known position
          <span className="legend-swatch unconfirmed" /> unconfirmed estimate
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="map-layout">
        <div
          className="map-container"
          ref={containerRef}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleTrayDrop}
        />
        {tray.length > 0 && <Tray items={tray} selectedId={selectedId} onSelect={handleSelectOne} />}
        <DetailPanel
          file={selected?.file ?? null}
          position={selected?.position ?? null}
          timelineFile={selected?.timelineFile ?? null}
          onConfirm={handleConfirm}
          onRevert={handleRevert}
          onReset={handleReset}
          busy={busy}
          multiSelectedItems={multiSelectedItems}
          onSelectOne={handleSelectOne}
        />
      </div>
    </section>
  );
}

/**
 * Files with no derivable position (SPEC §6.4): fewer than two anchors in the whole
 * folder, or no capture time of their own. Dragging one onto the map sets its
 * position (handled by `handleTrayDrop` on the map container, the same
 * `dragPosition` route a marker drag uses) — confirming it is what then makes it an
 * anchor (§5.5).
 */
function Tray({
  items,
  selectedId,
  onSelect,
}: {
  items: MapItem[];
  selectedId: FileId | null;
  onSelect: (fileId: FileId) => void;
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
            draggable
            onDragStart={(e) => e.dataTransfer.setData('text/plain', String(file.id))}
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
  geotaggerFileId?: FileId;
  geotaggerBorderClass?: 'known' | 'unconfirmed';
  /** The marker's `[width, height]` in pixels, from `markerSize` (SPEC §6.3). */
  geotaggerSize?: [number, number];
  geotaggerUncertaintyM?: number | null;
};

/** Green for a known position (camera GPS or confirmed), red for anything derived or not yet confirmed (SPEC §6.5). */
function borderClassFor(source: ComputedPosition['source']): 'known' | 'unconfirmed' {
  return source === 'camera-gps' || source === 'confirmed' ? 'known' : 'unconfirmed';
}

/** SPEC §5.6's ghost: the faint marker at a file's old position plus the thin line to its new one. */
function createGhost(
  ghosts: L.LayerGroup,
  anchor: L.LatLng,
  live: L.LatLng,
  filename: string,
): { line: L.Polyline; dot: L.CircleMarker } {
  const line = L.polyline([anchor, live], { color: '#666666', weight: 1.5, dashArray: '4 4', opacity: 0.8 }).addTo(
    ghosts,
  );
  const dot = L.circleMarker(anchor, { radius: 8, color: '#666666', weight: 2, fillColor: '#ffffff', fillOpacity: 0.7 })
    .bindTooltip(`${filename} — previous position`)
    .addTo(ghosts);
  return { line, dot };
}

/**
 * Selection highlight (SPEC §6.3) is a ring layered on top of the border colour, not a replacement for it.
 * Leaflet centres the icon on its point from `iconSize` alone, so a non-square `size` needs no anchor of its own.
 */
function thumbIcon(
  fileId: FileId,
  size: [number, number],
  borderClass: 'known' | 'unconfirmed',
  selected: boolean,
  multiSelected: boolean,
): L.DivIcon {
  const classes = ['map-thumb-icon', borderClass];
  if (selected) classes.push('selected');
  if (multiSelected) classes.push('multi-selected');
  return L.divIcon({
    className: classes.join(' '),
    html: `<img src="/api/files/${fileId}/thumb" loading="lazy" />`,
    iconSize: size,
  });
}

/**
 * SPEC §6.3: "a badge showing the count over a representative thumbnail" — the
 * first member's, shaped the same as that member's own marker. The border takes
 * the worst of the cluster's members — green only if every one of them is a known
 * position, red if even one is an unconfirmed estimate — so collapsing a mixed
 * group never hides that some of it still needs confirming.
 *
 * Selection highlights (§6.3, §6.5) carry through the same way: a stack that
 * contains the detail panel's selection, or any multi-selected file, shows that
 * ring on the cluster icon too — collapsing a stack should not make a selected file
 * look deselected.
 */
function clusterIcon(markers: L.Marker[], selectedId: FileId | null, multiSelected: Set<FileId>): L.DivIcon {
  const withFile = markers as MarkerWithFile[];
  const first = withFile[0];
  const fileId = first?.geotaggerFileId;
  const borderClass = withFile.some((m) => m.geotaggerBorderClass === 'unconfirmed') ? 'unconfirmed' : 'known';
  const classes = ['map-cluster-icon', borderClass];
  if (withFile.some((m) => m.geotaggerFileId === selectedId)) classes.push('selected');
  if (withFile.some((m) => m.geotaggerFileId !== undefined && multiSelected.has(m.geotaggerFileId))) {
    classes.push('multi-selected');
  }
  return L.divIcon({
    className: classes.join(' '),
    html: `<img src="/api/files/${fileId}/thumb" loading="lazy" /><span class="cluster-count">${markers.length}</span>`,
    iconSize: first?.geotaggerSize ?? [THUMB_SIZE_PX, THUMB_SIZE_PX],
  });
}
