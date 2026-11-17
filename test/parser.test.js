import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const parserSource = readFileSync(new URL("../src/parser.js", import.meta.url), "utf8");
const fixture = readFileSync(new URL("./fixtures/your-bids.html", import.meta.url), "utf8");

function parse(html) {
  const dom = new JSDOM(html, { url: "https://ts1.x1.europe.travian.com/hero/auction", runScripts: "outside-only" });
  const before = dom.serialize();
  // executeScript() structured-clones the result out of the page; do the same.
  const result = structuredClone(dom.window.eval(parserSource));
  assert.equal(dom.serialize(), before, "parser must not modify the DOM");
  return result;
}

test("parses finished auctions from Your bids without touching the page", () => {
  const result = parse(fixture);
  assert.equal(result.server, "ts1.x1.europe.travian.com");
  assert.equal(result.tables.length, 1);
  const [table] = result.tables;
  assert.equal(table.heading, "Your bids");
  assert.deepEqual(table.sort, { column: "finishedAt", direction: "down" });
  assert.equal(table.page, 11);
  assert.equal(table.order, "newestFirst");
  assert.equal(table.skippedRunning, 9);
  assert.equal(table.rows.length, 8);

  assert.deepEqual(table.rows[0], {
    itemName: "Cage", itemTypeId: 114, quantity: 10, price: 4000,
    bidderRaw: "Gonysunmag (PNG2)", bidder: "Gonysunmag", alliance: "PNG2", bids: 6,
  });
  const book = table.rows.find((r) => r.itemName === "Book of Wisdom");
  assert.deepEqual([book.quantity, book.price, book.bids], [1, 7000, 14]);
});

test("running auctions are not returned", () => {
  const { tables: [table] } = parse(fixture);
  for (const name of ["Maja", "Average player", "Сэм"]) {
    assert.ok(!table.rows.some((r) => r.bidder === name), `${name} only has running auctions`);
  }
});

test("player without alliance", () => {
  // Make Maja's running auction finished by removing its timer.
  const html = fixture.replace(/<span class="timerReact">00:03:27<\/span>/, "Finished");
  const maja = parse(html).tables[0].rows.find((r) => r.bidder === "Maja");
  assert.deepEqual([maja.bidderRaw, maja.alliance, maja.quantity], ["Maja", null, 30]);
});
