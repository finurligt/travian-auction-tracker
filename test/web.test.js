// The read-only web build of the statistics page, with a fake server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const root = new URL("../", import.meta.url);

test("web version: login, read-only statistics, logout", async () => {
  execFileSync(process.execPath, ["scripts/build-web.js"], { cwd: root });
  const html = readFileSync(new URL("dist-web/index.html", root), "utf8");
  const dom = new JSDOM(html, { url: "https://tracker.example/" });
  const doc = dom.window.document;

  const auctions = Array.from({ length: 6 }, (_, i) => ({
    id: `a${i}`, server: "ts1", itemTypeId: 114, itemName: "Cage", quantity: i < 3 ? 5 : 10,
    price: 2000 + i * 300, unitPrice: (2000 + i * 300) / (i < 3 ? 5 : 10),
    bidderRaw: "Helm (VOID)", bidder: "Helm", alliance: "VOID", bids: 8, firstSeenAt: Date.UTC(2026, 10, 10 + i),
  }));
  const requests = [];
  const g = globalThis;
  for (const k of ["window", "document", "Node", "Option", "localStorage", "Event"]) g[k] = k === "window" ? dom.window : dom.window[k];
  g.fetch = async (url, init) => {
    requests.push([url, init.headers.Authorization]);
    const ok = init.headers.Authorization === "Bearer secret";
    return { ok, status: ok ? 200 : 401, json: async () => ({ auctions, captureCount: 4 }) };
  };

  await import(new URL("dist-web/stats/stats.js", root));
  assert.ok(doc.body.classList.contains("read-only"));
  assert.ok(doc.body.classList.contains("logged-out"), "asks for the token first");
  assert.equal(requests.length, 0);

  const login = async (token) => {
    doc.querySelector("#loginToken").value = token;
    doc.querySelector("#loginForm").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));
  };

  await login("wrong");
  assert.ok(doc.body.classList.contains("logged-out"));
  assert.equal(doc.querySelector("#loginStatus").textContent, "Wrong token.");

  await login("secret");
  assert.ok(!doc.body.classList.contains("logged-out"));
  assert.deepEqual(requests.at(-1), ["/api/auctions", "Bearer secret"]);
  assert.equal(localStorage.getItem("auctionTrackerToken"), "secret", "remembered for next visit");
  assert.equal(doc.querySelectorAll("#chartSvg circle.point").length, 6);
  assert.equal(doc.querySelectorAll("#lotSizes tbody tr").length, 2);
  assert.match(doc.querySelector("#cards").textContent, /Captures4/);
  assert.ok(doc.querySelector("section.edit-only"), "data section is marked edit-only (hidden by CSS)");

  doc.querySelector("#logout").click();
  assert.ok(doc.body.classList.contains("logged-out"));
  assert.equal(localStorage.getItem("auctionTrackerToken"), null);
});
