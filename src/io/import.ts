// Boundary import: shapefiles (zipped, or .shp/.dbf/.prj picked together),
// KML, KMZ and GeoJSON. Agvance (desktop Mapping and SKY Mapping) exports
// boundaries as shapefiles, typically named "<Field>-Boundary.shp".

import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';

export type BoundaryGeometry = Polygon | MultiPolygon;

export interface ImportedField {
  name: string;
  grower?: string;
  farm?: string;
  geometry: BoundaryGeometry;
}

const NAME_KEYS = ['name', 'field', 'field_name', 'fieldname', 'fld_name', 'field_nm', 'fieldnm', 'fname', 'title'];
const GROWER_KEYS = ['grower', 'grower_name', 'growername', 'client', 'client_name', 'customer', 'cust_name', 'custname'];
const FARM_KEYS = ['farm', 'farm_name', 'farmname'];

function pick(props: Record<string, unknown> | null | undefined, keys: string[]): string | undefined {
  if (!props) return undefined;
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) lower[k.toLowerCase()] = v;
  for (const k of keys) {
    const v = lower[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return undefined;
}

function cleanFileName(name: string): string {
  return name
    .replace(/^.*[\\/]/, '')
    .replace(/\.[^.]+$/, '')
    .replace(/[-_ ]?boundary$/i, '')
    .replace(/[_]+/g, ' ')
    .trim();
}

function extractPolygons(geom: Geometry | null): Polygon['coordinates'][] {
  if (!geom) return [];
  switch (geom.type) {
    case 'Polygon':
      return [geom.coordinates];
    case 'MultiPolygon':
      return geom.coordinates;
    case 'GeometryCollection':
      return geom.geometries.flatMap(extractPolygons);
    default:
      return [];
  }
}

function checkLonLat(polys: Polygon['coordinates'][]) {
  for (const poly of polys) for (const ring of poly) for (const [x, y] of ring) {
    if (!(Math.abs(x) <= 180 && Math.abs(y) <= 90)) {
      throw new Error(
        'This boundary uses projected coordinates. Include the .prj file (or export as WGS84 / lat-long) and try again.',
      );
    }
  }
}

export function featuresToFields(fc: FeatureCollection | Feature | Geometry, fallbackName: string): ImportedField[] {
  const features: Feature[] =
    fc.type === 'FeatureCollection'
      ? fc.features
      : fc.type === 'Feature'
        ? [fc]
        : [{ type: 'Feature', properties: {}, geometry: fc }];
  const out: ImportedField[] = [];
  features.forEach((f, i) => {
    const polys = extractPolygons(f.geometry).map((p) =>
      p.map((ring) => ring.map((c) => [c[0], c[1]])).filter((ring) => ring.length >= 4),
    ).filter((p) => p.length > 0);
    if (!polys.length) return;
    checkLonLat(polys);
    const name = pick(f.properties, NAME_KEYS) ?? (features.length > 1 ? `${fallbackName} ${i + 1}` : fallbackName);
    out.push({
      name,
      grower: pick(f.properties, GROWER_KEYS),
      farm: pick(f.properties, FARM_KEYS),
      geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys },
    });
  });
  return out;
}

async function parseKmlText(text: string, fallbackName: string): Promise<ImportedField[]> {
  const { kml } = await import('@tmcw/togeojson');
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  return featuresToFields(kml(doc) as FeatureCollection, fallbackName);
}

async function parseShapefileZip(buf: ArrayBuffer, fallbackName: string): Promise<ImportedField[]> {
  const shp = (await import('shpjs')).default;
  const result = await shp(buf);
  const layers: (FeatureCollection & { fileName?: string })[] = Array.isArray(result) ? result : [result];
  return layers.flatMap((layer) => featuresToFields(layer, layer.fileName ? cleanFileName(layer.fileName) : fallbackName));
}

/** Parses one or more picked files into boundaries. */
export async function importFiles(files: File[]): Promise<ImportedField[]> {
  const out: ImportedField[] = [];
  const byExt = (ext: string) => files.filter((f) => f.name.toLowerCase().endsWith(ext));

  // Loose shapefile parts picked together: group by base name.
  const shps = byExt('.shp');
  for (const shpFile of shps) {
    const base = shpFile.name.slice(0, -4).toLowerCase();
    const part = (ext: string) => files.find((f) => f.name.toLowerCase() === base + ext);
    const { parseShp, parseDbf, combine } = await import('shpjs');
    const prj = part('.prj');
    const dbf = part('.dbf');
    const cpg = part('.cpg');
    const geoms = parseShp(await shpFile.arrayBuffer(), prj ? await prj.text() : undefined);
    const attrs = dbf ? parseDbf(await dbf.arrayBuffer(), cpg ? await cpg.text() : undefined) : undefined;
    out.push(...featuresToFields(combine([geoms, attrs]), cleanFileName(shpFile.name)));
  }

  for (const f of files) {
    const lower = f.name.toLowerCase();
    const fallback = cleanFileName(f.name);
    if (lower.endsWith('.zip')) {
      out.push(...(await parseShapefileZip(await f.arrayBuffer(), fallback)));
    } else if (lower.endsWith('.kml')) {
      out.push(...(await parseKmlText(await f.text(), fallback)));
    } else if (lower.endsWith('.kmz')) {
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(await f.arrayBuffer());
      const entry = Object.values(zip.files).find((e) => e.name.toLowerCase().endsWith('.kml'));
      if (!entry) throw new Error(`${f.name}: no KML inside the KMZ`);
      out.push(...(await parseKmlText(await entry.async('text'), fallback)));
    } else if (lower.endsWith('.geojson') || lower.endsWith('.json')) {
      out.push(...featuresToFields(JSON.parse(await f.text()), fallback));
    }
  }

  const recognized = files.some((f) => /\.(zip|kml|kmz|geojson|json|shp)$/i.test(f.name));
  if (!recognized) throw new Error('Unsupported file. Use a shapefile (.zip or .shp/.dbf/.prj), KML, KMZ or GeoJSON.');
  if (!out.length) throw new Error('No field boundaries (polygons) found in that file.');
  return out;
}
