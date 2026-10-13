// A made-up ~150 ac field (with a waterway exclusion) for trying the app.

import type { BoundaryGeometry } from './io/import';

export const DEMO_FIELD: { name: string; grower: string; geometry: BoundaryGeometry } = {
  name: 'Demo field',
  grower: 'Demo Farms',
  geometry: {"type": "Polygon", "coordinates": [[[-93.62, 42.03], [-93.62, 42.0368425], [-93.6132275, 42.0372027], [-93.6100832, 42.0357621], [-93.6103251, 42.0303601], [-93.6149207, 42.0298199], [-93.62, 42.03]], [[-93.6154044, 42.032701], [-93.614316, 42.032701], [-93.614316, 42.0337814], [-93.6154044, 42.0337814], [-93.6154044, 42.032701]]]},
};
