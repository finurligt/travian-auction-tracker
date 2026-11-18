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
  assert.deepEqual(applyCapture(db, snapshot1), { stored: true, finished: 8, added: 8, duplicates: 0, skippedRunning: 4, unordered: false });
  assert.deepEqual(applyCapture(db, snapshot2), { stored: true, finished: 11, added: 3, duplicates: 8, skippedRunning: 2, unordered: false });
  assert.equal(db.auctions.length, 11);
  // Capturing the same page again changes nothing, so it isn't stored.
  const again = applyCapture(db, { ...snapshot2, id: "again", capturedAt: 3000 });
  assert.equal(again.stored, false);
  assert.equal(again.added, 0);
  assert.equal(db.captures.length, 2);
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
  const reversed = { ...snapshot2, id: "reversed", capturedAt: 5000, tables: [{ ...snapshot2.tables[0], order: "oldestFirst", rows: [...snapshot2.tables[0].rows].reverse() }] };
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
  const rebuilt = rebuild(db).auctions;
  assert.equal(rebuilt.length, 11);
  // Seen in both snapshots: dated by the earlier one.
  assert.equal(rebuilt.find((a) => a.bidder === "sears").firstSeenAt, 1000);
});

// Builds a list of distinct finished auctions, newest first. Every 3rd one
// is the same item, price, buyer and bid count, so only position separates them.
const history = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => {
    const k = n - i + offset;
    return k % 3 === 0 ? row("Cage", 5, 2222, "Helm (VOID)", 13) : row("Ointment", 10, 3000 + k, "SM18 (Warriors)", 6);
  });
const pages = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) }, (_, p) => rows.slice(p * size, (p + 1) * size));

test("page breaks moving between captures don't create duplicates", () => {
  const db = emptyDb();
  let t = 0;
  // Day 1: 40 auctions, captured as pages of 7.
  for (const page of pages(history(40), 7)) applyCapture(db, capture(page, ++t));
  // With no overlap at all between pages, an identical auction seen only at a
  // page top and one seen only at another page's bottom can't be told apart yet.
  assert.ok(db.auctions.length >= 38 && db.auctions.length <= 40);
  // Day 2: 5 more finished, every page break has shifted by 5. Capture all again.
  for (const page of pages(history(45), 7)) applyCapture(db, capture(page, ++t));
  assert.equal(db.auctions.length, 45);
  // Day 3: 2 more, capture only some pages, out of order.
  const day3 = pages(history(47), 7);
  for (const p of [3, 0, 5]) applyCapture(db, capture(day3[p], ++t));
  assert.equal(db.auctions.length, 47);
  assert.equal(db.auctions.filter((a) => a.price === 2222).length, 15);
});

test("identical neighbours split by a page break, captured before the full view", () => {
  const a = row("Cage", 5, 2222, "Helm (VOID)", 13);
  const [P, X, Y, Q] = ["P", "X", "Y", "Q"].map((n) => row(n, 1, 1, "p", 1));
  const db = emptyDb();
  applyCapture(db, capture([P, X, a], 1)); // first copy at the bottom of a page
  applyCapture(db, capture([a, Y, Q], 2)); // second copy at the top of the next
  applyCapture(db, capture([X, a, a, Y], 3)); // later both visible together
  assert.equal(db.auctions.length, 6);
  assert.equal(db.auctions.filter((x) => x.price === 2222).length, 2);
});

test("a capture with only known auctions is kept if it adds neighbour context", () => {
  const [A, B, C, D] = ["A", "B", "C", "D"].map((n, i) => row(n, 1, i + 1, "p", 1));
  const db = emptyDb();
  applyCapture(db, capture([A, B], 1)); // B seen at the page bottom: older neighbour unknown
  applyCapture(db, capture([C, D], 2)); // C seen at the page top: newer neighbour unknown
  // Page breaks moved: B and C now seen together. Nothing new, but B's older and
  // C's newer neighbour become known.
  const shifted = applyCapture(db, capture([B, C], 3));
  assert.equal(shifted.added, 0);
  assert.equal(shifted.stored, true);
  assert.equal(db.captures.length, 3);
  // The same view again adds nothing.
  assert.equal(applyCapture(db, capture([B, C], 4)).stored, false);
  assert.equal(db.captures.length, 3);
});
