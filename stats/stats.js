import { emptyDb, rebuild } from "../src/dedup.js";
import { loadDb, saveDb } from "../src/storage.js";

const $ = (id) => document.getElementById(id);
const state = { db: emptyDb(), server: "", sinceDays: 0, item: null, search: "" };

const fmt = (n, digits = 0) =>
  n === null || n === undefined || Number.isNaN(n) ? "–" : n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
const fmtDate = (t) => new Date(t).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const itemKey = (a) => `${a.itemTypeId ?? ""}|${a.itemName}`;

// Builds a table from column specs. Uses textContent only: player names come
// from other players and must never be interpreted as HTML.
function renderTable(table, columns, rows, { onClick, isSelected, emptyText = "No data yet." } = {}) {
  table.replaceChildren();
  if (!rows.length) {
    const td = document.createElement("td");
    td.className = "empty";
    td.textContent = emptyText;
    table.appendChild(document.createElement("tr")).appendChild(td);
    return;
  }
  const head = table.createTHead().insertRow();
  for (const c of columns) {
    const th = document.createElement("th");
    th.textContent = c.label;
    if (c.num) th.className = "num";
    head.appendChild(th);
  }
  const body = table.createTBody();
  for (const r of rows) {
    const tr = body.insertRow();
    if (onClick) {
      tr.className = "clickable";
      tr.addEventListener("click", () => onClick(r));
    }
    if (isSelected && isSelected(r)) tr.classList.add("selected");
    for (const c of columns) {
      const td = tr.insertCell();
      const v = c.value(r);
      if (v instanceof Node) td.appendChild(v);
      else td.textContent = v ?? "";
      if (c.num) td.className = "num";
    }
  }
}

function filtered() {
  const since = state.sinceDays ? Date.now() - state.sinceDays * 86400000 : 0;
  return state.db.auctions.filter((a) => (!state.server || a.server === state.server) && a.firstSeenAt >= since);
}

function renderServers() {
  const servers = [...new Set(state.db.auctions.map((a) => a.server))].sort();
  if (state.server && !servers.includes(state.server)) state.server = "";
  if (!state.server && servers.length === 1) state.server = servers[0];
  const sel = $("server");
  sel.replaceChildren(new Option("All servers", ""), ...servers.map((s) => new Option(s, s)));
  sel.value = state.server;
}

function renderCards(auctions) {
  const total = auctions.reduce((n, a) => n + a.price, 0);
  const cards = [
    ["Auctions", fmt(auctions.length)],
    ["Silver spent", fmt(total)],
    ["Buyers", fmt(new Set(auctions.map((a) => a.bidderRaw)).size)],
    ["Captures", fmt(state.db.captures.length)],
  ];
  $("cards").replaceChildren(
    ...cards.map(([label, value]) => {
      const div = document.createElement("div");
      div.className = "card";
      const l = div.appendChild(document.createElement("div"));
      l.className = "label";
      l.textContent = label;
      const v = div.appendChild(document.createElement("div"));
      v.className = "value";
      v.textContent = value;
      return div;
    }),
  );
}

function renderItems(auctions) {
  const groups = new Map();
  for (const a of auctions) {
    const k = itemKey(a);
    if (!groups.has(k)) groups.set(k, { key: k, name: a.itemName, list: [] });
    groups.get(k).list.push(a);
  }
  const weekAgo = Date.now() - 7 * 86400000;
  const rows = [...groups.values()].map((g) => {
    const unit = g.list.map((a) => a.unitPrice);
    const units = g.list.reduce((n, a) => n + a.quantity, 0);
    const spent = g.list.reduce((n, a) => n + a.price, 0);
    const recent = g.list.filter((a) => a.firstSeenAt >= weekAgo).map((a) => a.unitPrice);
    return {
      key: g.key,
      name: g.name,
      lots: g.list.length,
      units,
      median: median(unit),
      weighted: units ? spent / units : null,
      min: Math.min(...unit),
      max: Math.max(...unit),
      recent: median(recent),
    };
  });
  rows.sort((a, b) => b.lots - a.lots);
  renderTable(
    $("items"),
    [
      { label: "Item", value: (r) => r.name },
      { label: "Auctions", num: true, value: (r) => fmt(r.lots) },
      { label: "Units", num: true, value: (r) => fmt(r.units) },
      { label: "Median", num: true, value: (r) => fmt(r.median, 1) },
      { label: "Avg (weighted)", num: true, value: (r) => fmt(r.weighted, 1) },
      { label: "Min", num: true, value: (r) => fmt(r.min, 1) },
      { label: "Max", num: true, value: (r) => fmt(r.max, 1) },
      { label: "Median last 7 d", num: true, value: (r) => fmt(r.recent, 1) },
    ],
    rows,
    {
      onClick: (r) => {
        state.item = state.item === r.key ? null : r.key;
        render();
      },
      isSelected: (r) => r.key === state.item,
    },
  );
}

