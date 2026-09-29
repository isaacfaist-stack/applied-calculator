// On-device storage. Everything lives in the iPad's browser storage so the
// app works with no signal in the field.

import type { BoundaryGeometry } from './io/import';
import type { CornerStyle, ShutoffMode } from './engine/plan';

export interface FieldRecord {
  id: string;
  name: string;
  grower?: string;
  farm?: string;
  geometry: BoundaryGeometry;
  source: string;
  createdAt: number;
  updatedAt: number;
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
}

export interface ProductSettings {
  rate: number;
  unit: string;
  loaded?: number;
}

export type Imagery = 'google-satellite' | 'google-hybrid' | 'esri';

export interface Settings {
  activeMachineId?: string;
  lastFieldId?: string;
  product: ProductSettings;
  theme: 'auto' | 'light' | 'dark';
  boundaryServer?: { url: string; token: string };
  /** Google Maps Platform key (Map Tiles API); overrides the build-time key. */
  googleKey?: string;
  imagery?: Imagery;
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
      product: { rate: 200, unit: 'lb' },
      theme: 'auto',
      ...read<Partial<Settings>>(KEYS.settings, {}),
    } as Settings;
  },
  saveSettings(s: Settings) {
    write(KEYS.settings, s);
  },
};
