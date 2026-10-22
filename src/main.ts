import 'leaflet/dist/leaflet.css';
import './styles.css';
import L from 'leaflet';
import { registerSW } from 'virtual:pwa-register';

import { M_PER_FT, SQ_M_PER_ACRE, ringArea } from './engine/geometry';
import { simplifyRing } from './engine/plan';
import { makeProjection } from './engine/projection';
import type { CornerStyle, ShutoffMode } from './engine/plan';
import {
  type ChangePart,
  type DensityReading,
  type Ingredient,
  adviseRate,
  averageCalibration,
  checkJob,
  densityFor,
  ingredientKey,
  learnDensities,
  predictDensity,
  splitChange,
  trackingFor,
} from './engine/rate';
import { type ExclusionKind, type LocalField, distanceMiles, geometryCenter, geometryRings, pointInGeometry, toLocalField } from './fieldModel';
import { fetchRemoteBoundary, listRemoteFields } from './integrations/boundaryServer';
import { type BoundaryGeometry, importFiles } from './io/import';
import { type Ticket, importTicket } from './io/ticket';
import { type OpsReport, combineReports, importOpsReport } from './io/jdReport';
import { PolygonEditor } from './map/editor';
import {
  GoogleMapsError,
  clearGoogleSession,
  createGoogleLayer,
  explainGoogleError,
  testGoogleKey,
} from './map/googleTiles';
import type { PlanRequest, PlanResponse } from './planWorker';
import { DEMO_FIELD } from './demoField';
import { HELP } from './help';
import { type CalibrationRecord, type FieldRecord, type Imagery, type MachineRecord, type Settings, DEFAULT_MACHINES, store, uid } from './store';

registerSW({ immediate: true });

// ---------------------------------------------------------------------------
// DOM helpers

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const fmt = (n: number, d = 1) =>
  Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '–';
const fmtPct = (f: number, d = 1) => `${f >= 0 ? '+' : '−'}${fmt(Math.abs(f * 100), d)}%`;
const fmtQty = (n: number, unit: string) => `${fmt(n, Math.abs(n) >= 100 ? 0 : 1)} ${unit}`;

function num(input: HTMLInputElement): number | undefined {
  const v = parseFloat(input.value);
  return Number.isFinite(v) ? v : undefined;
}

let toastTimer = 0;
function toast(msg: string, error = false) {
  const t = $('toast');
  // An open window sits above everything else, so show the message inside it.
  const host = document.querySelector<HTMLDialogElement>('dialog[open]') ?? document.body;
  if (t.parentElement !== host) host.appendChild(t);
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), error ? 6000 : 3000);
}

function setSeg(id: string, value: string) {
  for (const b of $(id).querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(b.dataset.v === value));
  }
}

function onSeg(id: string, fn: (v: string) => void) {
  $(id).addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (b?.dataset.v) fn(b.dataset.v);
  });
}

// ---------------------------------------------------------------------------
// State

let settings: Settings = store.settings();
let fields: FieldRecord[] = store.fields();
let machines: MachineRecord[] = store.machines();
/** First selected field; single-field tools (edit, rename) act on it. */
let activeField: FieldRecord | null = null;

/** One selected field, its local geometry, and its plan once computed. */
interface PlanEntry {
  field: FieldRecord;
  local: LocalField;
  result: PlanResponse | null;
}
/** Selected fields. Several are planned separately and totaled as one job. */
let entries: PlanEntry[] = [];

/** Sums over every selected field's plan; null until all are planned. */
interface PlanTotals {
  surfaceM2: number;
  appliedM2: number;
  headlandAppliedM2: number;
  passAppliedM2: number;
  passCount: number;
  onDistanceM: number;
  speedChanges: number;
  coverage: { singleM2: number; overlapAreaM2: number; overlapExtraM2: number; skipM2: number; offFieldM2: number };
}
let result: PlanTotals | null = null;

function computeTotals(): PlanTotals | null {
  if (!entries.length || entries.some((e) => !e.result)) return null;
  const t: PlanTotals = {
    surfaceM2: 0,
    appliedM2: 0,
    headlandAppliedM2: 0,
    passAppliedM2: 0,
    passCount: 0,
    onDistanceM: 0,
    speedChanges: 0,
    coverage: { singleM2: 0, overlapAreaM2: 0, overlapExtraM2: 0, skipM2: 0, offFieldM2: 0 },
  };
  for (const { result: r } of entries) {
    t.surfaceM2 += r!.surfaceM2;
    t.appliedM2 += r!.appliedM2;
    t.headlandAppliedM2 += r!.headlandAppliedM2;
    t.passAppliedM2 += r!.passAppliedM2;
    t.passCount += r!.passCount;
    t.onDistanceM += r!.onDistanceM;
    t.speedChanges += r!.speedChanges;
    for (const k of Object.keys(t.coverage) as (keyof PlanTotals['coverage'])[]) t.coverage[k] += r!.coverage[k];
  }
  return t;
}
let gps: [number, number] | null = null;
let showCoverage = true;
/** Density the app last told the operator to program (density mode). */
let recommendedDensity: number | undefined;

type EditMode = 'new' | 'edit' | 'hole';
/** What an edit changes: a field part's outline, or one of its exclusions. */
interface EditTarget {
  part: number;
  hole?: number;
}
let editSession: { mode: EditMode; fieldId?: string; editor: PolygonEditor; target?: EditTarget } | null = null;
let newHoleKind: ExclusionKind = 'drive';

const plan = {
  laps: 2,
  headingMode: 'longest' as 'longest' | 'optimized' | 'manual',
  headingDeg: 0,
};

function activeMachine(): MachineRecord {
  return machines.find((m) => m.id === settings.activeMachineId) ?? machines[0] ?? DEFAULT_MACHINES[0];
}

/** Active machine's bias as a fraction (+0.03 = puts out 3% more). */
function machineBias(): number {
  return (activeMachine().biasPct ?? 0) / 100;
}

/** Density adjustment only makes sense for dry product sold by weight. */
function isDryUnit(unit: string): boolean {
  return unit === 'lb' || unit === 'ton';
}

function densityMode(): boolean {
  return settings.product.adjustBy === 'density' && isDryUnit(settings.product.unit);
}

/** Active machine's achieved ÷ requested rate (0.96 = averages 4% under). */
/** Speed changes per mile with product on, for the current plan. */
function changesPerMile(): number | undefined {
  return result && result.onDistanceM > 0 ? result.speedChanges / (result.onDistanceM / 1609.344) : undefined;
}

/** Achieved ÷ requested for this machine on the planned field(s). */
function machineTracking(): number {
  const m = activeMachine();
  const cpm = changesPerMile();
  if (m.trackingModel && cpm !== undefined) return trackingFor(m.trackingModel, cpm);
  const t = m.trackingPct;
  return t && t > 0 ? t / 100 : 1;
}

let densityReadings: DensityReading[] = store.densityReadings();

/** Learned density for a blend, when it's mostly products you've cup-checked. */
function learnedDensity(ings: Ingredient[] | undefined) {
  if (!ings?.length || !densityReadings.length) return null;
  const p = predictDensity(learnDensities(densityReadings, ings), ings);
  return p && p.coverage >= 0.9 ? p : null;
}

function addDensityReading(ings: Ingredient[], density: number, label?: string) {
  densityReadings = [...densityReadings, { id: uid(), date: Date.now(), label, ingredients: ings, density }];
  store.saveDensityReadings(densityReadings);
}

function saveSettings() {
  store.saveSettings(settings);
}

function saveFieldPrefs() {
  if (!entries.length) return;
  for (const { field } of entries) {
    field.prefs = {
      machineId: activeMachine().id,
      headlandLaps: plan.laps,
      // A combined job's heading is per field, so only a manual one is shared.
      headingDeg: entries.length === 1 || plan.headingMode === 'manual' ? plan.headingDeg : field.prefs?.headingDeg,
      headingMode: plan.headingMode,
    };
  }
  store.saveFields(fields);
}

// ---------------------------------------------------------------------------
// Theme

function applyTheme() {
  if (settings.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  setSeg('themeSeg', settings.theme);
}

// ---------------------------------------------------------------------------
// Map

const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([41.6, -93.6], 6);
map.attributionControl.setPrefix(false);

const esriImagery = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { maxNativeZoom: 19, maxZoom: 21, attribution: 'Imagery © Esri' },
);
let baseLayer: L.TileLayer | null = null;
let baseRequest = 0;

const IMAGERY_NAMES: Record<Imagery, string> = {
  'google-satellite': 'Google satellite',
  'google-hybrid': 'Google satellite + roads',
  esri: 'Esri satellite',
};

function googleKey(): string {
  return (settings.googleKey || import.meta.env.VITE_GOOGLE_MAPS_API_KEY || '').trim();
}

/** Imagery actually shown: Google needs a key and a connection. */
function effectiveImagery(): Imagery {
  const want = settings.imagery ?? 'google-satellite';
  if (want !== 'esri' && (!googleKey() || !navigator.onLine)) return 'esri';
  return want;
}

async function setBaseLayer() {
  const req = ++baseRequest;
  const kind = effectiveImagery();
  let next: L.TileLayer = esriImagery;
  if (kind !== 'esri') {
    try {
      next = await createGoogleLayer(map, googleKey(), kind === 'google-hybrid' ? 'hybrid' : 'satellite');
    } catch (err) {
      const raw = err instanceof GoogleMapsError ? err.googleMessage : (err as Error).message;
      toast(`Google imagery isn't available: ${explainGoogleError(raw)} Showing Esri imagery. (Settings → Test Google imagery for details.)`, true);
      next = esriImagery;
    }
  }
  if (req !== baseRequest) return;
  if (baseLayer && baseLayer !== next) baseLayer.remove();
  if (!map.hasLayer(next)) next.addTo(map).bringToBack();
  if (next !== esriImagery) {
    // A rejected session (bad or expired key) shows up as tile errors.
    let errors = 0;
    next.on('tileerror', () => {
      if (++errors === 8 && navigator.onLine) {
        clearGoogleSession();
        toast('Google imagery is not loading. Open Settings → Test Google imagery to see why.', true);
      }
    });
  }
  baseLayer = next;
}

window.addEventListener('online', () => void setBaseLayer());
window.addEventListener('offline', () => void setBaseLayer());

const layers = {
  fields: L.layerGroup().addTo(map),
  boundary: L.layerGroup().addTo(map),
  coverage: L.layerGroup().addTo(map),
  lines: L.layerGroup().addTo(map),
  gps: L.layerGroup().addTo(map),
};

function toLatLng([lon, lat]: [number, number]): L.LatLngExpression {
  return [lat, lon];
}

function fieldLatLngs(f: FieldRecord): L.LatLngExpression[][][] {
  return geometryRings(f.geometry).map((p) => p.map((r) => r.map(toLatLng)));
}

/** Active field in white; every other saved field outlined and tappable. */
function drawBoundary() {
  layers.boundary.clearLayers();
  layers.fields.clearLayers();
  const editing = !!editSession;
  const selected = new Set(entries.map((e) => e.field.id));
  for (const f of fields) {
    if (selected.has(f.id)) continue;
    const poly = L.polygon(fieldLatLngs(f), {
      color: '#fde047',
      weight: 2,
      opacity: 0.9,
      fillColor: '#fde047',
      fillOpacity: 0.08,
      interactive: !editing,
    });
    poly.bindTooltip(esc(f.name), { direction: 'center', className: 'field-label', permanent: map.getZoom() >= 14 });
    poly.on('click', () => {
      if (!editSession) selectField(f.id);
    });
    poly.addTo(layers.fields);
  }
  for (const { field } of entries) {
    if (editSession?.fieldId === field.id) continue;
    // Exclusions: dashed blue = drive through, shaded red = go around.
    const kinds = holeKindsOf(field);
    polygonsOf(field.geometry).forEach((p, i) =>
      p.slice(1).forEach((ring, j) => {
        const avoid = kinds[i][j] === 'avoid';
        L.polygon(openRing(ring), {
          color: avoid ? '#fca5a5' : '#93c5fd',
          weight: 2,
          dashArray: avoid ? undefined : '6 5',
          fill: avoid,
          fillColor: '#7f1d1d',
          fillOpacity: 0.45,
          interactive: false,
        }).addTo(layers.boundary);
      }),
    );
    const poly = L.polygon(fieldLatLngs(field), { color: '#ffffff', weight: 3, fill: false, interactive: false });
    if (entries.length > 1) {
      poly.bindTooltip(esc(field.name), { direction: 'center', className: 'field-label', permanent: map.getZoom() >= 14 });
    }
    poly.addTo(layers.boundary);
  }
}

// Field names are shown permanently only when zoomed in enough to read them.
let labelsPermanent = false;
map.on('zoomend', () => {
  const want = map.getZoom() >= 14;
  if (want !== labelsPermanent) {
    labelsPermanent = want;
    drawBoundary();
  }
});

function fitField() {
  if (!entries.length) return;
  const pts = entries.flatMap(({ field }) => geometryRings(field.geometry).flatMap((p) => p[0].map(toLatLng)));
  map.fitBounds(L.latLngBounds(pts as L.LatLngTuple[]), { padding: [24, 24] });
}

let coverageUrls: string[] = [];
let drawGeneration = 0;

function drawPlanLayers() {
  layers.coverage.clearLayers();
  layers.lines.clearLayers();
  for (const u of coverageUrls) URL.revokeObjectURL(u);
  coverageUrls = [];
  const gen = ++drawGeneration;
  if (!result) return;
  for (const { local, result: r } of entries) {
    if (!r) continue;
    const proj = local.proj;
    const ll = (x: number, y: number) => toLatLng(proj.toLonLat({ x, y }));

    if (showCoverage) {
      const c = r.coverage;
      const canvas = document.createElement('canvas');
      canvas.width = c.cols;
      canvas.height = c.rows;
      const ctx = canvas.getContext('2d')!;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(c.rgba), c.cols, c.rows), 0, 0);
      const bounds = L.latLngBounds([
        ll(c.minX, c.minY) as L.LatLngTuple,
        ll(c.minX + c.cols * c.cell, c.minY + c.rows * c.cell) as L.LatLngTuple,
      ]);
      canvas.toBlob((blob) => {
        if (!blob || gen !== drawGeneration || !showCoverage) return;
        const url = URL.createObjectURL(blob);
        coverageUrls.push(url);
        L.imageOverlay(url, bounds, { opacity: 0.85, interactive: false }).addTo(layers.coverage);
      });
    }

    const headland = r.headlandPaths.map((ring) => [...ring, ring[0]].map((p) => ll(p.x, p.y)));
    L.polyline(headland as L.LatLngExpression[][], { color: '#fde047', weight: 1.5, opacity: 0.9, interactive: false }).addTo(
      layers.lines,
    );
    const passes = r.passLines.map(([pa, pb]) => [ll(pa.x, pa.y), ll(pb.x, pb.y)]);
    L.polyline(passes as L.LatLngExpression[][], {
      color: '#ffffff',
      weight: 1,
      opacity: 0.75,
      dashArray: '6 6',
      interactive: false,
    }).addTo(layers.lines);
  }
  $('mapLegend').hidden = !showCoverage;
}

$('fitBtn').addEventListener('click', fitField);
$('layersBtn').addEventListener('click', () => {
  showCoverage = !showCoverage;
  $('layersBtn').setAttribute('aria-pressed', String(showCoverage));
  drawPlanLayers();
});
$('locateBtn').addEventListener('click', () => {
  if (gps) map.setView(toLatLng(gps), Math.max(map.getZoom(), 16));
  else toast('Waiting for GPS… (allow location access for this app)');
});

// ---------------------------------------------------------------------------
// GPS: show position and offer the field you're sitting in.

