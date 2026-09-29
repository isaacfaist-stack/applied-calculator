import 'leaflet/dist/leaflet.css';
import './styles.css';
import L from 'leaflet';
import { registerSW } from 'virtual:pwa-register';

import { M_PER_FT, SQ_M_PER_ACRE, ringArea } from './engine/geometry';
import { makeProjection } from './engine/projection';
import type { CornerStyle, ShutoffMode } from './engine/plan';
import { actualRateAt, adviseMidField, adviseRate, densityFor } from './engine/rate';
import { type LocalField, distanceMiles, geometryCenter, geometryRings, pointInGeometry, toLocalField } from './fieldModel';
import { fetchRemoteBoundary, listRemoteFields } from './integrations/boundaryServer';
import { type BoundaryGeometry, importFiles } from './io/import';
import { PolygonEditor } from './map/editor';
import {
  GoogleMapsError,
  clearGoogleSession,
  createGoogleLayer,
  explainGoogleError,
  testGoogleKey,
} from './map/googleTiles';
import type { PlanRequest, PlanResponse } from './planWorker';
import { type FieldRecord, type Imagery, type MachineRecord, type Settings, DEFAULT_MACHINES, store, uid } from './store';

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
let activeField: FieldRecord | null = null;
let local: LocalField | null = null;
let result: PlanResponse | null = null;
let gps: [number, number] | null = null;
let showCoverage = true;
/** Density the app last told the operator to program (density mode). */
let recommendedDensity: number | undefined;

type EditMode = 'new' | 'edit' | 'hole';
let editSession: { mode: EditMode; fieldId?: string; editor: PolygonEditor } | null = null;

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

function saveSettings() {
  store.saveSettings(settings);
}

