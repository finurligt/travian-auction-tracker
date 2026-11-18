import { emptyDb, rebuild } from "../src/dedup.js";
import { serverAge, serverSpeed, validateRounds } from "../src/serverAge.js";
import {
  isConfigured,
  loadDb,
  loadSync,
  LoginRequired,
  logout,
  onDbChanged,
  readOnly,
  requestSync,
  saveDb,
  saveSync,
  setToken,
} from "../src/platform.js";

const $ = (id) => document.getElementById(id);
const state = { db: emptyDb(), server: "", sinceDays: 0, item: null, search: "", ageScale: false };

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
    ["Captures", fmt(state.db.captureCount ?? state.db.captures.length)],
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
  resizeTimer = setTimeout(() => {
    renderChart(filtered());
    renderAgeChart(filtered());
  }, 150);
});

const FEW_SALES = 5;

// Per item, compares the price per unit across the lot sizes it was sold in.
function lotSizeStats(auctions) {
  const items = new Map();
  for (const a of auctions) {
    const k = itemKey(a);
    if (!items.has(k)) items.set(k, { name: a.itemName, sizes: new Map() });
    const sizes = items.get(k).sizes;
    if (!sizes.has(a.quantity)) sizes.set(a.quantity, []);
    sizes.get(a.quantity).push(a);
  }
  const rows = [];
  for (const [key, item] of items) {
    if (item.sizes.size < 2) continue;
    const sizes = [...item.sizes].map(([quantity, list]) => ({
      key,
      name: item.name,
      quantity,
      sales: list.length,
      median: median(list.map((a) => a.unitPrice)),
      average: list.reduce((n, a) => n + a.price, 0) / list.reduce((n, a) => n + a.quantity, 0),
      bids: median(list.map((a) => a.bids)),
    }));
    const best = Math.max(...sizes.map((s) => s.median));
    sizes.sort((a, b) => a.quantity - b.quantity);
    sizes.forEach((s, i) => rows.push({ ...s, vsBest: s.median / best - 1, isBest: s.median === best, first: i === 0 }));
  }
  return rows;
}

const MAX_AGE_SERIES = 3;
let agePoints = [];

function ageX(age) {
  return state.ageScale && age.speed ? age.day * age.speed : age.day;
}

