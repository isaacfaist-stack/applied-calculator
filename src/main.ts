import 'leaflet/dist/leaflet.css';
import './styles.css';
import L from 'leaflet';
import { registerSW } from 'virtual:pwa-register';

import { M_PER_FT, SQ_M_PER_ACRE } from './engine/geometry';
import type { CornerStyle, ShutoffMode } from './engine/plan';
import { adviseMidField, adviseRate } from './engine/rate';
import { type LocalField, distanceMiles, geometryCenter, geometryRings, pointInGeometry, toLocalField } from './fieldModel';
import { fetchRemoteBoundary, listRemoteFields } from './integrations/boundaryServer';
import { type BoundaryGeometry, importFiles } from './io/import';
import type { PlanRequest, PlanResponse } from './planWorker';
import { type FieldRecord, type MachineRecord, type Settings, DEFAULT_MACHINES, store, uid } from './store';

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

const plan = {
  laps: 2,
  headingMode: 'longest' as 'longest' | 'optimized' | 'manual',
  headingDeg: 0,
};

function activeMachine(): MachineRecord {
  return machines.find((m) => m.id === settings.activeMachineId) ?? machines[0] ?? DEFAULT_MACHINES[0];
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
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
  maxNativeZoom: 19,
  maxZoom: 21,
  attribution: 'Imagery © Esri',
}).addTo(map);

const layers = {
  boundary: L.layerGroup().addTo(map),
  coverage: L.layerGroup().addTo(map),
  lines: L.layerGroup().addTo(map),
  gps: L.layerGroup().addTo(map),
  draw: L.layerGroup().addTo(map),
};
let coverageUrl = '';

function toLatLng([lon, lat]: [number, number]): L.LatLngExpression {
  return [lat, lon];
}

function drawBoundary() {
  layers.boundary.clearLayers();
  if (!activeField) return;
  const polys = geometryRings(activeField.geometry).map((p) => p.map((r) => r.map(toLatLng)));
  L.polygon(polys as L.LatLngExpression[][][], { color: '#ffffff', weight: 3, fill: false, interactive: false }).addTo(
    layers.boundary,
  );
}

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
  const a = adviseRate({ surfaceAc, appliedAc, targetRate: rate, loaded });
  const answerChange = $('answerChange');
  const kv = $('productKv');
  if (!a) {
    $('answerRate').textContent = '–';
    $('answerUnit').textContent = '';
    answerChange.textContent = 'Enter a target rate';
    answerChange.className = 'answer-change';
    $('answerSub').textContent = '';
    kv.innerHTML = '';
  } else {
    const useLoad = a.rateToEmpty !== undefined;
    const setRate = useLoad ? a.rateToEmpty! : a.rateForTarget;
    const change = useLoad ? a.rateToEmptyChangePct! : a.rateChangePct;
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
    $('answerSub').textContent = useLoad
      ? `Empties the ${fmtQty(loaded!, unit)} load across ${fmt(appliedAc)} applied ac. Ground gets ${fmt(a.groundRateIfEmptied!, 1)} ${unit}/ac.`
      : `Lays down ${fmt(rate, rate >= 100 ? 0 : 1)} ${unit}/ac on the ${fmt(surfaceAc)} surface ac, including overlap.`;

    const rows: [string, string, string?][] = [
      ['Needed at target (surface ac)', fmtQty(a.productNeeded, unit), 'strong'],
      ['Used if rate is left at target', fmtQty(a.productAtTarget, unit)],
      ['Extra from overlap', fmtQty(a.productAtTarget - a.productNeeded, unit)],
    ];
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
  const m = adviseMidField({ plannedAppliedAc, appliedSoFarAc: applied, remaining: left, currentRate: settings.product.rate });
  if (!m) {
    out.innerHTML = `<p class="muted small">Monitor already shows the planned ${fmt(plannedAppliedAc)} applied ac or more.</p>`;
    return;
  }
  out.innerHTML = `
    <div class="muted small">About ${fmt(m.remainingAc)} applied ac to go. Set rate to</div>
    <div class="big">${fmt(m.rateToFinish, m.rateToFinish >= 100 ? 1 : 2)} <span class="answer-unit">${esc(unit)}/ac</span></div>
    <div class="answer-change ${m.changePct < 0 ? 'down' : 'up'}">${fmtPct(m.changePct)} vs. ${fmt(settings.product.rate, 1)}</div>
    <p class="muted small">At the current rate you'd ${m.balance < 0 ? 'run out' : 'have left over'} about ${fmtQty(Math.abs(m.balance), unit)}.</p>`;
}

