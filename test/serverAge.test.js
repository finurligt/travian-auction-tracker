import { test } from "node:test";
import assert from "node:assert/strict";
import { isDate, mergeServerRounds, serverAge, serverSpeed, validateRounds } from "../src/serverAge.js";

const HOST = "ts1.x1.europe.travian.com";
const at = (s) => Date.parse(s);
const age = (rounds, t) => serverAge({ [HOST]: { rounds, updatedAt: 1 } }, HOST, at(t));

test("speed comes from the server address", () => {
  assert.equal(serverSpeed("ts1.x1.europe.travian.com"), 1);
  assert.equal(serverSpeed("ts5.x3.international.travian.com"), 3);
  assert.equal(serverSpeed("ts20.x10.america.travian.com"), 10);
  assert.equal(serverSpeed("example.com"), null);
});

test("dates", () => {
  assert.ok(isDate("2026-11-15"));
  assert.ok(!isDate("2026-02-31"));
  assert.ok(!isDate("15/11/2026"));
  assert.ok(!isDate(null));
});

test("validating rounds", () => {
  assert.deepEqual(
    validateRounds([{ start: "2027-03-01", end: "" }, { start: "2026-11-15", end: "2027-02-20" }, { start: "", end: "" }]),
    [{ start: "2026-11-15", end: "2027-02-20" }, { start: "2027-03-01", end: null }],
    "sorted, empty rows dropped, empty end = running",
  );
  assert.throws(() => validateRounds([{ start: "", end: "2026-12-01" }]), /needs a start date/);
  assert.throws(() => validateRounds([{ start: "2026-11-15", end: "2026-11-01" }]), /ends before it starts/);
  assert.throws(() => validateRounds([{ start: "2026-11-15", end: "2027-03-01" }, { start: "2027-03-01", end: null }]), /overlap/);
  assert.throws(() => validateRounds([{ start: "2026-11-15", end: null }, { start: "2026-11-15", end: null }]), /overlap/);
  assert.throws(() => validateRounds([{ start: "2026-11-31", end: null }]), /isn't a date/);
});

test("server day within a round, end day included", () => {
  const rounds = [{ start: "2026-11-15", end: "2027-02-20" }, { start: "2027-03-01", end: null }];
  assert.deepEqual(age(rounds, "2026-11-15T00:00:00Z"), { round: "2026-11-15", day: 1, speed: 1 });
  assert.deepEqual(age(rounds, "2026-11-17T09:23:00Z"), { round: "2026-11-15", day: 3, speed: 1 });
  assert.equal(age(rounds, "2027-02-20T23:59:00Z").round, "2026-11-15", "last day still counts");
  assert.equal(age(rounds, "2027-02-21T00:00:00Z"), null, "between rounds");
  assert.deepEqual(age(rounds, "2027-03-02T12:00:00Z"), { round: "2027-03-01", day: 2, speed: 1 });
  assert.equal(age(rounds, "2026-11-14T23:59:00Z"), null, "before the first round");
  assert.equal(serverAge({}, HOST, at("2026-11-17T00:00:00Z")), null);
});

test("a round without an end stops where the next round starts", () => {
  const rounds = [{ start: "2026-11-15", end: null }, { start: "2027-03-01", end: null }];
  assert.equal(age(rounds, "2027-02-28T23:00:00Z").round, "2026-11-15");
  assert.deepEqual(age(rounds, "2027-03-01T08:00:00Z"), { round: "2027-03-01", day: 1, speed: 1 });
  assert.equal(age(rounds, "2030-01-01T00:00:00Z").round, "2027-03-01", "the last open round runs on");
});

test("merging keeps the most recent edit per server", () => {
  const r = (start) => [{ start, end: null }];
  const a = { s1: { rounds: r("2026-01-01"), updatedAt: 5 }, s2: { rounds: r("2026-02-01"), updatedAt: 1 } };
  const b = { s1: { rounds: r("2026-01-02"), updatedAt: 3 }, s2: { rounds: r("2026-02-02"), updatedAt: 9 }, s3: { rounds: [], updatedAt: 2 } };
  assert.deepEqual(mergeServerRounds(a, b), {
    s1: { rounds: r("2026-01-01"), updatedAt: 5 },
    s2: { rounds: r("2026-02-02"), updatedAt: 9 },
    s3: { rounds: [], updatedAt: 2 },
  });
  assert.deepEqual(mergeServerRounds(undefined, b), b);
});