function renderAgeChart(auctions) {
  const groups = new Map();
  for (const a of auctions) {
    const k = itemKey(a);
    if (!groups.has(k)) groups.set(k, { key: k, name: a.itemName, count: 0 });
    groups.get(k).count += 1;
  }
  const options = [...groups.values()].sort((a, b) => b.count - a.count);
  const key = state.item && groups.has(state.item) ? state.item : options[0]?.key;
  const sel = $("ageItem");
  sel.replaceChildren(...options.map((g) => new Option(`${g.name} (${g.count})`, g.key)));
  if (key) sel.value = key;

  // One series per server round, with the median per day of the round.
  const series = new Map();
  let unknownAge = 0;
  for (const a of auctions) {
    if (itemKey(a) !== key) continue;
    const age = serverAge(state.db.serverRounds, a.server, a.firstSeenAt);
    if (!age) {
      unknownAge += 1;
      continue;
    }
    const id = `${a.server}|${age.round}`;
    if (!series.has(id)) series.set(id, { label: `${a.server.replace(/\.travian\.com$/, "")} · ${age.round}`, days: new Map(), count: 0 });
    const s = series.get(id);
    const x = ageX(age);
    if (!s.days.has(x)) s.days.set(x, []);
    s.days.get(x).push(a.unitPrice);
    s.count += 1;
  }
  const all = [...series.values()].sort((a, b) => b.count - a.count);
  const shown = all.slice(0, MAX_AGE_SERIES).map((s, i) => ({
    ...s,
    cls: `s${i + 1}`,
    points: [...s.days].map(([x, v]) => ({ x, v: median(v), n: v.length })).sort((a, b) => a.x - b.x),
  }));

  const notes = [];
  if (all.length > MAX_AGE_SERIES) notes.push(`Showing the ${MAX_AGE_SERIES} server rounds with the most sales (of ${all.length}).`);
  if (unknownAge) notes.push(`${unknownAge} sales of this item fall outside every round you've entered.`);
  $("ageNote").textContent = notes.join(" ");

  $("ageLegend").replaceChildren(
    ...shown.map((s) => {
      const span = document.createElement("span");
      span.className = s.cls;
      const key = span.appendChild(document.createElement("i"));
      key.className = "key line series";
      span.append(s.label);
      return span;
    }),
  );

  const svg = $("ageSvg");
  svg.replaceChildren();
  $("ageTooltip").hidden = true;
  agePoints = [];
  const width = svg.clientWidth || 800;
  const height = svg.clientHeight || 280;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  if (!shown.length) {
    const msg = readOnly ? "No server rounds yet. Add them in the extension." : "Add the server's rounds under Servers below.";
    svgEl(svg, "text", { x: width / 2, y: height / 2, "text-anchor": "middle", class: "empty-label" }).textContent = msg;
    return;
  }

  const m = { left: 52, right: 18, top: 14, bottom: 28 };
  const xs = shown.flatMap((s) => s.points.map((p) => p.x));
  let [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  if (x1 - x0 < 2) [x0, x1] = [x0 - 1, x1 + 1];
  x0 = Math.max(0, x0);
  const yMaxRaw = Math.max(...shown.flatMap((s) => s.points.map((p) => p.v))) || 1;
  const yStep = niceStep(yMaxRaw, 5);
  const yMax = Math.ceil((yMaxRaw * 1.05) / yStep) * yStep;
  const x = (d) => m.left + ((d - x0) / (x1 - x0)) * (width - m.left - m.right);
  const y = (v) => height - m.bottom - (v / yMax) * (height - m.top - m.bottom);

  for (let v = 0; v <= yMax + 1e-9; v += yStep) {
    svgEl(svg, "line", { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v), class: "grid" });
    svgEl(svg, "text", { x: m.left - 8, y: y(v) + 4, "text-anchor": "end", class: "axis-label" }).textContent = fmt(v, yStep < 1 ? 1 : 0);
  }
  const xStep = Math.max(1, niceStep(x1 - x0, Math.max(2, Math.floor((width - m.left - m.right) / 80))));
  for (let d = Math.ceil(x0 / xStep) * xStep; d <= x1; d += xStep) {
    svgEl(svg, "text", { x: x(d), y: height - 8, "text-anchor": "middle", class: "axis-label" }).textContent = `Day ${fmt(d)}`;
  }

  for (const s of shown) {
    const g = svgEl(svg, "g", { class: s.cls });
    if (s.points.length > 1) {
      svgEl(g, "path", { class: "age-line", d: s.points.map((p, i) => `${i ? "L" : "M"}${x(p.x)},${y(p.v)}`).join(" ") });
    }
    for (const p of s.points) {
      const el = svgEl(g, "circle", { cx: x(p.x), cy: y(p.v), r: 4, class: "age-point" });
      agePoints.push({ px: x(p.x), py: y(p.v), p, s, el });
    }
  }
}

function showAgeTooltip(e) {
  const svg = $("ageSvg");
  const rect = svg.getBoundingClientRect();
  const scale = rect.width / (svg.viewBox.baseVal.width || rect.width);
  const mx = (e.clientX - rect.left) / scale;
  const my = (e.clientY - rect.top) / scale;
  let best = null;
  let bestDist = 24;
  for (const point of agePoints) {
    point.el.classList.remove("hover");
    const d = Math.hypot(point.px - mx, point.py - my);
    if (d < bestDist) [best, bestDist] = [point, d];
  }
  const tip = $("ageTooltip");
  if (!best) {
    tip.hidden = true;
    return;
  }
  best.el.classList.add("hover");
  const line = (text, cls) => {
    const div = document.createElement("div");
    div.textContent = text;
    if (cls) div.className = cls;
    return div;
  };
  tip.replaceChildren(
    line(best.s.label),
    line(`${state.ageScale ? "Scaled day" : "Day"} ${fmt(best.p.x)}: ${fmt(best.p.v, 1)} per unit`),
    line(`median of ${best.p.n} sale${best.p.n === 1 ? "" : "s"}`, "muted"),
  );
  tip.hidden = false;
  const box = $("ageChart").getBoundingClientRect();
  const left = best.px * scale + 12;
  tip.style.left = `${left + tip.offsetWidth > box.width ? best.px * scale - tip.offsetWidth - 12 : left}px`;
  tip.style.top = `${Math.max(4, best.py * scale - tip.offsetHeight / 2)}px`;
}

$("ageSvg").addEventListener("pointermove", showAgeTooltip);
$("ageSvg").addEventListener("pointerleave", () => {
  $("ageTooltip").hidden = true;
  for (const p of agePoints) p.el.classList.remove("hover");
});
$("ageItem").addEventListener("change", (e) => {
  state.item = e.target.value;
  render();
});
$("ageScale").addEventListener("change", (e) => {
  state.ageScale = e.target.checked;
  renderAgeChart(filtered());
});

async function saveServerRounds(host, rounds, statusEl) {
  let cleaned;
  try {
    cleaned = validateRounds(rounds);
  } catch (e) {
    statusEl.textContent = e.message;
    return;
  }
  const db = await loadDb();
  db.serverRounds = { ...db.serverRounds, [host]: { rounds: cleaned, updatedAt: Date.now() } };
  await commit(db, "");
  runSync();
}

