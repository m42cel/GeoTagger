import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import * as L from 'leaflet';
import 'leaflet.markercluster';
import 'leaflet-polylinedecorator';
import { GeodesicLine } from 'leaflet.geodesic';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import type {
  BasePosition,
  ComputedPosition,
  FileId,
  FileRecord,
  FilesResponse,
  LatLon,
  TimelineFile,
  TimelineResponse,
} from '@geotagger/shared';
import { canConfirm, groupByMode, shownPosition } from '@geotagger/shared';
import { api } from '../api.js';
import { errorText } from '../App.js';
import { DetailPanel } from './DetailPanel.js';
import { borderClassFor } from './marker-status.js';
import { markerSize } from './marker-size.js';
import { hasEstimateWithoutOwnAnchor, resetTarget } from './reset-target.js';
import { isShown, STATUS_FILTERS, type StatusFilter } from './filters.js';
import { pathSegments, pathVertices, segmentTooltip, speedColor, type PathSegment } from './path.js';

/**
 * The map view (SPEC §5, §6.3, §7, §6.5): every file plotted at its known or
 * interpolated position, clustered, with a path line and uncertainty circles.
 * Selecting a thumbnail shows the detail panel; dragging a marker or using the
 * panel's confirm/discard move/reset buttons edits its position (SPEC §5.6). A dragged
 * file draws a ghost at its own position — its anchor, still placing everyone else,
 * or its estimate — connected by a thin line to where it is now, until the drag is
 * confirmed or discarded.
 *
 * Editing is wired the same way the alignment view's mutations are: every edit posts
 * to the server and replaces local state with the response it sends back, rather
 * than predicting the recomputation (SPEC §5.5) itself.
 *
 * Multi-select (SPEC §6.5) is shift-click to toggle one marker at a time, or a
 * shift+drag rubber band to select every marker inside the box, independent of the
 * single `selectedId` the detail panel shows — it exists only to batch-confirm a
 * selection at once (§6.5's "confirm the selection together"), not to drag or discard
 * a group, so it carries no per-file detail of its own.
 */

const THUMB_SIZE_PX = 48;

interface MapItem {
  file: FileRecord;
  position: ComputedPosition;
  timelineFile: TimelineFile | null;
}

type BaseLayerId = 'osm' | 'esri';

/** How far past the view, as a fraction of its size, vector layers stay drawn while panning. */
const RENDERER_PADDING = 1.5;
const GHOST_PANE = 'ghosts';

const BASE_LAYERS: Record<BaseLayerId, { url: string; attribution: string; maxZoom: number }> = {
  osm: {
    url: '/tiles/osm/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  esri: {
    url: '/tiles/esri/{z}/{x}/{y}.png',
    attribution: 'Imagery &copy; Esri',
    maxZoom: 19,
  },
};

