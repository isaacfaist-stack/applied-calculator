# Google satellite imagery

Applied Acres shows Google's satellite imagery through the Google Maps
Platform **Map Tiles API**. This is Google's supported way to use its tiles
in a non-Google map. It needs your own API key. Google bills usage to your
Google Cloud account, with a monthly free allowance; check the current
[Map Tiles API pricing](https://developers.google.com/maps/documentation/tile/usage-and-billing)
for the numbers. One person's daily use is small.

## Get a key (about 10 minutes, one time)

1. Go to <https://console.cloud.google.com/>, sign in, and create a project
   (e.g. "Applied Acres").
2. Set up billing for the project (Google requires a billing account even
   within the free allowance).
3. **APIs & Services → Library**: search for **Map Tiles API** and click
   **Enable**.
4. **APIs & Services → Credentials → Create credentials → API key**.
5. Restrict the key so it's useless to anyone else:
   - **Application restrictions → Websites**: add
     `https://<your-github-user>.github.io/*` (and `http://localhost:5173/*`
     if you run it locally).
   - **API restrictions → Restrict key → Map Tiles API**.

## Put the key in the app

Pick one:

- **On the iPad:** ⚙︎ Settings → Satellite imagery → paste the key → *Save
  imagery settings*. It's stored only on that iPad.
- **Built into the app** (every iPad gets it automatically): in the GitHub
  repo, **Settings → Secrets and variables → Actions → New repository secret**,
  name it `GOOGLE_MAPS_API_KEY`, and paste the key. The next deploy includes
  it. A key in a web app is visible to anyone who looks, which is normal for
  browser map keys and why the website restriction above matters.

## Things to know

- Google's terms don't allow saving its imagery for offline use, so Google
  imagery needs signal. With no signal the app switches to Esri imagery, and
  any Esri tiles you've viewed before are kept on the iPad. Before heading to
  fields with poor coverage, glance at them once on Esri with signal.
- Field boundaries, plans and all the math work fully offline regardless of
  imagery.
- The map shows the attribution Google returns for the area in view
  ("Google Maps · Imagery ©…"), as Google requires.
- If Google imagery stops loading, the app says so. It usually means the key
  was restricted to the wrong website, or the Map Tiles API isn't enabled.