function startGps() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.watchPosition(
    (pos) => {
      gps = [pos.coords.longitude, pos.coords.latitude];
      layers.gps.clearLayers();
      L.circle(toLatLng(gps), { radius: pos.coords.accuracy, color: '#3b82f6', weight: 1, fillOpacity: 0.12 }).addTo(
        layers.gps,
      );
      L.circleMarker(toLatLng(gps), { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(
        layers.gps,
      );
      updateGpsChip();
    },
    () => {},
    { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
  );
}

function fieldAtGps(): FieldRecord | undefined {
  if (!gps) return undefined;
  return fields.find((f) => pointInGeometry(f.geometry, gps!));
}

function updateGpsChip() {
  const chip = $('gpsChip');
  const here = fieldAtGps();
  if (here && !entries.some((e) => e.field.id === here.id)) {
    chip.innerHTML = `You're in <b>${esc(here.name)}</b><button type="button" id="gpsOpen">Open</button>`;
    chip.hidden = false;
    $('gpsOpen').onclick = () => selectField(here.id);
  } else {
    chip.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Planning (in a worker)

const worker = new Worker(new URL('./planWorker.ts', import.meta.url), { type: 'module' });
let reqId = 0;
let planTimer = 0;
/** Outstanding requests of the current batch: request id → entry index. */
let pending = new Map<number, number>();

worker.onmessage = (e: MessageEvent<PlanResponse>) => {
  const r = e.data;
  const idx = pending.get(r.id);
  if (idx === undefined) return; // stale
  pending.delete(r.id);
  const entry = entries[idx];
  if (r.error) {
    toast(`Couldn't plan ${entry?.field.name ?? 'this field'}: ${r.error}`, true);
  } else if (entry) {
    entry.result = r;
  }
  if (pending.size) return;
  $('computing').hidden = true;
  result = computeTotals();
  if (plan.headingMode !== 'manual' && entries.length === 1 && entries[0].result) {
    plan.headingDeg = entries[0].result.headingDeg;
  }
  syncHeadingUi();
  drawPlanLayers();
  renderResults();
};

function schedulePlan() {
  clearTimeout(planTimer);
  if (!entries.length) return;
  $('computing').hidden = false;
  planTimer = window.setTimeout(() => {
    const m = activeMachine();
    pending = new Map();
    entries.forEach((entry, i) => {
      const id = ++reqId;
      pending.set(id, i);
      const req: PlanRequest = {
        id,
        fieldKey: entry.field.id + ':' + entry.field.updatedAt,
        polys: entry.local.polys,
        avoid: entry.local.avoid,
        widthM: m.widthFt * M_PER_FT,
        sections: m.sections,
        headlandLaps: plan.laps,
        cornerStyle: m.cornerStyle,
        shutoff: m.shutoff,
        headingMode: plan.headingMode,
        headingDeg: plan.headingDeg,
      };
      worker.postMessage(req);
    });
  }, 120);
}

// ---------------------------------------------------------------------------
// Results

// ---------------------------------------------------------------------------
// Collapsible sections: remember which are open, and show a one-line summary
// on each so a closed section still says what it's set to.

const FOLD_KEY = 'aac.folds.v1';
function restoreFolds() {
  let saved: Record<string, boolean> = {};
  try {
    saved = JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}');
  } catch {
    /* defaults from the markup */
  }
  for (const d of document.querySelectorAll<HTMLDetailsElement>('details.fold')) {
    if (d.id in saved) d.open = saved[d.id];
    d.addEventListener('toggle', () => {
      saved[d.id] = d.open;
      try {
        localStorage.setItem(FOLD_KEY, JSON.stringify(saved));
      } catch {
        /* not remembered this time */
      }
    });
  }
}

const HEADING_LABELS = { longest: 'longest side', optimized: 'least overlap', manual: 'manual' } as const;
const SHUTOFF_LABELS: Record<ShutoffMode, string> = { noskip: 'no skips', center: 'center', nooverlap: 'least overlap' };

function updateSummaries() {
  const p = settings.product;
  const m = activeMachine();
  const product = [p.rate > 0 ? `${fmt(p.rate, p.rate >= 100 ? 0 : 1)} ${p.unit}/ac` : 'no rate yet'];
  if (p.loaded) product.push(p.loadedAs === 'acres' ? `${fmt(p.loaded, 2)} acres' worth` : fmtQty(p.loaded, p.unit));
  product.push(densityMode() ? `density${p.density ? ` ${fmt(p.density, 1)}` : ''}` : 'by rate');
  $('productSummary').textContent = product.join(' · ');
  const j = settings.job;
  $('fieldBtnLabel').textContent = j?.ticketNo ? `Ticket ${j.ticketNo}${j.grower ? ` · ${j.grower}` : ''}` : entries.length > 1 ? 'Fields' : 'Field';
  $('jobTag').hidden = !j;
  if (j) {
    const who = [j.grower, j.fieldName].filter(Boolean).join(' – ');
    $('jobTag').innerHTML =
      `<strong>${j.ticketNo ? `Ticket ${esc(j.ticketNo)}` : 'Blend ticket'}</strong>${who ? ` · ${esc(who)}` : ''}` +
      `${j.acres ? ` · ${fmt(j.acres, 2)} ac on ticket` : ''}` +
      `${j.products?.length ? `<span class="muted small">${esc(j.products.join(' + '))}</span>` : ''}` +
      (j.finishedAt
        ? `<span class="job-done">✓ Finished and logged ${new Date(j.finishedAt).toLocaleDateString()}</span>`
        : `<button class="btn small-btn primary job-finish" type="button" data-action="finish-job">Finish job</button>`);
  }

  $('planSummary').textContent = [
    `${plan.laps} headland lap${plan.laps === 1 ? '' : 's'}`,
    plan.headingMode === 'manual' ? `${fmt(plan.headingDeg, 0)}°` : HEADING_LABELS[plan.headingMode],
    SHUTOFF_LABELS[m.shutoff],
  ].join(' · ');


  $('breakdownSummary').textContent = result
    ? `${fmtPct(result.appliedM2 / result.surfaceM2 - 1)} overlap · ${fmt(result.coverage.overlapAreaM2 / SQ_M_PER_ACRE)} ac doubled`
    : '';
  const acres = result
    ? result.surfaceM2 / SQ_M_PER_ACRE
    : entries.reduce((sum, e) => sum + e.local.acres, 0);
  const names = entries.map((e) => e.field.name);
  $('fieldSummary').textContent = entries.length
    ? `${entries.length > 1 ? `${entries.length} fields` : names[0]} · ${fmt(acres)} ac`
    : 'not chosen';
  $('fieldCurrent').innerHTML = entries.length
    ? `<strong>${esc(names.join(' + '))}</strong> · ${fmt(acres)} ac${entries.length === 1 && entries[0].field.grower ? ` · ${esc(entries[0].field.grower)}` : ''}`
    : 'No field chosen yet. Tap the field name at the top to load a blend ticket or pick a field.';

  // Step badges and the empty-state checklist.
  const done1 = entries.length > 0;
  const done2 = p.rate > 0 && (!densityMode() || !!(p.density && p.density > 0));
  const done3 = done1 && !!result;
  [done1, done2, done3].forEach((d, i) => {
    $(`step${i + 1}`).classList.toggle('done', d);
    $(`step${i + 1}`).textContent = d ? '✓' : String(i + 1);
    $(`ck${i + 1}`).classList.toggle('done', d);
  });
}

/**
 * "Why" under the answer: how much of the change comes from the ticket's
 * product vs. the boundary, from overlap, and from machine corrections.
 * Each part is shown as its own change to the setting; they multiply to the total.
 */
function renderWhy(parts: ChangePart[] | null, ctx: { byDensity: boolean; surfaceAc: number; appliedAc: number; rate: number; loaded?: number; total: number }) {
  const box = $('answerWhy');
  const shown = parts?.filter((p) => Math.abs(p.factor - 1) >= 0.0005) ?? [];
  box.hidden = !shown.length;
  if (!shown.length) return;
  const asChange = (f: number) => (ctx.byDensity ? 1 / f - 1 : f - 1);
  const short: Record<ChangePart['key'], string> = { given: 'ticket acres', overlap: 'overlap', tracking: 'rate decrease', bias: 'bias' };
  const j = settings.job;
  const givenAc = ctx.loaded && ctx.rate > 0 ? ctx.loaded / ctx.rate : 0;
  const tracking = machineTracking();
  const bias = machineBias();
  const detail = (p: ChangePart): [string, string] => {
    switch (p.key) {
      case 'given': {
        const fromTicket = j?.acres && Math.abs(j.acres / givenAc - 1) < 0.01;
        return [
          fromTicket ? 'Ticket acres vs. boundary' : 'Product given vs. boundary',
          `${fmt(givenAc, 2)} ac ${fromTicket ? 'on the ticket' : "worth given"} · ${fmt(ctx.surfaceAc, 2)} ac boundary`,
        ];
      }
      case 'overlap':
        return ['Overlap', `${fmt(ctx.appliedAc, 2)} applied ac on ${fmt(ctx.surfaceAc, 2)} ac`];
      case 'tracking': {
        const cpm = changesPerMile();
        const shaped = activeMachine().trackingModel && cpm !== undefined;
        return [
          'Average rate decrease',
          `belt averages ${fmt(Math.abs(1 - tracking) * 100, 1)}% ${tracking < 1 ? 'under' : 'over'}${shaped ? ` here (${fmt(cpm!, 0)} speed changes a mile)` : ''}`,
        ];
      }
      case 'bias':
        return ['Machine bias', `puts out ${fmt(Math.abs(bias) * 100, 1)}% ${bias > 0 ? 'more' : 'less'} than it shows`];
    }
  };
  $('answerWhySum').textContent = shown.map((p) => `${fmtPct(asChange(p.factor))} ${short[p.key]}`).join(' · ');
  $('answerWhyList').innerHTML =
    shown
      .map((p) => {
        const [name, sub] = detail(p);
        return `<li><span><b>${name}</b><small>${esc(sub)}</small></span><span class="why-pct">${fmtPct(asChange(p.factor))}</span></li>`;
      })
      .join('') + (shown.length > 1 ? `<li class="why-total"><span><b>Together</b></span><span class="why-pct">${fmtPct(ctx.total)}</span></li>` : '');
  // Point at the cause when the ticket, not the field plan, drives the change.
  const given = shown.find((p) => p.key === 'given');
  const overlap = shown.find((p) => p.key === 'overlap');
  const hint = $('answerWhyHint');
  const g = given ? given.factor - 1 : 0;
  if (given && Math.abs(g) >= 0.02 && Math.abs(g) > Math.abs((overlap?.factor ?? 1) - 1)) {
    hint.textContent =
      g < 0
        ? 'Most of this comes from the ticket being figured on fewer acres than the boundary, not from overlap. If the boundary takes in ground you don’t spread (grass edges, waterways, the yard), trim it or add exclusions; otherwise the ticket is short.'
        : 'Most of this comes from more product than the boundary acres need, not from overlap. If the boundary is missing ground you will spread, fix it; otherwise there is extra to use up.';
    hint.hidden = false;
  } else hint.hidden = true;
}

function renderResults() {
  updateSummaries();
  const has = !!(result && entries.length);
  $('heroEmpty').hidden = has;
  $('heroBody').hidden = !has;
  $('breakdownCard').hidden = !has;
  if (!result || !entries.length) return;

  const surfaceAc = result.surfaceM2 / SQ_M_PER_ACRE;
  const appliedAc = result.appliedM2 / SQ_M_PER_ACRE;
  $('surfaceAc').textContent = fmt(surfaceAc);
  $('appliedAc').textContent = fmt(appliedAc);
  $('overlapPct').textContent = fmtPct(appliedAc / surfaceAc - 1);

  const unit = settings.product.unit;
  const rate = settings.product.rate;
  // "67 acres' worth" means the plant loaded target rate × 67 ac of product.
  const givenAcres = settings.product.loadedAs === 'acres' ? settings.product.loaded : undefined;
  const loaded = givenAcres !== undefined ? givenAcres * rate : settings.product.loaded;
  const bias = machineBias();
  const tracking = machineTracking();
  const a = adviseRate({ surfaceAc, appliedAc, targetRate: rate, loaded, bias, tracking });
  const answerChange = $('answerChange');
  const kv = $('productKv');
  const byDensity = densityMode();
  const density = settings.product.density;
  $('answerLabel').textContent = byDensity ? 'On the controller, set Density to' : 'On the controller, set Rate to';
  const warn = $('answerWarn');
  warn.hidden = true;
  /** Flag big changes: they usually mean an input is wrong, not the field. */
  const checkChange = (chg: number) => {
    if (Math.abs(chg) <= 0.1) return;
    const reasons: string[] = [];
    if (loaded && rate > 0) {
      const givenAc = loaded / rate;
      const off = givenAc / surfaceAc - 1;
      if (Math.abs(off) > 0.1) {
        reasons.push(
          `Product given is ${fmt(givenAc, 1)} ac worth for ${fmt(surfaceAc, 1)} surface ac (${fmtPct(off)}). Right field${entries.length > 1 ? 's' : ''} and amount?`,
        );
      }
    }
    if (byDensity) reasons.push(`True density ${fmt(density ?? 0, 1)} lb/ft³: blend tickets can be several pounds off.`);
    if (Math.abs(bias) >= 0.05 || Math.abs(1 - tracking) >= 0.05) {
      reasons.push(
        `Machine corrections are large (bias ${fmtPct(bias)}, rate decrease ${fmt((1 - tracking) * 100, 1)}%). Check them with 🚜.`,
      );
    }
    reasons.push(`Target rate ${fmt(rate, 1)} ${unit}/ac and the right unit.`);
    const severe = Math.abs(chg) > 0.25;
    warn.className = `answer-warn${severe ? ' severe' : ''}`;
    warn.innerHTML = `<strong>⚠ ${severe ? 'This is a very big change' : 'This is a big change'} (${fmtPct(chg)}). Double-check before you set it:</strong><ul>${reasons
      .map((r) => `<li>${esc(r)}</li>`)
      .join('')}</ul>`;
    warn.hidden = false;
  };
  recommendedDensity = undefined;
  const whyCtx = { byDensity, surfaceAc, appliedAc, rate, loaded, total: 0 };
  const parts = splitChange({ surfaceAc, appliedAc, targetRate: rate, loaded, bias, tracking });
  const blank = (msg: string) => {
    renderWhy(null, whyCtx);
    $('answerRate').textContent = '–';
    $('answerUnit').textContent = '';
    answerChange.textContent = msg;
    answerChange.className = 'answer-change';
    $('answerSub').textContent = '';
  };
  if (!a) {
    blank('Enter a target rate');
    kv.innerHTML = '';
  } else {
    const useLoad = a.rateToEmpty !== undefined;
    // The rate the controller effectively has to meter at.
    const setRate = useLoad ? a.rateToEmpty! : a.rateForTarget;
    const change = useLoad ? a.rateToEmptyChangePct! : a.rateChangePct;
    const why = useLoad
      ? `Spreads the ${givenAcres !== undefined ? `${fmt(givenAcres, 2)} acres' worth (${fmtQty(loaded!, unit)})` : `${fmtQty(loaded!, unit)} load`} across ${fmt(appliedAc)} applied ac. Ground gets ${fmt(a.groundRateIfEmptied!, 1)} ${unit}/ac.`
      : `Lays down ${fmt(rate, rate >= 100 ? 0 : 1)} ${unit}/ac on the ${fmt(surfaceAc)} surface ac, including overlap.`;
    if (!byDensity) {
      $('answerRate').textContent = fmt(setRate, setRate >= 100 ? 1 : 2);
      $('answerUnit').textContent = `${unit}/ac`;
      const dir = change < -0.0005 ? 'down' : change > 0.0005 ? 'up' : '';
      answerChange.className = `answer-change ${dir}`;
      answerChange.textContent =
        dir === 'down'
          ? `${fmtPct(change)} — cut back to stretch`
          : dir === 'up'
            ? `${fmtPct(change)} — raise to use it up`
            : 'No change needed';
      $('answerSub').textContent = why;
      renderWhy(parts, { ...whyCtx, total: change });
      checkChange(change);
    } else if (!(density && density > 0)) {
      blank('Enter the product density');
    } else {
      const prog = densityFor(density, rate, setRate);
      recommendedDensity = prog;
      const dChange = prog / density - 1;
      $('answerRate').textContent = fmt(prog, 1);
      $('answerUnit').textContent = 'lb/ft³';
      // Density works backwards: more density = less product.
      const dir = dChange > 0.0005 ? 'down' : dChange < -0.0005 ? 'up' : '';
      answerChange.className = `answer-change ${dir}`;
      answerChange.textContent =
        dir === 'down'
          ? `${fmtPct(dChange)} — raise density to stretch`
          : dir === 'up'
            ? `${fmtPct(dChange)} — lower density to use it up`
            : 'No change needed';
      $('answerSub').textContent = `Leave Rate at ${fmt(rate, rate >= 100 ? 0 : 1)} ${unit}/ac. ${why}`;
      renderWhy(parts, { ...whyCtx, total: dChange });
      checkChange(dChange);
    }

    const rows: [string, string, string?][] = [
      ['Needed at target (surface ac)', fmtQty(a.productNeeded, unit), 'strong'],
      ['Used if rate is left at target', fmtQty(a.productAtTarget, unit)],
      [
        a.productAtTarget < a.productNeeded
          ? 'Short of needed (machine runs under)'
          : bias || tracking !== 1
            ? 'Extra from overlap + machine factors'
            : 'Extra from overlap',
        fmtQty(Math.abs(a.productAtTarget - a.productNeeded), unit),
      ],
    ];
    if (tracking !== 1) {
      rows.push([
        `Average rate decrease (${activeMachine().name})`,
        `${fmt(Math.abs(1 - tracking) * 100, 1)}% ${tracking < 1 ? 'under' : 'over'} requested`,
      ]);
    }
    if (bias) {
      rows.push([
        `Machine bias (${activeMachine().name})`,
        `${fmt(Math.abs(bias) * 100, 1)}% ${bias > 0 ? 'more' : 'less'} than monitor`,
      ]);
    }
    if (byDensity && recommendedDensity) {
      rows.push(['Same as a rate change of', fmtPct(useLoad ? a.rateToEmptyChangePct! : a.rateChangePct)]);
    }
    if (a.loadBalance !== undefined) {
      const bal = a.loadBalance;
      rows.push([
        bal < 0 ? 'Load is short at target rate' : 'Left over at target rate',
        fmtQty(Math.abs(bal), unit),
        bal < 0 ? 'bad' : 'ok',
      ]);
    }
    kv.innerHTML = rows
      .map(([k, v, cls]) => `<dt>${esc(k)}</dt><dd class="${cls ?? ''}">${esc(v)}</dd>`)
      .join('');
  }

  const c = result.coverage;
  const pct = (m2: number) => fmt((m2 / result!.surfaceM2) * 100, 1) + '%';
  const acres = (m2: number) => fmt(m2 / SQ_M_PER_ACRE) + ' ac';
  $('legend').innerHTML = [
    ['single', 'Applied once', c.singleM2],
    ['double', 'Overlapped (2× or more)', c.overlapAreaM2],
    ['skip', 'Missed', c.skipM2],
    ['off', 'Applied off the field / on exclusions', c.offFieldM2],
  ]
    .map(
      ([cls, label, m2]) =>
        `<li><i class="sw ${cls}"></i><span>${label}</span><b>${acres(m2 as number)} · ${pct(m2 as number)}</b></li>`,
    )
    .join('');
  const m = activeMachine();
  const multi = entries.length > 1;
  $('fieldBreakdown').hidden = !multi;
  $('fieldBreakdown').innerHTML = multi
    ? `<li class="fb-head"><span>Field</span><span>Surface</span><span>Applied</span><span>Overlap</span></li>` +
      entries
        .map(({ field, result: r }) => {
          const sAc = r!.surfaceM2 / SQ_M_PER_ACRE;
          const aAc = r!.appliedM2 / SQ_M_PER_ACRE;
          return `<li><span>${esc(field.name)}</span><span>${fmt(sAc, 2)}</span><span>${fmt(aAc, 2)}</span><span>${fmtPct(aAc / sAc - 1)}</span></li>`;
        })
        .join('') +
      `<li class="fb-total"><span>Total</span><span>${fmt(surfaceAc, 2)}</span><span>${fmt(appliedAc, 2)}</span><span>${fmtPct(appliedAc / surfaceAc - 1)}</span></li>`
    : '';
  $('planKv').innerHTML = [
    ['Headland laps', `${plan.laps} × ${fmt(m.widthFt, 0)} ft`],
    ['Headland applied', acres(result.headlandAppliedM2)],
    [
      'Passes',
      multi
        ? `${result.passCount} (${entries.map((e) => `${fmt(e.result!.headingDeg, 0)}°`).join(', ')})`
        : `${result.passCount} at ${fmt(entries[0].result!.headingDeg, 1)}°`,
    ],
    ['Pass applied', acres(result.passAppliedM2)],
    ['Distance with product on', `${fmt(result.onDistanceM / 1609.344, 2)} mi`],
  ]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');

  syncAdjustUi();
  renderDensityLearn();
}

// ---------------------------------------------------------------------------
// After the job: split the result into rate tracking and a remaining gap.

function prefillJobCheck() {
  const p = settings.product;
  const setIfEmpty = (id: string, v: number | undefined) => {
    const el = $(id) as HTMLInputElement;
    if (!el.value && v) el.value = String(Math.round(v * 100) / 100);
  };
  if (!($('ckLoaded') as HTMLInputElement).value && p.loaded) {
    ($('ckLoadedAs') as HTMLSelectElement).value = p.loadedAs ?? 'product';
  }
  setIfEmpty('ckLoaded', p.loaded);
  setIfEmpty('ckRequested', p.rate);
  setIfEmpty('ckAcres', result ? result.appliedM2 / SQ_M_PER_ACRE : undefined);
  if (densityMode()) {
    setIfEmpty('ckTrueDensity', p.density);
    setIfEmpty('ckProgDensity', recommendedDensity);
  }
  const unit = p.unit;
  $('ckLoadedUnitOpt').textContent = unit;
  $('ckLeftUnit').textContent = unit;
  $('ckAchievedUnit').textContent = `${unit}/ac`;
  $('ckRequestedUnit').textContent = `${unit}/ac`;
}

/** The job in the Calibrate form, ready to add to the log. */
let ckCurrent: Omit<CalibrationRecord, 'id' | 'date' | 'label'> | null = null;
/** Form contents last added, so the same job isn't added twice. */
let ckAddedKey = '';

function renderJobCheck() {
  const out = $('ckResult');
  ckCurrent = null;
  const unit = settings.product.unit;
  const requested = num($('ckRequested') as HTMLInputElement);
  const loadedRaw = num($('ckLoaded') as HTMLInputElement);
  const loaded =
    loadedRaw !== undefined && ($('ckLoadedAs') as HTMLSelectElement).value === 'acres' && requested
      ? loadedRaw * requested
      : loadedRaw;
  const left = num($('ckLeft') as HTMLInputElement) ?? 0;
  const acres = num($('ckAcres') as HTMLInputElement);
  if (!requested || !loaded || !acres) {
    out.innerHTML = '<p class="muted small">Fill in product loaded, applied acres and requested rate.</p>';
    return;
  }
  const used = loaded - left;
  const trueDensity = num($('ckTrueDensity') as HTMLInputElement);
  const job = {
    requestedRate: requested,
    achievedRate: num($('ckAchieved') as HTMLInputElement),
    appliedAc: acres,
    used,
    trueDensity,
    programmedDensity: num($('ckProgDensity') as HTMLInputElement),
    densityMeasured: !!trueDensity && ($('ckCup') as HTMLInputElement).checked,
    // What the plan expected for this job, to learn from.
    changesPerMile: changesPerMile(),
    predictedAc: result ? result.appliedM2 / SQ_M_PER_ACRE : undefined,
  };
  const r = checkJob(job);
  if (!r) {
    out.innerHTML = '<p class="muted small">Check the numbers: more left over than was loaded?</p>';
    return;
  }
  const m = activeMachine();
  const parts: string[] = [];
  parts.push(`<dl class="kv">
    <dt>Product used</dt><dd class="strong">${fmtQty(used, unit)}</dd>
    <dt>Monitor thinks it put out</dt><dd>${fmtQty(r.monitorProduct, unit)}</dd>
    <dt>Should have left the bin</dt><dd>${fmtQty(r.expectedOut, unit)}</dd>
    <dt>Ground got (per applied ac)</dt><dd>${fmt(used / acres, 1)} ${esc(unit)}/ac</dd>
  </dl>`);

  if (r.tracking !== undefined) {
    parts.push(`<div class="ck-row">
      <div><strong>Average rate decrease: ${fmt((1 - r.tracking) * 100, 1)}%</strong>
      <div class="muted small">Averaged ${fmt(Math.abs(1 - r.tracking) * 100, 1)}% ${r.tracking < 1 ? 'under' : 'over'} the request on this job.</div></div>
    </div>`);
  } else {
    parts.push(
      '<p class="muted small">Add the monitor\'s average applied rate to separate the belt keeping up from everything else.</p>',
    );
  }

  const gap = r.gap;
  if (Math.abs(gap) < 0.01) {
    parts.push(`<p class="ck-ok"><strong>✓ Within 1% (${fmtPct(gap)}).</strong> No density or bias change needed.</p>`);
  } else {
    const more = gap > 0;
    const explained = [
      r.tracking !== undefined ? 'rate tracking' : '',
      num($('ckProgDensity') as HTMLInputElement) ? 'the density setting' : '',
    ].filter(Boolean);
    const than = explained.length
      ? `${explained.join(' and ')} explain${explained.length > 1 ? '' : 's'}`
      : 'the monitor shows';
    parts.push(`<div class="ck-gap">
      <strong>${fmt(Math.abs(gap) * 100, 1)}% ${more ? 'more' : 'less'} product went out than ${than}.</strong>
      <div class="muted small">It is one of these, not both. Density on blend tickets is often calculated rather than measured, so if you didn't use a density cup, density is the usual cause.</div>
    </div>`);
    if (r.impliedDensity !== undefined) {
      parts.push(`<div class="ck-row">
        <div><strong>Product density was really ~${fmt(r.impliedDensity, 1)} lb/ft³</strong>
        <div class="muted small">Use this for the rest of this blend.</div></div>
        <button class="btn" type="button" data-ck="density" data-v="${r.impliedDensity.toFixed(1)}">Use ${fmt(r.impliedDensity, 1)}</button>
      </div>`);
    }
    parts.push(`<div class="ck-row">
      <div><strong>Or: machine puts out ${fmt(Math.abs(gap) * 100, 1)}% ${more ? 'more' : 'less'} than the monitor</strong>
      <div class="muted small">Add the job to the log below. A bias is set from the average of several jobs, not one.</div></div>
    </div>`);
  }
  ckCurrent = job;
  const key = JSON.stringify(job);
  const added = key === ckAddedKey;
  const j = settings.job;
  const defaultLabel = j?.ticketNo
    ? `Ticket ${j.ticketNo}${j.fieldName ? ` · ${j.fieldName}` : ''}`
    : entries.map((e) => e.field.name).join(' + ');
  const prevLabel = (document.getElementById('ckLabel') as HTMLInputElement | null)?.value;
  parts.push(`<div class="ck-add">
    <label class="field"><span>Job name</span><input id="ckLabel" type="text" value="${esc(prevLabel || defaultLabel)}" placeholder="e.g. Barrett, 10/15" /></label>
    <button class="btn primary" type="button" id="ckAddBtn" ${added ? 'disabled' : ''}>${added ? '✓ Added to log' : `Add to ${esc(m.name)} log`}</button>
  </div>`);
  out.innerHTML = parts.join('');
}

function machineCalibrations(m: MachineRecord): CalibrationRecord[] {
  return m.calibrations ?? [];
}

/** The log for the active machine: averages, apply buttons, jobs, start over. */
function renderCalLog() {
  const m = activeMachine();
  const box = $('calLog');
  $('calMachineName').textContent = `· ${m.name}`;
  const logs = machineCalibrations(m);
  const curTrack = m.trackingPct !== undefined ? 100 - m.trackingPct : 0;
  const curBias = m.biasPct ?? 0;
  const nowTrack = m.trackingModel
    ? `rate decrease ${fmt(m.trackingModel.a * 100, 1)}% + ${fmt(m.trackingModel.k * 1000, 1)}% per 10 speed changes a mile`
    : `average rate decrease ${fmt(curTrack, 1)}%`;
  const nowLine = `<p class="muted small">This machine now: ${nowTrack} · bias ${fmtPct(curBias / 100)}.</p>`;
  if (!logs.length) {
    box.innerHTML = `<p class="muted small">No jobs logged yet. Check a finished job above and add it to the log. The average of several jobs sets this machine's rate decrease and bias.</p>${nowLine}${
      curTrack || curBias || m.trackingModel ? '<button class="btn danger-text" type="button" data-cal="reset">Start over</button>' : ''
    }`;
    return;
  }
  const avg = averageCalibration(logs);
  const parts: string[] = [];
  if (!avg) {
    parts.push('<p class="muted small">Every job is left out. Tap one to count it again.</p>');
  } else {
    parts.push('<div class="cal-sum">');
    parts.push(`<p class="cal-n"><strong>Average of ${avg.n} job${avg.n === 1 ? '' : 's'}</strong> <span class="muted small">bigger loads and recent jobs count for more</span></p>`);
    if (avg.trackingModel) {
      const tm = avg.trackingModel;
      const cpm = changesPerMile();
      const same = !!m.trackingModel && Math.abs(m.trackingModel.a - tm.a) < 1e-4 && Math.abs(m.trackingModel.k - tm.k) < 1e-6;
      parts.push(`<div class="ck-row">
        <div><strong>Rate decrease ${fmt(tm.a * 100, 1)}% + ${fmt(tm.k * 1000, 1)}% per 10 speed changes a mile</strong>
        <div class="muted small">Your jobs show the belt losing more on cut-up fields.${cpm !== undefined ? ` This field (${fmt(cpm, 0)} a mile): ${fmt((1 - trackingFor(tm, cpm)) * 100, 1)}%.` : ''} Flat average would be ${fmt((1 - avg.tracking!) * 100, 1)}%.</div></div>
        <button class="btn" type="button" data-cal="trackmodel" ${same ? 'disabled' : ''}>${same ? '✓ In use' : 'Use'}</button>
      </div>`);
    } else if (avg.tracking !== undefined) {
      const dec = (1 - avg.tracking) * 100;
      const same = !m.trackingModel && Math.abs(dec - curTrack) <= 0.051;
      const why =
        avg.trackingN >= 3
          ? 'Same on open and cut-up fields so far.'
          : 'With 3+ jobs from different kinds of fields, the app checks whether cut-up fields lose more.';
      parts.push(`<div class="ck-row">
        <div><strong>Average rate decrease ${fmt(dec, 1)}%</strong>
        <div class="muted small">From ${avg.trackingN} job${avg.trackingN === 1 ? '' : 's'} with the monitor's average rate. ${why}</div></div>
        <button class="btn" type="button" data-cal="tracking" data-v="${(avg.tracking * 100).toFixed(1)}" ${same ? 'disabled' : ''}>${same ? '✓ In use' : 'Use'}</button>
      </div>`);
    }
    const g = avg.gap * 100;
    const sd = avg.gapSd * 100;
    const ci = 2 * avg.gapSe * 100;
    let verdict: string;
    if (avg.gapFromMeasured) verdict = `From ${avg.gapN} loads with cup-checked density, so density error is out of it.`;
    else if (avg.gapN < 3) verdict = `Add ${3 - avg.gapN} more job${3 - avg.gapN === 1 ? '' : 's'} before trusting this as a bias.`;
    else if (sd > 2) verdict = `The jobs disagree (±${fmt(sd, 1)}% job to job). That's usually density changing from blend to blend, not the machine.`;
    else verdict = `Consistent across ${avg.gapN} jobs (±${fmt(sd, 1)}% job to job), so it's most likely the machine.`;
    const sameBias = Math.abs(g - curBias) <= 0.051;
    parts.push(`<div class="ck-row">
      <div><strong>Puts out ${fmt(Math.abs(g), 1)}% ${g >= 0 ? 'more' : 'less'} than the monitor <span class="cal-ci">± ${fmt(ci, 1)}%</span></strong>
      <div class="muted small">${verdict}</div></div>
      <button class="btn" type="button" data-cal="bias" data-v="${g.toFixed(1)}" ${sameBias ? 'disabled' : ''}>${sameBias ? '✓ In use' : 'Use as bias'}</button>
    </div>`);
    if (avg.acreError !== undefined) {
      const e = avg.acreError * 100;
      parts.push(`<div class="ck-row">
        <div><strong>Monitor acres vs the plan: ${fmtPct(avg.acreError)}</strong>
        <div class="muted small">${
          Math.abs(e) < 1
            ? `The app's applied-acre estimate is within 1% of your monitor over ${avg.acreN} job${avg.acreN === 1 ? '' : 's'}.`
            : `Your monitor counts ${fmt(Math.abs(e), 1)}% ${e < 0 ? 'fewer' : 'more'} applied acres than the plan predicts (${avg.acreN} job${avg.acreN === 1 ? '' : 's'}). Check the work plan settings (laps, shutoff, corners) match how you drive.`
        }</div></div>
      </div>`);
    }
    // What would tighten the numbers most.
    const tip = !logs.some((c) => c.densityMeasured && !c.excluded)
      ? 'Tip: cup-check the density on a load and tick "Measured with a density cup". One measured load sharpens the bias more than several unmeasured ones.'
      : avg.gapFromMeasured
        ? ''
        : 'Tip: one more cup-checked load and the bias will come from measured loads only.';
    if (tip) parts.push(`<p class="cal-tip">${tip}</p>`);
    parts.push('</div>');
  }
  parts.push(nowLine);
  const sorted = [...logs].sort((a, b) => b.date - a.date);
  parts.push(
    `<ul class="cal-list">${sorted
      .map((c) => {
        const gap = avg?.gaps[c.id];
        const odd = avg?.outliers.includes(c.id);
        const bits = [
          c.achievedRate ? `rate decrease ${fmt((1 - c.achievedRate / c.requestedRate) * 100, 1)}%` : '',
          gap !== undefined ? `out vs monitor ${fmtPct(gap)}` : '',
          `${fmt(c.appliedAc, 1)} ac${c.predictedAc ? ` (plan ${fmt(c.predictedAc, 1)})` : ''} · ${fmtQty(c.used, settings.product.unit)}`,
          c.changesPerMile !== undefined ? `${fmt(c.changesPerMile, 0)} speed changes/mi` : '',
          c.densityMeasured ? 'density cup ✓' : '',
        ].filter(Boolean);
        return `<li class="${c.excluded ? 'excluded' : ''}">
          <div class="cal-main">
            <strong>${esc(c.label || 'Job')}</strong>
            <span class="muted small">${new Date(c.date).toLocaleDateString()} · ${esc(bits.join(' · '))}</span>
            ${odd && !c.excluded ? '<span class="cal-odd">⚠ Doesn\'t fit the other jobs. Wrong density or a typo? Consider leaving it out.</span>' : ''}
          </div>
          <button class="btn small-btn" type="button" data-cal="toggle" data-id="${c.id}" aria-pressed="${!c.excluded}">${c.excluded ? 'Left out' : 'Counted'}</button>
          <button class="icon-btn cal-del" type="button" data-cal="del" data-id="${c.id}" aria-label="Delete ${esc(c.label)}">🗑</button>
        </li>`;
      })
      .join('')}</ul>`,
  );
  parts.push('<button class="btn danger-text" type="button" data-cal="reset">Start over</button>');
  box.innerHTML = parts.join('');
}

$('calLog').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-cal]');
  if (!b) return;
  const m = activeMachine();
  const logs = machineCalibrations(m);
  const action = b.dataset.cal;
  if (action === 'tracking') {
    m.trackingPct = parseFloat(b.dataset.v!);
    m.trackingModel = undefined;
    toast(`${m.name}: average rate decrease set to ${fmt(100 - m.trackingPct, 1)}%`);
  } else if (action === 'trackmodel') {
    const avg = averageCalibration(logs);
    if (!avg?.trackingModel) return;
    m.trackingModel = avg.trackingModel;
    m.trackingPct = Math.round(avg.tracking! * 1000) / 10;
    toast(`${m.name}: rate decrease now follows each field's speed changes`);
  } else if (action === 'bias') {
    m.biasPct = parseFloat(b.dataset.v!);
    toast(`${m.name}: bias set to ${fmt(Math.abs(m.biasPct), 1)}% ${m.biasPct > 0 ? 'more' : 'less'}`);
  } else if (action === 'toggle') {
    const c = logs.find((x) => x.id === b.dataset.id);
    if (c) c.excluded = !c.excluded;
  } else if (action === 'del') {
    const c = logs.find((x) => x.id === b.dataset.id);
    if (!c || !confirm(`Delete "${c.label || 'this job'}" from the log?`)) return;
    m.calibrations = logs.filter((x) => x !== c);
  } else if (action === 'reset') {
    const n = logs.length;
    if (
      !confirm(
        `Start ${m.name} over from a clean slate?\n\n${n ? `This deletes all ${n} logged job${n === 1 ? '' : 's'} and ` : 'This '}resets its average rate decrease and bias to 0. Learned product densities are kept.`,
      )
    )
      return;
    m.calibrations = [];
    m.trackingPct = undefined;
    m.trackingModel = undefined;
    m.biasPct = undefined;
    ckAddedKey = '';
    toast(`${m.name} reset. Add finished jobs to calibrate it again.`);
  }
  store.saveMachines(machines);
  syncMachineUi();
  renderJobCheck();
  renderCalLog();
  renderResults();
});

$('ckResult').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const m = activeMachine();
  if (t.closest('#ckAddBtn') && ckCurrent) {
    const label = ($('ckLabel') as HTMLInputElement).value.trim() || new Date().toLocaleDateString();
    m.calibrations = [...machineCalibrations(m), { ...ckCurrent, id: uid(), date: Date.now(), label }];
    store.saveMachines(machines);
    ckAddedKey = JSON.stringify(ckCurrent);
    const n = m.calibrations.length;
    // A cup reading of a ticket blend also teaches the product densities.
    const ings = settings.job?.ingredients;
    const cup = ckCurrent.densityMeasured && ckCurrent.trueDensity && ings?.length;
    if (cup) addDensityReading(ings, ckCurrent.trueDensity!, label);
    toast(`Added to ${m.name} log (${n} job${n === 1 ? '' : 's'})${cup ? ' and the density reading to your products' : ''}`);
    renderDensityLib();
    renderJobCheck();
    renderCalLog();
    return;
  }
  const b = t.closest<HTMLElement>('[data-ck]');
  if (!b) return;
  const v = parseFloat(b.dataset.v!);
  if (b.dataset.ck === 'density') {
    settings.product.density = v;
    settings.product.adjustBy = 'density';
    saveSettings();
    ($('densityInput') as HTMLInputElement).value = String(v);
    toast(
      m.biasPct
        ? `Density set to ${fmt(v, 1)}. ${m.name} still has a ${fmt(Math.abs(m.biasPct), 1)}% bias; clear it if density explains the gap.`
        : `Density set to ${fmt(v, 1)} lb/ft³`,
    );
  }
  syncMachineUi();
  renderResults();
});

/** Learned product densities and the cup readings behind them. */
function renderDensityLib() {
  const box = $('densityLib');
  if (!densityReadings.length) {
    box.innerHTML =
      '<p class="muted small">No density-cup readings yet. Cup-check a ticket load, then save it from the Product card or tick "Measured with a density cup" when you add the job above. The app learns each product\'s real density and predicts new blends from it.</p>';
    return;
  }
  const model = learnDensities(densityReadings);
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  for (const r of densityReadings)
    for (const i of r.ingredients) {
      const k = ingredientKey(i.name);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      names.set(k, i.name);
    }
  const rows = model.keys
    .map((k, i) => {
      const d = 1 / model.v[i];
      const sd = d * d * Math.sqrt(Math.max(model.cov[i][i], 0));
      return `<dt>${esc(names.get(k) ?? k)} <span class="muted small">(${counts.get(k) ?? 0} reading${counts.get(k) === 1 ? '' : 's'})</span></dt><dd>${fmt(d, 1)} <span class="muted small">± ${fmt(sd, 1)}</span></dd>`;
    })
    .join('');
  const list = [...densityReadings]
    .sort((a, b) => b.date - a.date)
    .map(
      (r) => `<li>
        <div class="cal-main"><strong>${esc(r.label || r.ingredients.map((i) => i.name).join(' + '))}: ${fmt(r.density, 1)} lb/ft³</strong>
        <span class="muted small">${new Date(r.date).toLocaleDateString()} · ${esc(r.ingredients.map((i) => `${i.name} ${fmt(i.rate, 0)}`).join(' + '))}</span></div>
        <button class="icon-btn cal-del" type="button" data-dens-del="${r.id}" aria-label="Delete reading">🗑</button>
      </li>`,
    )
    .join('');
  box.innerHTML = `<p class="muted small">Each product's density as learned from your cup readings (lb/ft³). New blends of these are predicted from them.</p>
    <dl class="kv">${rows}</dl>
    <ul class="cal-list">${list}</ul>
    <button class="btn danger-text" type="button" data-dens-clear>Clear density readings</button>`;
}

$('densityLib').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const del = t.closest<HTMLElement>('[data-dens-del]');
  if (del) {
    if (!confirm('Delete this density reading?')) return;
    densityReadings = densityReadings.filter((r) => r.id !== del.dataset.densDel);
  } else if (t.closest('[data-dens-clear]')) {
    if (!confirm(`Delete all ${densityReadings.length} density readings? Learned product densities go back to rough starting values.`)) return;
    densityReadings = [];
  } else return;
  store.saveDensityReadings(densityReadings);
  renderDensityLib();
  renderResults();
});

