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

// Browsers normally tell other sites only "https://user.github.io/" when a
// page requests something cross-origin. Sending the full page address makes
// a key restricted to either ".../*" or ".../applied-calculator/*" work.
const REFERRER_POLICY = 'no-referrer-when-downgrade' as const;

/** Turns Google's error text into what to change, in plain words. */
export function explainGoogleError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('referer') || m.includes('referrer'))
    return `The key's website restriction doesn't allow this app. In Google Cloud → Credentials → your key → Website restrictions, add ${location.origin}/*`;
  if (m.includes('billing'))
    return 'Billing is not set up on the Google Cloud project. Google requires a billing account even inside the free allowance.';
  if (m.includes('has not been used') || m.includes('is disabled') || m.includes('not been enabled'))
    return 'The Map Tiles API is not turned on. In Google Cloud → APIs & Services → Library, search "Map Tiles API" and click Enable. It can take a few minutes to take effect.';
  if (m.includes('not authorized to use this api') || m.includes('api_key_service_blocked') || m.includes('blocked'))
    return "The key's API restrictions don't include the Map Tiles API. In Google Cloud → Credentials → your key → API restrictions, add Map Tiles API.";
  if (m.includes('api key not valid') || m.includes('invalid api key') || m.includes('api_key_invalid'))
    return "Google doesn't recognize the key. It may have been copied with a missing or extra character.";
  if (m.includes('load failed') || m.includes('failed to fetch') || m.includes('network'))
    return "Couldn't reach Google. Check the iPad has signal or Wi-Fi.";
  return message;
}

export class GoogleMapsError extends Error {
  constructor(
    public readonly googleMessage: string,
    public readonly status: number,
  ) {
    super(`Google Maps: ${googleMessage}`);
  }
}

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

async function createSession(key: string, imagery: GoogleImagery, useCache = true): Promise<Session> {
  const cached = useCache ? loadSession(key, imagery) : null;
  if (cached) return cached;
  const body: Record<string, unknown> = {
    mapType: 'satellite',
    language: navigator.language || 'en-US',
    region: 'US',
  };
  // Hybrid = satellite with roads and place labels drawn on top.
  if (imagery === 'hybrid') body.layerTypes = ['layerRoadmap'];
  let res: Response;
  try {
    res = await fetch(`${API}/v1/createSession?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      referrerPolicy: REFERRER_POLICY,
    });
  } catch (err) {
    throw new GoogleMapsError(String((err as Error)?.message ?? err), 0);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const e = (await res.json())?.error;
      detail = [e?.message, e?.status, ...(e?.details ?? []).map((d: { reason?: string }) => d?.reason)]
        .filter(Boolean)
        .join(' · ') || detail;
    } catch {
      /* keep status */
    }
    throw new GoogleMapsError(detail, res.status);
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
    referrerPolicy: REFERRER_POLICY,
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
        const res = await fetch(`${API}/tile/v1/viewport?${params}`, { referrerPolicy: REFERRER_POLICY });
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

export interface GoogleTestResult {
  ok: boolean;
  /** Plain-language result for the operator. */
  message: string;
  /** Google's own error text, for troubleshooting. */
  detail?: string;
}

/** Checks a key end to end: a fresh session, then one real tile. */
export async function testGoogleKey(key: string): Promise<GoogleTestResult> {
  if (!key) return { ok: false, message: 'No API key entered.' };
  let s: Session;
  try {
    s = await createSession(key, 'satellite', false);
  } catch (err) {
    const raw = err instanceof GoogleMapsError ? err.googleMessage : String((err as Error)?.message ?? err);
    return { ok: false, message: explainGoogleError(raw), detail: raw };
  }
  const tileOk = await new Promise<boolean>((resolve) => {
    const img = new Image();
    img.referrerPolicy = REFERRER_POLICY;
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = `${API}/v1/2dtiles/0/0/0?session=${encodeURIComponent(s.session)}&key=${encodeURIComponent(key)}`;
  });
  return tileOk
    ? { ok: true, message: 'Google imagery is working.' }
    : {
        ok: false,
        message: `The key works but Google refused the imagery itself. Check the key's website restriction includes ${location.origin}/* and that the Map Tiles API is enabled.`,
      };
}