// ---------------------------------------------------------------------------
// Field selection

function selectField(id: string | null) {
  activeField = id ? fields.find((f) => f.id === id) ?? null : null;
  result = null;
  local = null;
  layers.coverage.clearLayers();
  layers.lines.clearLayers();
  settings.lastFieldId = activeField?.id;
  saveSettings();
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
  fitField();
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
      renderFieldList();
    }
  } catch (err) {
    toast((err as Error).message, true);
  }
});

// ---------------------------------------------------------------------------
// Draw a boundary on the map

let drawPts: L.LatLng[] = [];
let drawing = false;

function renderDraw() {
  layers.draw.clearLayers();
  if (drawPts.length > 1) L.polygon(drawPts, { color: '#22c55e', weight: 3, fillOpacity: 0.15 }).addTo(layers.draw);
  for (const p of drawPts) {
    L.circleMarker(p, { radius: 7, color: '#fff', weight: 3, fillColor: '#16a34a', fillOpacity: 1 }).addTo(layers.draw);
  }
  $('drawHint').textContent = drawPts.length < 3 ? `Tap each corner of the field (${drawPts.length} so far)` : `${drawPts.length} corners`;
}

function stopDraw() {
  drawing = false;
  drawPts = [];
  layers.draw.clearLayers();
  $('drawBar').hidden = true;
}

$('drawBtn').addEventListener('click', () => {
  ($('fieldsSheet') as HTMLDialogElement).close();
  drawing = true;
  drawPts = [];
  $('drawBar').hidden = false;
  renderDraw();
  if (gps && !activeField) map.setView(toLatLng(gps), 16);
});

map.on('click', (e: L.LeafletMouseEvent) => {
  if (!drawing) return;
  drawPts.push(e.latlng);
  renderDraw();
});
$('drawUndo').addEventListener('click', () => {
  drawPts.pop();
  renderDraw();
});
$('drawCancel').addEventListener('click', stopDraw);
$('drawDone').addEventListener('click', () => {
  if (drawPts.length < 3) {
    toast('Tap at least 3 corners.', true);
    return;
  }
  const name = prompt('Field name?', 'New field');
  if (name === null) return;
  const ring = drawPts.map((p) => [p.lng, p.lat]);
  ring.push(ring[0]);
  const [added] = addFields([{ name: name.trim() || 'New field', geometry: { type: 'Polygon', coordinates: [ring] } }], 'drawn');
  stopDraw();
  selectField(added.id);
});

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
}

function syncControls() {
  $('lapsOut').textContent = String(plan.laps);
  syncHeadingUi();
  syncMachineUi();
  const p = settings.product;
  ($('rateInput') as HTMLInputElement).value = p.rate ? String(p.rate) : '';
  ($('unitSelect') as HTMLSelectElement).value = p.unit;
  ($('loadedInput') as HTMLInputElement).value = p.loaded ? String(p.loaded) : '';
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

function productChanged() {
  settings.product = {
    rate: num($('rateInput') as HTMLInputElement) ?? 0,
    unit: ($('unitSelect') as HTMLSelectElement).value,
    loaded: num($('loadedInput') as HTMLInputElement),
  };
  $('loadedUnit').textContent = settings.product.unit;
  $('midLeftUnit').textContent = settings.product.unit;
  saveSettings();
  renderResults();
}
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
  openSheet('settingsSheet');
});
onSeg('themeSeg', (v) => {
  settings.theme = v as Settings['theme'];
  saveSettings();
  applyTheme();
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
syncControls();
$('layersBtn').setAttribute('aria-pressed', 'true');
if (settings.lastFieldId && fields.some((f) => f.id === settings.lastFieldId)) selectField(settings.lastFieldId);
else renderResults();
startGps();
