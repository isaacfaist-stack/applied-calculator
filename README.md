# Applied Acres

An iPad app for custom applicators. Load a field boundary, set your machine
width and how you'll run the headlands, and it plans the field and tells you:

- **Surface acres**: the real area of the field.
- **Applied acres**: what your rate controller will count once headland
  corners, pass ends crossing angled headlands, and the partial last pass are
  included.
- **The rate to set** so the product you loaded comes out even. It gives
  the percentage to cut back (stretch) or raise (use it all up).

A **Mid-field check** takes what the monitor and bin show partway through
and tells you the rate that finishes the field empty.

## Why applied acres differ from surface acres

A rate controller meters product as *rate × working width × distance driven
with product on*. Any ground you cover twice is product that leaves the
machine, even though the ticket was figured on surface acres. The app drives a
simulated plan across the boundary and adds up the overlap:

1. **Headland laps**: laps around the boundary spaced one working width
   apart. Corners are handled one of two ways: *Run into corner* (drive until
   the spread reaches the edge, then turn, so no skips but extra product) or
   *Pivot on line* (turn on the lap line, which leaves small corner skips).
2. **Passes**: straight passes through the middle, one width apart, in
   the direction you choose: along the longest side, the direction with the
   least overlap (the app tries every heading), or manual.
3. **Shutoff at the headland**: when product turns off where a pass meets
   the headland. *No skips* keeps it on while any part of the boom/spread is
   over unapplied ground. *Center* shuts off when the middle crosses.
   *Least overlap* shuts off as soon as any part crosses. With **sections**
   set above 1, each section does this on its own, the same way auto section
   control does.
4. **Coverage map**: the map shades ground applied once (green), twice
   (yellow), three or more times (orange), missed (red), and product thrown
   outside the boundary or onto excluded areas (blue).

Holes in a boundary (waterways, farmsteads, ponds) are excluded from surface
acres, and passes shut off across them.

## Using it on the iPad

1. Open the app's web address in **Safari**, tap **Share → Add to Home
   Screen**. It then opens full-screen like a regular app and **works
   offline**. Satellite imagery you've already viewed is kept for offline use.
2. Tap **Field → Import file** and pick an Agvance shapefile export (.zip),
   KML/KMZ or GeoJSON, or tap **Draw on map** and tap the field's corners.
   See [docs/agvance-integration.md](docs/agvance-integration.md) for
   Agvance.
3. Set up your machine once (width in feet, number of sections). You can
   save several machines.
4. Enter the target rate, plus the amount loaded if you know it. The big
   number at the top is what to set on the controller.

### Satellite map and drawing boundaries

- **Imagery:** Google satellite, Google satellite with roads and labels, or
  Esri. Tap 🛰 on the map to switch. Google imagery needs an API key (see
  [docs/google-maps.md](docs/google-maps.md)). Esri needs no key, and Esri
  tiles you've viewed stay available offline. Without signal, the app falls
  back to Esri automatically.
- **All your fields on the map:** every saved field is outlined and labeled.
  Tap one to open it.
- **Draw a field:** tap **Field → Draw on map**, then tap the corners. The
  acreage updates as you go.
- **Edit a field:** **Edit boundary** lets you drag a corner to move it, tap a
  corner to remove it, or tap the small ◦ between two corners to add one.
  Undo works through every change.
- **Exclusions:** **Add exclusion** draws a waterway, farmstead or pond inside
  the field. It comes off the surface acres, and passes shut off across it.

Fields, machines and each field's last settings are saved on the iPad. With
location allowed, the field list sorts by distance, and the app offers the
field you're parked in. **Settings → Back up** saves everything to a file.

## Development

```bash
npm install
npm run dev        # local dev server (use --host to reach it from the iPad on the same Wi-Fi)
npm test           # geometry and rate-math tests
npm run build      # production build in dist/
```

The app is plain TypeScript + Vite, using Leaflet for the map and Clipper for
polygon offsetting. The planning engine (`src/engine/`) has no UI
dependencies and runs in a web worker.

| Path | What it does |
| --- | --- |
| `src/engine/plan.ts` | Headland laps, passes, section shutoff, heading optimizer |
| `src/engine/coverage.ts` | Rasterized coverage map and overlap/skip totals |
| `src/engine/rate.ts` | Rate adjustment and mid-field math |
| `src/io/import.ts` | Shapefile / KML / KMZ / GeoJSON import |
| `src/map/googleTiles.ts` | Google satellite imagery (Map Tiles API) with live attribution |
| `src/map/editor.ts` | Touch boundary editor (draw, drag, insert, remove, undo) |
| `src/integrations/boundaryServer.ts` | Optional Agvance sync via a boundary server |
| `samples/` | Example boundary files for trying the app |

### Deploying

`.github/workflows/deploy.yml` runs the tests and publishes the app to GitHub
Pages on every push to `main`. Turn it on once under **Settings → Pages →
Source: GitHub Actions**. The app is then at
`https://<your-user>.github.io/applied-calculator/`.

## Limits of the estimate

This is a planning estimate, not an as-applied record. It assumes straight,
evenly spaced passes at the programmed width. Spinner spread-pattern overlap,
GPS drift, point rows the operator runs differently, and headland laps around
interior obstacles aren't modeled. Compare against a few finished fields'
as-applied acres and adjust the headland/shutoff settings to match how you
actually run.
