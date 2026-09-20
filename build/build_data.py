#!/usr/bin/env python3
"""
Build prepared GeoJSON + data files for the EU population map web app.

Inputs (downloaded by this script if missing):
  - europe_countries.geojson : country polygons (raw.githubusercontent.com/leakyMirror/map-of-europe)
  - nuts2.geojson            : NUTS level 2 regions (GISCO)
  - nuts3.geojson            : NUTS level 3 regions (GISCO)

Outputs (written to <repo>/data/):
  - countries.geojson
  - nuts2.geojson
  - nuts3.geojson

All numeric attributes used by the UI (population, gdp_per_capita_ppp,
seats_lower, meps) are embedded directly into the GeoJSON feature properties so
the frontend has everything it needs without extra joins.
"""
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
WORK = HERE  # raw inputs land next to this script
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))
os.makedirs(DATA, exist_ok=True)

# Douglas-Peucker tolerance in degrees (~0.01deg ~ 1km).
COUNTRY_TOL = 0.008
NUTS_TOL = 0.012

# Eurostat NUTS uses some country codes that differ from ISO2 / our COUNTRY_STATS
# keys. Normalize them so every region maps to a known country.
NUTS_CC_ALIAS = {
    "EL": "GR",   # Greece
    "UK": "UK",   # already ISO2-style here
}

RAW = {
    "europe_countries.geojson": "https://raw.githubusercontent.com/leakyMirror/map-of-europe/master/GeoJSON/europe.geojson",
    "nuts1.geojson": "https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_01M_2021_4326_LEVL_1.geojson",
    "nuts2.geojson": "https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_01M_2021_4326_LEVL_2.geojson",
    "nuts3.geojson": "https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/NUTS_RG_01M_2021_4326_LEVL_3.geojson",
}

# ---------------------------------------------------------------------------
# Data tables
# ---------------------------------------------------------------------------

# Country statistics. Population ~2023 (millions of people). GDP per capita PPP
# ~2023 (international $). Seats in the lower/single house of the national
# legislature. Sources: Eurostat / national parliaments. Values are rounded
# approximations suitable for an interactive demo.
# iso2 -> {name, population_m, gdp_per_capita_ppp, seats_lower}
COUNTRY_STATS = {
    "AT": ("Austria", 9.1, 62000, 183),
    "BE": ("Belgium", 11.7, 64000, 150),
    "BG": ("Bulgaria", 6.4, 32000, 240),
    "HR": ("Croatia", 3.8, 36000, 151),
    "CY": ("Cyprus", 1.3, 51000, 56),
    "CZ": ("Czechia", 10.5, 50000, 200),
    "DK": ("Denmark", 5.9, 74000, 179),
    "EE": ("Estonia", 1.4, 45000, 101),
    "FI": ("Finland", 5.6, 58000, 200),
    "FR": ("France", 68.0, 56000, 577),
    "DE": ("Germany", 84.0, 63000, 733),
    "GR": ("Greece", 10.4, 39000, 300),
    "HU": ("Hungary", 9.6, 42000, 199),
    "IE": ("Ireland", 5.3, 137000, 174),
    "IT": ("Italy", 58.9, 50000, 400),
    "LV": ("Latvia", 1.9, 39000, 100),
    "LT": ("Lithuania", 2.8, 46000, 141),
    "LU": ("Luxembourg", 0.66, 137000, 60),
    "MT": ("Malta", 0.56, 57000, 79),
    "NL": ("Netherlands", 17.8, 68000, 150),
    "PL": ("Poland", 37.6, 44000, 460),
    "PT": ("Portugal", 10.3, 38000, 230),
    "RO": ("Romania", 18.9, 42000, 330),
    "SK": ("Slovakia", 5.4, 36000, 150),
    "SI": ("Slovenia", 2.1, 47000, 90),
    "ES": ("Spain", 48.6, 45000, 350),
    "SE": ("Sweden", 10.5, 61000, 349),
    # EFTA / others present in NUTS data
    "CH": ("Switzerland", 8.8, 89000, 200),
    "NO": ("Norway", 5.5, 95000, 169),
    "IS": ("Iceland", 0.39, 74000, 63),
    "LI": ("Liechtenstein", 0.04, 180000, 25),
    "UK": ("United Kingdom", 67.7, 54000, 650),
    # candidate / non-EU present in NUTS data
    "AL": ("Albania", 2.7, 17000, 140),
    "BA": ("Bosnia and Herzegovina", 3.2, 18000, 42),
    "RS": ("Serbia", 6.6, 21000, 250),
    "ME": ("Montenegro", 0.62, 24000, 81),
    "MK": ("North Macedonia", 1.8, 19000, 120),
    "TR": ("Turkey", 85.0, 32000, 600),
}