const SVG_NS = "http://www.w3.org/2000/svg";
const HOUR = 3600000;
const DAY = 24 * HOUR;
let chartPoints = [];

function svgEl(parent, name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent.appendChild(el);
  return el;
}

function niceStep(range, targetTicks) {
  const raw = range / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

// Noon of the local day: where a day's median is drawn.
function dayNoon(t) {
  const d = new Date(t);
  d.setHours(12, 0, 0, 0);
  return d.getTime();
}

function timeTicks(min, max, maxTicks) {
  const steps = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY];
  const step = steps.find((s) => (max - min) / s <= maxTicks) || steps.at(-1);
  const start = new Date(min);
  if (step >= DAY) start.setHours(0, 0, 0, 0);
  else start.setMinutes(0, 0, 0);
  const ticks = [];
  for (let d = start; d.getTime() <= max; ) {
    if (d.getTime() >= min) ticks.push(d.getTime());
    d = new Date(d);
    // Step whole days by calendar date so ticks stay on midnight across DST.
    if (step >= DAY) d.setDate(d.getDate() + step / DAY);
    else d.setTime(d.getTime() + step);
  }
  const label = (t) =>
    step >= DAY
      ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : new Date(t).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return ticks.map((t) => ({ t, label: label(t) }));
}

function renderChart(auctions) {
  const groups = new Map();
  for (const a of auctions) {
    const k = itemKey(a);
    if (!groups.has(k)) groups.set(k, { key: k, name: a.itemName, count: 0 });
    groups.get(k).count += 1;
  }
  const options = [...groups.values()].sort((a, b) => b.count - a.count);
  const key = state.item && groups.has(state.item) ? state.item : options[0]?.key;
  const sel = $("chartItem");
  sel.replaceChildren(...options.map((g) => new Option(`${g.name} (${g.count})`, g.key)));
  if (key) sel.value = key;

  const svg = $("chartSvg");
  svg.replaceChildren();
  $("tooltip").hidden = true;
  chartPoints = [];
  const width = svg.clientWidth || 800;
  const height = svg.clientHeight || 280;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const list = auctions.filter((a) => itemKey(a) === key).sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  if (!list.length) {
    svgEl(svg, "text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "empty-label" }).textContent = "No auctions yet.";
    return;
  }

  const m = { left: 52, right: 18, top: 14, bottom: 28 };
  let [t0, t1] = [list[0].firstSeenAt, list.at(-1).firstSeenAt];
  if (t1 - t0 < HOUR) [t0, t1] = [t0 - HOUR, t1 + HOUR];
  const pad = (t1 - t0) * 0.03;
  [t0, t1] = [t0 - pad, t1 + pad];

  // Daily medians, so the trend reads through the scatter of single sales.
  const days = new Map();
  for (const a of list) {
    const d = dayNoon(a.firstSeenAt);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(a.unitPrice);
  }
  const medians = [...days].map(([day, v]) => ({ day, t: Math.min(Math.max(day, t0), t1), v: median(v), n: v.length }));

  const yMaxRaw = Math.max(...list.map((a) => a.unitPrice)) || 1;
  const yStep = niceStep(yMaxRaw, 5);
  const yMax = Math.ceil((yMaxRaw * 1.05) / yStep) * yStep;
  const x = (t) => m.left + ((t - t0) / (t1 - t0)) * (width - m.left - m.right);
  const y = (v) => height - m.bottom - (v / yMax) * (height - m.top - m.bottom);

  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    svgEl(svg, "line", { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: "grid" });
    svgEl(svg, "text", { x: m.left - 8, y: y(v) + 4, "text-anchor": "end", class: "axis-label" }).textContent = fmt(v, yStep < 1 ? 1 : 0);
  }
  for (const tick of timeTicks(t0, t1, Math.max(2, Math.floor((width - m.left - m.right) / 110)))) {
    svgEl(svg, "text", { x: x(tick.t), y: height - 8, "text-anchor": "middle", class: "axis-label" }).textContent = tick.label;
  }

  if (medians.length > 1) {
    svgEl(svg, "path", { class: "median", d: medians.map((p, i) => `${i ? "L" : "M"}${x(p.t)},${y(p.v)}`).join(" ") });
  }
  if (medians.length <= 31) {
    for (const p of medians) svgEl(svg, "circle", { cx: x(p.t), cy: y(p.v), r: 3.5, class: "median-point" });
  }

  const medianByDay = new Map(medians.map((p) => [p.day, p]));
  for (const a of list) {
    const px = x(a.firstSeenAt);
    const py = y(a.unitPrice);
    const el = svgEl(svg, "circle", { cx: px, cy: py, r: 4.5, class: "point" });
    chartPoints.push({ px, py, a, el, day: medianByDay.get(dayNoon(a.firstSeenAt)) });
  }
}

