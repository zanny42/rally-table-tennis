const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../www/rules.js");

const match = (o = {}) => Object.assign({ firstServer: 0, target: 11, bestOf: 3, games: [[]] }, o);
const pts = (a, b) => Array(a).fill(0).concat(Array(b).fill(1));

test("serve changes every two points, then every point from 10-10", () => {
  const m = match();
  const seq = Array.from({ length: 24 }, (_, n) => R.serverAt(m, 0, n)).join("");
  assert.equal(seq, "001100110011001100110101");
});

test("first server alternates each game", () => {
  const m = match();
  assert.equal(R.serverAt(m, 1, 0), 1);
  assert.equal(R.serverAt(m, 2, 0), 0);
});

test("21-point games change serve every five points", () => {
  const m = match({ target: 21 });
  const seq = Array.from({ length: 12 }, (_, n) => R.serverAt(m, 0, n)).join("");
  assert.equal(seq, "000001111100");
});

test("a game needs 11 points and a two-point lead", () => {
  assert.equal(R.gameOver(11, 9, 11), true);
  assert.equal(R.gameOver(11, 10, 11), false);
  assert.equal(R.gameOver(12, 10, 11), true);
  assert.equal(R.gameOver(10, 8, 11), false);
});

test("summarize tracks games won and ends a best of 3 at 2 games", () => {
  let s = R.summarize(match({ games: [pts(11, 5), pts(9, 11)] }));
  assert.deepEqual(s.gw, [1, 1]);
  assert.equal(s.over, false);
  s = R.summarize(match({ games: [pts(11, 5), pts(11, 3)] }));
  assert.equal(s.over, true);
  assert.equal(s.winner, 0);
});

test("ends change after each game and at 5 points in the deciding game", () => {
  const m = match({ games: [pts(11, 5), pts(5, 11), pts(4, 0)] });
  assert.equal(R.switchCount(m, R.summarize(m)), 2);
  m.games[2] = pts(5, 0);
  assert.equal(R.switchCount(m, R.summarize(m)), 3);
});

test("stats count points, runs and serve wins", () => {
  const st = R.stats(match({ games: [pts(11, 0)] }));
  assert.deepEqual(st.pts, [11, 0]);
  assert.equal(st.run[0], 11);
  assert.equal(st.srvWon[0] + st.srvWon[1], 6);
  assert.equal(st.series[0].at(-1), 11);
});

const rec = (id, a, b, winner, t) => ({ id, a, b, aKey: R.keyOf(a), bKey: R.keyOf(b), bestOf: 1, target: 11, firstServer: 0,
  g: [winner ? "1".repeat(11) : "0".repeat(11)], winner, gw: winner ? [0, 1] : [1, 0], startedAt: t - 1000, endedAt: t });

test("Elo: equal players move by 20 each way, totals are conserved", () => {
  const { players, deltas } = R.computeBoard([rec("m1", "Maya", "Theo", 0, 1)]);
  assert.deepEqual(deltas.get("m1"), [20, -20]);
  assert.equal(players[0].name, "Maya");
  assert.equal(players[0].r + players[1].r, 2000);
});

test("Elo: names are matched case-insensitively and an upset earns more", () => {
  const list = [rec("m1", "Maya", "Theo", 0, 1), rec("m2", "maya ", "Theo", 0, 2), rec("m3", "Theo", "MAYA", 0, 3)];
  const { players, deltas } = R.computeBoard(list);
  assert.equal(players.length, 2);
  assert.ok(deltas.get("m3")[0] > 20);
  assert.deepEqual(R.streakOf(players.find(p => p.key === "theo").res), { win: true, n: 1 });
});

test("validRecord accepts a real result and rejects tampered ones", () => {
  const good = rec("m1", "Maya", "Theo", 0, 5);
  assert.equal(R.validRecord(good), true);
  assert.equal(R.validRecord(Object.assign({}, good, { winner: 1 })), false);
  assert.equal(R.validRecord(Object.assign({}, good, { g: ["0000"] })), false);
  assert.equal(R.validRecord(Object.assign({}, good, { b: "maya", bKey: "maya" })), false);
  assert.equal(R.validRecord(Object.assign({}, good, { g: ["<script>"] })), false);
});