# MEPs per country in the European Parliament, 2024-2029 term (720 seats total).
# Non-EU countries are absent and get `meps: null`.
# iso2 -> seats
COUNTRY_MEPS = {
    "AT": 20, "BE": 22, "BG": 17, "HR": 12, "CY": 6, "CZ": 21,
    "DK": 15, "EE": 7, "FI": 15, "FR": 81, "DE": 96, "GR": 21,
    "HU": 21, "IE": 14, "IT": 76, "LV": 9, "LT": 11, "LU": 6,
    "MT": 6, "NL": 31, "PL": 53, "PT": 21, "RO": 33, "SK": 15,
    "SI": 9, "ES": 61, "SE": 21,
}

# Whether NUTS regions at a given level are real administrative-legal units in
# the country (own government / elected assembly / legally constituted
# administration: Land parliament, county assembly, autonomous region, ...),
# as opposed to groupings that exist only for statistics (Eurostat made many
# NUTS units purely for statistical comparability, e.g. Croatian NUTS 2).
# iso2 -> {nuts1/nuts2/nuts3: bool}; regions listed in
# ADMIN_STATUS_EXCEPTIONS below override their country default.
# "True" for whole-country NUTS units (AL0, CH0, HR0, ...) means the region
# is the state itself.
ADMIN_STATUS = {
    "AL": {"nuts1": True,  "nuts2": False, "nuts3": True},   # qarku councils (NUTS3)
    "AT": {"nuts1": False, "nuts2": True,  "nuts3": False},  # Länder are NUTS2 here
    "BE": {"nuts1": True,  "nuts2": True,  "nuts3": True},   # regions / provinces / arrondissements
    "BG": {"nuts1": False, "nuts2": False, "nuts3": True},  # oblasti have governors
    "CH": {"nuts1": True,  "nuts2": False, "nuts3": True},  # cantons are NUTS3
    "CY": {"nuts1": True,  "nuts2": True,  "nuts3": True},   # single-unit country
    "CZ": {"nuts1": True,  "nuts2": False, "nuts3": True},  # kraje with councils
    "DE": {"nuts1": True,  "nuts2": False, "nuts3": True},  # Länder / Reg.-Bez. / Kreise
    "DK": {"nuts1": True,  "nuts2": True,  "nuts3": False},  # regions with councils
    "EE": {"nuts1": True,  "nuts2": True,  "nuts3": False},  # EE00 is the whole state
    "GR": {"nuts1": False, "nuts2": True,  "nuts3": True},   # perifereies / regional units
    "ES": {"nuts1": False, "nuts2": True,  "nuts3": True},   # CCAA / provinces & islands
    "FI": {"nuts1": False, "nuts2": False, "nuts3": True},   # maakunnat (except Åland)
    "FR": {"nuts1": True,  "nuts2": False, "nuts3": True},   # régions / départements
    "HR": {"nuts1": True,  "nuts2": False, "nuts3": True},   # županije have assemblies
    "HU": {"nuts1": False, "nuts2": False, "nuts3": True},   # megyék have assemblies
    "IE": {"nuts1": True,  "nuts2": True,  "nuts3": False},  # regional assemblies (NUTS2)
    "IS": {"nuts1": True,  "nuts2": True,  "nuts3": False},  # landsvæði are statistical
    "IT": {"nuts1": False, "nuts2": True,  "nuts3": True},   # regioni / province
    "LI": {"nuts1": True,  "nuts2": True,  "nuts3": True},   # single-unit country
    "LT": {"nuts1": True,  "nuts2": False, "nuts3": False},  # apskritys: statistical since 2015
    "LU": {"nuts1": True,  "nuts2": True,  "nuts3": True},   # single-unit country
    "LV": {"nuts1": True,  "nuts2": True,  "nuts3": False},  # LV00 is the whole state
    "ME": {"nuts1": True,  "nuts2": True,  "nuts3": False},  # statistical regions
    "MK": {"nuts1": True,  "nuts2": True,  "nuts3": False},  # planning regions
    "MT": {"nuts1": True,  "nuts2": True,  "nuts3": False},  # Gozo excepted below
    "NL": {"nuts1": False, "nuts2": True,  "nuts3": False},  # provincies / COROP
    "NO": {"nuts1": True,  "nuts2": True,  "nuts3": True},   # fylker with councils
    "PL": {"nuts1": False, "nuts2": True,  "nuts3": False},  # voivodeship sejmiki
    "PT": {"nuts1": False, "nuts2": False, "nuts3": True},   # intermunicipal communities
    "RO": {"nuts1": False, "nuts2": False, "nuts3": True},   # judet councils
    "RS": {"nuts1": False, "nuts2": False, "nuts3": False},  # okruzi statistical; Vojvodina excepted
    "SE": {"nuts1": False, "nuts2": False, "nuts3": True},   # län with landsting; NUTS1/2 statistical
    "SI": {"nuts1": True,  "nuts2": False, "nuts3": False},  # cohesion/statistical regions
    "SK": {"nuts1": True,  "nuts2": False, "nuts3": True},   # kraje with assemblies
    "TR": {"nuts1": False, "nuts2": False, "nuts3": True},   # iller with vali
    "UK": {"nuts1": False, "nuts2": False, "nuts3": True},   # devolved nations excepted
}

