import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuctionsHandler, createHandler } from "../lib/handler.js";
import { TOKEN, call, capture, memoryStore, server } from "./helpers.js";

test("requires the token", async () => {
  const handler = await server();
  assert.equal((await call(handler, { token: null })).statusCode, 401);
  assert.equal((await call(handler, { token: "wrong" })).statusCode, 401);
  assert.equal((await call(handler, {})).statusCode, 200);
});

test("CORS preflight works without a token", async () => {
  const res = await call(await server(), { method: "OPTIONS", token: null });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "*");
  assert.match(res.headers["access-control-allow-headers"], /Authorization/);
});

test("upload, delete and pull", async () => {
  const handler = await server();
  const up = await call(handler, { method: "POST", body: { add: [capture("a"), capture("b")] } });
  assert.deepEqual(up.body, { added: 2, removed: 0 });
  const del = await call(handler, { method: "POST", body: { delete: ["a"] } });
  assert.deepEqual(del.body, { added: 0, removed: 1 });
  const pull = await call(handler, { query: { after: "0" } });
  assert.deepEqual(pull.body.captures.map((c) => [c.id, c.deleted]), [["b", false], ["a", true]]);
});

test("rejects bad input", async () => {
  const handler = await server();
  const post = (body) => call(handler, { method: "POST", body });
  assert.equal((await post({ add: [{ id: "x" }] })).statusCode, 400);
  assert.equal((await post({ add: "nope" })).statusCode, 400);
  assert.equal((await post({ delete: [42] })).statusCode, 400);
  assert.equal((await post({ add: Array.from({ length: 201 }, (_, i) => capture(`c${i}`)) })).statusCode, 400);
  assert.equal((await call(handler, { query: { after: "-1" } })).statusCode, 400);
  assert.equal((await call(handler, { query: { after: "abc" } })).statusCode, 400);
  assert.equal((await call(handler, { method: "DELETE" })).statusCode, 405);
});

test("auctions endpoint: de-duplicated, both tokens, view token is read-only", async () => {
  const store = await memoryStore();
  const write = createHandler({ store, token: TOKEN });
  const read = createAuctionsHandler({ store, token: TOKEN, viewToken: "view" });
  // The same auction seen in two captures, plus one deleted capture.
  await call(write, { method: "POST", body: { add: [capture("a", 1000, 100), capture("b", 2000, 100), capture("c", 3000, 999)] } });
  await call(write, { method: "POST", body: { delete: ["c"] } });

  const res = await call(read, { token: "view" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.captureCount, 2);
  assert.equal(res.body.auctions.length, 1);
  assert.equal(res.body.auctions[0].firstSeenAt, 1000);
  assert.equal(res.body.auctions[0].sig, undefined, "no matching internals");
  assert.equal((await call(read, {})).statusCode, 200, "the sync token works too");
  assert.equal((await call(read, { token: "wrong" })).statusCode, 401);

  assert.equal((await call(write, { token: "view" })).statusCode, 401, "view token can't read captures");
  assert.equal((await call(write, { method: "POST", token: "view", body: { delete: ["a"] } })).statusCode, 401);
});

test("auctions endpoint without a view token configured", async () => {
  const read = createAuctionsHandler({ store: await memoryStore(), token: TOKEN, viewToken: undefined });
  assert.equal((await call(read, { token: "undefined" })).statusCode, 401);
  assert.equal((await call(read, { token: null })).statusCode, 401);
});