const roundText = (r) => `${r.start} – ${r.end ?? "running"}`;

// Editable list of rounds for one server: start and end date per round.
function roundsEditor(host, rounds) {
  const wrap = document.createElement("div");
  wrap.className = "rounds";
  const list = wrap.appendChild(document.createElement("div"));

  const dateInput = (value, label) => {
    const input = document.createElement("input");
    input.type = "date";
    input.className = "servers-input";
    input.value = value || "";
    input.setAttribute("aria-label", label);
    return input;
  };
  const addRow = (round = { start: "", end: null }) => {
    const row = list.appendChild(document.createElement("div"));
    row.className = "round";
    row.append(dateInput(round.start, `Round start for ${host}`), " – ", dateInput(round.end, `Round end for ${host} (empty while running)`));
    const remove = row.appendChild(document.createElement("button"));
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => row.remove());
  };
  for (const r of rounds) addRow(r);
  if (!rounds.length) addRow();

  const actions = wrap.appendChild(document.createElement("div"));
  actions.className = "round-actions";
  const add = actions.appendChild(document.createElement("button"));
  add.type = "button";
  add.textContent = "Add round";
  add.addEventListener("click", () => addRow());
  const save = actions.appendChild(document.createElement("button"));
  save.type = "button";
  save.textContent = "Save";
  const status = actions.appendChild(document.createElement("span"));
  status.className = "warn";
  save.addEventListener("click", () => {
    const entered = [...list.querySelectorAll(".round")].map((row) => {
      const [startInput, endInput] = row.querySelectorAll("input");
      return { start: startInput.value, end: endInput.value };
    });
    saveServerRounds(host, entered, status);
  });
  return wrap;
}

function renderServerTable() {
  // Don't throw away a half-filled form when a sync re-renders the page.
  if ($("servers").contains(document.activeElement)) return;
  const all = state.db.serverRounds || {};
  const counts = new Map();
  for (const a of state.db.auctions) counts.set(a.server, (counts.get(a.server) || 0) + 1);
  const hosts = [...new Set([...counts.keys(), ...Object.keys(all)])].sort();
  renderTable(
    $("servers"),
    [
      { label: "Server", value: (h) => h },
      { label: "Speed", num: true, value: (h) => (serverSpeed(h) ? `${serverSpeed(h)}×` : "?") },
      {
        label: "Rounds",
        value: (h) => {
          const rounds = all[h]?.rounds || [];
          if (readOnly) return rounds.map(roundText).join(" · ") || "–";
          return roundsEditor(h, rounds);
        },
      },
      { label: "Auctions", num: true, value: (h) => fmt(counts.get(h) || 0) },
    ],
    hosts,
  );
}

function renderLotSizes(auctions) {
  const rows = lotSizeStats(auctions);
  renderTable(
    $("lotSizes"),
    [
      { label: "Item", value: (r) => (r.first ? r.name : "") },
      { label: "Amount", num: true, value: (r) => `×${fmt(r.quantity)}` },
      { label: "Sales", num: true, value: (r) => fmt(r.sales) },
      { label: "Median per unit", num: true, value: (r) => fmt(r.median, 1) },
      { label: "vs best", num: true, value: (r) => (r.isBest ? "★ best" : `${fmt(r.vsBest * 100, 0)} %`) },
      { label: "Avg per unit", num: true, value: (r) => fmt(r.average, 1) },
      { label: "Median bids", num: true, value: (r) => fmt(r.bids, 0) },
      { label: "", value: (r) => (r.sales < FEW_SALES ? "few sales – uncertain" : "") },
    ],
    rows,
    {
      onClick: (r) => {
        state.item = r.key;
        render();
      },
      emptyText: "No item has been sold in more than one amount yet.",
    },
  );
  const trs = $("lotSizes").querySelectorAll("tbody tr");
  rows.forEach((r, i) => {
    if (r.first && i > 0) trs[i].classList.add("group-start");
    if (r.sales < FEW_SALES) trs[i].lastElementChild.classList.add("muted");
  });
}

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
  renderAgeChart(auctions);
  renderServerTable();
  renderLotSizes(auctions);
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

// With sync on, deletions are queued for the server so other PCs drop
// the captures too.
async function queueRemoteDelete(ids) {
  const sync = await loadSync();
  if (!isConfigured(sync)) return false;
  const gone = new Set(ids);
  await saveSync({
    ...sync,
    pendingDeletes: [...new Set([...(sync.pendingDeletes || []), ...ids])],
    synced: (sync.synced || []).filter((id) => !gone.has(id)),
  });
  return true;
}

