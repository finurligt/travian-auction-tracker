import { test } from "node:test";
import assert from "node:assert/strict";
import { capture, memoryStore } from "./helpers.js";

test("add is idempotent and list pages by seq", async () => {
  const store = await memoryStore();
  assert.equal(await store.add([capture("a"), capture("b"), capture("c")]), 3);
  assert.equal(await store.add([capture("a"), capture("d")]), 1);

  const first = await store.list(0, 3);
  assert.deepEqual(first.captures.map((c) => c.id), ["a", "b", "c"]);
  assert.equal(first.more, true);
  assert.deepEqual(first.captures[0].data, capture("a"));

  const second = await store.list(first.next, 3);
  assert.deepEqual(second.captures.map((c) => c.id), ["d"]);
  assert.equal(second.more, false);
  assert.deepEqual(await store.list(second.next, 3), { captures: [], next: second.next, more: false });
});

test("deletions show up after the last seq and can't be undone by re-uploading", async () => {
  const store = await memoryStore();
  await store.add([capture("a"), capture("b")]);
  const { next } = await store.list(0, 10);

  assert.equal(await store.remove(["a", "never-uploaded"]), 2);
  assert.equal(await store.remove(["a"]), 0, "already deleted");
  const changes = await store.list(next, 10);
  assert.deepEqual(changes.captures.map((c) => [c.id, c.deleted, c.data]), [["a", true, null], ["never-uploaded", true, null]]);

  // A PC that hasn't heard about the deletion uploads it again: stays deleted.
  assert.equal(await store.add([capture("a"), capture("never-uploaded")]), 0);
  assert.deepEqual((await store.list(changes.next, 10)).captures, []);
});
