# Getting field boundaries from Agvance

There are two ways to get boundaries into Applied Acres. The first works today;
the second needs access your company has to request from SSI.

## 1. Export files (works now)

Agvance can export boundaries as shapefiles, which Applied Acres imports directly.

- **Agvance Mapping (desktop):** in the resource tree, right-click the grower,
  farm or field, choose **Export → Export Shapefile Boundaries**. Each field
  comes out as `FieldName-Boundary.shp` plus its `.dbf`, `.shx` and `.prj`.
- **SKY Mapping:** use the boundary export there if you have it.

Zip each field's files together (or a whole folder of them), put the zip where
the iPad can see it (iCloud Drive, OneDrive, email, AirDrop to Files), then in
Applied Acres tap **Field → Import file** and pick it. A zip with many fields
imports all of them at once. You can also select the loose `.shp`, `.dbf`,
`.prj` files together in the picker. Always include the `.prj`, which records
the coordinate system.

KML/KMZ (Google Earth, Climate FieldView, John Deere Operations Center exports)
and GeoJSON also work.

Once a field is imported it stays on the iPad, and the app offers
"You're in <field>" when GPS puts you inside it.

## 2. Live sync through the Agvance API (needs setup)

SSI licenses the Agvance Web API per company. Access works like this:

- A company admin creates an API user and sets its security in
  **Admin Utilities**.
- A developer gets a developer key from SSI for testing and a separate
  production key when going live.
- An app logs in with those credentials, gets back a session ID, and sends
  that session ID on every later request.

References: [API Developer Resources](https://agvance.net/api),
[Agvance Web API help](https://api.agvance.net/help),
[API Security](https://helpcenter.agvance.net/home/api-security),
[API User Creation](https://helpcenter.agvance.net/home/api-user-creation).

Those credentials shouldn't be stored on an iPad, and a web app can't call the
Agvance API directly from the browser. So Applied Acres talks to a small
**boundary server** that you (or whoever supports your Agvance install) host.
The server keeps the credentials and translates Agvance's field and boundary
data into this simple contract:

```
GET {server}/fields?q=<search>
Authorization: Bearer <token>
→ 200 [{ "id": "123", "name": "North 160", "grower": "Faist Farms", "farm": "Home", "acres": 152.3 }, ...]

GET {server}/fields/{id}/boundary
Authorization: Bearer <token>
→ 200 { "type": "Polygon" | "MultiPolygon", "coordinates": [...] }   // GeoJSON, WGS84 lon/lat
```

The server must send CORS headers allowing the app's origin
(`Access-Control-Allow-Origin`, and `Authorization` in
`Access-Control-Allow-Headers`).

Once the server is running, open **Settings (⚙︎) → Agvance boundary server**,
enter its URL and token, and an **Agvance fields** button appears in the Field
picker. Picking a field downloads its boundary and saves it on the iPad, so it
keeps working without signal. Picking the same field again refreshes it.

### What to ask SSI / your Agvance admin

1. API access for your location, plus an API user with read rights to
   growers, fields and mapping boundaries.
2. Which API endpoints return field boundary geometry (SKY Mapping
   boundaries), and in what format.
3. Whether dispatched work orders (the jobs in Agvance Ops) can be read
   through the API. If so, the boundary server could also send the product,
   rate and ordered acres, so each job opens with the rate already filled in.

With those answers, the boundary server is a small job: a Cloudflare Worker
or a tiny Node service of roughly 100 lines.