/** Product card: learned density for the ticket blend, and saving a cup reading. */
function renderDensityLearn() {
  const box = $('densityLearn');
  const j = settings.job;
  const ings = j?.ingredients;
  if (!ings?.length || !densityMode()) {
    box.hidden = true;
    return;
  }
  const p = learnedDensity(ings);
  const cur = settings.product.density;
  const parts: string[] = [];
  if (p) {
    const same = cur !== undefined && Math.abs(cur - Math.round(p.density * 10) / 10) < 0.05;
    parts.push(`<div class="ck-row">
      <div><strong>From your cup checks: ${fmt(p.density, 1)} ± ${fmt(p.sd, 1)}</strong>
      <div class="muted small">${j?.ticketDensity ? `Ticket says ${fmt(j.ticketDensity, 2)}. ` : ''}Predicted from this blend's ingredients.</div></div>
      <button class="btn" type="button" data-learn="use" data-v="${p.density.toFixed(1)}" ${same ? 'disabled' : ''}>${same ? '✓ In use' : 'Use'}</button>
    </div>`);
  }
  const saved = densityReadings.some((r) => r.label === j?.ticketNo && cur !== undefined && Math.abs(r.density - cur) < 0.01);
  parts.push(`<div class="ck-row">
    <div><strong>Cup-checked this load?</strong>
    <div class="muted small">Enter the cup reading above and save it. The app learns each product's real density from it.</div></div>
    <button class="btn" type="button" data-learn="save" ${!cur || saved ? 'disabled' : ''}>${saved ? '✓ Saved' : 'Save reading'}</button>
  </div>`);
  box.innerHTML = parts.join('');
  box.hidden = false;
}

