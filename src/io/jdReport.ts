// John Deere Operations Center job report (the PDF from a field's work
// summary). Its text layer carries the monitor's totals for the job: area,
// applied total, applied and target rate, times and the machine.

import { type TextItem, readPdfItems, rowsOf } from './ticket';

export interface OpsReport {
  field?: string;
  farm?: string;
  product?: string;
  start?: Date;
  end?: Date;
  /** Applied acres the monitor counted. */
  areaAc: number;
  /** Product the monitor believes went out, in `unit`. */
  appliedTotal?: number;
  appliedRate?: number;
  targetRate?: number;
  targetTotal?: number;
  unit: string;
  /** Deere's rate accuracy, %. */
  rateAccuracy?: number;
  speedMph?: number;
  minutes?: number;
  equipment?: string;
  /** Serial / VIN, for matching the machine next time. */
  serial?: string;
  /** Applied-rate legend: share of the area at each rate (each label is a band's lower edge). */
  rateBins: { rate: number; pct: number }[];
  /** Share of the area in the lowest band (0.05 = 5%): the belt catching up after speed changes. */
  lagAreaPct?: number;
  /** Top of that lowest band, in unit/ac. */
  lagBelow?: number;
}

function toNum(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const v = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(v) ? v : undefined;
}

const rowText = (row: TextItem[]) =>
  row
    .map((i) => i.str.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+:/g, ':')
    .replace(/\s+/g, ' ');