function showChartTooltip(e) {
  const svg = $("chartSvg");
  const rect = svg.getBoundingClientRect();
  const scale = rect.width / (svg.viewBox.baseVal.width || rect.width);
  const mx = (e.clientX - rect.left) / scale;
  const my = (e.clientY - rect.top) / scale;
  let best = null;
  let bestDist = 24;
  for (const p of chartPoints) {
    p.el.classList.remove("hover");
    const d = Math.hypot(p.px - mx, p.py - my);
    if (d < bestDist) [best, bestDist] = [p, d];
  }
  const tip = $("tooltip");
  if (!best) {
    tip.hidden = true;
    return;
  }
  best.el.classList.add("hover");
  const a = best.a;
  const line = (text, cls) => {
    const div = document.createElement("div");
    div.textContent = text;
    if (cls) div.className = cls;
    return div;
  };
  tip.replaceChildren(
    line(`${a.itemName} ×${fmt(a.quantity)}`),
    line(`${fmt(a.unitPrice, 1)} per unit · ${fmt(a.price)} total`),
    line(`${a.bidder}${a.alliance ? ` (${a.alliance})` : ""} · ${fmt(a.bids)} bids`, "muted"),
    line(`First seen ${fmtDate(a.firstSeenAt)}`, "muted"),
    line(`Median that day: ${fmt(best.day.v, 1)} (${best.day.n} auctions)`, "muted"),
  );
  tip.hidden = false;
  const box = $("chart").getBoundingClientRect();
  const left = best.px * scale + 12;
  const flip = left + tip.offsetWidth > box.width;
  tip.style.left = `${flip ? best.px * scale - tip.offsetWidth - 12 : left}px`;
  tip.style.top = `${Math.max(4, best.py * scale - tip.offsetHeight / 2)}px`;
}

$("chartSvg").addEventListener("pointermove", showChartTooltip);
$("chartSvg").addEventListener("pointerleave", () => {
  $("tooltip").hidden = true;
  for (const p of chartPoints) p.el.classList.remove("hover");
});
$("chartItem").addEventListener("change", (e) => {
  state.item = e.target.value;
  render();
});
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderChart(filtered()), 150);
});

function renderBuyers(auctions) {
  const groups = new Map();
  for (const a of auctions) {
    if (!groups.has(a.bidderRaw)) groups.set(a.bidderRaw, { bidder: a.bidder, alliance: a.alliance, lots: 0, spent: 0 });
    const g = groups.get(a.bidderRaw);
    g.lots += 1;
    g.spent += a.price;
  }
  const rows = [...groups.values()].sort((a, b) => b.spent - a.spent).slice(0, 25);
  renderTable(
    $("buyers"),
    [
      { label: "Buyer", value: (r) => r.bidder },
      { label: "Alliance", value: (r) => r.alliance || "" },
      { label: "Auctions won", num: true, value: (r) => fmt(r.lots) },
      { label: "Silver spent", num: true, value: (r) => fmt(r.spent) },
    ],
    rows,
  );
}

