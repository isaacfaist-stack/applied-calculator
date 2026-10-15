// Blend ticket import. Agvance prints tickets as real PDFs with a text layer,
// so the numbers can be read on the iPad with no OCR. Labels and values sit in
// separate columns, so the text is rebuilt into rows by position first.

export interface TextItem {
  str: string;
  x: number;
  y: number; // PDF space: larger is higher on the page
  w: number;
}

export interface TicketLine {
  name: string;
  rate: number;
  unit: string;
  total?: number;
}

export interface Ticket {
  ticketNo?: string;
  supplier?: string;
  grower?: string;
  /** Agvance "Field ID", e.g. "MOYEFA / 12294" (grower code / field number). */
  fieldId?: string;
  growerCode?: string;
  /** Field name ("Description" on Agvance tickets). */
  fieldName?: string;
  county?: string;
  rangeSection?: string;
  orderedDate?: string;
  crop?: string;
  acres?: number;
  placement?: string;
  /** Blend rate per acre. */
  rate?: number;
  unit?: string;
  /** Total product for the ticket, in `unit`. */
  total?: number;
  /** Lb/ft³ from the ticket (calculated from the ingredients). */
  density?: number;
  batches?: number;
  perBatch?: number;
  acresPerBatch?: number;
  products: TicketLine[];
  /** Application charge line, e.g. "Spinner". */
  application?: string;
}

/** Numbers like "27,900.000" → 27900. */
function toNum(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return undefined;
  const v = parseFloat(m[0]);
  return Number.isFinite(v) ? v : undefined;
}

const UNIT_MAP: Record<string, string> = {
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  gal: 'gal', gals: 'gal', gallon: 'gal', gallons: 'gal',
  ton: 'ton', tons: 'ton',
  qt: 'qt', qts: 'qt', quart: 'qt', quarts: 'qt',
  oz: 'oz', 'fl oz': 'oz',
  pt: 'pt', pts: 'pt', pint: 'pt', pints: 'pt',
  acre: 'acre', acres: 'acre', ac: 'acre',
};
const UNIT_RE = '(lbs?|pounds?|gals?|gallons?|tons?|qts?|quarts?|fl oz|oz|pts?|pints?|acres?|ac)(?![a-z])';

/** Groups text items into rows (top to bottom), each sorted left to right. */
export function rowsOf(items: TextItem[], tol = 2.5): TextItem[][] {
  const sorted = items.filter((i) => i.str.trim()).sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: TextItem[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - it.y) <= tol) row.push(it);
    else rows.push([it]);
  }
  for (const r of rows) r.sort((a, b) => a.x - b.x);
  return rows;
}

const clean = (s: string) => s.replace(/_{2,}/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * "Label: value" pairs, whether printed as one string or as a label cell
 * followed by a value cell on the same row. First occurrence wins.
 */
function labelValues(rows: TextItem[][]): Map<string, { value: string; label: TextItem }> {
  const out = new Map<string, { value: string; label: TextItem }>();
  const put = (k: string, v: string, label: TextItem) => {
    const key = k.trim().toLowerCase();
    const value = clean(v);
    if (key && value && !out.has(key)) out.set(key, { value, label });
  };
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const s = row[i].str.trim();
      if (/:$/.test(s)) {
        const next = row[i + 1];
        if (next && !/:$/.test(next.str.trim()) && !/^[^:]{1,30}:\s*\S/.test(next.str.trim())) {
          put(s.slice(0, -1), next.str, row[i]);
        }
      } else {
        // Several pairs can share one string: "Lbs/Acre: 450  Lbs/Cu Ft: 65.00"
        const re = /([A-Za-z#][A-Za-z#/ .]{0,28}?):\s*([^:]+?)(?=\s+[A-Za-z#][A-Za-z#/ .]{0,28}?:|$)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(s))) put(m[1], m[2], row[i]);
      }
    }
  }
  return out;
}

function pick(map: Map<string, { value: string }>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = map.get(k.toLowerCase())?.value;
    if (v) return v;
  }
  return undefined;
}