$('densityLearn').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-learn]');
  const j = settings.job;
  if (!b || !j?.ingredients) return;
  if (b.dataset.learn === 'use') {
    settings.product.density = parseFloat(b.dataset.v!);
    ($('densityInput') as HTMLInputElement).value = b.dataset.v!;
    saveSettings();
    toast(`Density set to ${b.dataset.v} lb/ft³ from your cup checks`);
  } else if (settings.product.density) {
    addDensityReading(j.ingredients, settings.product.density, j.ticketNo);
    toast(`Saved: ${fmt(settings.product.density, 1)} lb/ft³ for this blend`);
  }
  renderResults();
});

// Machine & calibration window -------------------------------------------------

function showMachineTab(tab: 'machine' | 'calibrate') {
  setSeg('machineTabs', tab);
  $('machinePane').hidden = tab !== 'machine';
  $('calibratePane').hidden = tab !== 'calibrate';
  if (tab === 'calibrate') {
    prefillJobCheck();
    renderJobCheck();
    renderCalLog();
    renderDensityLib();
  }
}

function openMachineSheet(tab: 'machine' | 'calibrate' = 'machine') {
  syncMachineUi();
  showMachineTab(tab);
  openSheet('machineSheet');
}

$('machineBtn').addEventListener('click', () => openMachineSheet());
onSeg('machineTabs', (v) => showMachineTab(v as 'machine' | 'calibrate'));
for (const id of ['ckLoaded', 'ckLeft', 'ckAcres', 'ckAchieved', 'ckRequested', 'ckProgDensity', 'ckTrueDensity']) {
  $(id).addEventListener('input', renderJobCheck);
}
$('ckLoadedAs').addEventListener('change', renderJobCheck);
$('ckCup').addEventListener('change', renderJobCheck);

// ---------------------------------------------------------------------------
// Field selection

function selectField(id: string | null, opts: { keepView?: boolean } = {}) {
  selectFields(id ? [id] : [], opts);
}

/** Selects one or more fields; several are planned and totaled as one job. */
function selectFields(ids: string[], opts: { keepView?: boolean } = {}) {
  if (editSession) stopEdit();
  const picked = ids.map((id) => fields.find((f) => f.id === id)).filter((f): f is FieldRecord => !!f);
  entries = [];
  for (const f of picked) {
    try {
      entries.push({ field: f, local: toLocalField(f.geometry, holeKindsOf(f)), result: null });
    } catch (err) {
      toast(`Boundary problem in ${f.name}: ${(err as Error).message}`, true);
    }
  }
  activeField = entries[0]?.field ?? null;
  result = null;
  pending = new Map();
  drawPlanLayers();
  settings.lastFieldId = activeField?.id;
  settings.lastFieldIds = entries.map((e) => e.field.id);
  // A ticket job belongs to its fields; choosing others ends it.
  if (settings.job && settings.job.fieldIds.join() !== settings.lastFieldIds.join()) delete settings.job;
  saveSettings();
  // Boundary tools edit one field at a time.
  $('boundaryTools').hidden = !entries.length;
  renderBoundaryTools();
  if (!activeField) {
    $('fieldName').textContent = 'Choose a field';
    drawBoundary();
    renderResults();
    updateGpsChip();
    return;
  }
  $('fieldName').textContent =
    entries.length === 1 ? activeField.name : `${entries.length} fields: ${entries.map((e) => e.field.name).join(' + ')}`;
  const p = activeField.prefs ?? {};
  if (p.machineId && machines.some((m) => m.id === p.machineId)) settings.activeMachineId = p.machineId;
  plan.laps = p.headlandLaps ?? activeMachine().defaultHeadlandLaps;
  plan.headingMode = p.headingMode ?? 'longest';
  plan.headingDeg = p.headingDeg ?? 0;
  syncControls();
  drawBoundary();
  if (!opts.keepView) fitField();
  renderResults();
  updateGpsChip();
  schedulePlan();
  (document.getElementById('fieldsSheet') as HTMLDialogElement).close();
}

function fieldMeta(f: FieldRecord): string {
  const parts = [f.grower, f.farm].filter(Boolean) as string[];
  let acres = '';
  try {
    acres = fmt(toLocalField(f.geometry).acres) + ' ac';
  } catch {
    /* ignore bad geometry here */
  }
  parts.push(acres);
  if (gps) parts.push(`${fmt(distanceMiles(gps, geometryCenter(f.geometry)), 1)} mi`);
  return parts.filter(Boolean).join(' · ');
}

const acresCache = new Map<string, string>();
function cachedMeta(f: FieldRecord): string {
  const key = f.id + f.updatedAt + (gps ? gps.map((v) => v.toFixed(3)).join() : '');
  if (!acresCache.has(key)) acresCache.set(key, fieldMeta(f));
  return acresCache.get(key)!;
}

/** "Select several" mode in the Fields sheet. */
let multiMode = false;
const multiChecked = new Set<string>();

function setMultiMode(on: boolean) {
  multiMode = on;
  multiChecked.clear();
  if (on) for (const e of entries) multiChecked.add(e.field.id);
  $('multiBtn').hidden = on;
  $('multiHint').hidden = !on;
  $('multiBar').hidden = !on;
  updateMultiBar();
  renderFieldList();
}

function updateMultiBar() {
  const n = multiChecked.size;
  let acres = 0;
  for (const id of multiChecked) {
    const f = fields.find((x) => x.id === id);
    try {
      if (f) acres += toLocalField(f.geometry).acres;
    } catch {
      /* skip bad geometry */
    }
  }
  $('multiCount').textContent = n ? `${n} selected · ${fmt(acres, 2)} ac` : 'None selected';
  ($('multiGo') as HTMLButtonElement).disabled = n === 0;
  $('multiGo').textContent = n > 1 ? `Plan ${n} together` : 'Plan';
}

$('multiBtn').addEventListener('click', () => setMultiMode(true));
$('multiCancel').addEventListener('click', () => setMultiMode(false));
$('multiGo').addEventListener('click', () => {
  const ids = [...multiChecked];
  setMultiMode(false);
  selectFields(ids);
});

function renderFieldList() {
  const q = ($('fieldSearch') as HTMLInputElement).value.trim().toLowerCase();
  const here = fieldAtGps();
  let list = fields.filter((f) => !q || [f.name, f.grower, f.farm].some((s) => s?.toLowerCase().includes(q)));
  if (gps) {
    const g = gps;
    list = list
      .map((f) => ({ f, d: distanceMiles(g, geometryCenter(f.geometry)) }))
      .sort((a, b) => a.d - b.d)
      .map((x) => x.f);
  } else {
    list.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const ul = $('fieldList');
  if (!list.length) {
    ul.innerHTML = `<li class="empty">${fields.length ? 'No matches.' : 'No fields yet. Import a boundary file or draw one.'}</li>`;
    return;
  }
  ul.innerHTML = list
    .map(
      (f) => `<li class="${multiMode && multiChecked.has(f.id) ? 'checked' : ''}">
        ${multiMode ? `<span class="check" aria-hidden="true">${multiChecked.has(f.id) ? '✓' : ''}</span>` : ''}
        <button type="button" class="pick" data-id="${f.id}" ${multiMode ? `role="checkbox" aria-checked="${multiChecked.has(f.id)}"` : ''}>
          <span class="name">${esc(f.name)}${here?.id === f.id ? ' <span class="here">• you are here</span>' : ''}</span>
          <span class="meta">${esc(cachedMeta(f))}</span>
        </button>
        ${multiMode ? '' : `<button type="button" class="del" data-del="${f.id}" aria-label="Delete ${esc(f.name)}">🗑</button>`}
      </li>`,
    )
    .join('');
}

$('fieldList').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const pick = t.closest<HTMLElement>('[data-id]');
  const del = t.closest<HTMLElement>('[data-del]');
  if (del) {
    const f = fields.find((x) => x.id === del.dataset.del);
    if (f && confirm(`Delete "${f.name}" from this iPad?`)) {
      store.deleteField(f.id);
      fields = store.fields();
      if (entries.some((e) => e.field.id === f.id)) {
        selectFields(entries.map((e) => e.field.id).filter((id) => id !== f.id));
      } else drawBoundary();
      renderFieldList();
    }
  } else if (pick && multiMode) {
    const id = pick.dataset.id!;
    if (multiChecked.has(id)) multiChecked.delete(id);
    else multiChecked.add(id);
    updateMultiBar();
    renderFieldList();
  } else if (pick) {
    selectField(pick.dataset.id!);
  }
});