# Region-level exceptions keyed by NUTS ID (override the country default at
# whatever level the ID appears).
ADMIN_STATUS_EXCEPTIONS = {
    # whole-Land German NUTS-2 units (no Regierungsbezirk layer)
    "DE30": True, "DE40": True, "DE50": True, "DE60": True,
    "DE80": True, "DEE0": True, "DEF0": True, "DEG0": True,
    # UK devolved nations (NUTS1); England's regions stay statistical
    "UKL": True, "UKM": True, "UKN": True,
    # autonomous / special regions
    "RS12": True,   # Vojvodina autonomous province (NUTS2)
    "FI2": True, "FI20": True,                     # Åland
    "PT2": True, "PT3": True,                       # Azores / Madeira (NUTS1)
    "PT20": True, "PT30": True,                    # Azores / Madeira (NUTS2)
    "PT200": True, "PT300": True,                  # Azores / Madeira (NUTS3)
    "FRY1": True, "FRY2": True, "FRY3": True, "FRY4": True, "FRY5": True,  # overseas régions (NUTS2)
    "FRY": False,                                   # RUP NUTS1 grouping: no single government
    "MT002": True,                                  # Gozo (regional committee)
    "NO0B": False, "NO0B1": False, "NO0B2": False,  # Jan Mayen / Svalbard: no county council
    # Mazowieckie is split into two purely statistical NUTS-2 units
    "PL91": False, "PL92": False,
}

