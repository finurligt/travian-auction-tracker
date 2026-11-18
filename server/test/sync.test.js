// Two PCs syncing through the real handler and store.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCapture, emptyDb } from "../../src/dedup.js";
import { applyExchange, exchange } from "../../src/sync.js";
import { TOKEN, capture, fetchFor, server } from "./helpers.js";

function pc(fetchImpl) {
  const self = {
    db: emptyDb(),
    settings: { url: "https://sync.example/", token: TOKEN, lastSeq: 0, synced: [], pendingDeletes: [] },
    async sync() {
      const result = await exchange(self.db, self.settings, fetchImpl);
      self.db = applyExchange(self.db, result);
      self.settings = result.settings;
      return result.summary;
    },
    deleteCapture(id) {
      self.db = { ...self.db, captures: self.db.captures.filter((c) => c.id !== id) };
      self.settings.pendingDeletes.push(id);
      self.settings.synced = self.settings.synced.filter((x) => x !== id);
    },
  };
  return self;
}

test("captures made on one PC appear on the other, deletions too", async () => {
  const fetchImpl = fetchFor(await server());
  const home = pc(fetchImpl);
  const work = pc(fetchImpl);

  applyCapture(home.db, capture("h1", 1000, 100));
  applyCapture(home.db, capture("h2", 2000, 200));
  assert.deepEqual(await home.sync(), { uploaded: 2, deletedRemotely: 0, downloaded: 0, removedLocally: 0 });

  applyCapture(work.db, capture("w1", 3000, 300));
  assert.deepEqual(await work.sync(), { uploaded: 1, deletedRemotely: 0, downloaded: 2, removedLocally: 0 });
  assert.equal(work.db.auctions.length, 3, "auctions rebuilt from all captures");

  assert.equal((await home.sync()).downloaded, 1);
  assert.deepEqual(home.db.captures.map((c) => c.id).sort(), ["h1", "h2", "w1"]);

  // Nothing new: nothing moves.
  assert.deepEqual(await home.sync(), { uploaded: 0, deletedRemotely: 0, downloaded: 0, removedLocally: 0 });

  work.deleteCapture("h1");
  assert.equal((await work.sync()).deletedRemotely, 1);
  assert.equal((await home.sync()).removedLocally, 1);
  assert.deepEqual(home.db.captures.map((c) => c.id).sort(), ["h2", "w1"]);
  assert.equal(home.db.auctions.length, 2);
});

test("a wrong token is reported, nothing is lost", async () => {
  const home = pc(fetchFor(await server()));
  home.settings.token = "wrong";
  applyCapture(home.db, capture("h1"));
  await assert.rejects(home.sync(), /rejected the token/);
  assert.equal(home.db.captures.length, 1);
});

test("pulls more than one page", async () => {
  const fetchImpl = fetchFor(await server());
  const home = pc(fetchImpl);
  for (let i = 0; i < 450; i++) applyCapture(home.db, capture(`c${i}`, i, i));
  await home.sync();
  const work = pc(fetchImpl);
  assert.equal((await work.sync()).downloaded, 450);
});

test("server rounds sync between PCs", async () => {
  const fetchImpl = fetchFor(await server());
  const home = pc(fetchImpl);
  const work = pc(fetchImpl);
  const host = "ts1.x1.europe.travian.com";
  home.db.serverRounds = { [host]: { rounds: [{ start: "2026-11-15", end: null }], updatedAt: 100 } };
  await home.sync();
  await work.sync();
  assert.deepEqual(work.db.serverRounds, home.db.serverRounds);

  // The round ends and a new one starts, entered on work: home picks it up.
  const rounds = [{ start: "2026-11-15", end: "2027-02-20" }, { start: "2027-03-01", end: null }];
  work.db.serverRounds = { [host]: { rounds, updatedAt: 200 } };
  await work.sync();
  await home.sync();
  assert.deepEqual(home.db.serverRounds[host].rounds, rounds);
});