$('fieldSearch').addEventListener('input', renderFieldList);

function openSheet(id: string) {
  const d = $(id) as HTMLDialogElement;
  if (!d.open) d.showModal();
}

for (const d of document.querySelectorAll<HTMLDialogElement>('dialog')) {
  d.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === d || t.closest('[data-close]')) d.close();
  });
}

function openFields() {
  setMultiMode(false);
  $('syncBtn').hidden = !settings.boundaryServer?.url;
  openSheet('fieldsSheet');
}

$('fieldBtn').addEventListener('click', openFields);
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-action="open-fields"]')) openFields();
  if (t.closest('[data-action="new-job"]')) openJob();
  if (t.closest('[data-action="finish-job"]')) openFinish();
});

function addFields(items: { name: string; grower?: string; farm?: string; geometry: BoundaryGeometry }[], source: string) {
  const now = Date.now();
  const added: FieldRecord[] = items.map((it, i) => ({
    id: uid(),
    name: it.name || 'Field',
    grower: it.grower,
    farm: it.farm,
    geometry: it.geometry,
    source,
    createdAt: now + i,
    updatedAt: now + i,
  }));
  fields = [...fields, ...added];
  if (!store.saveFields(fields)) toast('Storage is full — delete some fields to save more.', true);
  return added;
}

async function importPicked(input: HTMLInputElement) {
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;
  try {
    const items = await importFiles(files);
    const added = addFields(items, files.map((f) => f.name).join(', '));
    if (added.length === 1) {
      selectField(added[0].id);
      toast(`Imported ${added[0].name}`);
    } else {
      toast(`Imported ${added.length} fields`);
      drawBoundary();
      renderFieldList();
    }
  } catch (err) {
    toast((err as Error).message, true);
  }
}
$('fileInput').addEventListener('change', (e) => void importPicked(e.target as HTMLInputElement));

// ---------------------------------------------------------------------------
// Drawing and editing boundaries on the satellite map

type LonLatRing = number[][];

function closeRing(pts: L.LatLng[]): LonLatRing {
  const ring = pts.map((p) => [p.lng, p.lat]);
  ring.push(ring[0]);
  return ring;
}

function openRing(ring: LonLatRing): L.LatLng[] {
  const pts = ring.map(([lng, lat]) => L.latLng(lat, lng));
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (pts.length > 1 && a.lat === b.lat && a.lng === b.lng) pts.pop();
  return pts;
}

/** Polygons of a geometry as a list (Polygon → one entry). */
function polygonsOf(g: BoundaryGeometry): LonLatRing[][] {
  return g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
}

function geometryFrom(polys: LonLatRing[][]): BoundaryGeometry {
  return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
}

function ringAcres(pts: L.LatLng[]): number {
  if (pts.length < 3) return 0;
  const proj = makeProjection(pts[0].lng, pts[0].lat);
  return ringArea(pts.map((p) => proj.toLocal([p.lng, p.lat]))) / SQ_M_PER_ACRE;
}

/** Index of the largest polygon part (the one "Edit boundary" edits). */
function largestPart(g: BoundaryGeometry): number {
  const areas = polygonsOf(g).map((p) => ringAcres(openRing(p[0])));
  return areas.indexOf(Math.max(...areas));
}

/** Each part's exclusion kinds, shaped to match the field's geometry. */
function holeKindsOf(f: FieldRecord): ExclusionKind[][] {
  return polygonsOf(f.geometry).map((p, i) => p.slice(1).map((_, j) => f.holeKinds?.[i]?.[j] ?? 'drive'));
}

/** Keep the boundary as imported before the first change, so it can be restored. */
function rememberOriginal(f: FieldRecord) {
  if (f.originalGeometry || f.source === 'drawn') return;
  f.originalGeometry = JSON.parse(JSON.stringify(f.geometry));
  f.originalHoleKinds = holeKindsOf(f);
}

function saveFieldChange(f: FieldRecord, geometry: BoundaryGeometry, kinds: ExclusionKind[][]) {
  rememberOriginal(f);
  f.geometry = geometry;
  f.holeKinds = kinds;
  f.updatedAt = Date.now();
  store.saveFields(fields);
}

/**
 * Imported boundaries can have thousands of points, far too many handles to
 * drag on a tablet. Thin them (Douglas–Peucker) until there are at most
 * `max`, and report how far the outline may have moved.
 */
function thinForEditing(pts: L.LatLng[], max = 250): { pts: L.LatLng[]; tolerance: number } {
  if (pts.length <= max) return { pts, tolerance: 0 };
  const proj = makeProjection(pts[0].lng, pts[0].lat);
  const local = pts.map((p) => proj.toLocal([p.lng, p.lat]));
  for (const tol of [0.25, 0.5, 1, 1.5, 2, 3, 5, 8]) {
    const thin = simplifyRing(local, tol);
    if (thin.length <= max || tol === 8) {
      return { pts: thin.map((q) => { const [lng, lat] = proj.toLonLat(q); return L.latLng(lat, lng); }), tolerance: tol };
    }
  }
  return { pts, tolerance: 0 };
}

const EDIT_HINTS: Record<EditMode, string> = {
  new: 'Tap each corner of the field',
  edit: 'Drag corners to move · tap a corner to remove · tap a ◦ to add one',
  hole: 'Tap the corners of the area to leave out (waterway, farmstead, pond)',
};

function startEdit(mode: EditMode, target?: EditTarget, fieldId?: string) {
  if (editSession) stopEdit();
  (document.getElementById('fieldsSheet') as HTMLDialogElement).close();
  const field = fieldId ? fields.find((x) => x.id === fieldId) ?? null : activeField;
  let initial: L.LatLng[] = [];
  let note = '';
  if (mode === 'edit') {
    if (!field) return;
    const parts = polygonsOf(field.geometry);
    target = target ?? { part: largestPart(field.geometry) };
    const ring = target.hole === undefined ? parts[target.part]?.[0] : parts[target.part]?.[target.hole + 1];
    if (!ring) return;
    const thinned = thinForEditing(openRing(ring));
    initial = thinned.pts;
    if (thinned.tolerance) {
      note = `Simplified from ${ring.length - 1} points to ${thinned.pts.length} for editing (shape kept within ${fmt(thinned.tolerance, thinned.tolerance < 1 ? 2 : 0)} m).`;
    }
  } else if (mode === 'hole' && !field) {
    return;
  }
  const hint = (pts: L.LatLng[]) =>
    pts.length < 3 ? `${EDIT_HINTS[mode]} (${pts.length} so far)` : `${EDIT_HINTS[mode]} — ${fmt(ringAcres(pts))} ac`;
  const editor = new PolygonEditor(map, initial, {
    appendOnMapTap: mode !== 'edit',
    color: mode === 'hole' || target?.hole !== undefined ? '#f87171' : '#22c55e',
    onChange: (pts) => {
      $('drawHint').textContent = hint(pts);
    },
  });
  editSession = { mode, fieldId: mode === 'new' ? undefined : field?.id, editor, target };
  newHoleKind = 'drive';
  setSeg('holeKindSeg', newHoleKind);
  $('holeKindSeg').hidden = mode !== 'hole';
  $('drawBar').hidden = false;
  layers.coverage.remove();
  layers.lines.remove();
  $('mapLegend').hidden = true;
  drawBoundary();
  if (initial.length) map.fitBounds(L.latLngBounds(initial), { padding: [40, 40] });
  if (mode === 'new' && gps && !activeField) map.setView(toLatLng(gps), 16);
  if (note) toast(note);
}

function stopEdit() {
  editSession?.editor.destroy();
  editSession = null;
  $('drawBar').hidden = true;
  layers.coverage.addTo(map);
  layers.lines.addTo(map);
  $('mapLegend').hidden = !(showCoverage && result);
  drawBoundary();
}

function saveEdit() {
  if (!editSession) return;
  const pts = editSession.editor.points;
  if (pts.length < 3) {
    toast('Tap at least 3 corners.', true);
    return;
  }
  const mode = editSession.mode;
  if (mode === 'new') {
    const fromJob = job?.drawing ? job : null;
    const name = prompt('Field name?', fromJob?.ticket?.fieldName || 'New field');
    if (name === null) return;
    stopEdit();
    const [added] = addFields(
      [{ name: name.trim() || 'New field', grower: fromJob?.ticket?.grower, geometry: { type: 'Polygon', coordinates: [closeRing(pts)] } }],
      'drawn',
    );
    selectField(added.id);
    if (fromJob) {
      fromJob.drawing = false;
      fromJob.offered.unshift(added.id);
      fromJob.picked.add(added.id);
      showJobStep(2);
      openSheet('jobSheet');
    }
    return;
  }
  const f = fields.find((x) => x.id === editSession!.fieldId);
  if (!f) {
    stopEdit();
    return;
  }
  const parts = polygonsOf(f.geometry).map((p) => p.map((r) => r.slice()));
  const kinds = holeKindsOf(f);
  if (mode === 'edit') {
    const t = editSession.target ?? { part: largestPart(f.geometry) };
    if (t.hole === undefined) parts[t.part][0] = closeRing(pts);
    else parts[t.part][t.hole + 1] = closeRing(pts);
  } else {
    // Add the exclusion to whichever part it sits in.
    const probe: [number, number] = [pts[0].lng, pts[0].lat];
    const idx = parts.findIndex((p) => pointInGeometry({ type: 'Polygon', coordinates: [p[0]] }, probe));
    if (idx < 0) {
      toast('The exclusion has to be inside the field boundary.', true);
      return;
    }
    parts[idx].push(closeRing(pts));
    kinds[idx].push(newHoleKind);
  }
  saveFieldChange(f, geometryFrom(parts), kinds);
  stopEdit();
  reselect(f.id);
  toast(mode === 'edit' ? 'Boundary saved' : 'Exclusion added');
}

$('drawBtn').addEventListener('click', () => startEdit('new'));
onSeg('holeKindSeg', (v) => {
  newHoleKind = v as ExclusionKind;
  setSeg('holeKindSeg', newHoleKind);
});

/** Re-plan after a field changed, keeping several selected fields together. */
function reselect(changedId: string) {
  const ids = entries.map((e) => e.field.id);
  selectFields(ids.includes(changedId) ? ids : [changedId], { keepView: true });
}

/** Boundary editing, exclusions, rename and restore for each selected field. */
function renderBoundaryTools() {
  const multi = entries.length > 1;
  $('boundaryTools').innerHTML = entries
    .map(({ field: f }) => {
      const parts = polygonsOf(f.geometry);
      const kinds = holeKindsOf(f);
      const id = esc(f.id);
      const partBtns =
        parts.length === 1
          ? `<button class="btn" type="button" data-fid="${id}" data-edit-part="0">✎ Edit boundary</button>`
          : parts
              .map(
                (p, i) =>
                  `<button class="btn" type="button" data-fid="${id}" data-edit-part="${i}">✎ Edit part ${i + 1} · ${fmt(ringAcres(openRing(p[0])), 1)} ac</button>`,
              )
              .join('');
      const items: string[] = [];
      parts.forEach((p, i) =>
        p.slice(1).forEach((ring, j) => {
          const kind = kinds[i][j];
          const n = items.length + 1;
          items.push(`<li>
            <div class="ex-head"><strong>Exclusion ${n}</strong><span class="muted small">${fmt(ringAcres(openRing(ring)), 2)} ac</span>
              <button class="btn ex-btn" type="button" data-fid="${id}" data-ex-edit="${i}:${j}">Edit</button>
              <button class="btn ex-btn danger-text" type="button" data-fid="${id}" data-ex-del="${i}:${j}" aria-label="Delete exclusion ${n}">✕</button>
            </div>
            <div class="seg" role="radiogroup">
              <button type="button" role="radio" aria-checked="${kind === 'drive'}" data-fid="${id}" data-ex-kind="${i}:${j}:drive">Drive through</button>
              <button type="button" role="radio" aria-checked="${kind === 'avoid'}" data-fid="${id}" data-ex-kind="${i}:${j}:avoid">Go around</button>
            </div>
          </li>`);
        }),
      );
      return `<section class="boundary-field">
        <h3>${multi ? esc(f.name) : 'Boundary'}</h3>
        <div class="row gap wrap">${partBtns}
          <button class="btn" type="button" data-fid="${id}" data-rename>Rename</button>
          ${f.originalGeometry ? `<button class="btn" type="button" data-fid="${id}" data-restore>Restore imported boundary</button>` : ''}
        </div>
        <h4>Exclusions <button type="button" class="info" data-help="exclusions" aria-label="What are exclusions?">i</button></h4>
        <ul class="exclusion-list">${items.length ? items.join('') : '<li class="muted small">None. Add waterways, trees, ponds or buildings that don\'t get product.</li>'}</ul>
        <button class="btn" type="button" data-fid="${id}" data-add-hole>+ Add exclusion</button>
      </section>`;
    })
    .join('');
  $('editMapBtn').hidden = !entries.length;
}

$('boundaryTools').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const el = t.closest<HTMLElement>('[data-fid]');
  if (!el) return;
  const f = fields.find((x) => x.id === el.dataset.fid);
  if (!f) return;
  const d = el.dataset;
  if (d.editPart !== undefined) {
    startEdit('edit', { part: Number(d.editPart) }, f.id);
  } else if (d.exEdit) {
    const [i, j] = d.exEdit.split(':').map(Number);
    startEdit('edit', { part: i, hole: j }, f.id);
  } else if (d.addHole !== undefined) {
    startEdit('hole', undefined, f.id);
  } else if (d.exDel) {
    const [i, j] = d.exDel.split(':').map(Number);
    if (!confirm('Delete this exclusion?')) return;
    const parts = polygonsOf(f.geometry).map((p) => p.map((r) => r.slice()));
    const kinds = holeKindsOf(f);
    parts[i].splice(j + 1, 1);
    kinds[i].splice(j, 1);
    saveFieldChange(f, geometryFrom(parts), kinds);
    reselect(f.id);
  } else if (d.exKind) {
    const [i, j, kind] = d.exKind.split(':');
    const kinds = holeKindsOf(f);
    kinds[Number(i)][Number(j)] = kind as ExclusionKind;
    saveFieldChange(f, f.geometry, kinds);
    reselect(f.id);
    toast(kind === 'avoid' ? 'Laps now go around this exclusion' : 'Passes now drive through this exclusion');
  } else if (d.rename !== undefined) {
    const name = prompt('Field name', f.name);
    if (!name?.trim()) return;
    f.name = name.trim();
    f.updatedAt = Date.now();
    store.saveFields(fields);
    reselect(f.id);
  } else if (d.restore !== undefined) {
    if (!f.originalGeometry) return;
    if (!confirm(`Put ${f.name} back the way it was imported? Your boundary edits and exclusions are removed.`)) return;
    f.geometry = f.originalGeometry;
    f.holeKinds = f.originalHoleKinds;
    f.originalGeometry = undefined;
    f.originalHoleKinds = undefined;
    f.updatedAt = Date.now();
    store.saveFields(fields);
    reselect(f.id);
    toast('Imported boundary restored');
  }
});

// ✎ on the map: edit right away with one field; with several, show the list.
$('editMapBtn').addEventListener('click', () => {
  if (entries.length === 1) {
    startEdit('edit', undefined, entries[0].field.id);
    return;
  }
  const card = $('fieldCard') as HTMLDetailsElement;
  card.open = true;
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast('Pick which field to edit in 1 Field');
});
$('drawUndo').addEventListener('click', () => editSession?.editor.undo());
$('drawCancel').addEventListener('click', stopEdit);
$('drawDone').addEventListener('click', saveEdit);

// ---------------------------------------------------------------------------
// Agvance (boundary server)

