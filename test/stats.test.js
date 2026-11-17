// Smoke test: loads the statistics page in jsdom with a fake extension
// storage and checks it renders the tables and the chart without errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { applyCapture, emptyDb } from "../src/dedup.js";

const row = (itemName, quantity, price, bidderRaw, bids) => {
  const [, bidder, alliance] = bidderRaw.match(/^(.*\S)\s*\(([^()]*)\)$/);
  return { itemName, itemTypeId: 114, quantity, price, bidderRaw, bidder, alliance, bids };
};

test("statistics page renders chart and tables", async () => {
  const db = emptyDb();
  const start = new Date("2026-11-10T08:00:00").getTime();
  for (let day = 0; day < 6; day++) {
    const rows = Array.from({ length: 4 }, (_, i) => row("Cage", 5, 2000 + day * 100 + i * 37, `p${i} (A)`, 5 + i));
    applyCapture(db, { id: `c${day}`, server: "ts1", capturedAt: start + day * 86400000 + 3600000 * day, tables: [{ order: "newestFirst", rows }] });
  }
  applyCapture(db, { id: "x", server: "ts1", capturedAt: start, tables: [{ order: "newestFirst", rows: [row("Ointment", 10, 3000, "q (B)", 4)] }] });
  applyCapture(db, { id: "y", server: "ts1", capturedAt: start, tables: [{ order: "newestFirst", rows: [row("Cage", 10, 9000, "r (C)", 9)] }] });

  const html = readFileSync(new URL("../stats/stats.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://example.invalid/stats.html" });
  const g = globalThis;
  for (const k of ["window", "document", "Node", "Option"]) g[k] = k === "window" ? dom.window : dom.window[k];
  g.browser = {
    storage: {
      local: { get: async () => ({ db }), set: async () => {} },
      onChanged: { addListener() {} },
    },
  };
  await import("../stats/stats.js");

  const doc = dom.window.document;
  assert.equal(doc.querySelectorAll("#chartSvg circle.point").length, 25, "one dot per Cage auction");
  assert.ok(doc.querySelector("#chartSvg path.median").getAttribute("d").split("L").length === 6, "six daily medians");
  assert.ok(doc.querySelectorAll("#chartSvg .axis-label").length > 4);
  assert.equal(doc.querySelector("#chartItem").value, "114|Cage");
  assert.equal(doc.querySelectorAll("#items tbody tr").length, 2);
  assert.equal(doc.querySelectorAll("#auctions tbody tr").length, 26);

  // Cage was sold as ×5 (24 sales, ~460/unit) and ×10 (1 sale, 900/unit).
  const lots = [...doc.querySelectorAll("#lotSizes tbody tr")].map((tr) => [...tr.cells].map((td) => td.textContent));
  assert.equal(lots.length, 2, "only Cage comes in more than one amount");
  assert.deepEqual(lots.map((r) => r[1]), ["×5", "×10"]);
  assert.equal(lots[1][4], "★ best");
  assert.match(lots[0][4], /^-\d+ %$/);
  assert.equal(lots[1][7], "few sales – uncertain");
  assert.equal(lots[0][7], "");

  // Switching the item updates the chart and filters the auction list.
  const sel = doc.querySelector("#chartItem");
  sel.value = "114|Ointment";
  sel.dispatchEvent(new dom.window.Event("change"));
  assert.equal(doc.querySelectorAll("#chartSvg circle.point").length, 1);
  assert.equal(doc.querySelectorAll("#auctions tbody tr").length, 1);
});
