const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../www/rules.js");

const M = (o = {}) => Object.assign({ kind: "doubles", bestOf: 3, target: 11, firstServer: 0, picks: [{ s: 0, r: 0 }], games: [[]] }, o);
const tag = p => (p[0] ? "B" : "A") + p[1];
const at = (m, g, n) => { const d = R.doublesAt(m, g, n); return tag(d.srv) + ">" + tag(d.rcv); };

test("doubles: serve goes round all four players every two points", () => {
  const m = M();
  const seen = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(n => at(m, 0, n));
  assert.deepEqual(seen, ["A0>B0", "A0>B0", "B0>A1", "B0>A1", "A1>B1", "A1>B1", "B1>A0", "B1>A0", "A0>B0"]);
});

test("doubles: the chosen first server and receiver set the order", () => {
  const m = M({ firstServer: 1, picks: [{ s: 1, r: 0 }] });
  assert.deepEqual([0, 2, 4, 6].map(n => at(m, 0, n)), ["B1>A0", "A0>B0", "B0>A1", "A1>B1"]);
});

test("doubles: from 10-10 the serve changes every point, still in the same order", () => {
  const m = M();
  // 20 points = 10 turns: turn 10 is A0>B0 again (10 % 4 = 2 -> A1>B1)
  assert.equal(at(m, 0, 20), "A1>B1");
  assert.equal(at(m, 0, 21), "B1>A0");
  assert.equal(at(m, 0, 22), "A0>B0");
});

test("doubles: 21-point games change serve every five points", () => {
  const m = M({ target: 21 });
  assert.deepEqual([0, 4, 5, 9, 10, 15].map(n => at(m, 0, n)), ["A0>B0", "A0>B0", "B0>A1", "B0>A1", "A1>B1", "B1>A0"]);
});

test("doubles: the serving side always matches the singles serve rule", () => {
  for (const target of [11, 21]) for (const f of [0, 1]) for (const s of [0, 1]) for (const r of [0, 1]) for (const g of [0, 1, 2]) {
    const m = M({ target, firstServer: f, bestOf: 5, picks: [{ s, r }, { s: 1 - s }, { s }] , games: [[], [], []] });
    for (let n = 0; n < 50; n++) assert.equal(R.doublesAt(m, g, n).srv[0], R.serverAt(m, g, n), `t${target} f${f} g${g} n${n}`);
  }
});

test("doubles: next game, the receiving pair serves and the receiver is who served to them", () => {
  // game 1: A0>B0, B0>A1, A1>B1, B1>A0. So A0 served to B0 and A1 served to B1.
  const m0 = M({ picks: [{ s: 0, r: 0 }, { s: 0 }] });
  assert.equal(at(m0, 1, 0), "B0>A0");
  assert.deepEqual([0, 2, 4, 6].map(n => at(m0, 1, n)), ["B0>A0", "A0>B1", "B1>A1", "A1>B0"]);
  const m1 = M({ picks: [{ s: 0, r: 0 }, { s: 1 }] });
  assert.equal(at(m1, 1, 0), "B1>A1");
  assert.deepEqual(R.doublesReceiverFor(m0, 1, 0), [0, 0]);
  assert.deepEqual(R.doublesReceiverFor(m0, 1, 1), [0, 1]);
  // game 3 goes back to orange serving
  const m2 = M({ picks: [{ s: 0, r: 0 }, { s: 0 }, { s: 1 }] });
  assert.equal(R.doublesAt(m2, 2, 0).srv[0], 0);
});

test("doubles: deciding game, the receivers swap when a pair reaches 5", () => {
  const m = M({ bestOf: 1, games: [[0, 0, 0, 0, 0, 1, 1, 0]] });
  assert.equal(R.doublesSwapAt(m, 0), 5);
  assert.equal(at(m, 0, 4), "A1>B1");
  // point 5 is still A1's turn, but the white pair now swap: B0 receives
  assert.equal(at(m, 0, 5), "A1>B0");
  assert.equal(R.doublesAt(m, 0, 5).swapped, true);
  // then B0 serves to A1's partner, and the rotation runs the other way round
  assert.deepEqual([6, 8, 10, 12].map(n => at(m, 0, n)), ["B0>A0", "A0>B1", "B1>A1", "A1>B0"]);
  // not the deciding game of a best of 3: no swap
  assert.equal(R.doublesSwapAt(M({ games: [[0, 0, 0, 0, 0]] }), 0), -1);
});

test("doubles: a pair's initials skip the &", () => {
  assert.equal(R.initials("Jo & Kai"), "JK");
  assert.equal(R.initials("Maya Lee"), "ML");
  assert.equal(R.initials("&"), "?");
});

test("doubles: serve order lists the next four turns", () => {
  const m = M();
  assert.deepEqual(R.doublesOrder(m, 0, 3).map(([s, r]) => tag(s) + ">" + tag(r)), ["B0>A1", "A1>B1", "B1>A0", "A0>B0"]);
});

test("doubles: records are checked as pairs", () => {
  const rec = { kind: "doubles", a: "Ali & Sam", b: "Jo & Kai", ap: ["Ali", "Sam"], bp: ["Jo", "Kai"], aKey: R.pairKey("Ali", "Sam"), bKey: R.pairKey("Jo", "Kai"),
    bestOf: 1, target: 11, firstServer: 0, picks: [{ s: 0, r: 0 }], g: ["00000000000"], winner: 0, gw: [1, 0], startedAt: 1, endedAt: 2 };
  assert.equal(R.validRecord(rec), true);
  assert.equal(R.pairKey("Sam", "Ali"), R.pairKey("ali ", "SAM"), "a pair is the same pair in either order");
  assert.equal(R.validRecord(Object.assign({}, rec, { bp: ["Jo", "ali"], b: "Jo & ali", bKey: R.pairKey("Jo", "ali") })), false, "a player can't be on both sides");
  assert.equal(R.validRecord(Object.assign({}, rec, { aKey: "ali & sam x" })), false);
  assert.equal(R.validRecord(Object.assign({}, rec, { kind: "triples" })), false);
});