# Map leakyMirror "NAME" -> ISO2 (only for the countries we want on the map).
NAME_TO_ISO2 = {
    "Austria": "AT", "Belgium": "BE", "Bulgaria": "BG",
    "Croatia": "HR", "Cyprus": "CY", "Czech Republic": "CZ",
    "Denmark": "DK", "Estonia": "EE", "Finland": "FI", "France": "FR",
    "Germany": "DE", "Greece": "GR", "Hungary": "HU", "Ireland": "IE",
    "Italy": "IT", "Latvia": "LV", "Lithuania": "LT", "Luxembourg": "LU",
    "Malta": "MT", "Netherlands": "NL", "Poland": "PL", "Portugal": "PT",
    "Romania": "RO", "Slovakia": "SK", "Slovenia": "SI", "Spain": "ES",
    "Sweden": "SE", "Switzerland": "CH", "Norway": "NO", "Iceland": "IS",
    "Liechtenstein": "LI", "United Kingdom": "UK", "Albania": "AL",
    "Bosnia and Herzegovina": "BA", "Serbia": "RS", "Montenegro": "ME",
    "The former Yugoslav Republic of Macedonia": "MK", "Turkey": "TR",
}

# NUTS region population (millions) and GDP per capita PPP (int $) estimates.
# Keyed by NUTS_ID. Only a representative subset is provided here; regions not
# listed fall back to estimates derived from their parent country so every
# region still has values for the UI. Values are rounded approximations.
NUTS_STATS = {
    # Germany (DE) level 2
    "DE11": ("Stuttgart", 4.0, 66000),
    "DE12": ("Karlsruhe", 2.7, 60000),
    "DE13": ("Freiburg", 2.2, 55000),
    "DE14": ("Tübingen", 1.8, 55000),
    "DE21": ("Oberbayern", 4.7, 73000),
    "DE22": ("Niederbayern", 1.0, 49000),
    "DE23": ("Oberpfalz", 1.1, 52000),
    "DE71": ("Darmstadt", 4.0, 69000),
    "DE30": ("Berlin", 3.7, 53000),
    "DE40": ("Brandenburg", 2.5, 38000),
    "DE50": ("Bremen", 0.67, 54000),
    "DE60": ("Hamburg", 1.9, 70000),
    "DEA": ("Düsseldorf", 5.4, 60000),
    "DEB": ("Köln", 4.6, 57000),
    "DEC": ("Münster", 2.6, 55000),
    "DED": ("Detmold", 2.1, 52000),
    "DEE": ("Arnsberg", 3.7, 51000),
    "DEF": ("Schleswig-Holstein", 2.9, 51000),
    "DEG": ("Thüringen", 2.1, 42000),
    # France (FR) level 2
    "FR10": ("Île-de-France", 12.3, 78000),
    "FR24": ("Centre-Val de Loire", 2.6, 38000),
    "FR22": ("Bretagne", 3.4, 39000),
    "FRF2": ("Bourgogne", 1.6, 36000),
    "FRB0": ("Normandie", 3.3, 37000),
    "FRC2": ("Auvergne", 1.1, 35000),
    "FRE1": ("Languedoc-Roussillon", 2.9, 32000),
    "FRJ2": ("Nouvelle-Aquitaine", 6.0, 38000),
    "FRK2": ("Provence-Alpes-Côte d'Azur", 5.1, 40000),
    "FRI3": ("Rhône-Alpes", 8.2, 47000),
    "FRL0": ("Provence-Alpes-Côte d'Azur", 5.1, 40000),
    # Italy level 2
    "ITC1": ("Piemonte", 4.3, 39000),
    "ITC4": ("Lombardia", 10.1, 46000),
    "ITI1": ("Toscana", 3.7, 40000),
    "ITI2": ("Umbria", 0.88, 35000),
    "ITI3": ("Marche", 1.5, 35000),
    "ITI4": ("Lazio", 5.8, 42000),
    "ITF1": ("Abruzzo", 1.3, 32000),
    "ITF3": ("Campania", 5.8, 29000),
    "ITF4": ("Puglia", 4.0, 28000),
    "ITF6": ("Calabria", 1.9, 25000),
    "ITG1": ("Sicilia", 4.8, 27000),
    "ITG2": ("Sardegna", 1.6, 30000),
    "ITC2": ("Valle d'Aosta", 0.13, 46000),
    "ITH5": ("Emilia-Romagna", 4.5, 45000),
    "ITI5": ("Molise", 0.30, 31000),
    "ITF2": ("Molise", 0.30, 31000),
    # Spain level 2
    "ES11": ("Galicia", 2.7, 32000),
    "ES12": ("Principado de Asturias", 1.0, 34000),
    "ES21": ("País Vasco", 2.2, 46000),
    "ES22": ("Comunidad Foral de Navarra", 0.66, 44000),
    "ES23": ("La Rioja", 0.32, 38000),
    "ES24": ("Aragón", 1.3, 36000),
    "ES30": ("Comunidad de Madrid", 6.8, 45000),
    "ES41": ("Castilla y León", 2.4, 33000),
    "ES42": ("Castilla-La Mancha", 2.1, 29000),
    "ES43": ("Extremadura", 1.1, 27000),
    "ES51": ("Cataluña", 7.8, 42000),
    "ES52": ("Comunidad Valenciana", 5.1, 34000),
    "ES53": ("Illes Balears", 1.2, 36000),
    "ES61": ("Andalucía", 8.5, 29000),
    "ES62": ("Región de Murcia", 1.6, 30000),
    "ES70": ("Canarias", 2.2, 31000),
    # Poland level 2
    "PL11": ("Warszawski", 3.4, 55000),
    "PL21": ("Białostocki", 0.75, 36000),
    "PL22": ("Suwalski", 0.34, 32000),
    "PL31": ("Krakowski", 1.9, 41000),
    "PL32": ("Tarnowski", 0.6, 30000),
    "PL33": ("Nowosądecki", 1.0, 30000),
    "PL41": ("Poznański", 1.7, 42000),
    "PL42": ("Kaliszki", 1.1, 34000),
    "PL43": ("Pilski", 0.55, 31000),
    "PL51": ("Wrocławski", 2.2, 44000),
    "PL52": ("Opolski", 0.45, 33000),
    "PL53": ("Wałbrzyski", 0.85, 32000),
    "PL61": ("Trójmiasto", 1.8, 41000),
    "PL62": ("Bydgoski", 0.95, 33000),
    "PL63": ("Toruński", 1.0, 35000),
    "PL71": ("Łódzki", 1.0, 38000),
    "PL72": ("Sieradzki", 1.4, 30000),
    # Netherlands level 2
    "NL11": ("Groningen", 0.62, 49000),
    "NL12": ("Friesland", 0.65, 47000),
    "NL13": ("Drenthe", 0.49, 48000),
    "NL21": ("Overijssel", 1.2, 51000),
    "NL22": ("Gelderland", 2.1, 54000),
    "NL23": ("Flevoland", 0.43, 52000),
    "NL31": ("Utrecht", 1.4, 62000),
    "NL32": ("Noord-Holland", 2.9, 64000),
    "NL33": ("Zuid-Holland", 3.8, 63000),
    "NL34": ("Zeeland", 0.39, 49000),
    "NL41": ("Noord-Brabant", 2.6, 53000),
    "NL42": ("Limburg", 1.1, 48000),
}

