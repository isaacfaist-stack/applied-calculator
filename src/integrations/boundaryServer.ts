// Client for a "boundary server": a small service you host that holds your
// Agvance API credentials and hands this app field boundaries.
//
// The Agvance Web API is licensed per company by SSI and authenticates with a
// login that returns a session ID. Those credentials must not live in an app
// on an iPad, and the API is not reachable from a web page directly, so the
// app talks to this thin, documented contract instead. See
// docs/agvance-integration.md for the contract and setup steps.

import type { BoundaryGeometry } from '../io/import';

export interface RemoteFieldSummary {
  id: string;
  name: string;
  grower?: string;
  farm?: string;
  acres?: number;
}

export interface BoundaryServerConfig {
  url: string;
  token: string;
}

async function get<T>(cfg: BoundaryServerConfig, path: string): Promise<T> {
  const base = cfg.url.replace(/\/+$/, '');
  const res = await fetch(base + path, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Boundary server: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function listRemoteFields(cfg: BoundaryServerConfig, query = ''): Promise<RemoteFieldSummary[]> {
  return get(cfg, `/fields${query ? `?q=${encodeURIComponent(query)}` : ''}`);
}

export function fetchRemoteBoundary(cfg: BoundaryServerConfig, id: string): Promise<BoundaryGeometry> {
  return get(cfg, `/fields/${encodeURIComponent(id)}/boundary`);
}