let remoteTimer = 0;
async function renderRemote() {
  const cfg = settings.boundaryServer;
  const ul = $('remoteList');
  if (!cfg?.url) return;
  ul.innerHTML = '<li class="empty">Loading…</li>';
  try {
    const items = await listRemoteFields(cfg, ($('remoteSearch') as HTMLInputElement).value.trim());
    ul.innerHTML = items.length
      ? items
          .map(
            (f) => `<li><button type="button" class="pick" data-rid="${esc(f.id)}">
              <span class="name">${esc(f.name)}</span>
              <span class="meta">${esc([f.grower, f.farm, f.acres ? fmt(f.acres) + ' ac' : ''].filter(Boolean).join(' · '))}</span>
            </button></li>`,
          )
          .join('')
      : '<li class="empty">No fields found.</li>';
    ul.querySelectorAll<HTMLElement>('[data-rid]').forEach((el) => {
      el.onclick = async () => {
        const summary = items.find((i) => i.id === el.dataset.rid)!;
        try {
          const geometry = await fetchRemoteBoundary(cfg, summary.id);
          const existing = fields.find((f) => f.source === `agvance:${summary.id}`);
          if (existing) {
            existing.geometry = geometry;
            existing.name = summary.name;
            existing.updatedAt = Date.now();
            store.saveFields(fields);
            ($('remoteSheet') as HTMLDialogElement).close();
            selectField(existing.id);
          } else {
            const [added] = addFields([{ ...summary, geometry }], `agvance:${summary.id}`);
            ($('remoteSheet') as HTMLDialogElement).close();
            selectField(added.id);
          }
        } catch (err) {
          toast((err as Error).message, true);
        }
      };
    });
  } catch (err) {
    ul.innerHTML = `<li class="empty">${esc((err as Error).message)}</li>`;
  }
}

$('syncBtn').addEventListener('click', () => {
  ($('fieldsSheet') as HTMLDialogElement).close();
  openSheet('remoteSheet');
  renderRemote();
});
$('remoteSearch').addEventListener('input', () => {
  clearTimeout(remoteTimer);
  remoteTimer = window.setTimeout(renderRemote, 300);
});

// ---------------------------------------------------------------------------
// Controls

function syncHeadingUi() {
  setSeg('headingSeg', plan.headingMode);
  const range = $('headingRange') as HTMLInputElement;
  range.value = String(Math.round(plan.headingDeg));
  $('headingOut').textContent =
    entries.length > 1 && plan.headingMode !== 'manual'
      ? 'each field'
      : `${fmt(plan.headingDeg, plan.headingMode === 'optimized' ? 1 : 0)}°`;
}

function syncMachineUi() {
  const m = activeMachine();
  const sel = $('machineSelect') as HTMLSelectElement;
  sel.innerHTML = machines.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  sel.value = m.id;
  ($('widthInput') as HTMLInputElement).value = String(m.widthFt);
  ($('sectionsInput') as HTMLInputElement).value = String(m.sections);
  setSeg('shutoffSeg', m.shutoff);
  setSeg('cornerSeg', m.cornerStyle);
  const bias = m.biasPct ?? 0;
  setSeg('biasDirSeg', bias < 0 ? 'less' : 'more');
  ($('biasInput') as HTMLInputElement).value = bias ? String(Math.abs(bias)) : '';
  // Stored as % of requested (96); shown as the decrease (4).
  const decrease = m.trackingPct && m.trackingPct !== 100 ? Math.round((100 - m.trackingPct) * 100) / 100 : 0;
  ($('trackingInput') as HTMLInputElement).value = decrease ? String(decrease) : '';
  const note = $('trackModelNote');
  note.hidden = !m.trackingModel;
  if (m.trackingModel) {
    const cpm = changesPerMile();
    note.innerHTML =
      `Learned from your jobs: <b>${fmt(m.trackingModel.a * 100, 1)}%</b> plus <b>${fmt(m.trackingModel.k * 1000, 1)}%</b> per 10 speed changes a mile.` +
      (cpm !== undefined ? ` This field has ${fmt(cpm, 0)} a mile, so <b>${fmt((1 - machineTracking()) * 100, 1)}%</b>.` : '') +
      ' Type a number to use a flat value instead.';
  }
  updateSummaries();
}

function syncControls() {
  $('lapsOut').textContent = String(plan.laps);
  syncHeadingUi();
  syncMachineUi();
  const p = settings.product;
  ($('rateInput') as HTMLInputElement).value = p.rate ? String(p.rate) : '';
  ($('unitSelect') as HTMLSelectElement).value = p.unit;
  ($('loadedInput') as HTMLInputElement).value = p.loaded ? String(p.loaded) : '';
  ($('loadedAsSelect') as HTMLSelectElement).value = p.loadedAs ?? 'product';
  ($('densityInput') as HTMLInputElement).value = p.density ? String(p.density) : '';
  syncAdjustUi();
  updateSummaries();
  $('loadedUnitOpt').textContent = p.unit;
}

function planChanged() {
  updateSummaries();
  saveFieldPrefs();
  schedulePlan();
}

$('lapsMinus').addEventListener('click', () => {
  plan.laps = Math.max(0, plan.laps - 1);
  $('lapsOut').textContent = String(plan.laps);
  planChanged();
});
$('lapsPlus').addEventListener('click', () => {
  plan.laps = Math.min(8, plan.laps + 1);
  $('lapsOut').textContent = String(plan.laps);
  planChanged();
});

onSeg('headingSeg', (v) => {
  plan.headingMode = v as typeof plan.headingMode;
  syncHeadingUi();
  planChanged();
});
$('headingRange').addEventListener('input', (e) => {
  plan.headingMode = 'manual';
  plan.headingDeg = parseFloat((e.target as HTMLInputElement).value);
  syncHeadingUi();
  planChanged();
});

function updateMachine(patch: Partial<MachineRecord>) {
  const m = activeMachine();
  Object.assign(m, patch);
  if (!machines.includes(m)) machines = [...machines, m];
  store.saveMachines(machines);
  syncMachineUi();
  planChanged();
}

onSeg('shutoffSeg', (v) => updateMachine({ shutoff: v as ShutoffMode }));

function biasChanged(dir?: string) {
  const mag = Math.abs(num($('biasInput') as HTMLInputElement) ?? 0);
  const current = $('biasDirSeg').querySelector<HTMLElement>('[aria-checked="true"]')?.dataset.v;
  const d = dir ?? current ?? 'more';
  if (mag > 50) {
    toast('Bias over 50% looks like a typo; check the number.', true);
    syncMachineUi();
    return;
  }
  const m = activeMachine();
  m.biasPct = d === 'less' ? -mag : mag;
  store.saveMachines(machines);
  setSeg('biasDirSeg', d);
  renderResults();
}
onSeg('biasDirSeg', (v) => biasChanged(v));
function setTrackingDecrease(decrease: number | undefined) {
  activeMachine().trackingPct = decrease ? 100 - decrease : undefined;
  // Typing a number means "use this flat value", not the learned model.
  activeMachine().trackingModel = undefined;
  $('trackModelNote').hidden = true;
  store.saveMachines(machines);
  renderResults();
}
$('trackingInput').addEventListener('input', () => {
  const v = num($('trackingInput') as HTMLInputElement);
  if (v !== undefined && (v < -20 || v > 50)) return; // still typing, or a typo
  setTrackingDecrease(v);
});
// Requested + job average → decrease, filled in for the operator.
function trackingFromSummary() {
  const req = num($('trackReq') as HTMLInputElement);
  const avg = num($('trackAvg') as HTMLInputElement);
  if (!req || !avg || req <= 0 || avg <= 0) return;
  const decrease = Math.round((1 - avg / req) * 1000) / 10;
  if (decrease < -20 || decrease > 50) return;
  ($('trackingInput') as HTMLInputElement).value = String(decrease);
  setTrackingDecrease(decrease);
}
$('trackReq').addEventListener('input', trackingFromSummary);
$('trackAvg').addEventListener('input', trackingFromSummary);
$('biasInput').addEventListener('input', () => biasChanged());
onSeg('cornerSeg', (v) => updateMachine({ cornerStyle: v as CornerStyle }));

$('machineSelect').addEventListener('change', (e) => {
  settings.activeMachineId = (e.target as HTMLSelectElement).value;
  saveSettings();
  syncMachineUi();
  planChanged();
});
$('widthInput').addEventListener('change', (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (v >= 1 && v <= 400) updateMachine({ widthFt: v });
  else syncMachineUi();
});
$('sectionsInput').addEventListener('change', (e) => {
  const v = Math.round(parseFloat((e.target as HTMLInputElement).value));
  if (v >= 1 && v <= 48) updateMachine({ sections: v });
  else syncMachineUi();
});
$('addMachineBtn').addEventListener('click', () => {
  const name = prompt('Machine name?', 'New machine');
  if (!name) return;
  const base = activeMachine();
  const m: MachineRecord = { ...base, id: uid(), name: name.trim() };
  machines = [...machines, m];
  settings.activeMachineId = m.id;
  saveSettings();
  store.saveMachines(machines);
  syncMachineUi();
  planChanged();
});
$('renameMachineBtn').addEventListener('click', () => {
  const name = prompt('Rename machine', activeMachine().name);
  if (name?.trim()) updateMachine({ name: name.trim() });
});
$('deleteMachineBtn').addEventListener('click', () => {
  if (machines.length <= 1) {
    toast('Keep at least one machine.', true);
    return;
  }
  const m = activeMachine();
  if (!confirm(`Delete machine "${m.name}"?`)) return;
  machines = machines.filter((x) => x.id !== m.id);
  store.saveMachines(machines);
  settings.activeMachineId = machines[0].id;
  saveSettings();
  syncMachineUi();
  planChanged();
});

function syncAdjustUi() {
  const byDensity = densityMode();
  // Liquids and counts are adjusted by rate only.
  $('adjustRow').hidden = !isDryUnit(settings.product.unit);
  setSeg('adjustSeg', byDensity ? 'density' : 'rate');
  $('densityBlock').hidden = !byDensity;
}

function productChanged() {
  settings.product = {
    rate: num($('rateInput') as HTMLInputElement) ?? 0,
    unit: ($('unitSelect') as HTMLSelectElement).value,
    loaded: num($('loadedInput') as HTMLInputElement),
    loadedAs: ($('loadedAsSelect') as HTMLSelectElement).value as 'product' | 'acres',
    adjustBy: settings.product.adjustBy,
    density: num($('densityInput') as HTMLInputElement),
  };
  $('loadedUnitOpt').textContent = settings.product.unit;
  ($('loadedInput') as HTMLInputElement).placeholder = settings.product.loadedAs === 'acres' ? 'e.g. 67' : 'e.g. 24000';
  saveSettings();
  renderResults();
}
onSeg('adjustSeg', (v) => {
  settings.product.adjustBy = v as 'rate' | 'density';
  saveSettings();
  syncAdjustUi();
  renderResults();
});
$('densityInput').addEventListener('input', productChanged);
$('rateInput').addEventListener('input', productChanged);
$('unitSelect').addEventListener('change', productChanged);
$('loadedInput').addEventListener('input', productChanged);
$('loadedAsSelect').addEventListener('change', productChanged);

// Select-all on focus makes retyping numbers with gloves on much easier.
for (const el of document.querySelectorAll<HTMLInputElement>('input[type="number"]')) {
  el.addEventListener('focus', () => setTimeout(() => el.select(), 0));
}

// ---------------------------------------------------------------------------
// Settings sheet

$('settingsBtn').addEventListener('click', () => {
  ($('serverUrl') as HTMLInputElement).value = settings.boundaryServer?.url ?? '';
  ($('serverToken') as HTMLInputElement).value = settings.boundaryServer?.token ?? '';
  setSeg('themeSeg', settings.theme);
  setSeg('imagerySeg', settings.imagery ?? 'google-satellite');
  ($('googleKey') as HTMLInputElement).value = settings.googleKey ?? '';
  $('googleTestResult').hidden = true;
  ($('googleKey') as HTMLInputElement).placeholder = import.meta.env.VITE_GOOGLE_MAPS_API_KEY
    ? 'Using the key built into this app'
    : 'AIza…';
  openSheet('settingsSheet');
});
onSeg('themeSeg', (v) => {
  settings.theme = v as Settings['theme'];
  saveSettings();
  applyTheme();
});
onSeg('imagerySeg', (v) => {
  setSeg('imagerySeg', v);
  settings.imagery = v as Imagery;
  saveSettings();
  void setBaseLayer();
  const shown = effectiveImagery();
  if (shown !== settings.imagery) {
    toast(
      navigator.onLine
        ? 'Google imagery needs a key: Settings → Advanced.'
        : 'No signal: showing saved Esri imagery until you have signal.',
    );
  }
});
$('saveGoogleBtn').addEventListener('click', () => {
  const key = ($('googleKey') as HTMLInputElement).value.trim();
  if (key !== (settings.googleKey ?? '')) clearGoogleSession();
  settings.googleKey = key || undefined;
  saveSettings();
  void setBaseLayer();
  toast(key ? 'Key saved' : 'Using the key built into the app');
});

$('testGoogleBtn').addEventListener('click', async () => {
  const out = $('googleTestResult');
  const typed = ($('googleKey') as HTMLInputElement).value.trim();
  const key = typed || (import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '').trim();
  out.hidden = false;
  out.className = 'test-result';
  out.textContent = 'Testing…';
  const r = await testGoogleKey(key);
  out.className = `test-result ${r.ok ? 'ok' : 'bad'}`;
  out.innerHTML =
    `<strong>${r.ok ? '✓' : '✕'} ${esc(r.message)}</strong>` +
    (r.detail && r.detail !== r.message ? `<div class="small muted">Google said: ${esc(r.detail)}</div>` : '') +
    `<div class="small muted">Testing ${typed ? 'the key typed above' : 'the key built into the app'} from ${esc(location.origin)}</div>`;
  if (r.ok) {
    clearGoogleSession();
    void setBaseLayer();
  }
});

$('imageryBtn').addEventListener('click', () => {
  if (!googleKey()) {
    toast('Add a Google Maps API key in Settings to use Google imagery.');
    return;
  }
  const order: Imagery[] = ['google-satellite', 'google-hybrid', 'esri'];
  const cur = settings.imagery ?? 'google-satellite';
  settings.imagery = order[(order.indexOf(cur) + 1) % order.length];
  saveSettings();
  void setBaseLayer();
  toast(
    effectiveImagery() === settings.imagery ? IMAGERY_NAMES[settings.imagery] : 'No signal: showing saved Esri imagery',
  );
});

$('saveServerBtn').addEventListener('click', () => {
  const url = ($('serverUrl') as HTMLInputElement).value.trim();
  const token = ($('serverToken') as HTMLInputElement).value.trim();
  settings.boundaryServer = url ? { url, token } : undefined;
  saveSettings();
  toast(url ? 'Boundary server saved' : 'Boundary server removed');
});
$('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ version: 1, fields, machines, densityReadings }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `applied-acres-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});
$('restoreInput').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.fields) || !Array.isArray(data.machines)) throw new Error('Not a backup file.');
    const known = new Set(fields.map((f) => f.id));
    fields = [...fields, ...data.fields.filter((f: FieldRecord) => !known.has(f.id))];
    const knownM = new Set(machines.map((m) => m.id));
    machines = [...machines, ...data.machines.filter((m: MachineRecord) => !knownM.has(m.id))];
    store.saveFields(fields);
    store.saveMachines(machines);
    if (Array.isArray(data.densityReadings)) {
      const knownR = new Set(densityReadings.map((r) => r.id));
      densityReadings = [...densityReadings, ...data.densityReadings.filter((r: DensityReading) => !knownR.has(r.id))];
      store.saveDensityReadings(densityReadings);
    }
    syncMachineUi();
    toast(`Restored ${data.fields.length} fields, ${data.machines.length} machines`);
  } catch (err) {
    toast((err as Error).message, true);
  }
});

// ---------------------------------------------------------------------------
// ⓘ help

document.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-help]');
  if (!b) return;
  // Don't let a tap on ⓘ inside a label focus the input or toggle a section.
  e.preventDefault();
  e.stopPropagation();
  const h = HELP[b.dataset.help!];
  if (!h) return;
  $('helpTitle').textContent = h.title;
  $('helpDiagram').innerHTML = h.diagram ?? '';
  $('helpDiagram').hidden = !h.diagram;
  $('helpBody').innerHTML = h.body;
  openSheet('helpSheet');
}, true);

// ---------------------------------------------------------------------------
// First-run setup: machine → product → first field.

