/*
 * Europe Population Map
 * Static, dependency-light (Leaflet + prepared GeoJSON) interactive map.
 *
 * UI state:
 *   - level   : "country" | "nuts2" | "nuts3"  (what polygons are drawn)
 *   - label   : which attribute is written on the polygons
 *   - minPop  : minimum-population filter, in millions (0 = disabled)
 *
 * Slider semantics:
 *   - At 0 the filter is off; everything shown normally.
 *   - A polygon is "eligible" if its population >= minPop (in millions).
 *   - When switching to a more local level (nuts2/nuts3), a parent item is
 *     replaced by its children ONLY IF at least one child is eligible
 *     (population >= minPop). Otherwise the parent is kept.
 *   - If minPop exceeds the population of the whole (biggest) item shown, that
 *     item gets a transparent yellow overlay.
 */

const LEVEL_FILES = {
  country: "data/countries.geojson",
  nuts1: "data/nuts1.geojson",
  nuts2: "data/nuts2.geojson",
  nuts3: "data/nuts3.geojson",
};

const LEVEL_ORDER = ["country", "nuts1", "nuts2", "nuts3"];
const LEVEL_LABELS = {
  country: "Country",
  nuts1: "Major region (NUTS 1)",
  nuts2: "Region (NUTS 2)",
  nuts3: "Region (NUTS 3)",
};

const EP_TOTAL_MEPS = 720; // European Parliament seats, 2024–2029 term

const LABEL_FIELDS = {
  name: { key: "name", fmt: (v) => v ?? "—" },
  population: { key: "population", fmt: (v) => formatPop(v) },
  gdp_per_capita_ppp: {
    key: "gdp_per_capita_ppp",
    fmt: (v) => (v == null ? "—" : "$" + v.toLocaleString("en-US")),
  },
  seats_lower: {
    key: "seats_lower",
    fmt: (v) => (v == null ? "—" : v.toLocaleString("en-US")),
  },
  meps: { key: "meps", fmt: (v) => (v == null ? "—" : String(v)) },
  meps_projected: { key: "meps_projected", fmt: (v) => (v == null ? "—" : String(v)) },
};

const state = {
  level: "country",
  label: "name",
  minPopM: 0,
  data: { country: null, nuts1: null, nuts2: null, nuts3: null }, // feature collections
  layer: null, // current L.geoJSON layer
  overlayLayer: null, // yellow overlay polygons
  labelLayer: null, // L.layerGroup of tooltips
  selected: null, // { id, level }
  pendingCountry: null, // iso2 set when drilldown is blocked
};

const map = L.map("map", {
  center: [49, 12],
  zoom: 4,
  minZoom: 3,
  maxZoom: 9,
  zoomControl: true,
  worldCopyJump: false,
});

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  subdomains: "abcd",
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a> &middot; NUTS: Eurostat-GISCO',
}).addTo(map);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatPop(v) {
  if (v == null) return "—";
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return (v / 1_000).toFixed(0) + "k";
  return String(v);
}

// MEPs of a country by ISO2 (null for non-EU countries).
function countryMeps(iso2) {
  if (!state.data.country) return null;
  if (!state._mepByCountry) {
    const m = new Map();
    for (const f of state.data.country.features) m.set(f.properties.id, f.properties.meps);
    state._mepByCountry = m;
  }
  return state._mepByCountry.get(iso2) ?? null;
}

// Total population of all EU features at the given level. The projections of
// all EU features of one level sum to (about) 720.
function euPopulationAtLevel(level) {
  if (state.data["_euPop_" + level] != null) return state.data["_euPop_" + level];
  const fc = state.data[level];
  let total = 0;
  if (fc) {
    for (const f of fc.features) {
      const cc = level === "country" ? f.properties.id : f.properties.country;
      if (countryMeps(cc) != null) total += f.properties.population || 0;
    }
  }
  state.data["_euPop_" + level] = total;
  return total;
}