# ---------------------------------------------------------------------------
# Geometry helpers (tiny, dependency-free)
# ---------------------------------------------------------------------------

def to_2d(coords):
    """Drop any z coordinate -> 2D coords, recursively."""
    if isinstance(coords[0], (int, float)):
        return [float(coords[0]), float(coords[1])]
    return [to_2d(c) for c in coords]


def ring_area(ring):
    s = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        s += x1 * y2 - x2 * y1
    return abs(s) / 2.0


def poly_area(poly):
    # poly = [ exterior_ring, hole, hole, ... ]
    a = ring_area(poly[0])
    for h in poly[1:]:
        a -= ring_area(h)
    return a


def geom_area(geom):
    g = geom["coordinates"]
    if geom["type"] == "Polygon":
        return poly_area(g)
    if geom["type"] == "MultiPolygon":
        return sum(poly_area(p) for p in g)
    return 0.0


def clean_geometry(geom):
    return {"type": geom["type"], "coordinates": to_2d(geom["coordinates"])}


# Simplify a ring with Douglas-Peucker. A ring is treated as a polyline;
# we keep the first/last point identical (closed ring) by simplifying the
# open sequence ring[:-1] then re-appending the closing point.
def _perp_dist(pt, a, b):
    if a == b:
        dx, dy = pt[0] - a[0], pt[1] - a[1]
        return (dx * dx + dy * dy) ** 0.5
    ux, uy = b[0] - a[0], b[1] - a[1]
    vx, vy = pt[0] - a[0], pt[1] - a[1]
    cross = ux * vy - uy * vx
    return abs(cross) / (ux * ux + uy * uy) ** 0.5