/** "Oct 21, 2026 9:21 AM" → Date (local time). */
function toDate(s: string | undefined): Date | undefined {
  if (!s) return undefined;
  const d = new Date(s.replace(/(\d)(AM|PM)/i, '$1 $2'));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const UNITS: Record<string, string> = { lb: 'lb', lbs: 'lb', gal: 'gal', ton: 'ton', tons: 'ton', oz: 'oz', qt: 'qt' };

export function parseOpsReport(pages: TextItem[][]): OpsReport {
  const items = pages.flat();
  const rows = rowsOf(items);
  const lines = rows.map(rowText);
  const find = (re: RegExp) => {
    for (const l of lines) {
      const m = l.match(re);
      if (m) return m;
    }
    return null;
  };
  const NUM = '([\\d,]+(?:\\.\\d+)?)';
  const area = find(new RegExp(`Area Applied: ${NUM}\\s*ac`, 'i'));
  if (!area) throw new Error('This doesn’t look like an Operations Center job report (no “Area Applied”).');
  const applied = find(new RegExp(`Applied Rate: ${NUM}\\s*([a-z]+)/ac`, 'i'));
  const unit = UNITS[applied?.[2]?.toLowerCase() ?? 'lb'] ?? applied?.[2]?.toLowerCase() ?? 'lb';
  const r: OpsReport = {
    areaAc: toNum(area[1])!,
    appliedRate: toNum(applied?.[1]),
    appliedTotal: toNum(find(new RegExp(`Applied Total: ${NUM}`, 'i'))?.[1]),
    targetRate: toNum(find(new RegExp(`Target Rate: ${NUM}`, 'i'))?.[1]),
    targetTotal: toNum(find(new RegExp(`Target Total: ${NUM}`, 'i'))?.[1]),
    rateAccuracy: toNum(find(new RegExp(`Rate Accuracy: ${NUM}`, 'i'))?.[1]),
    speedMph: toNum(find(new RegExp(`Speed: ${NUM}\\s*mi`, 'i'))?.[1]),
    minutes: toNum(find(new RegExp(`Application Time: ${NUM}\\s*min`, 'i'))?.[1]),
    unit,
    field: find(/^Field: (.+)$/i)?.[1].trim(),
    product: find(/^\d{4} Application: (.+)$/i)?.[1].trim(),
    start: toDate(find(/^Start: (.+)$/i)?.[1]),
    end: toDate(find(/^End: (.+)$/i)?.[1]),
    rateBins: [],
  };
  // "Farm | Field" sits between the field line and the start time.
  const farmLine = lines.find((l, i) => l.includes(' | ') && i < lines.findIndex((x) => /^Work Totals/i.test(x)));
  if (farmLine) r.farm = farmLine.split(' | ')[0].trim();
  // The machine is the line under the "Equipment" heading.
  const eq = rows.findIndex((row) => rowText(row) === 'Equipment');
  if (eq >= 0 && rows[eq + 1]) {
    const row = rows[eq + 1];
    r.equipment = rowText(row);
    r.serial = row.map((i) => i.str.trim()).find((s) => /^[A-Z0-9]{10,}$/.test(s));
  }
  // Rate legend: rates and their area shares are separate columns, a couple
  // of points apart vertically.
  const rates = items.filter((i) => /^\d+(\.\d+)?$/.test(i.str.trim()));
  const pcts = items.filter((i) => /^\d+(\.\d+)?\s*%$/.test(i.str.trim()) && !/accuracy/i.test(i.str));
  for (const p of pcts) {
    const near = rates.filter((x) => x.x < p.x && Math.abs(x.y - p.y) < 6).sort((a, b) => b.x - a.x)[0];
    if (near) r.rateBins.push({ rate: parseFloat(near.str), pct: parseFloat(p.str) });
  }
  r.rateBins.sort((a, b) => b.rate - a.rate);
  if (r.rateBins.length >= 2) {
    r.lagAreaPct = r.rateBins[r.rateBins.length - 1].pct / 100;
    r.lagBelow = r.rateBins[r.rateBins.length - 2].rate;
  }
  if (r.appliedTotal === undefined && r.appliedRate !== undefined) r.appliedTotal = r.appliedRate * r.areaAc;
  return r;
}

export async function importOpsReport(file: Blob): Promise<OpsReport> {
  let pages: TextItem[][];
  try {
    pages = await readPdfItems(file);
  } catch {
    throw new Error('Couldn’t open that file as a PDF. Is it the Operations Center report?');
  }
  if (!pages.some((p) => p.some((i) => i.str.trim()))) {
    throw new Error('This PDF has no text in it (probably a photo or scan), so it can’t be read.');
  }
  return parseOpsReport(pages);
}

/** Several reports (one per field) for one job, added together. */
export function combineReports(reports: OpsReport[]): OpsReport | null {
  if (!reports.length) return null;
  if (reports.length === 1) return reports[0];
  const sum = (k: 'areaAc' | 'appliedTotal' | 'targetTotal' | 'minutes') =>
    reports.every((r) => r[k] !== undefined) ? reports.reduce((s, r) => s + (r[k] ?? 0), 0) : undefined;
  const areaAc = sum('areaAc')!;
  const appliedTotal = sum('appliedTotal');
  const targetTotal = sum('targetTotal');
  const starts = reports.map((r) => r.start?.getTime()).filter((t): t is number => t !== undefined);
  const ends = reports.map((r) => r.end?.getTime()).filter((t): t is number => t !== undefined);
  return {
    ...reports[0],
    field: reports.map((r) => r.field ?? '?').join(' + '),
    areaAc,
    appliedTotal,
    targetTotal,
    appliedRate: appliedTotal !== undefined ? appliedTotal / areaAc : undefined,
    targetRate: targetTotal !== undefined ? targetTotal / areaAc : reports[0].targetRate,
    minutes: sum('minutes'),
    lagAreaPct: reports.every((r) => r.lagAreaPct !== undefined)
      ? reports.reduce((s, r) => s + r.lagAreaPct! * r.areaAc, 0) / areaAc
      : undefined,
    lagBelow: reports[0].lagBelow,
    start: starts.length ? new Date(Math.min(...starts)) : undefined,
    end: ends.length ? new Date(Math.max(...ends)) : undefined,
    rateBins: [],
  };
}
