# Applied Acres

An iPad app for custom applicators. Load a field boundary, set your machine
width and how you'll run the headlands, and it plans the field and tells you:

- **Surface acres**: the real area of the field.
- **Applied acres**: what your rate controller will count once headland
  corners, pass ends crossing angled headlands, and the partial last pass are
  included.
- **The rate to set** so the product you loaded comes out even. It gives
  the percentage to cut back (stretch) or raise (use it all up).

**Rate or density:** you can make the adjustment by changing the rate, or
by changing the product density programmed into a dry controller. Density
works backwards: programming a higher density than the product really has
meters less product, so a 4.8% rate cut is the same as a 5.0% density
increase. With density, the rate on the screen and in your as-applied records
stays at the prescription.

**Machine bias (shim):** each machine can carry a percent it typically runs
off, such as a spreader that puts out 3% more than the monitor says. Every
suggested rate or density is corrected for it.

**Several fields on one ticket:** in the Field list, tap **Select several**,
tick the fields, and tap **Plan together**. Each field is still planned on its
own (its own headlands and pass direction), and the app totals them into
one surface/applied figure and one rate or density for the whole load, with
a per-field breakdown.

**Average rate decrease:** a belt that can't keep up with speed changes
averages under the requested rate. Each machine can carry its decrease (e.g.
4% under, or enter the requested and job-average rates and it works it out),
and every answer accounts for it.

**Machine & calibration window:** machine setup (width, sections, bias,
average rate decrease) and the finished-job check live in their own window,
opened with 🚜 in the top bar.

**Check a finished job:** enter the load, what's left, and the monitor's
applied acres and average rate. The app separates rate tracking from what
remains, and shows the true product density or the machine bias that would
explain the remainder. Use the density for the rest of that blend.

**Calibration log:** add each checked job to the machine's log. The machine's
average rate decrease and bias come from the average of the logged jobs
(bigger loads count for more), with a note on how consistent they are. A job
that doesn't fit the others is flagged and can be left out or deleted.
**Start over** clears the log and resets the machine to no corrections, for
recalibrating from a clean slate after a repair or a new controller.

**Finish job from the Operations Center report:** after the field, tap
**Finish job** on the ticket (Product card) or in 🚜 → Calibrate, and load the
job report PDF from Operations Center. The app reads the monitor's applied
acres, applied total, applied and target rate, times and machine serial (which
picks the machine next time). Product loaded comes from the ticket and the
density set comes from the app's answer, so the only number to type is **what's
left over** (or tap Empty). A density-cup reading is optional and makes the
result sharper. Inputs that don't fit together (wrong report, a reload not
counted) are flagged before saving. Saving adds the job to the calibration log
and opens it. For a ticket covering several fields, add one report per field.

**Tuning that separates the error sources:**

- *Learned product densities.* Bulk volumes add, so a blend's density follows
  from its ingredients. Each density-cup reading of a ticket blend teaches the
  app what your potash, triple super, MAP, urea and so on really weigh. Once a
  blend is mostly products you've cup-checked, its density is predicted from the
  ticket's ingredients and offered instead of the plant's calculated value.
- *Bias from measured loads.* Tick "Measured with a density cup" when logging a
  job. With two or more such loads, the bias comes from those only, so density
  error is kept out of it. The ± shown is a 95% range that narrows with more jobs.
- *Belt lag by field shape.* The plan counts speed changes (pass starts, lap
  starts, sharp corners) per mile. With logged jobs from open and cut-up fields,
  the app fits rate decrease = base + per-speed-change amount and uses the right
  value for each field, but only when the jobs clearly show it.
- *Acre check.* Each logged job keeps the plan's applied acres next to the
  monitor's, so you can see whether the work plan matches how you drive.
- Recent jobs count for more (a job's weight halves each year).

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

Holes in a boundary are **exclusions**, left out of surface acres. Each is
either **drive through** (a grass waterway: passes cross it with product off)
or **go around** (trees, a pond, buildings: headland laps wrap it like a field
edge and passes stop at that headland).

Shutoff settings only apply where a pass crosses a headland line. Where a
section runs alongside a headland, an obstacle or the last pass with only part
of its width over unapplied ground, it stays on rather than leave a strip.

Imported boundaries can be edited piece by piece. Very detailed ones are
thinned for editing (the app says how closely the shape is kept), and
**Restore imported boundary** undoes all edits.

## Made for crews, not just one person

- **First-run setup** walks a new user through their machine, usual product
  rate, and first field (import, draw, or a demo field). It can be rerun from
  Settings.
- **ⓘ on every setting** opens a plain-language explanation, with diagrams for
  headland shutoff and corners.
- **Sanity checks:** any adjustment over 10% shows a warning listing the inputs
  most likely to be wrong (product given vs. field size, density, machine
  corrections, rate and unit). Density mode is hidden for liquid units.
- **Numbered steps** (1 Field, 2 Product, 3 Work plan) tick off as they're
  filled in, and the answer says exactly what to set on the controller.
- **Labeled map buttons**, and the Google key / Agvance server tucked under
  Settings → Advanced.

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

### New job from a blend ticket

Tap the field name at the top, then **New job from ticket**, and choose the blend ticket PDF (from Files, Mail or
AirDrop). The app reads the ticket offline: grower, field name and Agvance
field ID, ticket acres, blend rate (lb/ac), total blend weight, density, the
products in the blend and the application method. Then:

1. **Field:** saved fields that match the ticket are listed and the best match
   is ticked. If the field isn't saved yet, import its boundary file or draw
   it right there. Tick several fields if one ticket covers them.
2. **Confirm:** check the rate, product given, density and machine. The app
   warns when the ticket acres and the boundary acres don't agree.
3. **Start job:** everything is filled in and the plan runs. The field
   remembers the ticket's Agvance field ID, so the next ticket for that field
   finds it straight away.

Tickets have to be real PDFs with text in them, which is how Agvance prints
them. A scan or a photo of a paper ticket can't be read; enter it by hand
with **No ticket**.

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

Every input section (Product, Work plan, Machine, and so on) folds closed with a
tap on its title and shows a one-line summary while closed. The app remembers
which sections you left open.

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
| `src/engine/rate.ts` | Rate, density, machine-factor and job-check math |
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
