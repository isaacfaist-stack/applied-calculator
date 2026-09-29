// Google satellite imagery through the Google Maps Platform Map Tiles API.
//
// Flow: POST createSession with the API key and map options, and get back a
// session token (valid for about two weeks, reused until it expires). Tiles
// are then plain XYZ URLs carrying the session and key. Google requires the
// attribution it returns for the area in view to be shown on the map, and
// tiles may only be cached as their HTTP Cache-Control headers allow (the
// browser handles that; the service worker deliberately leaves them alone).

import L from 'leaflet';

const API = 'https://tile.googleapis.com';

export type GoogleImagery = 'satellite' | 'hybrid';

interface Session {
  session: string;
  /** Unix seconds. */
  expiry: number;
  key: string;
  imagery: GoogleImagery;
}

const SESSION_KEY = 'aac.googleSession.v1';

function loadSession(key: string, imagery: GoogleImagery): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
    // Refresh a day early so a long day in the field never hits expiry.
    if (s && s.key === key && s.imagery === imagery && s.expiry * 1000 - Date.now() > 86_400_000) return s;
  } catch {
    /* fall through */
  }
  return null;
}

async function createSession(key: string, imagery: GoogleImagery): Promise<Session> {
  const cached = loadSession(key, imagery);
  if (cached) return cached;
  const body: Record<string, unknown> = {
    mapType: 'satellite',
    language: navigator.language || 'en-US',
    region: 'US',
  };
  // Hybrid = satellite with roads and place labels drawn on top.
  if (imagery === 'hybrid') body.layerTypes = ['layerRoadmap'];
  const res = await fetch(`${API}/v1/createSession?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      detail = (await res.json())?.error?.message ?? detail;
    } catch {
      /* keep status */
    }
    throw new Error(`Google Maps: ${detail}`);
  }
  const json = (await res.json()) as { session: string; expiry: string };
  const s: Session = { session: json.session, expiry: Number(json.expiry), key, imagery };
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  } catch {
    /* session just won't be reused */
  }
  return s;
}

/**
 * A Leaflet layer showing Google imagery. Keeps the map's attribution in
 * sync with the copyright Google reports for the current view.
 */
export async function createGoogleLayer(map: L.Map, key: string, imagery: GoogleImagery): Promise<L.TileLayer> {
  const s = await createSession(key, imagery);
  const q = `session=${encodeURIComponent(s.session)}&key=${encodeURIComponent(key)}`;
  const layer = L.tileLayer(`${API}/v1/2dtiles/{z}/{x}/{y}?${q}`, {
    maxNativeZoom: 20,
    maxZoom: 21,
    tileSize: 256,
  });

  let timer = 0;
  let current = 'Google Maps';
  const updateAttribution = () => {
    clearTimeout(timer);
    timer = window.setTimeout(async () => {
      if (!map.hasLayer(layer)) return;
      const b = map.getBounds();
      const params = new URLSearchParams({
        session: s.session,
        key,
        zoom: String(Math.min(22, Math.round(map.getZoom()))),
        north: String(Math.min(90, b.getNorth())),
        south: String(Math.max(-90, b.getSouth())),
        east: String(b.getEast()),
        west: String(b.getWest()),
      });
      try {
        const res = await fetch(`${API}/tile/v1/viewport?${params}`);
        if (!res.ok) return;
        const { copyright } = (await res.json()) as { copyright?: string };
        const next = `Google Maps${copyright ? ` · ${copyright}` : ''}`;
        if (next !== current && map.attributionControl) {
          map.attributionControl.removeAttribution(current);
          map.attributionControl.addAttribution(next);
          current = next;
        }
      } catch {
        /* offline: keep the last attribution */
      }
    }, 400);
  };
  layer.on('add', () => {
    map.attributionControl?.addAttribution(current);
    map.on('moveend', updateAttribution);
    updateAttribution();
  });
  layer.on('remove', () => {
    map.off('moveend', updateAttribution);
    map.attributionControl?.removeAttribution(current);
  });
  return layer;
}

/** Forget the cached session, e.g. after the key changes or a tile 403. */
export function clearGoogleSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}