def _dp(pts, tol):
    if len(pts) < 3:
        return pts
    stack = [(0, len(pts) - 1)]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        dmax, idx = -1.0, -1
        for k in range(i + 1, j):
            d = _perp_dist(pts[k], pts[i], pts[j])
            if d > dmax:
                dmax, idx = d, k
        if dmax > tol and idx != -1:
            keep[idx] = True
            stack.append((i, idx))
            stack.append((idx, j))
    return [pts[k] for k in range(len(pts)) if keep[k]]


def simplify_ring(ring, tol):
    if len(ring) <= 4:
        return ring
    open_seq = ring[:-1]
    simp = _dp(open_seq, tol)
    if simp[0] != simp[-1]:
        simp = simp + [simp[0]]
    return simp


def simplify_polygon(poly, tol):
    out = [simplify_ring(poly[0], tol)]
    for h in poly[1:]:
        s = simplify_ring(h, tol)
        if len(s) >= 4:
            out.append(s)
    return out


def simplify_geometry(geom, tol):
    g = geom["coordinates"]
    if geom["type"] == "Polygon":
        return {"type": "Polygon", "coordinates": simplify_polygon(g, tol)}
    if geom["type"] == "MultiPolygon":
        polys = [simplify_polygon(p, tol) for p in g]
        polys = [p for p in polys if len(p[0]) >= 4]
        return {"type": "MultiPolygon", "coordinates": polys}
    return geom


# ---------------------------------------------------------------------------
# Build steps
# ---------------------------------------------------------------------------

def ensure_raw():
    for name, url in RAW.items():
        p = os.path.join(WORK, name)
        if not os.path.exists(p):
            print(f"downloading {name} ...", flush=True)
            urllib.request.urlretrieve(url, p)


def load(name):
    with open(os.path.join(WORK, name)) as f:
        return json.load(f)


def build_countries():
    d = load("europe_countries.geojson")
    feats = []
    for f in d["features"]:
        name = f["properties"].get("NAME")
        iso2 = NAME_TO_ISO2.get(name)
        if not iso2:
            continue
        stats = COUNTRY_STATS.get(iso2)
        pop_m = stats[1] if stats else 0.0
        props = {
            "id": iso2,
            "iso2": iso2,
            "name": stats[0] if stats else name,
            "level": "country",
            "population": round(pop_m * 1_000_000),
            "gdp_per_capita_ppp": stats[2] if stats else None,
            "seats_lower": stats[3] if stats else None,
            "meps": COUNTRY_MEPS.get(iso2),
        }
        feats.append({
            "type": "Feature",
            "properties": props,
            "geometry": simplify_geometry(clean_geometry(f["geometry"]), COUNTRY_TOL),
        })
    out = {"type": "FeatureCollection", "features": feats}
    with open(os.path.join(DATA, "countries.geojson"), "w") as fh:
        fh.write(json.dumps(out, separators=(",", ":")))
    print(f"countries.geojson: {len(feats)} features")


def _country_for_nuts(cc):
    s = COUNTRY_STATS.get(cc)
    return s  # tuple or None