// Projected number of MEPs for an EU feature at any level: the 720 EP seats
// (2024–2029 term) distributed purely proportionally to population, i.e. the
// feature's share of the total EU population at its level times 720. Small
// regions can round to 0. Returns null for non-EU features or features
// without population data.
function projectedMeps(feat) {
  const pop = feat.properties.population;
  if (!pop) return null;
  const cc = feat.properties.level === "country" ? feat.properties.id : feat.properties.country;
  if (countryMeps(cc) == null) return null;
  const eu = euPopulationAtLevel(feat.properties.level);
  if (!eu) return null;
  return Math.round((pop / eu) * EP_TOTAL_MEPS);
}

function featureKey(f) {
  return f.properties.id + ":" + f.properties.level;
}

// index a feature collection by feature id
function indexBy(fc, keyFn) {
  const m = new Map();
  for (const f of fc.features) m.set(keyFn(f), f);
  return m;
}

// children of a country: all features whose `country` (or `id` for country
// level) equals the country iso2
function childrenOfCountry(iso2, childLevel) {
  const fc = state.data[childLevel];
  if (!fc) return [];
  return fc.features.filter((f) => f.properties.country === iso2);
}

// does this feature count as "eligible" given the slider?
function isEligible(f) {
  if (state.minPopM <= 0) return true;
  return (f.properties.population || 0) / 1_000_000 >= state.minPopM - 1e-9;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadLevel(level) {
  if (state.data[level]) return state.data[level];
  const res = await fetch(LEVEL_FILES[level]);
  if (!res.ok) throw new Error("Failed to load " + LEVEL_FILES[level]);
  const fc = await res.json();
  state.data[level] = fc;
  return fc;
}

async function ensureLoaded() {
  await Promise.all(LEVEL_ORDER.map((l) => loadLevel(l)));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function clearMap() {
  if (state.layer) {
    map.removeLayer(state.layer);
    state.layer = null;
  }
  if (state.overlayLayer) {
    map.removeLayer(state.overlayLayer);
    state.overlayLayer = null;
  }
  if (state.labelLayer) {
    map.removeLayer(state.labelLayer);
    state.labelLayer = null;
  }
}

/**
 * Decide which features to draw at the current level, given the slider.
 *
 * Returns { features: [...], overlays: [...], replaced: Map(id->reason) }
 *
 * For the country level: every country is drawn. A country whose population
 * is below minPop is dimmed; a country whose population is below minPop AND
 * that has no eligible finer-level children gets a yellow overlay only when
 * minPop exceeds the country population (per spec). We apply the overlay when
 * minPop (in M) > country population (in M).
 */
function computeVisible() {
  const out = [];
  const overlays = [];
  const minPop = state.minPopM;

  if (state.level === "country") {
    const fc = state.data.country;
    for (const f of fc.features) {
      const popM = (f.properties.population || 0) / 1_000_000;
      out.push(f);
      if (minPop > 0 && popM > 0 && minPop > popM) {
        overlays.push(f);
      }
    }
    return { features: out, overlays };
  }

  // local levels: for each country, decide whether to show its children or
  // keep the parent country polygon.
  const countries = state.data.country.features;
  const childrenByCountry = new Map();
  const fc = state.data[state.level];
  for (const f of fc.features) {
    const cc = f.properties.country;
    if (!childrenByCountry.has(cc)) childrenByCountry.set(cc, []);
    childrenByCountry.get(cc).push(f);
  }

  for (const c of countries) {
    const cc = c.properties.id;
    const kids = childrenByCountry.get(cc) || [];

    // Show children when slider is off, OR when at least one child is eligible.
    let showKids = kids.length > 0;
    if (minPop > 0) {
      const anyEligible = kids.some(isEligible);
      // Also: if the country population is below minPop, but a child is
      // eligible, we still show kids. If no child is eligible, keep country.
      if (!anyEligible) showKids = false;
    }

    if (showKids) {
      for (const k of kids) {
        out.push(k);
        // overlay a child if minPop exceeds the child population
        const kpopM = (k.properties.population || 0) / 1_000_000;
        if (minPop > 0 && kpopM > 0 && minPop > kpopM) overlays.push(k);
      }
    } else {
      // keep parent country polygon
      out.push(c);
      const cpopM = (c.properties.population || 0) / 1_000_000;
      if (minPop > 0 && cpopM > 0 && minPop > cpopM) overlays.push(c);
    }
  }
  return { features: out, overlays };
}

// Base polygon class: region level plus a shade for regions that have their
// own administrative-legal government (vs. purely statistical groupings).
function baseClassFor(feat) {
  const base = feat.properties.level === "country" ? "country-poly" : "region-poly";
  if (feat.properties.level !== "country" && feat.properties.admin_gov === true) {
    return base + " poly-admin";
  }
  return base;
}

function styleFor(feat) {
  return { className: baseClassFor(feat) };
}

function labelFor(feat) {
  const field = LABEL_FIELDS[state.label];
  if (state.label === "name") {
    return feat.properties.name || feat.properties.id;
  }
  if (state.label === "meps_projected") {
    return field.fmt(projectedMeps(feat));
  }
  return field.fmt(feat.properties[field.key]);
}

function shouldDim(feat) {
  if (state.minPopM <= 0) return false;
  return !isEligible(feat);
}

function onEachFeature(feat, layer) {
  layer.feature = feat;
  layer._featKey = featureKey(feat);

  if (state.selected && state.selected.id === feat.properties.id) {
    layer.setStyle({ className: baseClassFor(feat) + " poly-selected" });
  } else if (shouldDim(feat)) {
    layer.setStyle({ className: baseClassFor(feat) + " poly-dim" });
  }

  layer.on({
    mouseover: (e) => {
      const l = e.target;
      if (l.options.className && l.options.className.includes("poly-selected")) return;
      l.setStyle({ className: baseClassFor(feat) + " poly-hover" });
      l.bringToFront();
    },
    mouseout: (e) => {
      const l = e.target;
      if (state.selected && state.selected.id === feat.properties.id) {
        l.setStyle({ className: baseClassFor(feat) + " poly-selected" });
      } else if (shouldDim(feat)) {
        l.setStyle({ className: baseClassFor(feat) + " poly-dim" });
      } else {
        l.setStyle({ className: baseClassFor(feat) });
      }
    },
    click: (e) => {
      L.DomEvent.stopPropagation(e);
      selectFeature(feat);
    },
  });

  let tipText = feat.properties.name + (feat.properties.population ? " &middot; " + formatPop(feat.properties.population) : "");
  if (feat.properties.level === "country" && feat.properties.meps != null) {
    tipText += " &middot; " + feat.properties.meps + " MEPs";
  }
  layer.bindTooltip(tipText, {
    sticky: true,
    direction: "top",
    className: feat.properties.level === "country" ? "country-tip" : "region-tip",
  });
}

const LABEL_W = 220; // max estimated label width, px (labels are nowrap)
const LABEL_H = 14;
const LABEL_PAD = 3; // extra separation between labels, in px

// Estimated label box on screen, centered on the feature centroid.
function labelBox(c, txt) {
  const p = map.latLngToLayerPoint(c);
  const w = Math.min(LABEL_W, Math.max(24, txt.length * 6.5));
  return { x: p.x - w / 2, y: p.y - LABEL_H / 2, w: w, h: LABEL_H };
}

function boxesOverlap(a, b) {
  return !(a.x + a.w < b.x - LABEL_PAD || b.x + b.w < a.x - LABEL_PAD ||
           a.y + a.h < b.y - LABEL_PAD || b.y + b.h < a.y - LABEL_PAD);
}

// Small countries whose labels must never be hidden just because a neighbour
// was drawn first.
const PRIORITY_IDS = new Set(["MT", "LU", "CY", "EE", "LV", "SI", "HR"]);

function renderLabels(features) {
  state.labelLayer = L.layerGroup().addTo(map);
  const items = [];
  for (const f of features) {
    const c = centroidOf(f);
    if (!c) continue;
    const txt = labelFor(f);
    if (txt == null || txt === "—") continue;
    items.push({ f, c, txt, dim: shouldDim(f) });
  }

  // Priority order: keep-at-all-costs small countries, then by population
  // descending so big items keep their labels when zoomed out.
  items.sort((a, b) => {
    const pa = PRIORITY_IDS.has(a.f.properties.id) ? 1 : 0;
    const pb = PRIORITY_IDS.has(b.f.properties.id) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (b.f.properties.population || 0) - (a.f.properties.population || 0);
  });

  const shown = [];
  for (const it of items) {
    const box = labelBox(it.c, it.txt);
    let collides = false;
    for (const s of shown) {
      if (boxesOverlap(box, s.box)) { collides = true; break; }
    }
    if (collides) continue;
    it.box = box;
    shown.push(it);
  }

  for (const it of shown) {
    L.marker(it.c, {
      icon: L.divIcon({
        className: "map-label" + (it.dim ? " dim" : ""),
        html: escapeHtml(it.txt),
        iconSize: [it.box.w, LABEL_H],
        iconAnchor: [it.box.w / 2, LABEL_H / 2],
      }),
      interactive: false,
      keyboard: false,
    }).addTo(state.labelLayer);
  }
}

function renderOverlays(overlays) {
  if (!overlays.length) return;
  state.overlayLayer = L.geoJSON(
    { type: "FeatureCollection", features: overlays },
    {
      style: { className: "poly-overlay" },
      interactive: false,
      pointToLayer: () => null,
    }
  ).addTo(map);
}

function render() {
  clearMap();
  const { features, overlays } = computeVisible();

  state.layer = L.geoJSON(
    { type: "FeatureCollection", features },
    {
      style: styleFor,
      onEachFeature: onEachFeature,
    }
  ).addTo(map);

  renderOverlays(overlays);
  renderLabels(features);
  updateStatsPanel(features);
}

// ---------------------------------------------------------------------------
// Bottom statistics panel (EU regions shown only)
// ---------------------------------------------------------------------------

const statsPanel = {
  metric: "population", // which metric the histogram plots
  collapsed: false,
};

function isEuFeature(feat) {
  const cc = feat.properties.level === "country" ? feat.properties.id : feat.properties.country;
  return countryMeps(cc) != null;
}

// MEPs for a feature: the real count at country level, the population-
// proportional projection at region levels.
function mepsOf(feat) {
  if (feat.properties.level === "country") {
    return feat.properties.meps;
  }
  return projectedMeps(feat);
}

// The three metrics the panel offers, each computed over the EU features
// currently shown on the map.
function statsMetrics(features) {
  const eu = features.filter(isEuFeature);
  const rows = [];
  for (const f of eu) {
    const pop = f.properties.population || 0;
    const meps = mepsOf(f);
    if (pop <= 0 || meps == null) continue;
    rows.push({
      feature: f,
      population: pop,
      meps: meps,
      mepsPer100k: (meps / pop) * 100_000,
    });
  }
  return rows;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function meanOf(values) {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function varianceOf(values) {
  if (values.length < 2) return null;
  const m = meanOf(values);
  return values.reduce((s, v) => s + (v - m) * (v - m), 0) / (values.length - 1);
}

function modeOf(values) {
  if (!values.length) return null;
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null, bestN = -1;
  for (const [v, n] of counts) {
    if (n > bestN || (n === bestN && v < best)) best = v, bestN = n;
  }
  return { value: best, count: bestN };
}

function fmtStat(v, digits = 2) {
  if (v == null || Number.isNaN(v)) return "\u2014";
  if (Math.abs(v) >= 1000) return v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(v) >= 10) return v.toLocaleString("en-US", { maximumFractionDigits: 1 });
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

const METRIC_DEFS = [
  { key: "population", title: "Population", unit: "", digits: 0 },
  { key: "meps", title: "MEPs / Projected MEPs", unit: "", digits: 0 },
  { key: "mepsPer100k", title: "MEPs / 100k people", unit: "", digits: 2 },
];

function updateStatsPanel(features) {
  const statsEl = document.getElementById("bpStats");
  const graphEl = document.getElementById("bpGraph");
  const scopeEl = document.getElementById("bpScope");
  if (!statsEl || !graphEl) return;

  const rows = statsMetrics(features);
  const levelLabel = LEVEL_LABELS[state.level] || state.level;
  scopeEl.textContent = rows.length
    ? `${levelLabel} \u00b7 ${rows.length} EU region${rows.length === 1 ? "" : "s"}`
    : `${levelLabel} \u00b7 no EU regions shown`;

  if (!rows.length) {
    statsEl.innerHTML = '<p class="placeholder">No EU-member regions are shown \u2014 statistics apply to EU regions only.</p>';
    graphEl.innerHTML = "";
    return;
  }

  const cards = [];
  for (const def of METRIC_DEFS) {
    const values = rows.map((r) => r[def.key]);
    const sorted = [...values].sort((a, b) => a - b);
    const mean = meanOf(values);
    const variance = varianceOf(values);
    const sd = variance == null ? null : Math.sqrt(variance);
    const q3 = quantile(sorted, 0.75);
    const mode = modeOf(values);
    const median = quantile(sorted, 0.5);
    const sum = values.reduce((s, v) => s + v, 0);
    cards.push({
      def,
      n: values.length,
      sum,
      mean,
      median,
      q3,
      variance,
      sd,
      mode,
      values,
    });
  }

  statsEl.innerHTML = cards
    .map(
      (c, i) => `
      <div class="metric-card${statsPanel.metric === c.def.key ? " active" : ""}" data-metric="${c.def.key}">
        <div class="m-title"><span>${c.def.title}</span><span class="m-n">n = ${c.n}</span></div>
        <div class="m-chips">
          <span class="m-chip">mode <b>${c.mode ? fmtStat(c.mode.value, c.def.digits) + (c.mode.count > 1 ? " \u00d7" + c.mode.count : "") : "\u2014"}</b></span>
          <span class="m-chip">mean <b>${fmtStat(c.mean, c.def.digits)}</b></span>
          <span class="m-chip">median <b>${fmtStat(c.median, c.def.digits)}</b></span>
          <span class="m-chip">Q3 <b>${fmtStat(c.q3, c.def.digits)}</b></span>
          <span class="m-chip">variance <b>${fmtStat(c.variance, c.def.digits)}</b></span>
          <span class="m-chip">std. dev. <b>${fmtStat(c.sd, c.def.digits)}</b></span>
          <span class="m-chip">total <b>${fmtStat(c.sum, c.def.digits)}</b></span>
        </div>
      </div>`
    )
    .join("");

  statsEl.querySelectorAll(".metric-card").forEach((card) => {
    card.addEventListener("click", () => {
      statsPanel.metric = card.dataset.metric;
      updateStatsPanel(features);
    });
  });

  const active = cards.find((c) => c.def.key === statsPanel.metric) || cards[0];
  drawHistogram(graphEl, active);
}

function drawHistogram(el, card) {
  const values = card.values;
  const W = 560, H = 160, PAD = { l: 8, r: 8, t: 18, b: 18 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const BINS = 12;
  if (!isFinite(min) || !isFinite(max)) { el.innerHTML = ""; return; }
  const width = max - min || 1;
  const bins = Array.from({ length: BINS }, (_, i) => ({
    x0: min + (width / BINS) * i,
    x1: min + (width / BINS) * (i + 1),
    n: 0,
  }));
  for (const v of values) {
    let idx = Math.min(BINS - 1, Math.floor(((v - min) / width) * BINS));
    if (idx < 0) idx = 0;
    bins[idx].n++;
  }
  const maxN = Math.max(...bins.map((b) => b.n));
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const median = quantile([...values].sort((a, b) => a - b), 0.5);
  const medianX = PAD.l + ((median - min) / width) * plotW;

  let bars = "";
  bins.forEach((b, i) => {
    const h = maxN ? (b.n / maxN) * plotH : 0;
    const x = PAD.l + (plotW / BINS) * i;
    const y = PAD.t + plotH - h;
    bars += `<g class="bar"><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(plotW / BINS - 1).toFixed(1)}" height="${Math.max(h, b.n ? 1 : 0).toFixed(1)}"></rect>`;
    if (b.n) bars += `<text x="${(x + (plotW / BINS - 1) / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}">${b.n}</text>`;
    bars += "</g>";
  });

  el.innerHTML = `
    <svg class="histogram" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <line class="axis" x1="${PAD.l}" y1="${PAD.t + plotH}" x2="${W - PAD.r}" y2="${PAD.t + plotH}"></line>
      ${bars}
      <line class="median-line" x1="${medianX.toFixed(1)}" y1="${PAD.t}" x2="${medianX.toFixed(1)}" y2="${PAD.t + plotH}"></line>
      <text class="median-line-label" x="${Math.min(medianX + 3, W - PAD.r - 60).toFixed(1)}" y="${PAD.t - 6}">median ${fmtStat(median, card.def.digits)}</text>
      <text class="axis-label" x="${PAD.l}" y="${H - 4}">${fmtStat(min, card.def.digits)}</text>
      <text class="axis-label" x="${W - PAD.r}" y="${H - 4}" text-anchor="end">${fmtStat(max, card.def.digits)}</text>
    </svg>
    <div class="bp-hint">${card.def.title} \u2014 distribution of ${card.n} EU regions shown</div>
  `;
}

// Re-run label decluttering after pan/zoom: which labels fit changes with the
// viewport, and it is much cheaper than redrawing polygons.
map.on("zoomend moveend", () => {
  if (!state.labelLayer || !state.layer) return;
  const { features: visible } = computeVisible();
  map.removeLayer(state.labelLayer);
  state.labelLayer = null;
  renderLabels(visible);
});

// ---------------------------------------------------------------------------
// Selection / side panel
// ---------------------------------------------------------------------------

function selectFeature(feat) {
  state.selected = { id: feat.properties.id, level: feat.properties.level };
  showPanel(feat);
  render();
}

function showPanel(feat) {
  const panel = document.getElementById("sidepanel");
  const content = document.getElementById("panelContent");
  panel.classList.remove("empty");
  const p = feat.properties;
  const badge = LEVEL_LABELS[p.level] || "Item";
  const sub = p.level === "country" ? "Country code " + p.id : p.country_name + " &middot; " + p.id;

  let rows = `
    <div class="detail-row"><span class="k">Population</span><span class="v">${formatPop(p.population)}</span></div>
    <div class="detail-row"><span class="k">GDP / person (PPP)</span><span class="v">${p.gdp_per_capita_ppp == null ? "—" : "$" + p.gdp_per_capita_ppp.toLocaleString("en-US")}</span></div>
    <div class="detail-row"><span class="k">Legislative seats</span><span class="v">${p.seats_lower == null ? "—" : p.seats_lower.toLocaleString("en-US")}</span></div>
  `;
  if (p.level === "country") {
    rows += `<div class="detail-row"><span class="k">MEPs in European Parliament</span><span class="v">${p.meps == null ? "—" : p.meps.toLocaleString("en-US")}</span></div>`;
  }
  const proj = projectedMeps(feat);
  if (proj != null) {
    rows += `<div class="detail-row"><span class="k">Projected MEPs (pop.-proportional)</span><span class="v">≈ ${proj.toLocaleString("en-US")}</span></div>`;
  }
  if (p.level !== "country") {
    rows += `<div class="detail-row"><span class="k">Country</span><span class="v">${escapeHtml(p.country_name)} (${p.country})</span></div>`;
    const admin = p.admin_gov;
    rows += `<div class="detail-row"><span class="k">Own administration</span><span class="v">${
      admin === true
        ? '<span class="admin-yes">yes</span> — administrative-legal entity'
        : admin === false
        ? '<span class="admin-no">no</span> — statistical grouping only'
        : "\u2014"
    }</span></div>`;
  }

  content.innerHTML = `
    <div class="detail-header">
      <span class="detail-badge">${escapeHtml(badge)}</span>
      <h2 class="detail-title">${escapeHtml(p.name || p.id)}</h2>
    </div>
    <p class="detail-sub">${sub}</p>
    <div class="detail-grid">${rows}</div>
    <div class="legend">
      <div class="legend-row"><span class="legend-swatch" style="background:var(--selected)"></span> selected</div>
      <div class="legend-row"><span class="legend-swatch" style="background:var(--hover)"></span> hover</div>
      <div class="legend-row"><span class="legend-swatch" style="background:var(--overlay-yellow)"></span> below min. population</div>
      <div class="legend-row"><span class="legend-swatch admin-swatch"></span> has own administration (legal)</div>
      <div class="legend-row"><span class="legend-swatch region-swatch"></span> statistical grouping only</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function centroidOf(feat) {
  const g = feat.geometry;
  if (!g) return null;
  let coords;
  if (g.type === "Point") return [g.coordinates[1], g.coordinates[0]];
  if (g.type === "Polygon") coords = g.coordinates[0];
  else if (g.type === "MultiPolygon") {
    // pick largest polygon
    let best = g.coordinates[0][0], bestArea = -1;
    for (const poly of g.coordinates) {
      const a = ringArea(poly[0]);
      if (a > bestArea) { bestArea = a; best = poly[0]; }
    }
    coords = best;
  } else return null;
  let x = 0, y = 0, n = 0;
  for (const c of coords) { x += c[0]; y += c[1]; n++; }
  return n ? [y / n, x / n] : null;
}

function ringArea(ring) {
  let s = 0, n = ring.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

const levelSelect = document.getElementById("levelSelect");
const labelSelect = document.getElementById("labelSelect");
const minPopSlider = document.getElementById("minPopSlider");
const minPopValue = document.getElementById("minPopValue");
const sliderHint = document.getElementById("sliderHint");
const overlay = document.getElementById("loadingOverlay");

function updateSliderDisplay() {
  const m = state.minPopM;
  minPopValue.textContent = m <= 0 ? "off" : m >= 1 ? m.toFixed(1) + "M" : Math.round(m * 1000) + "k";
  if (m <= 0) {
    sliderHint.textContent = "No filter";
  } else {
    sliderHint.textContent = "Items below " + (m >= 1 ? m.toFixed(1) + "M" : Math.round(m * 1000) + "k") + " stay as parent or get a yellow overlay";
  }
}

levelSelect.addEventListener("change", () => {
  state.level = levelSelect.value;
  state.selected = null;
  resetPanel();
  render();
});

labelSelect.addEventListener("change", () => {
  state.label = labelSelect.value;
  render();
});

minPopSlider.addEventListener("input", () => {
  state.minPopM = parseFloat(minPopSlider.value);
  updateSliderDisplay();
  render();
});

const bpToggle = document.getElementById("bpToggle");
if (bpToggle) {
  bpToggle.addEventListener("click", () => {
    statsPanel.collapsed = !statsPanel.collapsed;
    const panel = document.getElementById("bottompanel");
    panel.classList.toggle("collapsed", statsPanel.collapsed);
    bpToggle.textContent = statsPanel.collapsed ? "+" : "\u2212";
    bpToggle.setAttribute("aria-expanded", String(!statsPanel.collapsed));
  });
}

function resetPanel() {
  const panel = document.getElementById("sidepanel");
  const content = document.getElementById("panelContent");
  panel.classList.add("empty");
  content.innerHTML = '<p class="placeholder">Click a polygon on the map to see its details.</p>';
}

map.on("click", () => {
  state.selected = null;
  resetPanel();
  render();
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  try {
    await ensureLoaded();
    updateSliderDisplay();
    render();
  } catch (err) {
    console.error(err);
    document.querySelector("#loadingOverlay p").textContent =
      "Failed to load data: " + err.message;
    document.querySelector(".spinner").style.display = "none";
    return;
  }
  overlay.classList.remove("visible");
}

init();
