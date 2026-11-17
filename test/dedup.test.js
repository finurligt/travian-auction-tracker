import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCapture, emptyDb, rebuild } from "../src/dedup.js";

const SERVER = "ts1.x1.europe.travian.com";
const row = (itemName, quantity, price, bidderRaw, bids, status = "finished") => {
  const m = bidderRaw.match(/^(.*\S)\s*\(([^()]*)\)$/);
  return {
    itemName, itemTypeId: null, quantity, price, bidderRaw,
    bidder: m ? m[1] : bidderRaw, alliance: m ? m[2] : null, bids, status,
  };
};
// Mirrors the parser: running auctions are dropped and only counted.
const capture = (rows, capturedAt, order = "newestFirst") => {
  const finished = rows.filter((r) => r.status === "finished").map(({ status, ...r }) => r);
  return {
    id: String(capturedAt), server: SERVER, capturedAt,
    tables: [{ page: 11, order, skippedRunning: rows.length - finished.length, rows: finished }],
  };
};

// The 8 finished rows visible in both of the user's snapshots.
const finishedTail = [
  row("Cage", 10, 4000, "Gonysunmag (PNG2)", 6),
  row("Ointment", 10, 3800, "SM18 (Warriors)", 8),
  row("Cage", 5, 2555, "Helm (VOID)", 8),
  row("Cage", 5, 2222, "Helm (VOID)", 13),
  row("Book of Wisdom", 1, 7000, "sears (V1rus)", 14),
  row("Cage", 10, 4005, "Gonysunmag (PNG2)", 8),
  row("Ointment", 30, 12760, "cengiz_han (KING)", 9),
  row("Ointment", 10, 3378, "AmunRa (V1rus)", 8),
];

// Snapshot 1 = the saved HTML page, snapshot 2 = the Ctrl+A text a few minutes later.
const snapshot1 = capture([
  row("Cage", 5, 2185, "gence26 (KING)", 9, "active"),
  row("Cage", 30, 10001, "Maja", 6, "active"),
  row("Ointment", 10, 3336, "SM18 (Warriors)", 6, "active"),
  row("Cage", 5, 2223, "gence26 (KING)", 6, "active"),
  ...finishedTail,
], 1000);
const snapshot2 = capture([
  row("Ointment", 10, 2501, "Salahudin (ShadowMythLegi)", 5, "active"),
  row("Cage", 5, 2185, "gence26 (KING)", 9, "active"),
  row("Cage", 30, 13414, "Macek51 (PNG)", 7),
  row("Ointment", 10, 3336, "SM18 (Warriors)", 6),
  row("Cage", 5, 2223, "gence26 (KING)", 6),
  ...finishedTail,
], 2000);

test("the user's two snapshots: only the newly finished auctions are added", () => {
  const db = emptyDb();
  assert.deepEqual(applyCapture(db, snapshot1), { finished: 8, added: 8, duplicates: 0, skippedRunning: 4, unordered: false });
  assert.deepEqual(applyCapture(db, snapshot2), { finished: 11, added: 3, duplicates: 8, skippedRunning: 2, unordered: false });
  assert.equal(db.auctions.length, 11);
  // Capturing the same page again changes nothing.
  assert.equal(applyCapture(db, { ...snapshot2, capturedAt: 3000 }).added, 0);
  assert.equal(db.auctions.length, 11);
});

test("same buyer, item and price twice in a row are kept as two auctions", () => {
  const a = row("Cage", 5, 2222, "Helm (VOID)", 13);
  const db = emptyDb();
  applyCapture(db, capture([row("X", 1, 1, "p", 1), a, a, row("Y", 1, 1, "p", 1)], 1));
  assert.equal(db.auctions.length, 4);
  applyCapture(db, capture([row("X", 1, 1, "p", 1), a, a, row("Y", 1, 1, "p", 1)], 2));
  assert.equal(db.auctions.length, 4);
});

test("identical auctions far apart are separated by their neighbours", () => {
  const a = row("Cage", 5, 2222, "Helm (VOID)", 13);
  const db = emptyDb();
  // Page 1 shows one copy, a later page shows another copy with other neighbours.
  applyCapture(db, capture([row("X", 1, 1, "p", 1), a, row("Y", 1, 1, "p", 1)], 1));
  applyCapture(db, capture([row("Z", 1, 1, "p", 1), a, row("W", 1, 1, "p", 1)], 2));
  assert.equal(db.auctions.filter((x) => x.price === 2222).length, 2);
});

test("page edges: a row with an unknown neighbour still matches", () => {
  const db = emptyDb();
  applyCapture(db, capture([row("A", 1, 1, "p", 1), row("B", 1, 2, "p", 1), row("C", 1, 3, "p", 1)], 1));
  // After a new auction finished, B and C slid to the top of the next page.
  applyCapture(db, capture([row("B", 1, 2, "p", 1), row("C", 1, 3, "p", 1), row("D", 1, 4, "p", 1)], 2));
  assert.deepEqual(db.auctions.map((a) => a.itemName).sort(), ["A", "B", "C", "D"]);
});

test("ascending sort and unsorted lists", () => {
  const db = emptyDb();
  applyCapture(db, snapshot2);
  const reversed = { ...snapshot2, capturedAt: 5000, tables: [{ ...snapshot2.tables[0], order: "oldestFirst", rows: [...snapshot2.tables[0].rows].reverse() }] };
  assert.equal(applyCapture(db, reversed).added, 0);
  const byPrice = capture(finishedTail, 6000, null);
  const summary = applyCapture(db, byPrice);
  assert.equal(summary.unordered, true);
  assert.equal(summary.added, 0);
});

test("running auctions are never stored", () => {
  const db = emptyDb();
  applyCapture(db, snapshot1);
  assert.ok(!db.auctions.some((a) => a.bidder === "Maja" || a.price === 2185));
  assert.ok(snapshot1.tables[0].rows.every((r) => !("status" in r)));
});

test("rebuild from captures gives the same result", () => {
  const db = emptyDb();
  db.captures.push(snapshot2, snapshot1);
  assert.equal(rebuild(db).auctions.length, 11);
});
