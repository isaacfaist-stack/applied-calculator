// Touch-friendly polygon editor on the Leaflet map.
//  - drawing a new ring: tap the map to add corners
//  - drag a corner to move it, tap a corner to remove it
//  - tap (or drag) the small handle between two corners to add one there
//  - every change can be undone

import L from 'leaflet';

export interface EditorOptions {
  /** Tapping the map appends a corner (new boundary / exclusion). */
  appendOnMapTap: boolean;
  color: string;
  onChange: (points: L.LatLng[]) => void;
}

const vertexIcon = L.divIcon({ className: 'edit-vertex', iconSize: [30, 30] });
const midIcon = L.divIcon({ className: 'edit-mid', iconSize: [26, 26] });

export class PolygonEditor {
  private pts: L.LatLng[];
  private history: L.LatLng[][] = [];
  private group = L.layerGroup();
  private shape: L.Path | null = null;
  private dragging = false;

  constructor(
    private map: L.Map,
    initial: L.LatLng[],
    private opts: EditorOptions,
  ) {
    this.pts = initial.map((p) => L.latLng(p.lat, p.lng));
    this.group.addTo(map);
    map.on('click', this.onMapClick);
    this.render();
  }

  get points(): L.LatLng[] {
    return this.pts.slice();
  }

  undo() {
    const prev = this.history.pop();
    if (!prev) return;
    this.pts = prev;
    this.render();
  }

  canUndo(): boolean {
    return this.history.length > 0;
  }

  destroy() {
    this.map.off('click', this.onMapClick);
    this.group.remove();
  }

  private snapshot() {
    this.history.push(this.pts.map((p) => L.latLng(p.lat, p.lng)));
    if (this.history.length > 200) this.history.shift();
  }

  private onMapClick = (e: L.LeafletMouseEvent) => {
    if (!this.opts.appendOnMapTap || this.dragging) return;
    this.snapshot();
    this.pts.push(e.latlng);
    this.render();
  };

  private redrawShape() {
    const style = { color: this.opts.color, weight: 3, fillOpacity: 0.15, interactive: false };
    if (this.shape) this.shape.remove();
    const shape: L.Path =
      this.pts.length >= 3 ? L.polygon(this.pts, style) : L.polyline(this.pts, { ...style, dashArray: '6 6' });
    shape.addTo(this.group);
    shape.bringToBack();
    this.shape = shape;
  }

  private render() {
    this.group.clearLayers();
    this.shape = null;
    this.redrawShape();
    const n = this.pts.length;

    this.pts.forEach((p, i) => {
      const m = L.marker(p, { icon: vertexIcon, draggable: true, keyboard: false, zIndexOffset: 1000 });
      m.on('dragstart', () => {
        this.dragging = true;
        this.snapshot();
      });
      m.on('drag', () => {
        this.pts[i] = m.getLatLng();
        this.redrawShape();
      });
      m.on('dragend', () => {
        this.pts[i] = m.getLatLng();
        // Leaflet fires a map click right after some drags; ignore it.
        setTimeout(() => (this.dragging = false), 50);
        this.render();
      });
      m.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev);
        if (this.pts.length <= 3 && !this.opts.appendOnMapTap) return;
        this.snapshot();
        this.pts.splice(i, 1);
        this.render();
      });
      m.addTo(this.group);
    });

    // Midpoint handles (closing edge only once it's a polygon).
    const edges = n >= 3 ? n : n - 1;
    for (let i = 0; i < edges; i++) {
      const a = this.pts[i];
      const b = this.pts[(i + 1) % n];
      const mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
      const m = L.marker(mid, { icon: midIcon, draggable: true, keyboard: false, zIndexOffset: 500 });
      let inserted = false;
      const insert = () => {
        if (inserted) return;
        inserted = true;
        this.snapshot();
        this.pts.splice(i + 1, 0, m.getLatLng());
      };
      m.on('dragstart', () => {
        this.dragging = true;
        insert();
      });
      m.on('drag', () => {
        this.pts[i + 1] = m.getLatLng();
        this.redrawShape();
      });
      m.on('dragend', () => {
        setTimeout(() => (this.dragging = false), 50);
        this.render();
      });
      m.on('click', (ev) => {
        L.DomEvent.stopPropagation(ev);
        insert();
        this.render();
      });
      m.addTo(this.group);
    }
    this.opts.onChange(this.points);
  }
}
