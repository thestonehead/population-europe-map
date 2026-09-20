# Europe Population Map

A static, interactive map of Europe where every country **and** its local
government units (NUTS&nbsp;2 / NUTS&nbsp;3 regions) are highlightable,
clickable polygons. No backend required — just open `index.html` (or serve the
folder over HTTP so the GeoJSON files load).

## Features

- **Show selector** — switch between *Countries*, *Major regions (NUTS&nbsp;1)*,
  *Localities (NUTS&nbsp;2)* and *Localities (NUTS&nbsp;3)*.
- **Label selector** — write **name**, **population**, **GDP per person
  (PPP)**, **number of representatives in the legislative body**, **MEPs**
  (country level) or **projected MEPs** on each polygon.
- **Label decluttering** — labels are placed at feature centroids and
  collision-checked in screen space. When zooming out, overlapping labels are
  hidden so the map stays readable; they re-appear as you zoom in. Larger
  items (by population) and small priority countries keep their labels.
- **Hover** — a polygon is highlighted on mouse-over, with a tooltip
  (countries also show their number of MEPs).
- **Click** — a side panel shows all details for the selected item
  (country / region), including population, GDP/cap PPP, legislative seats,
  MEPs in the European Parliament (country level), projected MEPs, own
  administration status and parent country.
- **Own administration (legal)** — NUTS regions are shaded differently
  depending on whether they are real administrative-legal units in their
  country (own government / elected assembly: German Länder, Croatian
  županije, …) or purely statistical groupings (e.g. Croatian NUTS&nbsp;2,
  Swedish NUTS&nbsp;1). Teal = has own administration, indigo = statistical
  grouping. The side panel shows the same information per region. Exceptions
  are handled per region (Åland, Azores/Madeira, Vojvodina, UK devolved
  nations, German city-states, …).
- **MEPs** — countries show the number of Members of the European Parliament
  elected there in the 2024–2029 term (720 seats in total). Non-EU countries
  show “—”.
- **Projected MEPs** — at every level (countries and NUTS&nbsp;2 /
  NUTS&nbsp;3 regions), each EU item shows a *projected* number of MEPs: the
  **720** seats of the European Parliament distributed **purely
  proportionally to population** — `round(population / total EU population
  at that level × 720)` — so projections of one level always sum to ≈ 720.
  Compare them with the actual, degressively-proportional allocation to see
  how much small states are over-represented in the EP.
- **Minimum-population slider** — filters how the map breaks items down:
  - `0` (off): the chosen level is shown in full.
  - `> 0`: when switching to a more local level, an item is only replaced by
    its smaller units **if at least one of those units has a population at or
    above the slider value**; otherwise the bigger parent stays.
  - If the slider value is **higher than the population of an entire (biggest)
    item**, that item gets a **transparent yellow overlay**.
  - Items below the threshold are dimmed.

## Data

All data is prepared up-front by `build/build_data.py` and stored in `data/`
as compact GeoJSON with the attributes embedded in each feature's properties:

| level    | file                | count |
|----------|---------------------|-------|
| country  | `data/countries.geojson` | 38    |
| NUTS 1   | `data/nuts1.geojson`     | 125   |
| NUTS 2   | `data/nuts2.geojson`     | 334   |
| NUTS 3   | `data/nuts3.geojson`     | 1514  |

Country boundaries come from the
[leakyMirror/map-of-europe](https://github.com/leakyMirror/map-of-europe)
GeoJSON; regional boundaries from
[Eurostat GISCO NUTS 2021](https://gisco-services.ec.europa.eu/distribution/v2/nuts/).

Population, GDP/capita (PPP) and legislative-seat figures are rounded
approximations compiled for the demo. MEP counts per country are the official
allocation for the 2024–2029 term (720 seats). The "own administration"
flag (true/false per region) reflects whether the NUTS unit is an
administrative-legal entity in its country; it is a curated approximation
compiled from national structures — treat it as indicative, not legal advice.
Regenerate the prepared files with:

```bash
python3 build/build_data.py
```

The build script downloads the raw sources into `build/` if they are missing
and writes the simplified, attribute-enriched GeoJSON into `data/`.

## Run

Because the page fetches local GeoJSON, serve the folder over HTTP, e.g.:

```bash
python3 -m http.server 8000
# open http://localhost:8000/
```

Leaflet (JS + CSS) is vendored under `vendor/leaflet@1.9.4/` so the page has no
runtime dependency on a CDN. The base-map tiles are still loaded from a public
Carto tile server; if you are offline, the polygons and labels still render
on a dark background (tiles simply won't fill in).

## Layout

```
index.html          app entry
styles.css          dark theme + polygon styles
app.js              map logic, selectors, slider, side panel
data/*.geojson      prepared polygons + attributes
vendor/leaflet*     vendored Leaflet 1.9.4
build/build_data.py data preparation / simplification script
```
