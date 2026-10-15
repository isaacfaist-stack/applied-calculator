// On-device storage. Everything lives in the iPad's browser storage so the
// app works with no signal in the field.

import type { BoundaryGeometry } from './io/import';
import type { CornerStyle, ShutoffMode } from './engine/plan';
import type { CalibrationJob } from './engine/rate';

export interface FieldRecord {
  id: string;
  name: string;
  grower?: string;
  farm?: string;
  /** Agvance field ID from a blend ticket ("GROWER / 12345"), for matching the next ticket. */
  externalId?: string;
  geometry: BoundaryGeometry;
  source: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Per polygon part, per exclusion (hole): 'drive' = drive through with
   * product off (default), 'avoid' = go around it like a field edge.
   */
  holeKinds?: ('drive' | 'avoid')[][];
  /** The boundary as first imported, kept so edits can be undone. */
  originalGeometry?: BoundaryGeometry;
  originalHoleKinds?: ('drive' | 'avoid')[][];
  /** Last plan settings used on this field, restored when reopened. */
  prefs?: FieldPrefs;
}

export interface FieldPrefs {
  machineId?: string;
  headlandLaps?: number;
  headingDeg?: number;
  headingMode?: 'longest' | 'optimized' | 'manual';
}

export interface MachineRecord {
  id: string;
  name: string;
  widthFt: number;
  sections: number;
  shutoff: ShutoffMode;
  cornerStyle: CornerStyle;
  defaultHeadlandLaps: number;
  /**
   * Machine bias in percent: actual product out vs. what the monitor
   * reports. +3 = puts out 3% more than it shows.
   */
  biasPct?: number;
  /** Average achieved rate as % of requested (96 = runs 4% under). */
  trackingPct?: number;
  /** Finished jobs checked on this machine; their average sets tracking and bias. */
  calibrations?: CalibrationRecord[];
}

export interface CalibrationRecord extends CalibrationJob {
  date: number;
  label: string;
}

export interface ProductSettings {
  rate: number;
  unit: string;
  /** Product given for the field, in `loadedAs` terms. */
  loaded?: number;
  /** "product": loaded is lb/gal/...; "acres": loaded is acres' worth at the target rate. */
  loadedAs?: 'product' | 'acres';
  /** How to make the adjustment on the controller. */
  adjustBy?: 'rate' | 'density';
  /** True product density (lb/ft³) from the ticket or a density cup. */
  density?: number;
}

/** The blend ticket the current job was started from. */
export interface JobRecord {
  ticketNo?: string;
  grower?: string;
  fieldName?: string;
  acres?: number;
  crop?: string;
  products?: string[];
  fieldIds: string[];
  startedAt: number;
}

export type Imagery = 'google-satellite' | 'google-hybrid' | 'esri';

export interface Settings {
  activeMachineId?: string;
  lastFieldId?: string;
  /** All fields selected last time (several = one combined job). */
  lastFieldIds?: string[];
  product: ProductSettings;
  theme: 'auto' | 'light' | 'dark';
  boundaryServer?: { url: string; token: string };
  /** Google Maps Platform key (Map Tiles API); overrides the build-time key. */
  googleKey?: string;
  imagery?: Imagery;
  /** Current job from a blend ticket; cleared when other fields are chosen. */
  job?: JobRecord;
  /** First-run setup finished or skipped. */
  setupDone?: boolean;
}

const KEYS = { fields: 'aac.fields.v1', machines: 'aac.machines.v1', settings: 'aac.settings.v1' };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const DEFAULT_MACHINES: MachineRecord[] = [
  { id: 'm-floater-70', name: 'Floater 70 ft spinner', widthFt: 70, sections: 1, shutoff: 'center', cornerStyle: 'overrun', defaultHeadlandLaps: 2 },
  { id: 'm-sprayer-120', name: 'Sprayer 120 ft, 9 sections', widthFt: 120, sections: 9, shutoff: 'center', cornerStyle: 'pivot', defaultHeadlandLaps: 1 },
];

export const store = {
  fields(): FieldRecord[] {
    return read<FieldRecord[]>(KEYS.fields, []);
  },
  saveFields(fields: FieldRecord[]): boolean {
    return write(KEYS.fields, fields);
  },
  upsertField(f: FieldRecord): boolean {
    const all = store.fields();
    const i = all.findIndex((x) => x.id === f.id);
    if (i >= 0) all[i] = f;
    else all.push(f);
    return store.saveFields(all);
  },
  deleteField(id: string) {
    store.saveFields(store.fields().filter((f) => f.id !== id));
  },
  machines(): MachineRecord[] {
    const m = read<MachineRecord[] | null>(KEYS.machines, null);
    return m && m.length ? m : DEFAULT_MACHINES;
  },
  saveMachines(m: MachineRecord[]) {
    write(KEYS.machines, m);
  },
  settings(): Settings {
    return {
      product: { rate: 0, unit: 'lb' },
      theme: 'auto',
      ...read<Partial<Settings>>(KEYS.settings, {}),
    } as Settings;
  },
  saveSettings(s: Settings) {
    write(KEYS.settings, s);
  },
};