/** Reads a blend ticket from the text items of each page. */
export function parseTicket(pages: TextItem[][]): Ticket {
  const first = pages[0] ?? [];
  const rows = rowsOf(first);
  const kv = labelValues(rows);
  const t: Ticket = { products: [] };

  for (const row of rows) {
    const s = row.map((i) => i.str).join(' ');
    const m = s.match(/(?:custom application|application|ticket|order)\s*(?:#|no\.?|number)?\s*:?\s*(\d{4,})/i);
    if (m) {
      t.ticketNo = m[1];
      break;
    }
  }
  t.supplier = rows[0]?.find((i) => !/application|ticket/i.test(i.str))?.str.trim();

  t.fieldId = pick(kv, 'Field ID', 'Field');
  if (t.fieldId) {
    const m = t.fieldId.match(/^([A-Za-z0-9]+)\s*\/\s*(\S+)/);
    if (m) t.growerCode = m[1];
  }
  t.fieldName = pick(kv, 'Description', 'Field Name');
  t.county = pick(kv, 'County/Township', 'County');
  t.rangeSection = pick(kv, 'Range/Section');
  t.orderedDate = pick(kv, 'Ordered Date', 'Date');
  t.crop = pick(kv, 'Crop');
  t.placement = pick(kv, 'Placement');
  t.acres = toNum(pick(kv, 'Acre', 'Acres', 'Field Acres'));

  // Grower: left column, just above or level with the Field ID label.
  const fid = kv.get('field id')?.label;
  if (fid) {
    const cands = first
      .filter((i) => i.x + i.w < fid.x - 10 && i.y >= fid.y - 2 && i.y <= fid.y + 25 && i.str.trim() && !/\d{3}/.test(i.str))
      .sort((a, b) => b.y - a.y);
    t.grower = cands[0]?.str.trim();
  }
  t.grower ??= pick(kv, 'Grower', 'Customer', 'Bill To');

  // Product lines: "<name> ... <rate> <unit> ... <total> <unit>"
  const headerIdx = rows.findIndex((r) => r.some((i) => /^product$/i.test(i.str.trim())) && r.some((i) => /rate/i.test(i.str)));
  if (headerIdx >= 0) {
    const nameMaxX = Math.min(...rows[headerIdx].filter((i) => /rate/i.test(i.str)).map((i) => i.x));
    for (const row of rows.slice(headerIdx + 1)) {
      const text = row.map((i) => i.str).join(' ');
      if (/batches|analysis|^lbs\b/i.test(text)) break;
      const name = clean(row.filter((i) => i.x < nameMaxX - 20).map((i) => i.str).join(' '));
      const nums = [...row.filter((i) => i.x >= nameMaxX - 20).map((i) => i.str).join(' ').matchAll(new RegExp(`([\\d,]+(?:\\.\\d+)?)\\s*${UNIT_RE}`, 'gi'))];
      if (!name || !nums.length) continue;
      const unit = UNIT_MAP[nums[0][2].toLowerCase()] ?? nums[0][2].toLowerCase();
      const line: TicketLine = { name, rate: toNum(nums[0][1])!, unit, total: toNum(nums[1]?.[1]) };
      if (unit === 'acre') {
        t.application = name.replace(/^application\s*[-–:]\s*/i, '').trim() || name;
      } else {
        t.products.push(line);
      }
    }
  }

  // Blend totals in the footer, falling back to the product lines.
  const ratePair = [...kv.entries()].find(([k]) => /^(lbs|gal|gals|tons|units)\s*\/\s*acre$/.test(k));
  if (ratePair) {
    t.rate = toNum(ratePair[1].value);
    t.unit = UNIT_MAP[ratePair[0].split('/')[0].trim()] ?? 'lb';
  }
  const lineUnits = new Set(t.products.map((p) => p.unit));
  if (t.rate === undefined && t.products.length && lineUnits.size === 1) {
    t.rate = t.products.reduce((s, p) => s + p.rate, 0);
    t.unit = t.products[0].unit;
  }
  t.density = toNum(pick(kv, 'Lbs/Cu Ft', 'Density', 'Lb/Cu Ft'));
  t.batches = toNum(pick(kv, '# of Batches', 'Batches'));
  t.perBatch = toNum([...kv.entries()].find(([k]) => /^(lbs|gal|gals|tons)\s*\/\s*batch$/.test(k))?.[1].value);
  t.acresPerBatch = toNum(pick(kv, 'Acre/Batch', 'Acres/Batch'));

  const blendWeight = toNum(pick(kv, 'Total Blend Weight', 'Total Weight'));
  if (blendWeight) t.total = blendWeight;
  else if (t.perBatch) t.total = t.perBatch * (t.batches ?? 1);
  else if (t.products.length && t.products.every((p) => p.total !== undefined && p.unit === t.unit)) {
    t.total = t.products.reduce((s, p) => s + (p.total ?? 0), 0);
  } else if (t.rate && t.acres) t.total = t.rate * t.acres;
  t.acres ??= t.acresPerBatch !== undefined ? t.acresPerBatch * (t.batches ?? 1) : undefined;
  return t;
}

/** Pulls positioned text from every page of a PDF (pdf.js, loaded on demand). */
export async function readPdfItems(file: Blob): Promise<TextItem[][]> {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  const pages: TextItem[][] = [];
  for (let n = 1; n <= Math.min(doc.numPages, 4); n++) {
    const content = await (await doc.getPage(n)).getTextContent();
    pages.push(
      content.items
        .filter((i): i is typeof i & { str: string; transform: number[]; width: number } => 'str' in i)
        .map((i) => ({ str: i.str, x: i.transform[4], y: i.transform[5], w: i.width })),
    );
  }
  await task.destroy();
  return pages;
}

export async function importTicket(file: Blob): Promise<Ticket> {
  let pages: TextItem[][];
  try {
    pages = await readPdfItems(file);
  } catch (err) {
    if ((err as Error).name === 'PasswordException') throw new Error('This PDF is password protected, so it can’t be read.');
    throw new Error('Couldn’t open that file as a PDF. Is it the blend ticket?');
  }
  if (!pages.some((p) => p.some((i) => i.str.trim()))) {
    throw new Error('This PDF has no text in it (probably a scan or photo), so it can’t be read. Enter the job by hand.');
  }
  const t = parseTicket(pages);
  if (!t.rate && !t.total && !t.acres) throw new Error('Couldn’t find a rate, acres or product total on this ticket.');
  return t;
}