export function MapView({
  focusFileId,
  writeCount,
  onBack,
  onOpenAlignment,
  onOpenPersist,
}: {
  /** A file to open on: zoomed to and selected. */
  focusFileId: FileId | null;
  /** Changes after each write to the files, which this view then refetches. */
  writeCount: number;
  onBack: () => void;
  onOpenAlignment: () => void;
  onOpenPersist: () => void;
}) {
  const [filesResp, setFilesResp] = useState<FilesResponse | null>(null);
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // SPEC §6.3 filters: visibility-only, everything shown by default. A group is the
  // grouping mode's subfolder or device, whatever its strips and lanes; groups are kept as
  // the hidden ones so a group that appears later (a regroup) shows.
  const [hiddenGroups, setHiddenGroups] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState<StatusFilter>('all');
  const [satellite, setSatellite] = useState(false);
  const [speedColors, setSpeedColors] = useState(false);
  const [selectedId, setSelectedId] = useState<FileId | null>(focusFileId);
  const [multiSelected, setMultiSelected] = useState<Set<FileId>>(new Set());
  const [busy, setBusy] = useState(false);

  // Kept in sync with the state above on every render so the marker-rebuild effect
  // (below) can read the latest selection without depending on it — that effect only
  // needs to depend on the *data*, since selection highlighting is applied in place
  // by a separate, cheap effect further down instead of by rebuilding every marker.
  const speedColorsRef = useRef(speedColors);
  speedColorsRef.current = speedColors;
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
  }, [writeCount]);

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

  function handleDiscardMove(): void {
    if (selectedId !== null) void editPosition(() => api.discardMove(selectedId));
  }

  function handleReset(): void {
    if (selectedId !== null) void editPosition(() => api.resetPosition(selectedId));
  }

  function handleForceInterpolation(): void {
    if (selectedId !== null) void editPosition(() => api.forceInterpolation(selectedId));
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

  function toggleGroup(key: string): void {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
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
      position: positionById.get(file.id) ?? { fileId: file.id, base: null, pending: null },
      timelineFile: timelineById.get(file.id) ?? null,
    }));
  }, [filesResp, timeline]);

  const groups = useMemo(
    () => (timeline && filesResp ? groupByMode(timeline.groupingMode, filesResp.files, filesResp.devices) : []),
    [timeline, filesResp],
  );

  const onMap = useMemo(() => items.filter((i) => shownPosition(i.position) !== null), [items]);

  // SPEC §6.3 filters: visibility only — `onMap` (and `path`, derived from it below)
  // stay the full set, so the path line and anything else built from `onMap` are
  // unaffected by what's currently hidden. This is what markers actually get drawn
  // from.
  const visibleOnMap = useMemo(() => {
    const context = { unpersistedIds: new Set(filesResp?.unpersistedFileIds ?? []) };
    const hiddenFileIds = new Set(groups.filter((g) => hiddenGroups.has(g.key)).flatMap((g) => g.fileIds));
    const filters = { hiddenFileIds, status };
    return onMap.filter((i) => isShown(i, context, filters));
  }, [onMap, filesResp, groups, hiddenGroups, status]);

  const tray = useMemo(() => items.filter((i) => shownPosition(i.position) === null), [items]);
  const selected = useMemo(() => items.find((i) => i.file.id === selectedId) ?? null, [items, selectedId]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.file.id, i])), [items]);

  // Same eligibility as the single-file confirm button (SPEC §6.5): camera GPS and
  // an already-confirmed position with no drag on top are already anchors, with
  // nothing to confirm.
  // Filtering here — not just on the server — means the bar can hide the button
  // entirely when the selection has nothing confirmable in it, rather than showing
  // a button that would silently no-op on every selected file.
  const confirmableSelected = useMemo(
    () =>
      [...multiSelected].filter((id) => {
        const position = itemById.get(id)?.position;
        return position !== undefined && canConfirm(position);
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

  const path = useMemo(() => pathVertices(onMap), [onMap]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const ghostRendererRef = useRef<L.Renderer | undefined>(undefined);
  const baseLayersRef = useRef<Record<BaseLayerId, L.TileLayer> | null>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const circlesRef = useRef<L.LayerGroup | null>(null);
  const ghostsRef = useRef<L.LayerGroup | null>(null);
  const pathRef = useRef<L.LayerGroup | null>(null);
  const pathSegmentLinesRef = useRef<{ line: L.Polyline; segment: PathSegment }[]>([]);
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
    // The renderer only redraws vector layers (path line, circles, ghosts) once a pan
    // ends, and clips them to the view plus `padding` (a fraction of its size): the
    // default 0.1 leaves them cut off mid-pan, one and a half views on each side doesn't.
    const map = L.map(containerRef.current, {
      center: [20, 0],
      zoom: 2,
      boxZoom: false,
      renderer: L.svg({ padding: RENDERER_PADDING }),
    });
    // Ghosts (SPEC §5.6, §6.3) sit in a pane of their own between the overlay pane
    // (path line, arrowheads, circles: 400) and the markers (600), so they draw over
    // the line however often the arrowheads are re-added on pan. A pane gets its own
    // renderer, which needs the same padding as the map's.
    map.createPane(GHOST_PANE).style.zIndex = '450';
    ghostRendererRef.current = L.svg({ padding: RENDERER_PADDING, pane: GHOST_PANE });
    const layers = {
      osm: L.tileLayer(BASE_LAYERS.osm.url, { attribution: BASE_LAYERS.osm.attribution, maxZoom: BASE_LAYERS.osm.maxZoom }),
      esri: L.tileLayer(BASE_LAYERS.esri.url, { attribution: BASE_LAYERS.esri.attribution, maxZoom: BASE_LAYERS.esri.maxZoom }),
    };
    layers.osm.addTo(map);
    const switches = new L.Control({ position: 'topright' });
    switches.onAdd = () => {
      const row = L.DomUtil.create('div', 'map-switches');
      row.append(mapSwitch('Show track speed', setSpeedColors), mapSwitch('Satellite', setSatellite));
      return row;
    };
    switches.addTo(map);
    const legend = new L.Control({ position: 'bottomleft' });
    legend.onAdd = () => {
      const box = L.DomUtil.create('div', 'leaflet-bar map-legend');
      box.innerHTML =
        '<span class="legend-swatch known"></span> known position' +
        '<span class="legend-swatch unconfirmed"></span> unconfirmed position';
      return box;
    };
    legend.addTo(map);
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
    const [shown, hidden] = satellite ? [layers.esri, layers.osm] : [layers.osm, layers.esri];
    map.removeLayer(hidden);
    shown.addTo(map);
  }, [satellite]);

  // Restyled in place rather than by rebuilding the path, which the effect below only
  // does along with every marker.
  useEffect(() => {
    for (const { line, segment } of pathSegmentLinesRef.current) styleSegment(line, segment, speedColors);
  }, [speedColors]);

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
      const { base, pending } = item.position;
      const shown = shownPosition(item.position) as LatLon;
      const borderClass = borderClassFor(item.position);
      const size = markerSize(item.file.width, item.file.height, THUMB_SIZE_PX);
      const marker = L.marker([shown.lat, shown.lon], {
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
      // A dragged file's circle belongs to the estimate it is overriding, drawn on
      // its ghost below, not to where the drag has put it.
      markerWithFile.geotaggerUncertaintyM = pending === null ? (base?.uncertaintyM ?? null) : null;
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
      const startedAt = L.latLng(shown.lat, shown.lon);

      // SPEC §5.6's ghost: dragging a file leaves its own position marked — an
      // anchor because it still places everyone else, an estimate because it is
      // where the track still puts the file — with a thin line to where the file is
      // now. A file already mid-drag from an *earlier* gesture already has this ghost
      // drawn below from server state; this branch instead covers the *first* drag,
      // where the server hasn't been told about it yet — the ghost has to appear
      // locally, the instant the drag starts, rather than waiting on that round trip.
      if (pending === null && base !== null) {
        let ghost: { line: L.Polyline; dot: L.CircleMarker } | null = null;
        marker.on('dragstart', () => {
          ghost = createGhost(ghosts, ghostRendererRef.current, startedAt, startedAt, ghostTooltip(item.file.filename, base));
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

      if (pending !== null && base !== null) {
        const baseLatLng = L.latLng(base.lat, base.lon);
        const ghost = createGhost(ghosts, ghostRendererRef.current, baseLatLng, startedAt, ghostTooltip(item.file.filename, base));
        if (base.uncertaintyM !== null) uncertaintyCircle(baseLatLng, base.uncertaintyM).addTo(ghosts);
        // Follow the marker while it's being re-dragged so the line doesn't point at
        // the file's old (pre-drag) spot until the state update on `dragend` catches
        // up — Leaflet fires 'drag' continuously during the gesture, same as it does
        // for the marker's own live position.
        marker.on('drag', () => ghost.line.setLatLngs([baseLatLng, marker.getLatLng()]));
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
        circles.addLayer(uncertaintyCircle(center, maxUncertaintyM));
      }
    };

    cluster.on('animationend spiderfied unspiderfied', rebuildCircles);
    cluster.addTo(map);
    clusterRef.current = cluster;
    rebuildCircles();
    circles.addTo(map);
    circlesRef.current = circles;

    // A corner of the path whose file is filtered out keeps a small dot (SPEC §6.3),
    // so the line doesn't bend at nothing. Smaller than §5.6's re-drag ghost, which
    // means something else, and small enough that a dense run of hidden camera-GPS
    // photos just reads as a slightly heavier stretch of line.
    const visibleIds = new Set(visibleOnMap.map((i) => i.file.id));
    for (const vertex of path) {
      if (visibleIds.has(vertex.fileId)) continue;
      L.circleMarker([vertex.lat, vertex.lon], {
        radius: 3,
        color: '#666666',
        weight: 1,
        fillColor: '#ffffff',
        fillOpacity: 0.8,
        interactive: false,
        renderer: ghostRendererRef.current,
      }).addTo(ghosts);
    }
    ghosts.addTo(map);
    ghostsRef.current = ghosts;

    if (path.length > 1) {
      // Fixed rather than themed, like the marker borders: this sits on map imagery,
      // not the app background. Geodesic so each segment follows the same great
      // circle the estimates on it were placed along (SPEC §5.1). One line per
      // segment, so each can take the color of the speed it was travelled at.
      const segments = L.layerGroup();
      pathSegmentLinesRef.current = pathSegments(path).map((segment) => {
        const line = new GeodesicLine(
          [
            [segment.from.lat, segment.from.lon],
            [segment.to.lat, segment.to.lon],
          ],
          { weight: 2, opacity: 0.8 },
        );
        styleSegment(line, segment, speedColorsRef.current);
        line.addTo(segments);
        return { line, segment };
      });
      segments.addTo(map);
      pathRef.current = segments;

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
      //
      // Laid along the whole path rather than per segment, so the spacing runs on
      // across corners instead of restarting at each — short segments would otherwise
      // get none. The line itself is never added to the map, only measured.
      const whole = new GeodesicLine(path.map((v) => [v.lat, v.lon]));
      const arrows = L.polylineDecorator(whole, {
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
      pathSegmentLinesRef.current = [];
      pathArrowsRef.current = null;
    }

    if (!didFitRef.current && onMap.length > 0) {
      didFitRef.current = true;
      // A focus file that has no position, or is filtered out, opens on the whole trip.
      const focus = markers.find((m) => m.geotaggerFileId === focusFileId);
      if (focus) {
        map.setView(focus.getLatLng(), 16, { animate: false });
        cluster.zoomToShowLayer(focus);
      } else {
        const bounds = L.latLngBounds(
          onMap.map((i) => {
            const { lat, lon } = shownPosition(i.position) as LatLon;
            return [lat, lon];
          }),
        );
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      }
    }
  }, [visibleOnMap, path]);

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
      {/* Columns match `.map-layout`'s below, so the filters stay over the map. */}
      <div className="view-actions">
        <div className="map-filters">
          <div className="filter-group">
            <span className="filter-label">Status:</span>
            <div className="segmented" role="radiogroup" aria-label="Status">
              {STATUS_FILTERS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={status === id}
                  className={status === id ? 'on' : ''}
                  onClick={() => setStatus(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {/* With a single group, hiding it would just hide everything. */}
          {groups.length > 1 && (
            <div className="filter-group">
              <span className="filter-label">Show group:</span>
              <div className="toggle-chips">
                {groups.map(({ key, label }) => {
                  const on = !hiddenGroups.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={on}
                      className={`toggle-chip${on ? ' on' : ''}`}
                      onClick={() => toggleGroup(key)}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
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
        </div>
        {tray.length > 0 && <div className="tray-spacer" />}
        <div className="view-actions-end">
          <button type="button" className="ghost" onClick={onBack}>
            ← Back to overview
          </button>
          <button type="button" className="ghost" onClick={onOpenAlignment}>
            Fix timestamps
          </button>
          <button
            type="button"
            className="persist-button"
            disabled={!filesResp?.hasPendingChanges}
            onClick={onOpenPersist}
          >
            Persist changes
          </button>
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
          onDiscardMove={handleDiscardMove}
          onReset={handleReset}
          onForceInterpolation={handleForceInterpolation}
          resetTarget={selected ? resetTarget(selected.file, selected.timelineFile, items) : 'none'}
          canForceInterpolation={
            selected ? hasEstimateWithoutOwnAnchor(selected.file.id, selected.timelineFile, items) : false
          }
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

/** A switch in Leaflet's own control styling, so it reads as part of the map like the zoom buttons. */
function mapSwitch(text: string, onChange: (checked: boolean) => void): HTMLLabelElement {
  const label = L.DomUtil.create('label', 'leaflet-bar map-switch');
  const input = L.DomUtil.create('input', '', label);
  input.type = 'checkbox';
  input.setAttribute('role', 'switch');
  L.DomUtil.create('span', 'switch-track', label);
  label.append(text);
  L.DomEvent.on(input, 'change', () => onChange(input.checked));
  L.DomEvent.disableClickPropagation(label);
  return label;
}

/** SPEC §6.3: with track speed off, every segment is the plain line, with nothing on hover. */
function styleSegment(line: L.Polyline, segment: PathSegment, speedColors: boolean): void {
  line.setStyle({ color: speedColor(speedColors ? segment.speedKmh : null) });
  line.unbindTooltip();
  const tooltip = speedColors ? segmentTooltip(segment) : null;
  if (tooltip) line.bindTooltip(tooltip, { sticky: true });
}

function ghostTooltip(filename: string, base: BasePosition): string {
  return `${filename} — ${base.source === 'estimate' ? 'estimated position' : 'previous position'}`;
}

/** SPEC §5.2's faint circle. */
function uncertaintyCircle(center: L.LatLng, radiusM: number): L.Circle {
  return L.circle(center, { radius: radiusM, color: '#d1453b', weight: 1, fillOpacity: 0.08, opacity: 0.35 });
}

/** SPEC §5.6's ghost: the faint marker at a dragged file's own position plus the thin line to the drag. */
function createGhost(
  ghosts: L.LayerGroup,
  renderer: L.Renderer | undefined,
  anchor: L.LatLng,
  live: L.LatLng,
  filename: string,
): { line: L.Polyline; dot: L.CircleMarker } {
  const line = L.polyline([anchor, live], {
    color: '#666666',
    weight: 1.5,
    dashArray: '4 4',
    opacity: 0.8,
    renderer,
  }).addTo(ghosts);
  const dot = L.circleMarker(anchor, {
    radius: 8,
    color: '#666666',
    weight: 2,
    fillColor: '#ffffff',
    fillOpacity: 0.7,
    renderer,
  })
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