function renderAuctions(auctions) {
  const q = state.search.toLowerCase();
  const rows = auctions
    .filter((a) => !state.item || itemKey(a) === state.item)
    .filter((a) => !q || `${a.itemName} ${a.bidderRaw}`.toLowerCase().includes(q))
    .sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  $("count").textContent = `${rows.length} shown`;
  renderTable(
    $("auctions"),
    [
      { label: "First seen", value: (a) => fmtDate(a.firstSeenAt) },
      { label: "Item", value: (a) => a.itemName },
      { label: "Qty", num: true, value: (a) => fmt(a.quantity) },
      { label: "Price", num: true, value: (a) => fmt(a.price) },
      { label: "Per unit", num: true, value: (a) => fmt(a.unitPrice, 1) },
      { label: "Buyer", value: (a) => a.bidder },
      { label: "Alliance", value: (a) => a.alliance || "" },
      { label: "Bids", num: true, value: (a) => fmt(a.bids) },
    ],
    rows,
  );
}

function renderCaptures() {
  const rows = [...state.db.captures].sort((a, b) => b.capturedAt - a.capturedAt);
  renderTable(
    $("captures"),
    [
      { label: "Captured", value: (c) => fmtDate(c.capturedAt) },
      { label: "Server", value: (c) => c.server },
      { label: "Page", num: true, value: (c) => c.tables.map((t) => t.page ?? "?").join(", ") },
      { label: "Finished rows", num: true, value: (c) => fmt(c.tables.reduce((n, t) => n + t.rows.length, 0)) },
      {
        label: "",
        value: (c) => {
          const b = document.createElement("button");
          b.textContent = "Delete";
          b.className = "danger";
          b.addEventListener("click", () => deleteCapture(c.id));
          return b;
        },
      },
    ],
    rows,
    { emptyText: "No captures yet. Use the toolbar button on the Auctions → Your bids page." },
  );
}

function render() {
  renderServers();
  const auctions = filtered();
  renderCards(auctions);
  renderChart(auctions);
  renderItems(auctions);
  renderBuyers(auctions);
  renderAuctions(auctions);
  renderCaptures();
}

async function commit(db, message) {
  state.db = db;
  await saveDb(db);
  $("dataStatus").textContent = message || "";
  render();
}

async function deleteCapture(id) {
  if (!confirm("Delete this capture and recompute auctions without it?")) return;
  const db = { ...state.db, captures: state.db.captures.filter((c) => c.id !== id) };
  await commit(rebuild(db), "Capture deleted.");
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = () => new Date().toISOString().slice(0, 10);

function toCsv(auctions) {
  const cols = ["server", "itemTypeId", "itemName", "quantity", "price", "unitPrice", "bidder", "alliance", "bids", "firstSeenAt"];
  const esc = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = auctions.map((a) => cols.map((c) => esc(c === "firstSeenAt" ? new Date(a[c]).toISOString() : a[c])).join(","));
  return [cols.join(","), ...lines].join("\n");
}

$("server").addEventListener("change", (e) => {
  state.server = e.target.value;
  state.item = null;
  render();
});
$("since").addEventListener("change", (e) => {
  state.sinceDays = Number(e.target.value);
  render();
});
$("search").addEventListener("input", (e) => {
  state.search = e.target.value;
  renderAuctions(filtered());
});

$("exportJson").addEventListener("click", () => download(`travian-auctions-${stamp()}.json`, JSON.stringify(state.db), "application/json"));
$("exportCsv").addEventListener("click", () => download(`travian-auctions-${stamp()}.csv`, toCsv(filtered()), "text/csv"));

$("import").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    if (!Array.isArray(incoming.captures)) throw new Error("not an export from this extension");
    // Merge raw captures (by id) and recompute, so importing the same file
    // twice, or a file from another browser, doesn't create duplicates.
    const known = new Set(state.db.captures.map((c) => c.id));
    const added = incoming.captures.filter((c) => !known.has(c.id));
    const db = rebuild({ ...state.db, captures: [...state.db.captures, ...added] });
    await commit(db, `Imported ${added.length} new captures.`);
  } catch (err) {
    $("dataStatus").textContent = `Import failed: ${err.message}`;
  }
});

$("rebuild").addEventListener("click", async () => {
  await commit(rebuild(state.db), "Rebuilt from captures.");
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Delete ALL stored auctions and captures? Export first if you want a backup.")) return;
  await commit(emptyDb(), "All data deleted.");
});

// Keep the page live if a capture is made while it is open.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.db) {
    state.db = changes.db.newValue || emptyDb();
    render();
  }
});

state.db = await loadDb();
render();