type MachineKind = 'spinner' | 'boom' | 'sprayer';
const KIND_DEFAULTS: Record<MachineKind, Omit<MachineRecord, 'id' | 'name' | 'widthFt'> & { width: number; label: string }> = {
  spinner: { label: 'Spinner', width: 70, sections: 1, shutoff: 'center', cornerStyle: 'overrun', defaultHeadlandLaps: 2 },
  boom: { label: 'Dry boom', width: 60, sections: 1, shutoff: 'center', cornerStyle: 'pivot', defaultHeadlandLaps: 2 },
  sprayer: { label: 'Sprayer', width: 120, sections: 9, shutoff: 'center', cornerStyle: 'pivot', defaultHeadlandLaps: 1 },
};
let setupStep = 1;
let setupKind: MachineKind = 'spinner';
let setupAdjust: 'rate' | 'density' = 'rate';

function showSetupStep(n: number) {
  setupStep = n;
  for (const pane of document.querySelectorAll<HTMLElement>('#setupSheet .setup-pane')) pane.hidden = pane.dataset.s !== String(n);
  for (const li of document.querySelectorAll<HTMLElement>('#setupSteps li')) {
    const s = Number(li.dataset.s);
    li.classList.toggle('active', s === n);
    li.classList.toggle('done', s < n);
  }
  $('setupError').hidden = true;
  ($('setupBack') as HTMLButtonElement).hidden = n === 1;
  $('setupNext').textContent = n === 3 ? 'Skip for now' : 'Next';
  $('suAdjustRow').hidden = !isDryUnit(($('suUnit') as HTMLSelectElement).value);
}

function setSetupKind(kind: MachineKind) {
  setupKind = kind;
  setSeg('suType', kind);
  const d = KIND_DEFAULTS[kind];
  ($('suWidth') as HTMLInputElement).placeholder = `e.g. ${d.width}`;
  ($('suSections') as HTMLInputElement).value = String(d.sections);
}

function openSetup() {
  setSetupKind(setupKind);
  setSeg('suAdjust', setupAdjust);
  const r = settings.product.rate;
  if (r && !($('suRate') as HTMLInputElement).value) ($('suRate') as HTMLInputElement).value = String(r);
  showSetupStep(1);
  openSheet('setupSheet');
}

function setupError(msg: string) {
  $('setupError').textContent = msg;
  $('setupError').hidden = false;
}

/** Saves the machine and product from steps 1–2. */
function commitSetup(): boolean {
  const width = num($('suWidth') as HTMLInputElement);
  if (!width || width < 1 || width > 400) {
    showSetupStep(1);
    setupError('Enter the working width in feet.');
    return false;
  }
  const d = KIND_DEFAULTS[setupKind];
  const sections = Math.max(1, Math.min(48, Math.round(num($('suSections') as HTMLInputElement) ?? d.sections)));
  const name = ($('suName') as HTMLInputElement).value.trim() || `${d.label} ${fmt(width, 0)} ft`;
  const m: MachineRecord = {
    id: uid(),
    name,
    widthFt: width,
    sections,
    shutoff: d.shutoff,
    cornerStyle: d.cornerStyle,
    defaultHeadlandLaps: d.defaultHeadlandLaps,
  };
  // Replace the made-up starter machines the first time through.
  const untouched = machines.every((x) => DEFAULT_MACHINES.some((dm) => dm.id === x.id));
  machines = untouched ? [m] : [...machines, m];
  store.saveMachines(machines);
  settings.activeMachineId = m.id;
  plan.laps = m.defaultHeadlandLaps;
  const unit = ($('suUnit') as HTMLSelectElement).value;
  settings.product = {
    ...settings.product,
    rate: num($('suRate') as HTMLInputElement) ?? settings.product.rate,
    unit,
    adjustBy: isDryUnit(unit) ? setupAdjust : 'rate',
  };
  settings.setupDone = true;
  saveSettings();
  syncControls();
  renderResults();
  return true;
}

onSeg('suType', (v) => setSetupKind(v as MachineKind));
onSeg('suAdjust', (v) => {
  setupAdjust = v as 'rate' | 'density';
  setSeg('suAdjust', setupAdjust);
});
$('suUnit').addEventListener('change', () => {
  $('suAdjustRow').hidden = !isDryUnit(($('suUnit') as HTMLSelectElement).value);
});
$('setupBack').addEventListener('click', () => showSetupStep(Math.max(1, setupStep - 1)));
$('setupNext').addEventListener('click', () => {
  if (setupStep === 1) {
    const w = num($('suWidth') as HTMLInputElement);
    if (!w || w < 1 || w > 400) return setupError('Enter the working width in feet.');
    showSetupStep(2);
  } else if (setupStep === 2) {
    const r = num($('suRate') as HTMLInputElement);
    if (!r || r <= 0) return setupError('Enter the rate you usually put on.');
    if (commitSetup()) showSetupStep(3);
  } else {
    ($('setupSheet') as HTMLDialogElement).close();
  }
});
$('setupSkip').addEventListener('click', () => ($('setupSheet') as HTMLDialogElement).close());
$('setupSheet').addEventListener('close', () => {
  if (!settings.setupDone) {
    settings.setupDone = true;
    saveSettings();
  }
});
$('suFile').addEventListener('change', async (e) => {
  ($('setupSheet') as HTMLDialogElement).close();
  await importPicked(e.target as HTMLInputElement);
});
$('suDraw').addEventListener('click', () => {
  ($('setupSheet') as HTMLDialogElement).close();
  startEdit('new');
});
$('suDemo').addEventListener('click', () => {
  ($('setupSheet') as HTMLDialogElement).close();
  const [added] = addFields([DEMO_FIELD], 'demo');
  selectField(added.id);
  toast('Demo field loaded. Try changing the rate or work plan.');
});
$('rerunSetupBtn').addEventListener('click', () => {
  ($('settingsSheet') as HTMLDialogElement).close();
  openSetup();
});


// ---------------------------------------------------------------------------
// New job from a blend ticket: read the ticket, pick or bring in the field,
// confirm the numbers, start.

interface JobDraft {
  ticket: Ticket | null;
  /** Fields listed in the Field step (matches and new imports), in order. */
  offered: string[];
  picked: Set<string>;
  /** Drawing a boundary on the map for this job. */
  drawing?: boolean;
}
let job: JobDraft | null = null;
let jobStep = 1;

const norm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** How well a saved field fits the ticket: Agvance ID, then field and grower names. */
function ticketMatch(f: FieldRecord, t: Ticket): number {
  let score = 0;
  if (t.fieldId && f.externalId && norm(f.externalId) === norm(t.fieldId)) score += 100;
  const fn = norm(f.name);
  const tn = norm(t.fieldName);
  if (tn && fn === tn) score += 60;
  else if (tn && fn && (fn.includes(tn) || tn.includes(fn))) score += 35;
  const fieldNo = t.fieldId?.split('/')[1]?.trim();
  if (fieldNo && fieldNo.length >= 3 && new RegExp(`\\b${fieldNo}\\b`).test(f.name)) score += 30;
  const g = norm(f.grower);
  const tg = norm(t.grower);
  if (score && g && tg && (g.includes(tg) || tg.includes(g))) score += 20;
  return score;
}

function showJobStep(n: number) {
  jobStep = n;
  for (const pane of document.querySelectorAll<HTMLElement>('#jobSheet .job-pane')) pane.hidden = pane.dataset.s !== String(n);
  for (const li of document.querySelectorAll<HTMLElement>('#jobSteps li')) {
    const s = Number(li.dataset.s);
    li.classList.toggle('active', s === n);
    li.classList.toggle('done', s < n);
  }
  $('jobError').hidden = true;
  ($('jobBack') as HTMLButtonElement).hidden = n === 1;
  $('jobNext').textContent = n === 3 ? 'Start job' : 'Next';
  if (n === 2) renderJobFields();
  if (n === 3) fillJobConfirm();
}

function jobError(msg: string) {
  $('jobError').textContent = msg;
  $('jobError').hidden = false;
}

function openJob() {
  if (editSession) stopEdit();
  (document.getElementById('fieldsSheet') as HTMLDialogElement).close();
  job = { ticket: null, offered: [], picked: new Set() };
  $('jobTicketRead').hidden = true;
  $('jobTicketRead').innerHTML = '';
  showTicketPicked(false);
  ($('jobFieldSearch') as HTMLInputElement).value = '';
  showJobStep(1);
  openSheet('jobSheet');
}

/** Once a ticket is read, shrink the choices so the summary and Next fit. */
function showTicketPicked(picked: boolean) {
  $('jobNoTicket').hidden = picked;
  $('jobTicketPick').textContent = picked ? 'Choose a different ticket' : 'Choose blend ticket PDF';
  $('jobTicketPickSub').hidden = picked;
  $('jobTicketPick').closest('.choice')!.classList.toggle('compact', picked);
}

function renderTicketRead(t: Ticket) {
  const unit = t.unit ?? 'lb';
  const rows: [string, string | undefined][] = [
    ['Ticket', t.ticketNo],
    ['Grower', t.grower],
    ['Field', [t.fieldName, t.fieldId && `(${t.fieldId})`].filter(Boolean).join(' ')],
    ['Acres', t.acres !== undefined ? `${fmt(t.acres, 2)} ac` : undefined],
    ['Rate', t.rate !== undefined ? `${fmt(t.rate, t.rate >= 100 ? 0 : 1)} ${unit}/ac` : undefined],
    ['Product', t.total !== undefined ? fmtQty(t.total, unit) + (t.batches && t.batches > 1 ? ` in ${t.batches} batches` : '') : undefined],
    ['Density', t.density !== undefined ? `${fmt(t.density, 2)} lb/ft³` : undefined],
    ['Blend', t.products.map((p) => `${p.name} ${fmt(p.rate, 0)}`).join(' + ') || undefined],
    ['Applied with', t.application],
    ['Crop', t.crop],
  ];
  const missing = ['Rate', 'Product', 'Acres'].filter((k) => !rows.find((r) => r[0] === k)?.[1]);
  $('jobTicketRead').innerHTML =
    `<dl class="kv">${rows
      .filter((r) => r[1])
      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v!)}</dd>`)
      .join('')}</dl>` +
    (missing.length ? `<p class="muted small">Not found on the ticket: ${missing.join(', ').toLowerCase()}. You can type it in on the last step.</p>` : '');
  $('jobTicketRead').hidden = false;
}

$('jobTicketFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !job) return;
  $('jobError').hidden = true;
  $('jobTicketRead').hidden = false;
  $('jobTicketRead').innerHTML = '<p class="muted">Reading ticket…</p>';
  try {
    const t = await importTicket(file);
    job.ticket = t;
    renderTicketRead(t);
    showTicketPicked(true);
    // Offer the fields that fit; tick the best one when it's clear.
    const scored = fields
      .map((f) => ({ f, s: ticketMatch(f, t) }))
      .filter((x) => x.s >= 35)
      .sort((a, b) => b.s - a.s)
      .slice(0, 6);
    job.offered = scored.map((x) => x.f.id);
    job.picked = new Set();
    if (scored[0] && scored[0].s >= 60 && (!scored[1] || scored[1].s < scored[0].s)) job.picked.add(scored[0].f.id);
  } catch (err) {
    job.ticket = null;
    $('jobTicketRead').hidden = true;
    showTicketPicked(false);
    jobError((err as Error).message || 'Couldn’t read that PDF.');
  }
});

$('jobNoTicket').addEventListener('click', () => {
  if (!job) return;
  job.ticket = null;
  job.offered = entries.map((e) => e.field.id);
  job.picked = new Set(job.offered);
  showJobStep(2);
});

function renderJobFields() {
  if (!job) return;
  const t = job.ticket;
  $('jobFieldHint').textContent = t
    ? job.offered.length
      ? `Saved fields that look like ${t.fieldName ? `“${t.fieldName}”` : 'this ticket'}. Tick every field on the ticket.`
      : `No saved field matches ${t.fieldName ? `“${t.fieldName}”` : 'this ticket'}. Import its boundary, draw it, or search your saved fields.`
    : 'Tick every field for this job, or import or draw its boundary.';
  const q = norm(($('jobFieldSearch') as HTMLInputElement).value);
  const extra = q
    ? fields.filter((f) => !job!.offered.includes(f.id) && [f.name, f.grower, f.farm].some((s) => norm(s).includes(q))).slice(0, 8)
    : [];
  const list = [...job.offered.map((id) => fields.find((f) => f.id === id)).filter((f): f is FieldRecord => !!f), ...extra];
  $('jobFieldList').innerHTML = list.length
    ? list
        .map((f) => {
          const on = job!.picked.has(f.id);
          return `<li class="${on ? 'checked' : ''}">
            <span class="check" aria-hidden="true">${on ? '✓' : ''}</span>
            <button type="button" class="pick" data-job-field="${f.id}" role="checkbox" aria-checked="${on}">
              <span class="name">${esc(f.name)}</span>
              <span class="meta">${esc(cachedMeta(f))}</span>
            </button>
          </li>`;
        })
        .join('')
    : '';
  $('jobFieldList').hidden = !list.length;
}

$('jobFieldList').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-job-field]');
  if (!b || !job) return;
  const id = b.dataset.jobField!;
  if (job.picked.has(id)) job.picked.delete(id);
  else {
    job.picked.add(id);
    if (!job.offered.includes(id)) job.offered.push(id);
  }
  $('jobError').hidden = true;
  renderJobFields();
});
$('jobFieldSearch').addEventListener('input', renderJobFields);

$('jobBoundaryFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length || !job) return;
  try {
    const items = await importFiles(files);
    const added = addFields(items, files.map((f) => f.name).join(', '));
    const t = job.ticket;
    job.offered = [...added.map((f) => f.id), ...job.offered];
    if (added.length === 1) job.picked.add(added[0].id);
    else if (t) {
      const best = added.filter((f) => ticketMatch(f, t) >= 35);
      for (const f of best) job.picked.add(f.id);
    }
    renderJobFields();
    drawBoundary();
    toast(added.length === 1 ? `Imported ${added[0].name}` : `Imported ${added.length} fields — tick the ones on this ticket`);
  } catch (err) {
    toast((err as Error).message, true);
  }
});

$('jobDraw').addEventListener('click', () => {
  if (!job) return;
  job.drawing = true;
  ($('jobSheet') as HTMLDialogElement).close();
  startEdit('new');
  toast('Draw the field, then tap Done to come back to the job.');
});
$('drawCancel').addEventListener('click', () => {
  if (!job?.drawing) return;
  job.drawing = false;
  showJobStep(2);
  openSheet('jobSheet');
});

function jobFields(): FieldRecord[] {
  return job ? [...job.picked].map((id) => fields.find((f) => f.id === id)).filter((f): f is FieldRecord => !!f) : [];
}

function jobBoundaryAcres(list: FieldRecord[]): number {
  let acres = 0;
  for (const f of list) {
    try {
      acres += toLocalField(f.geometry, holeKindsOf(f)).acres;
    } catch {
      /* skip bad geometry */
    }
  }
  return acres;
}

function fillJobConfirm() {
  if (!job) return;
  const t = job.ticket;
  const p = settings.product;
  const unit = t?.unit ?? p.unit;
  ($('jobRate') as HTMLInputElement).value = String(t?.rate ?? (p.rate || ''));
  ($('jobUnit') as HTMLSelectElement).value = unit;
  ($('jobTotal') as HTMLInputElement).value = t ? (t.total !== undefined ? String(t.total) : '') : '';
  ($('jobDensity') as HTMLInputElement).value = String(t?.density ?? p.density ?? '');
  const learned = t ? learnedDensity(t.products.filter((x) => x.unit === 'lb').map((x) => ({ name: x.name, rate: x.rate }))) : null;
  $('jobDensityLabel').textContent = learned ? 'Density (learned)' : 'Density on ticket';
  $('jobDensityHint').hidden = !learned;
  if (learned) {
    ($('jobDensity') as HTMLInputElement).value = learned.density.toFixed(1);
    $('jobDensityHint').textContent = `From your cup checks, ± ${fmt(learned.sd, 1)}.${t?.density ? ` Ticket says ${fmt(t.density, 2)}.` : ''}`;
  }
  const app = norm(t?.application);
  const machine = (app && machines.find((m) => norm(m.name).includes(app))) || activeMachine();
  $('jobMachine').innerHTML = machines
    .map((m) => `<option value="${m.id}" ${m.id === machine.id ? 'selected' : ''}>${esc(m.name)}</option>`)
    .join('');
  const list = jobFields();
  const acres = jobBoundaryAcres(list);
  $('jobFieldsSum').innerHTML = `<strong>${esc(list.map((f) => f.name).join(' + '))}</strong> · ${fmt(acres, 2)} ac boundary`;
  updateJobConfirm();
}

function updateJobConfirm() {
  if (!job) return;
  const unit = ($('jobUnit') as HTMLSelectElement).value;
  $('jobTotalUnit').textContent = unit;
  $('jobDensityField').hidden = !isDryUnit(unit);
  const t = job.ticket;
  const acres = jobBoundaryAcres(jobFields());
  const rate = num($('jobRate') as HTMLInputElement);
  const total = num($('jobTotal') as HTMLInputElement);
  const note = $('jobAcresNote');
  const worth = rate && total ? total / rate : undefined;
  const ticketAcres = t?.acres ?? worth;
  const lines: string[] = [];
  const off = ticketAcres && acres ? acres / ticketAcres - 1 : 0;
  if (Math.abs(off) > 0.015) {
    lines.push(
      `The ticket was figured on <b>${fmt(ticketAcres!, 2)} ac</b> but the boundary is <b>${fmt(acres, 2)} ac</b> (${fmtPct(off)}).` +
        (Math.abs(off) > 0.25 ? ' <b>That’s a big difference — check this is the right field.</b>' : ''),
    );
  }
  note.classList.toggle('severe', Math.abs(off) > 0.25);
  if (worth && t?.acres && Math.abs(worth / t.acres - 1) > 0.01) {
    lines.push(`The product is ${fmt(worth, 2)} acres' worth at ${fmt(rate!, 0)} ${unit}/ac, not the ${fmt(t.acres, 2)} ac on the ticket.`);
  }
  if (lines.length) lines.push('The answer will spread exactly the product given over the real field.');
  note.innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
  note.hidden = !lines.length;
}
for (const id of ['jobRate', 'jobTotal']) $(id).addEventListener('input', updateJobConfirm);
$('jobUnit').addEventListener('change', updateJobConfirm);