def admin_status_for(nid, cc, level):
    lvl = f"nuts{level}"
    if nid in ADMIN_STATUS_EXCEPTIONS:
        return ADMIN_STATUS_EXCEPTIONS[nid]
    status = ADMIN_STATUS.get(cc)
    if not status:
        return None
    return status.get(lvl)


def _region_fallbacks(d, level):
    """Area-proportional population fallback for regions without NUTS_STATS.

    Splits each country's total population across its regions of this level
    proportionally to polygon area, so the level's populations sum to the
    country total (much more plausible than a flat per-region estimate)."""
    by_cc = {}
    for f in d["features"]:
        p = f["properties"]
        cc = p.get("CNTR_CODE")
        cc = NUTS_CC_ALIAS.get(cc, cc)
        if cc not in COUNTRY_STATS:
            continue
        by_cc.setdefault(cc, []).append(f)
    out = {}
    for cc, feats in by_cc.items():
        pops = {}
        areas = {f["properties"]["NUTS_ID"]: max(geom_area(f["geometry"]), 1e-12) for f in feats}
        known = {nid: NUTS_STATS[nid][1] for nid in areas if nid in NUTS_STATS}
        total_m = COUNTRY_STATS[cc][1]
        remainder_m = total_m - sum(known.values())
        unknown = [nid for nid in areas if nid not in known]
        if unknown:
            if remainder_m <= 0:
                # all NUTS_STATS values already exceed the country total:
                # fall back to area share of the country total
                for nid in unknown:
                    share = areas[nid] / sum(areas.values())
                    pops[nid] = round(total_m * share, 2)
            else:
                unknown_area = sum(areas[nid] for nid in unknown)
                for nid in unknown:
                    share = areas[nid] / unknown_area
                    pops[nid] = round(remainder_m * share, 2)
        for nid, pm in known.items():
            pops[nid] = pm
        out[cc] = pops
    return out


def build_nuts(infile, outfile, level):
    d = load(infile)
    fallbacks = _region_fallbacks(d, level)
    feats = []
    seen = set()
    for f in d["features"]:
        p = f["properties"]
        cc = p.get("CNTR_CODE")
        cc = NUTS_CC_ALIAS.get(cc, cc)
        if cc not in COUNTRY_STATS:
            continue
        nid = p.get("NUTS_ID")
        if nid in seen:
            continue
        seen.add(nid)
        cstat = COUNTRY_STATS[cc]
        nname = p.get("NUTS_NAME") or nid
        nstat = NUTS_STATS.get(nid)
        if nstat:
            pop_m = nstat[1]
            gdp = nstat[2]
        else:
            pop_m = fallbacks.get(cc, {}).get(nid) or max(0.05, round(cstat[1] * 0.02, 2))
            gdp = cstat[2]
        props = {
            "id": nid,
            "nuts_id": nid,
            "country": cc,
            "country_name": cstat[0],
            "name": nname,
            "level": f"nuts{level}",
            "population": round(pop_m * 1_000_000),
            "gdp_per_capita_ppp": gdp,
            "seats_lower": None,
            "meps": None,
            "admin_gov": admin_status_for(nid, cc, level),
        }
        feats.append({
            "type": "Feature",
            "properties": props,
            "geometry": simplify_geometry(clean_geometry(f["geometry"]), NUTS_TOL),
        })
    out = {"type": "FeatureCollection", "features": feats}
    with open(os.path.join(DATA, outfile), "w") as fh:
        fh.write(json.dumps(out, separators=(",", ":")))
    print(f"{outfile}: {len(feats)} features")


def main():
    ensure_raw()
    build_countries()
    build_nuts("nuts1.geojson", "nuts1.geojson", 1)
    build_nuts("nuts2.geojson", "nuts2.geojson", 2)
    build_nuts("nuts3.geojson", "nuts3.geojson", 3)
    print("done ->", DATA)


if __name__ == "__main__":
    main()