async function deleteCapture(id) {
  const everywhere = isConfigured(await loadSync());
  if (!confirm(`Delete this capture${everywhere ? " on all your PCs" : ""} and recompute auctions without it?`)) return;
  await queueRemoteDelete([id]);
  const db = { ...state.db, captures: state.db.captures.filter((c) => c.id !== id) };
  await commit(rebuild(db), "Capture deleted.");
  if (everywhere) await runSync();
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
  const cols = ["server", "speed", "round", "serverDay", "itemTypeId", "itemName", "quantity", "price", "unitPrice", "bidder", "alliance", "bids", "firstSeenAt"];
  auctions = auctions.map((a) => {
    const age = serverAge(state.db.serverRounds, a.server, a.firstSeenAt);
    return { ...a, speed: serverSpeed(a.server), round: age?.round, serverDay: age?.day };
  });
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
    if (added.length) await runSync();
  } catch (err) {
    $("dataStatus").textContent = `Import failed: ${err.message}`;
  }
});

$("rebuild").addEventListener("click", async () => {
  await commit(rebuild(state.db), "Rebuilt from captures.");
});

$("clear").addEventListener("click", async () => {
  const everywhere = isConfigured(await loadSync());
  const where = everywhere ? " on ALL your PCs and the sync server" : "";
  if (!confirm(`Delete ALL stored auctions and captures${where}? Export first if you want a backup.`)) return;
  await queueRemoteDelete(state.db.captures.map((c) => c.id));
  await commit(emptyDb(), "All data deleted.");
  if (everywhere) await runSync();
});

function renderSyncStatus(sync, message) {
  const el = $("syncStatus");
  el.className = sync.lastError && !message ? "warn" : "muted";
  if (message) el.textContent = message;
  else if (!isConfigured(sync)) el.textContent = "Not set up – data is only stored in this browser.";
  else if (sync.lastError) el.textContent = `Last sync failed: ${sync.lastError}`;
  else if (sync.lastSyncAt) el.textContent = `Last synced ${fmtDate(sync.lastSyncAt)}.`;
  else el.textContent = "Not synced yet.";
}

async function runSync() {
  const sync = await loadSync();
  if (!isConfigured(sync)) return renderSyncStatus(sync);
  renderSyncStatus(sync, "Syncing…");
  const result = await requestSync();
  const after = await loadSync();
  if (!result.ok) return renderSyncStatus(after);
  const parts = [`uploaded ${result.uploaded}`, `downloaded ${result.downloaded}`];
  if (result.removedLocally) parts.push(`removed ${result.removedLocally} deleted on another PC`);
  renderSyncStatus(after, `Synced ${fmtDate(after.lastSyncAt)}: ${parts.join(", ")}.`);
}

$("syncForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sync = await loadSync();
  const url = $("syncUrl").value.trim();
  const token = $("syncToken").value.trim();
  if (url && !/^https:\/\//.test(url) && !/^http:\/\/localhost(:|\/|$)/.test(url)) {
    return renderSyncStatus(sync, "The address must start with https://");
  }
  // A different server knows nothing about what we uploaded before.
  const sameServer = url === sync.url;
  await saveSync({
    ...sync,
    url,
    token,
    lastSeq: sameServer ? sync.lastSeq : 0,
    synced: sameServer ? sync.synced : [],
    pendingDeletes: sameServer ? sync.pendingDeletes : [],
    lastError: null,
  });
  await runSync();
});
$("syncNow").addEventListener("click", runSync);

// Keep the page live if a capture is made while it is open.
onDbChanged((db) => {
  state.db = db || emptyDb();
  render();
});

// Web version only: asks for the token, or shows why loading failed.
function showLogin(message) {
  document.body.classList.add("logged-out");
  $("loginStatus").textContent = message || "";
  $("loginToken").focus();
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const token = $("loginToken").value.trim();
  if (token) setToken(token);
  $("loginStatus").textContent = "Loading…";
  await start();
});

$("logout").addEventListener("click", () => {
  logout();
  state.db = emptyDb();
  render();
  showLogin("");
});

async function start() {
  try {
    state.db = await loadDb();
  } catch (e) {
    if (e instanceof LoginRequired) return showLogin(e.message);
    if (readOnly) return showLogin(`Couldn't load the statistics: ${e.message}`);
    throw e;
  }
  document.body.classList.remove("logged-out");
  render();
  if (readOnly) return;
  const savedSync = await loadSync();
  $("syncUrl").value = savedSync.url || "";
  $("syncToken").value = savedSync.token || "";
  runSync();
}

if (readOnly) document.body.classList.add("read-only");
await start();