function startJob() {
  if (!job) return;
  const list = jobFields();
  if (!list.length) {
    showJobStep(2);
    return jobError('Tick the field for this job.');
  }
  const rate = num($('jobRate') as HTMLInputElement);
  if (!rate || rate <= 0) return jobError('Enter the target rate.');
  const unit = ($('jobUnit') as HTMLSelectElement).value;
  const total = num($('jobTotal') as HTMLInputElement);
  const density = num($('jobDensity') as HTMLInputElement);
  const machineId = ($('jobMachine') as HTMLSelectElement).value;
  const t = job.ticket;

  settings.activeMachineId = machineId;
  settings.product = {
    ...settings.product,
    rate,
    unit,
    loaded: total && total > 0 ? total : undefined,
    loadedAs: 'product',
    density: isDryUnit(unit) && density ? density : settings.product.density,
  };
  if (!isDryUnit(unit)) settings.product.adjustBy = 'rate';

  // Remember the ticket's IDs on the field so the next ticket finds it.
  const now = Date.now();
  list.forEach((f, i) => {
    const upd: FieldRecord = { ...f, updatedAt: now };
    if (t?.fieldId && list.length === 1) upd.externalId = t.fieldId;
    if (t?.grower && !f.grower) upd.grower = t.grower;
    if (i === 0) upd.prefs = { ...f.prefs, machineId };
    store.upsertField(upd);
  });
  fields = store.fields();
  settings.job = t
    ? {
        ticketNo: t.ticketNo,
        grower: t.grower,
        fieldName: t.fieldName,
        acres: t.acres,
        crop: t.crop,
        products: t.products.map((p) => p.name),
        ingredients: t.products.filter((p) => p.unit === 'lb').map((p) => ({ name: p.name, rate: p.rate })),
        ticketDensity: t.density,
        loaded: total && total > 0 ? total : undefined,
        fieldIds: list.map((f) => f.id),
        startedAt: now,
      }
    : undefined;
  saveSettings();
  ($('jobSheet') as HTMLDialogElement).close();
  job = null;
  selectFields(list.map((f) => f.id));
  toast(t?.ticketNo ? `Ticket ${t.ticketNo} started` : 'Job started');
}

$('jobBack').addEventListener('click', () => showJobStep(Math.max(1, jobStep - 1)));
$('jobNext').addEventListener('click', () => {
  if (!job) return;
  if (jobStep === 1) {
    if (!job.ticket) return jobError('Choose the blend ticket PDF, or tap “No ticket”.');
    showJobStep(2);
  } else if (jobStep === 2) {
    if (!job.picked.size) return jobError('Tick the field, or import or draw its boundary.');
    showJobStep(3);
  } else {
    startJob();
  }
});


// ---------------------------------------------------------------------------
// Finish a job: the Operations Center report gives the monitor's side, the
// ticket gives what was loaded, the operator enters what's left. The result
// goes straight into the machine's calibration log.

let finishReports: OpsReport[] = [];

function finishReport(): OpsReport | null {
  return combineReports(finishReports);
}

/** True when the planned fields are this job's, so the plan can be compared. */
function planIsForJob(): boolean {
  const j = settings.job;
  if (!result || !entries.length) return false;
  return !j || j.fieldIds.join() === entries.map((e) => e.field.id).join();
}

function openFinish() {
  if (editSession) stopEdit();
  for (const id of ['machineSheet', 'fieldsSheet']) (document.getElementById(id) as HTMLDialogElement).close();
  finishReports = [];
  const j = settings.job;
  const p = settings.product;
  $('finishJobName').textContent = j?.ticketNo
    ? `· Ticket ${j.ticketNo}`
    : entries.length
      ? `· ${entries.map((e) => e.field.name).join(' + ')}`
      : '';
  const loaded = j?.loaded ?? (p.loaded ? (p.loadedAs === 'acres' ? p.loaded * p.rate : p.loaded) : undefined);
  ($('finLoaded') as HTMLInputElement).value = loaded ? String(Math.round(loaded * 100) / 100) : '';
  $('finLoadedHint').textContent = j?.loaded ? 'From the ticket' : loaded ? 'From Product given' : '';
  ($('finLeft') as HTMLInputElement).value = '';
  ($('finCup') as HTMLInputElement).value = '';
  const dry = isDryUnit(p.unit);
  const prog = densityMode() ? recommendedDensity : p.density;
  ($('finProg') as HTMLInputElement).value = dry && prog ? prog.toFixed(1) : '';
  $('finProgField').hidden = !dry;
  $('finCupField').hidden = !dry;
  for (const el of document.querySelectorAll('.finish-unit')) el.textContent = p.unit;
  $('finMachine').innerHTML = machines
    .map((m) => `<option value="${m.id}" ${m.id === activeMachine().id ? 'selected' : ''}>${esc(m.name)}</option>`)
    .join('');
  $('finishRead').hidden = true;
  $('finishInputs').hidden = true;
  $('finishError').hidden = true;
  $('finishPick').textContent = 'Choose Operations Center report PDF';
  ($('finishSave') as HTMLButtonElement).disabled = true;
  openSheet('finishSheet');
}

function renderFinishRead() {
  const r = finishReport();
  if (!r) return;
  const unit = r.unit;
  const when = r.start
    ? `${r.start.toLocaleDateString()} ${r.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${
        r.end ? `–${r.end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''
      }`
    : undefined;
  const rows: [string, string | undefined][] = [
    ['Field', [r.field, r.farm && `(${r.farm})`].filter(Boolean).join(' ')],
    ['Product', r.product],
    ['When', when],
    ['Applied acres (monitor)', `${fmt(r.areaAc, 2)} ac`],
    ['Applied total (monitor)', r.appliedTotal !== undefined ? fmtQty(r.appliedTotal, unit) : undefined],
    [
      'Applied vs target rate',
      r.appliedRate !== undefined && r.targetRate !== undefined
        ? `${fmt(r.appliedRate, 1)} of ${fmt(r.targetRate, 1)} ${unit}/ac`
        : undefined,
    ],
    ['Machine', r.equipment],
  ];
  const notes: string[] = [];
  const j = settings.job;
  const jobNames = entries.map((e) => norm(e.field.name));
  const reportNames = finishReports.map((x) => norm(x.field));
  if (entries.length && reportNames.length && !reportNames.some((n) => jobNames.some((jn) => jn && n && (jn.includes(n) || n.includes(jn))))) {
    notes.push(`The report is for “${esc(r.field ?? '?')}” but this job is “${esc(entries.map((e) => e.field.name).join(' + '))}”. Make sure it's the right report.`);
  }
  if (j?.ticketNo && finishReports.length === 1 && entries.length > 1) {
    notes.push('This ticket covered several fields. Add the report for each one.');
  }
  $('finishRead').innerHTML =
    `<dl class="kv">${rows
      .filter((x) => x[1])
      .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v!)}</dd>`)
      .join('')}</dl>` +
    (finishReports.length > 1 ? `<p class="muted small">${finishReports.length} reports added together.</p>` : '') +
    notes.map((n) => `<p class="finish-note">${n}</p>`).join('');
  $('finishRead').hidden = false;
  $('finishInputs').hidden = false;
  $('finishPick').textContent = 'Add another report (another field on this ticket)';
}

/** The job as it goes into the log, or why it can't yet. */
function finishJob(): { job: Omit<CalibrationRecord, 'id' | 'label' | 'date'>; check: NonNullable<ReturnType<typeof checkJob>> } | string {
  const r = finishReport();
  if (!r) return 'Load the job report first.';
  const loaded = num($('finLoaded') as HTMLInputElement);
  const left = num($('finLeft') as HTMLInputElement);
  if (!loaded) return 'Enter the product loaded.';
  if (left === undefined) return 'Enter what was left over (or tap Empty).';
  const requested = r.targetRate ?? settings.product.rate;
  if (!requested) return 'The report has no target rate.';
  const dry = isDryUnit(settings.product.unit);
  const cup = dry ? num($('finCup') as HTMLInputElement) : undefined;
  const programmed = dry ? num($('finProg') as HTMLInputElement) : undefined;
  const trueDensity = cup ?? (dry ? settings.product.density : undefined);
  const job = {
    requestedRate: requested,
    achievedRate: r.appliedRate,
    monitorTotal: r.appliedTotal,
    appliedAc: r.areaAc,
    used: loaded - left,
    trueDensity,
    programmedDensity: programmed,
    densityMeasured: !!cup,
    changesPerMile: planIsForJob() ? changesPerMile() : undefined,
    predictedAc: planIsForJob() && result ? result.appliedM2 / SQ_M_PER_ACRE : undefined,
    ticketNo: settings.job?.ticketNo,
  };
  const check = checkJob(job);
  if (!check) return 'Check the numbers: more left over than was loaded?';
  return { job, check };
}

function renderFinish() {
  const out = $('finishResult');
  const f = finishJob();
  ($('finishSave') as HTMLButtonElement).disabled = typeof f === 'string';
  if (typeof f === 'string') {
    out.innerHTML = finishReports.length ? `<p class="muted small">${f}</p>` : '';
    ($('finishSave') as HTMLButtonElement).textContent = 'Save to calibration log';
    return;
  }
  const { job, check } = f;
  const unit = settings.product.unit;
  const parts: string[] = [];
  parts.push(`<dl class="kv">
    <dt>Product used (loaded − left)</dt><dd class="strong">${fmtQty(job.used, unit)}</dd>
    <dt>Monitor says it put out</dt><dd>${fmtQty(check.monitorProduct, unit)}</dd>
    ${job.programmedDensity && job.trueDensity && Math.abs(job.programmedDensity - job.trueDensity) > 0.05 ? `<dt>Should have left at ${fmt(job.programmedDensity, 1)} set, ${fmt(job.trueDensity, 1)} real</dt><dd>${fmtQty(check.expectedOut, unit)}</dd>` : ''}
  </dl>`);
  if (check.tracking !== undefined) {
    parts.push(`<p class="finish-line"><b>Belt:</b> averaged ${fmt(Math.abs(1 - check.tracking) * 100, 1)}% ${check.tracking <= 1 ? 'under' : 'over'} the target.</p>`);
  }
  const g = check.gap;
  parts.push(
    `<p class="finish-line"><b>Machine vs monitor:</b> ${Math.abs(g) < 0.005 ? 'within ½%.' : `${fmt(Math.abs(g) * 100, 1)}% ${g > 0 ? 'more' : 'less'} went out than the monitor accounts for.`} ${
      job.densityMeasured
        ? 'Density was cup-checked, so this is the machine.'
        : 'Without a cup reading this is the machine and the ticket density mixed together; the log sorts them out over several jobs.'
    }</p>`,
  );
  if (job.predictedAc) {
    const e = job.appliedAc / job.predictedAc - 1;
    parts.push(`<p class="finish-line"><b>Acres:</b> plan predicted ${fmt(job.predictedAc, 1)} applied ac, monitor counted ${fmt(job.appliedAc, 1)} (${fmtPct(e)}).</p>`);
  }
  // A machine is never this far off; the inputs don't belong together.
  const odd = Math.abs(g) > 0.15;
  if (odd) {
    const r = finishReport()!;
    parts.push(`<div class="answer-warn severe"><strong>⚠ These numbers don't fit together (${fmtPct(g)}).</strong><ul>
      <li>The monitor says ${fmtQty(check.monitorProduct, unit)} went out on ${fmt(r.areaAc, 1)} ac, but ${fmtQty(job.used, unit)} was used.</li>
      <li>Is it the right report for this job? Reloaded during the job? Add every load to Product loaded.</li>
      ${job.programmedDensity ? `<li>Density set on the display: ${fmt(job.programmedDensity, 1)} lb/ft³. Is that what was really set?</li>` : ''}
    </ul>Saving it anyway would throw off the averages; it will be flagged in the log.</div>`);
  }
  ($('finishSave') as HTMLButtonElement).textContent = odd ? 'Save anyway' : 'Save to calibration log';
  out.innerHTML = parts.join('');
}

$('finishFile').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;
  $('finishError').hidden = true;
  try {
    for (const f of files) finishReports.push(await importOpsReport(f));
  } catch (err) {
    $('finishError').textContent = (err as Error).message;
    $('finishError').hidden = false;
    if (!finishReports.length) return;
  }
  // Pick the machine that ran this job by its serial number.
  const serial = finishReports.find((r) => r.serial)?.serial;
  const known = serial && machines.find((m) => m.equipment?.includes(serial));
  if (known) ($('finMachine') as HTMLSelectElement).value = known.id;
  renderFinishRead();
  renderFinish();
  ($('finLeft') as HTMLInputElement).focus();
});
for (const id of ['finLeft', 'finLoaded', 'finProg', 'finCup']) $(id).addEventListener('input', renderFinish);
$('finEmpty').addEventListener('click', (e) => {
  e.preventDefault();
  ($('finLeft') as HTMLInputElement).value = '0';
  renderFinish();
});

$('finishSave').addEventListener('click', () => {
  const f = finishJob();
  if (typeof f === 'string') {
    $('finishError').textContent = f;
    $('finishError').hidden = false;
    return;
  }
  const r = finishReport()!;
  const m = machines.find((x) => x.id === ($('finMachine') as HTMLSelectElement).value) ?? activeMachine();
  const j = settings.job;
  const label = j?.ticketNo
    ? `Ticket ${j.ticketNo}${j.fieldName ? ` · ${j.fieldName}` : ''}`
    : r.field ?? entries.map((e) => e.field.name).join(' + ');
  m.calibrations = [...(m.calibrations ?? []), { ...f.job, id: uid(), date: r.end?.getTime() ?? Date.now(), label }];
  if (r.serial && !m.equipment?.includes(r.serial)) m.equipment = [...(m.equipment ?? []), r.serial];
  store.saveMachines(machines);
  const ings = j?.ingredients;
  const cup = f.job.densityMeasured && f.job.trueDensity && ings?.length;
  if (cup) addDensityReading(ings, f.job.trueDensity!, j?.ticketNo);
  if (j) j.finishedAt = Date.now();
  settings.activeMachineId = m.id;
  saveSettings();
  ($('finishSheet') as HTMLDialogElement).close();
  renderResults();
  // Show the updated averages right away.
  openMachineSheet('calibrate');
  const n = m.calibrations.length;
  toast(`Logged to ${m.name} (${n} job${n === 1 ? '' : 's'})${cup ? ' and the density reading saved' : ''}`);
});

// ---------------------------------------------------------------------------
// Boot

applyTheme();
restoreFolds();
void setBaseLayer();
syncControls();
$('layersBtn').setAttribute('aria-pressed', 'true');
const lastIds = (settings.lastFieldIds ?? (settings.lastFieldId ? [settings.lastFieldId] : [])).filter((id) =>
  fields.some((f) => f.id === id),
);
if (lastIds.length) selectFields(lastIds);
else {
  renderResults();
  drawBoundary();
  const all = fields.flatMap((f) => fieldLatLngs(f).flatMap((p) => p[0])) as L.LatLngTuple[];
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
}
startGps();
// New install: walk through setup. Existing users (with fields) skip it.
if (!settings.setupDone) {
  if (fields.length) {
    settings.setupDone = true;
    saveSettings();
  } else {
    openSetup();
  }
}