function saveFieldPrefs() {
  if (!activeField) return;
  activeField.prefs = {
    machineId: activeMachine().id,
    headlandLaps: plan.laps,
    headingDeg: plan.headingDeg,
    headingMode: plan.headingMode,
  };
  store.upsertField(activeField);
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
let coverageUrl = '';

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
  for (const f of fields) {
    if (f.id === activeField?.id) continue;
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
  if (!activeField || editSession?.fieldId === activeField.id) return;
  L.polygon(fieldLatLngs(activeField), { color: '#ffffff', weight: 3, fill: false, interactive: false }).addTo(
    layers.boundary,
  );
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
  if (!activeField) return;
  const pts = geometryRings(activeField.geometry).flatMap((p) => p[0].map(toLatLng));
  map.fitBounds(L.latLngBounds(pts as L.LatLngTuple[]), { padding: [24, 24] });
}

function drawPlanLayers() {
  layers.coverage.clearLayers();
  layers.lines.clearLayers();
  if (coverageUrl) URL.revokeObjectURL(coverageUrl);
  coverageUrl = '';
  if (!result || !local) return;
  const proj = local.proj;
  const ll = (x: number, y: number) => toLatLng(proj.toLonLat({ x, y }));

  if (showCoverage) {
    const c = result.coverage;
    const canvas = document.createElement('canvas');
    canvas.width = c.cols;
    canvas.height = c.rows;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(c.rgba), c.cols, c.rows), 0, 0);
    const bounds = L.latLngBounds([
      ll(c.minX, c.minY) as L.LatLngTuple,
      ll(c.minX + c.cols * c.cell, c.minY + c.rows * c.cell) as L.LatLngTuple,
    ]);
    const forId = result.id;
    canvas.toBlob((blob) => {
      if (!blob || !result || result.id !== forId || !showCoverage) return;
      coverageUrl = URL.createObjectURL(blob);
      L.imageOverlay(coverageUrl, bounds, { opacity: 0.85, interactive: false }).addTo(layers.coverage);
    });
  }

  const headland = result.headlandPaths.map((r) => [...r, r[0]].map((p) => ll(p.x, p.y)));
  L.polyline(headland as L.LatLngExpression[][], { color: '#fde047', weight: 1.5, opacity: 0.9, interactive: false }).addTo(
    layers.lines,
  );
  const passes = result.passLines.map(([a, b]) => [ll(a.x, a.y), ll(b.x, b.y)]);
  L.polyline(passes as L.LatLngExpression[][], {
    color: '#ffffff',
    weight: 1,
    opacity: 0.75,
    dashArray: '6 6',
    interactive: false,
  }).addTo(layers.lines);
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
  if (here && here.id !== activeField?.id) {
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

worker.onmessage = (e: MessageEvent<PlanResponse>) => {
  const r = e.data;
  if (r.id !== reqId) return; // stale
  $('computing').hidden = true;
  if (r.error) {
    toast(`Couldn't plan this field: ${r.error}`, true);
    return;
  }
  result = r;
  if (plan.headingMode !== 'manual') {
    plan.headingDeg = r.headingDeg;
    syncHeadingUi();
  }
  drawPlanLayers();
  renderResults();
};

function schedulePlan() {
  clearTimeout(planTimer);
  if (!local || !activeField) return;
  $('computing').hidden = false;
  planTimer = window.setTimeout(() => {
    const m = activeMachine();
    const req: PlanRequest = {
      id: ++reqId,
      fieldKey: activeField!.id + ':' + activeField!.updatedAt,
      polys: local!.polys,
      widthM: m.widthFt * M_PER_FT,
      sections: m.sections,
      headlandLaps: plan.laps,
      cornerStyle: m.cornerStyle,
      shutoff: m.shutoff,
      headingMode: plan.headingMode,
      headingDeg: plan.headingDeg,
    };
    worker.postMessage(req);
  }, 120);
}

// ---------------------------------------------------------------------------
// Results

function renderResults() {
  const has = !!(result && activeField);
  $('heroEmpty').hidden = has;
  $('heroBody').hidden = !has;
  $('breakdownCard').hidden = !has;
  if (!result || !activeField) return;

  const surfaceAc = result.surfaceM2 / SQ_M_PER_ACRE;
  const appliedAc = result.appliedM2 / SQ_M_PER_ACRE;
  $('surfaceAc').textContent = fmt(surfaceAc);
  $('appliedAc').textContent = fmt(appliedAc);
  $('overlapPct').textContent = fmtPct(appliedAc / surfaceAc - 1);

  const unit = settings.product.unit;
  const rate = settings.product.rate;
  const loaded = settings.product.loaded;
  const bias = machineBias();
  const a = adviseRate({ surfaceAc, appliedAc, targetRate: rate, loaded, bias });
  const answerChange = $('answerChange');
  const kv = $('productKv');
  const byDensity = settings.product.adjustBy === 'density';
  const density = settings.product.density;
  $('answerLabel').textContent = byDensity ? 'Set controller density to' : 'Set controller rate to';
  recommendedDensity = undefined;
  const blank = (msg: string) => {
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
      ? `Empties the ${fmtQty(loaded!, unit)} load across ${fmt(appliedAc)} applied ac. Ground gets ${fmt(a.groundRateIfEmptied!, 1)} ${unit}/ac.`
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
      $('answerSub').textContent = `Leave the rate at ${fmt(rate, rate >= 100 ? 0 : 1)} ${unit}/ac. ${why}`;
    }

    const rows: [string, string, string?][] = [
      ['Needed at target (surface ac)', fmtQty(a.productNeeded, unit), 'strong'],
      ['Used if rate is left at target', fmtQty(a.productAtTarget, unit)],
      [bias ? 'Extra from overlap + machine bias' : 'Extra from overlap', fmtQty(a.productAtTarget - a.productNeeded, unit)],
    ];
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
  $('planKv').innerHTML = [
    ['Headland laps', `${plan.laps} × ${fmt(m.widthFt, 0)} ft`],
    ['Headland applied', acres(result.headlandAppliedM2)],
    ['Passes', `${result.passCount} at ${fmt(result.headingDeg, 1)}°`],
    ['Pass applied', acres(result.passAppliedM2)],
    ['Distance with product on', `${fmt(result.onDistanceM / 1609.344, 2)} mi`],
  ]
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');

  syncAdjustUi();
  renderMidField();
}

function renderMidField() {
  const out = $('midAnswer');
  const unit = settings.product.unit;
  if (!result) {
    out.innerHTML = '';
    return;
  }
  const applied = num($('midAppliedInput'));
  const left = num($('midLeftInput'));
  if (applied === undefined || left === undefined) {
    out.innerHTML = '<p class="muted small">Fill in both numbers.</p>';
    return;
  }
  const plannedAppliedAc = result.appliedM2 / SQ_M_PER_ACRE;
  const displayRate = settings.product.rate;
  const byDensity = settings.product.adjustBy === 'density';
  const trueDensity = settings.product.density;
  // In density mode, what's going on the ground depends on the density
  // programmed now (the app's suggestion unless the operator says otherwise).
  const progNow = num($('midDensityInput')) ?? recommendedDensity ?? trueDensity;
  const densityReady = byDensity && !!trueDensity && !!progNow;
  const actualNow = densityReady ? actualRateAt(trueDensity!, displayRate, progNow!) : displayRate;
  const m = adviseMidField({
    plannedAppliedAc,
    appliedSoFarAc: applied,
    remaining: left,
    currentRate: actualNow,
    bias: machineBias(),
  });
  if (!m) {
    out.innerHTML = `<p class="muted small">Monitor already shows the planned ${fmt(plannedAppliedAc)} applied ac or more.</p>`;
    return;
  }
  const balance = `<p class="muted small">At the current setting you'd ${m.balance < 0 ? 'run out' : 'have left over'} about ${fmtQty(Math.abs(m.balance), unit)}.</p>`;
  if (byDensity && !trueDensity) {
    out.innerHTML = '<p class="muted small">Enter the product density in the Product card.</p>';
    return;
  }
  if (densityReady) {
    const newDensity = densityFor(trueDensity!, displayRate, m.rateToFinish);
    const ch = newDensity / progNow! - 1;
    out.innerHTML = `
      <div class="muted small">About ${fmt(m.remainingAc)} applied ac to go. Set density to</div>
      <div class="big">${fmt(newDensity, 1)} <span class="answer-unit">lb/ft³</span></div>
      <div class="answer-change ${ch > 0 ? 'down' : 'up'}">${fmtPct(ch)} vs. ${fmt(progNow!, 1)} now</div>
      <p class="muted small">Leave the rate at ${fmt(displayRate, 1)} ${esc(unit)}/ac.</p>${balance}`;
    return;
  }
  out.innerHTML = `
    <div class="muted small">About ${fmt(m.remainingAc)} applied ac to go. Set rate to</div>
    <div class="big">${fmt(m.rateToFinish, m.rateToFinish >= 100 ? 1 : 2)} <span class="answer-unit">${esc(unit)}/ac</span></div>
    <div class="answer-change ${m.changePct < 0 ? 'down' : 'up'}">${fmtPct(m.changePct)} vs. ${fmt(displayRate, 1)}</div>${balance}`;
}

// ---------------------------------------------------------------------------
// Field selection

function selectField(id: string | null, opts: { keepView?: boolean } = {}) {
  if (editSession) stopEdit();
  activeField = id ? fields.find((f) => f.id === id) ?? null : null;
  result = null;
  local = null;
  layers.coverage.clearLayers();
  layers.lines.clearLayers();
  settings.lastFieldId = activeField?.id;
  saveSettings();
  $('boundaryCard').hidden = !activeField;
  if (!activeField) {
    $('fieldName').textContent = 'Choose a field';
    drawBoundary();
    renderResults();
    updateGpsChip();
    return;
  }
  const f = activeField;
  $('fieldName').textContent = f.name;
  const p = f.prefs ?? {};
  if (p.machineId && machines.some((m) => m.id === p.machineId)) settings.activeMachineId = p.machineId;
  plan.laps = p.headlandLaps ?? activeMachine().defaultHeadlandLaps;
  plan.headingMode = p.headingMode ?? 'longest';
  plan.headingDeg = p.headingDeg ?? 0;
  try {
    local = toLocalField(f.geometry);
  } catch (err) {
    toast(`Boundary problem: ${(err as Error).message}`, true);
  }
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
      (f) => `<li>
        <button type="button" class="pick" data-id="${f.id}">
          <span class="name">${esc(f.name)}${here?.id === f.id ? ' <span class="here">• you are here</span>' : ''}</span>
          <span class="meta">${esc(cachedMeta(f))}</span>
        </button>
        <button type="button" class="del" data-del="${f.id}" aria-label="Delete ${esc(f.name)}">🗑</button>
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
      if (activeField?.id === f.id) selectField(null);
      else drawBoundary();
      renderFieldList();
    }
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
  renderFieldList();
  $('syncBtn').hidden = !settings.boundaryServer?.url;
  openSheet('fieldsSheet');
}

$('fieldBtn').addEventListener('click', openFields);
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-action="open-fields"]')) openFields();
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

$('fileInput').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
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
});

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

const EDIT_HINTS: Record<EditMode, string> = {
  new: 'Tap each corner of the field',
  edit: 'Drag corners to move · tap a corner to remove · tap a ◦ to add one',
  hole: 'Tap the corners of the area to leave out (waterway, farmstead, pond)',
};

function startEdit(mode: EditMode) {
  if (editSession) stopEdit();
  (document.getElementById('fieldsSheet') as HTMLDialogElement).close();
  let initial: L.LatLng[] = [];
  if (mode === 'edit') {
    if (!activeField) return;
    const part = polygonsOf(activeField.geometry)[largestPart(activeField.geometry)];
    initial = openRing(part[0]);
  } else if (mode === 'hole' && !activeField) {
    return;
  }
  const editor = new PolygonEditor(map, initial, {
    appendOnMapTap: mode !== 'edit',
    color: mode === 'hole' ? '#f87171' : '#22c55e',
    onChange: (pts) => {
      $('drawHint').textContent =
        pts.length < 3 ? `${EDIT_HINTS[mode]} (${pts.length} so far)` : `${EDIT_HINTS[mode]} — ${fmt(ringAcres(pts))} ac`;
    },
  });
  editSession = { mode, fieldId: mode === 'new' ? undefined : activeField?.id, editor };
  $('drawBar').hidden = false;
  layers.coverage.remove();
  layers.lines.remove();
  $('mapLegend').hidden = true;
  drawBoundary();
  if (mode === 'new' && gps && !activeField) map.setView(toLatLng(gps), 16);
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
    const name = prompt('Field name?', 'New field');
    if (name === null) return;
    stopEdit();
    const [added] = addFields([{ name: name.trim() || 'New field', geometry: { type: 'Polygon', coordinates: [closeRing(pts)] } }], 'drawn');
    selectField(added.id);
    return;
  }
  const f = fields.find((x) => x.id === editSession!.fieldId);
  if (!f) {
    stopEdit();
    return;
  }
  const parts = polygonsOf(f.geometry).map((p) => p.map((r) => r.slice()));
  if (mode === 'edit') {
    parts[largestPart(f.geometry)][0] = closeRing(pts);
  } else {
    // Add the exclusion to whichever part it sits in.
    const probe: [number, number] = [pts[0].lng, pts[0].lat];
    const idx = parts.findIndex((p) => pointInGeometry({ type: 'Polygon', coordinates: [p[0]] }, probe));
    if (idx < 0) {
      toast('The exclusion has to be inside the field boundary.', true);
      return;
    }
    parts[idx].push(closeRing(pts));
  }
  f.geometry = geometryFrom(parts);
  f.updatedAt = Date.now();
  store.saveFields(fields);
  stopEdit();
  selectField(f.id, { keepView: true });
  toast(mode === 'edit' ? 'Boundary saved' : 'Exclusion added');
}

$('drawBtn').addEventListener('click', () => startEdit('new'));
$('editBoundaryBtn').addEventListener('click', () => startEdit('edit'));
$('addHoleBtn').addEventListener('click', () => startEdit('hole'));
$('clearHolesBtn').addEventListener('click', () => {
  if (!activeField) return;
  const parts = polygonsOf(activeField.geometry);
  const count = parts.reduce((n, p) => n + p.length - 1, 0);
  if (!count) {
    toast('This field has no exclusions.');
    return;
  }
  if (!confirm(`Remove ${count} exclusion${count > 1 ? 's' : ''} from ${activeField.name}?`)) return;
  activeField.geometry = geometryFrom(parts.map((p) => [p[0]]));
  activeField.updatedAt = Date.now();
  store.saveFields(fields);
  selectField(activeField.id, { keepView: true });
});
$('renameFieldBtn').addEventListener('click', () => {
  if (!activeField) return;
  const name = prompt('Field name', activeField.name);
  if (!name?.trim()) return;
  activeField.name = name.trim();
  activeField.updatedAt = Date.now();
  store.saveFields(fields);
  $('fieldName').textContent = activeField.name;
  drawBoundary();
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
  $('headingOut').textContent = `${fmt(plan.headingDeg, plan.headingMode === 'optimized' ? 1 : 0)}°`;
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
}

function syncControls() {
  $('lapsOut').textContent = String(plan.laps);
  syncHeadingUi();
  syncMachineUi();
  const p = settings.product;
  ($('rateInput') as HTMLInputElement).value = p.rate ? String(p.rate) : '';
  ($('unitSelect') as HTMLSelectElement).value = p.unit;
  ($('loadedInput') as HTMLInputElement).value = p.loaded ? String(p.loaded) : '';
  ($('densityInput') as HTMLInputElement).value = p.density ? String(p.density) : '';
  syncAdjustUi();
  $('loadedUnit').textContent = p.unit;
  $('midLeftUnit').textContent = p.unit;
}

function planChanged() {
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
  const byDensity = settings.product.adjustBy === 'density';
  setSeg('adjustSeg', byDensity ? 'density' : 'rate');
  $('densityBlock').hidden = !byDensity;
  $('midDensityField').hidden = !byDensity;
  ($('midDensityInput') as HTMLInputElement).placeholder = recommendedDensity
    ? `${fmt(recommendedDensity, 1)} (suggested above)`
    : '';
}

function productChanged() {
  settings.product = {
    rate: num($('rateInput') as HTMLInputElement) ?? 0,
    unit: ($('unitSelect') as HTMLSelectElement).value,
    loaded: num($('loadedInput') as HTMLInputElement),
    adjustBy: settings.product.adjustBy,
    density: num($('densityInput') as HTMLInputElement),
  };
  $('loadedUnit').textContent = settings.product.unit;
  $('midLeftUnit').textContent = settings.product.unit;
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
$('midDensityInput').addEventListener('input', renderMidField);
$('rateInput').addEventListener('input', productChanged);
$('unitSelect').addEventListener('change', productChanged);
$('loadedInput').addEventListener('input', productChanged);
$('midAppliedInput').addEventListener('input', renderMidField);
$('midLeftInput').addEventListener('input', renderMidField);

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
onSeg('imagerySeg', (v) => setSeg('imagerySeg', v));
$('saveGoogleBtn').addEventListener('click', () => {
  const key = ($('googleKey') as HTMLInputElement).value.trim();
  const chosen = $('imagerySeg').querySelector<HTMLElement>('[aria-checked="true"]')?.dataset.v as Imagery | undefined;
  if (key !== (settings.googleKey ?? '')) clearGoogleSession();
  settings.googleKey = key || undefined;
  settings.imagery = chosen ?? settings.imagery;
  saveSettings();
  void setBaseLayer();
  const shown = effectiveImagery();
  toast(
    settings.imagery !== 'esri' && shown === 'esri'
      ? navigator.onLine
        ? 'Saved. Add a Google Maps API key to see Google imagery.'
        : 'Saved. Google imagery will load when you have signal.'
      : `Showing ${IMAGERY_NAMES[shown]}`,
  );
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
  const blob = new Blob([JSON.stringify({ version: 1, fields, machines }, null, 2)], { type: 'application/json' });
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
    syncMachineUi();
    toast(`Restored ${data.fields.length} fields, ${data.machines.length} machines`);
  } catch (err) {
    toast((err as Error).message, true);
  }
});

// ---------------------------------------------------------------------------
// Boot

applyTheme();
void setBaseLayer();
syncControls();
$('layersBtn').setAttribute('aria-pressed', 'true');
if (settings.lastFieldId && fields.some((f) => f.id === settings.lastFieldId)) selectField(settings.lastFieldId);
else {
  renderResults();
  drawBoundary();
  const all = fields.flatMap((f) => fieldLatLngs(f).flatMap((p) => p[0])) as L.LatLngTuple[];
  if (all.length) map.fitBounds(L.latLngBounds(all), { padding: [24, 24] });
}
startGps();
