const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../www/rules.js");

const team = (prefix, teamName, n, start = 0) => Array.from({ length: n }, (_, i) => ({ id: prefix + i, name: prefix + i, team: teamName, position: start + i }));
// a finished match won by side w ("a" or "b") in a 1-game format
const done = (d, w) => Object.assign({}, d, { games: [w === "a" ? "0".repeat(11) : "1".repeat(11)], bestOf: 1, target: 11, status: "done" });
const P = ps => id => ps.find(p => p.id === id);

test("bracket: every first-round match is Lions v Hawks when teams are balanced", () => {
  const ps = team("U", "Lions", 4).concat(team("C", "Hawks", 4, 4));
  for (const draw of ["random", "seeded"]) for (let seed = 1; seed <= 25; seed++) {
    const d = R.bracketDraw({ mode: "bracket", crossTeam: true, draw, seed }, ps);
    assert.equal(d.size, 8);
    for (const [a, b] of d.slots) assert.notEqual(P(ps)(a).team, P(ps)(b).team, `${draw} seed ${seed}`);
  }
});

test("bracket: without cross-team, teammates can meet", () => {
  const ps = team("U", "Lions", 4).concat(team("C", "Hawks", 4, 4));
  const same = [];
  for (let seed = 1; seed <= 25; seed++) {
    const d = R.bracketDraw({ crossTeam: false, draw: "random", seed }, ps);
    same.push(d.slots.some(([a, b]) => P(ps)(a).team === P(ps)(b).team));
  }
  assert.ok(same.includes(true));
});

test("bracket: random draws are repeatable from the seed and differ between seeds", () => {
  const ps = team("p", "", 8);
  const a = R.bracketDraw({ draw: "random", seed: 42 }, ps), b = R.bracketDraw({ draw: "random", seed: 42 }, ps), c = R.bracketDraw({ draw: "random", seed: 7 }, ps);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.slots, c.slots);
});

test("bracket: 6 players get two byes, then winners advance to a final", () => {
  const ps = team("p", "", 6), t = { mode: "bracket", draw: "seeded", seed: 1 };
  let plan = R.bracketPlan(t, ps, []);
  assert.equal(plan.size, 8);
  assert.equal(plan.matches.length, 2, "only the two real first-round matches");
  const byes = plan.tree[0].filter(s => s.bye).map(s => s.aTp).sort();
  assert.deepEqual(byes, ["p0", "p1"], "top seeds get the byes");
  let played = plan.matches.map(m => done(m, "a"));
  plan = R.bracketPlan(t, ps, played);
  assert.equal(plan.matches.length, 4, "semi-finals created");
  played = played.concat(plan.matches.filter(m => m.round === 1).map(m => done(m, "b")));
  plan = R.bracketPlan(t, ps, played);
  const final = plan.matches.find(m => m.round === 2);
  assert.ok(final, "final created");
  played.push(done(final, "a"));
  plan = R.bracketPlan(t, ps, played);
  assert.equal(plan.champion, final.aTp);
  assert.equal(R.tournamentPlan(Object.assign({}, t, { mode: "bracket" }), ps, played).complete, true);
});

test("round robin: everyone plays everyone exactly once", () => {
  const ps = team("p", "", 5), seen = new Set();
  const ms = R.roundRobin({ mode: "round_robin" }, ps);
  assert.equal(ms.length, 10);
  for (const m of ms) { const k = [m.aTp, m.bTp].sort().join("-"); assert.ok(!seen.has(k)); seen.add(k); }
  const rounds = new Map(); for (const m of ms) { const r = rounds.get(m.round) || []; assert.ok(!r.includes(m.aTp) && !r.includes(m.bTp), "nobody plays twice in a round"); r.push(m.aTp, m.bTp); rounds.set(m.round, r); }
});

test("round robin with teams: only cross-team matches, every pair once", () => {
  const ps = team("U", "Lions", 3).concat(team("C", "Hawks", 4, 3));
  const ms = R.roundRobin({ mode: "round_robin", crossTeam: true }, ps);
  assert.equal(ms.length, 12);
  for (const m of ms) assert.notEqual(P(ps)(m.aTp).team, P(ps)(m.bTp).team);
});

test("king of the hill: winner stays on, loser queues, challengers come from the other team", () => {
  const ps = [{ id: "U1", name: "U1", team: "Lions", position: 0 }, { id: "U2", name: "U2", team: "Lions", position: 1 }, { id: "C1", name: "C1", team: "Hawks", position: 2 }, { id: "C2", name: "C2", team: "Hawks", position: 3 }];
  const t = { mode: "koth", crossTeam: true };
  let plan = R.kothPlan(t, ps, []);
  assert.deepEqual([plan.matches[0].aTp, plan.matches[0].bTp], ["U1", "C1"], "first challenger is from the other team");
  let played = [done(plan.matches[0], "a")];
  plan = R.kothPlan(t, ps, played);
  assert.deepEqual([plan.matches[1].aTp, plan.matches[1].bTp], ["U1", "C2"]);
  played.push(done(plan.matches[1], "a"));
  plan = R.kothPlan(t, ps, played);
  assert.equal(plan.streaks.get("U1").cur, 2);
  assert.deepEqual([plan.matches[2].aTp, plan.matches[2].bTp], ["U1", "C1"], "C1 is the next Hawks player in the queue");
  played.push(done(plan.matches[2], "b"));
  plan = R.kothPlan(t, ps, played);
  assert.equal(plan.champion, "C1");
  assert.equal(plan.streaks.get("U1").best, 2);
  assert.equal(plan.matches[3].aTp, "C1");
  assert.equal(P(ps)(plan.matches[3].bTp).team, "Lions");
});

test("king of the hill: a late joiner enters the queue without changing past matches", () => {
  const ps = team("p", "", 3);
  const t = { mode: "koth" };
  let plan = R.kothPlan(t, ps, []);
  const played = [done(plan.matches[0], "a")];
  plan = R.kothPlan(t, ps, played);
  const late = { id: "late", name: "Late", team: "", position: 9, joinedRound: plan.nextRound };
  const after = R.kothPlan(t, ps.concat(late), played);
  assert.deepEqual(after.matches.slice(0, 2), plan.matches.slice(0, 2), "past and pending matches unchanged");
  assert.ok(after.queue.includes("late"));
  assert.equal(R.kothPlan(Object.assign({}, t, { status: "done" }), ps, played).matches.length, 1, "ending stops new matches");
});

test("standings rank by wins and count team wins", () => {
  const ps = team("U", "Lions", 2).concat(team("C", "Hawks", 2, 2));
  const ms = R.roundRobin({ crossTeam: true }, ps).map((m, i) => done(m, i % 3 ? "a" : "b"));
  const s = R.standings(ps, ms);
  assert.equal(s.players.length, 4);
  assert.ok(s.players[0].w >= s.players[3].w);
  assert.equal(s.teams.reduce((t, x) => t + x.wins, 0), ms.length);
});

/* ---------- Teammates must not be drawn together when a cross-team match is possible ---------- */
const norm = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
const mates = (ps, a, b) => { const x = P(ps)(a), y = P(ps)(b); return !!norm(x.team) && norm(x.team) === norm(y.team); };
const firstRoundSame = (ps, d) => d.slots.filter(([a, b]) => a && b && mates(ps, a, b)).length;
// Fewest same-team first-round matches any draw could achieve: byes come off the biggest team,
// then only the biggest team's surplus over everyone else has to play itself.
function fewestSame(ps) {
  const counts = new Map(); ps.forEach(p => { const k = norm(p.team) || "\0" + p.id; counts.set(k, (counts.get(k) || 0) + 1); });
  let size = 1; while (size < ps.length) size *= 2;
  const c = [...counts.values()];
  for (let b = size - ps.length; b > 0; b--) { const i = c.indexOf(Math.max(...c)); c[i]--; }
  const r = c.reduce((s, x) => s + x, 0), m = Math.max(...c);
  return Math.max(0, Math.floor((2 * m - r) / 2));
}
const sweep = (ps, fn, extra = {}) => { for (const draw of ["random", "seeded"]) for (let seed = 1; seed <= 40; seed++) fn(R.bracketDraw(Object.assign({ mode: "bracket", crossTeam: true, draw, seed }, extra), ps), `${draw} seed ${seed}`); };

test("bracket: byes go to the bigger team so the smaller team is not left playing itself (4 v 2, Hawks seeded top)", () => {
  const ps = team("H", "Hawks", 2).concat(team("L", "Lions", 4, 2));
  sweep(ps, (d, why) => assert.equal(firstRoundSame(ps, d), 0, why));
});

test("bracket: unbalanced teams get the fewest possible same-team first-round matches", () => {
  const cases = [[5, 3], [6, 2], [3, 5], [2, 6], [6, 4], [4, 6], [7, 2], [5, 4], [9, 7], [10, 3], [1, 1], [2, 1], [3, 2], [12, 4]];
  for (const [l, h] of cases) for (const hawksFirst of [false, true]) {
    const ps = hawksFirst ? team("H", "Hawks", h).concat(team("L", "Lions", l, h)) : team("L", "Lions", l).concat(team("H", "Hawks", h, l));
    const best = fewestSame(ps);
    sweep(ps, (d, why) => assert.equal(firstRoundSame(ps, d), best, `${l} Lions v ${h} Hawks ${hawksFirst ? "(Hawks top)" : ""} ${why}`));
  }
});

test("bracket: three teams pair across teams whenever they can", () => {
  const cases = [[["Lions", 1], ["Hawks", 1], ["Owls", 2]], [["Lions", 2], ["Hawks", 2], ["Owls", 4]], [["Lions", 3], ["Hawks", 3], ["Owls", 3]], [["Owls", 4], ["Lions", 1], ["Hawks", 1]], [["Lions", 5], ["Hawks", 2], ["Owls", 2]]];
  for (const spec of cases) {
    let pos = 0; const ps = [].concat(...spec.map(([n, c]) => { const t = team(n[0], n, c, pos); pos += c; return t; }));
    const best = fewestSame(ps);
    sweep(ps, (d, why) => assert.equal(firstRoundSame(ps, d), best, `${JSON.stringify(spec)} ${why}`));
  }
});

test("pairUp: looks ahead instead of grabbing the first opponent (A, B, C, C)", () => {
  const ps = [{ id: "a", team: "Lions" }, { id: "b", team: "Hawks" }, { id: "c1", team: "Owls" }, { id: "c2", team: "Owls" }];
  const { pairs, rest } = R.pairUp(ps, true);
  assert.equal(rest.length, 0);
  for (const [x, y] of pairs) assert.ok(!R.sameTeam(x, y), `${x.id} v ${y.id}`);
});

test("team names that differ only in case or spaces are the same team", () => {
  assert.ok(R.sameTeam({ team: "Lions " }, { team: "lions" }));
  assert.ok(R.sameTeam({ team: " Lions  Club" }, { team: "lions club" }));
  // one real team written several ways: cross-team has nothing to cross, so everyone still plays
  const ps = [{ id: "a", name: "a", team: "Lions ", position: 0 }, { id: "b", name: "b", team: "lions", position: 1 }, { id: "c", name: "c", team: "LIONS", position: 2 }];
  assert.equal(R.roundRobin({ mode: "round_robin", crossTeam: true }, ps).length, 3);
  // mixed spellings across two real teams: teammates never meet
  const qs = [{ id: "l1", name: "l1", team: "Lions ", position: 0 }, { id: "l2", name: "l2", team: "lions", position: 1 }, { id: "h1", name: "h1", team: "Hawks", position: 2 }, { id: "h2", name: "h2", team: " hawks", position: 3 }];
  const rr = R.roundRobin({ mode: "round_robin", crossTeam: true }, qs);
  assert.equal(rr.length, 4);
  for (const m of rr) assert.ok(!mates(qs, m.aTp, m.bTp));
  sweep(qs, (d, why) => assert.equal(firstRoundSame(qs, d), 0, why));
  // standings: one entry per real team, and beating a differently-spelt teammate is not a team win
  const st = R.standings(qs, [done({ round: 0, slot: 0, aTp: "l1", bTp: "l2" }, "a"), done({ round: 0, slot: 1, aTp: "l1", bTp: "h1" }, "a")]);
  assert.equal(st.teams.length, 2);
  assert.equal(st.teams.reduce((t, x) => t + x.wins, 0), 1);
});

test("players without a team mix with team players and teammates still avoid each other", () => {
  const ps = team("L", "Lions", 4).concat(team("x", "", 3, 4), team("H", "Hawks", 1, 7));
  sweep(ps, (d, why) => assert.equal(firstRoundSame(ps, d), fewestSame(ps), why));
  const rr = R.roundRobin({ crossTeam: true }, ps);
  for (const m of rr) assert.ok(!mates(ps, m.aTp, m.bTp));
  assert.equal(rr.length, 28 - 6, "only the six Lions-v-Lions pairs are dropped");
});

test("cross-team is on unless it is explicitly turned off (null, undefined, strings)", () => {
  const ps = team("H", "Hawks", 2).concat(team("L", "Lions", 4, 2));
  for (let seed = 1; seed <= 20; seed++) for (const draw of ["random", "seeded"]) {
    const d = v => R.bracketDraw({ mode: "bracket", crossTeam: v, draw, seed }, ps);
    for (const v of [null, undefined, "true", "t", 1, "1"]) assert.deepEqual(d(v), d(true), `${String(v)} ${draw} ${seed}`);
    for (const v of ["false", "f", 0, "0"]) assert.deepEqual(d(v), d(false), `${String(v)} ${draw} ${seed}`);
  }
  assert.equal(firstRoundSame(ps, R.bracketDraw({ mode: "bracket", draw: "seeded", seed: 1 }, ps)), 0);
  assert.equal(R.roundRobin({ mode: "round_robin", crossTeam: null }, ps).length, 8);
  assert.equal(R.roundRobin({ mode: "round_robin", crossTeam: "false" }, ps).length, 15);
});

test("unbalanced draws are still repeatable from the seed", () => {
  const ps = team("L", "Lions", 5).concat(team("H", "Hawks", 3, 5), team("O", "Owls", 2, 8));
  for (let seed = 1; seed <= 10; seed++) assert.deepEqual(R.bracketDraw({ crossTeam: true, draw: "random", seed }, ps), R.bracketDraw({ crossTeam: true, draw: "random", seed }, ps.slice().reverse()));
});

// plays a tournament to the end with a fixed, arbitrary choice of winners
const winnerOf = m => (m.aTp.length + m.bTp.length + m.round + m.slot + m.aTp.charCodeAt(m.aTp.length - 1)) % 2 ? "a" : "b";
function playOut(t, ps, max = 200) {
  let played = [];
  for (let i = 0; i < max; i++) {
    const plan = R.tournamentPlan(t, ps, played), have = new Set(played.map(m => m.round + ":" + m.slot));
    const next = plan.desired.filter(d => !have.has(d.round + ":" + d.slot));
    if (plan.complete || !next.length || played.length >= max) return { plan, played };
    played = played.concat(next.map(d => done(d, winnerOf(d)))).slice(0, max);
  }
  return { plan: R.tournamentPlan(t, ps, played), played };
}

test("king of the hill: with 6 v 2, nobody ever plays a teammate", () => {
  for (const hawksFirst of [false, true]) {
    const ps = hawksFirst ? team("H", "Hawks", 2).concat(team("L", "Lions", 6, 2)) : team("L", "Lions", 6).concat(team("H", "Hawks", 2, 6));
    const { played } = playOut({ mode: "koth", crossTeam: true }, ps, 30);
    assert.equal(played.length, 30);
    for (const m of played) assert.ok(!mates(ps, m.aTp, m.bTp), `${m.aTp} v ${m.bTp}`);
  }
});

test("king of the hill: once a player from another team joins late, teammates stop meeting", () => {
  const ps = team("L", "Lions", 3);
  const t = { mode: "koth", crossTeam: true };
  let plan = R.kothPlan(t, ps, []);
  const played = [done(plan.matches[0], "a")];
  plan = R.kothPlan(t, ps, played);
  const late = { id: "H0", name: "H0", team: "hawks ", position: 9, joinedRound: plan.nextRound };
  const ps2 = ps.concat(late);
  const after = R.kothPlan(t, ps2, played);
  assert.deepEqual(after.matches, plan.matches, "the played and the already-called match are unchanged");
  let all = played.concat(done(after.matches[1], "a"));
  const next = R.kothPlan(t, ps2, all).matches[2];
  assert.ok(next.aTp === "H0" || next.bTp === "H0", "the Hawks joiner plays next");
  for (let i = 0; i < 12; i++) { const p = R.kothPlan(t, ps2, all), m = p.matches[p.matches.length - 1]; all = all.concat(done(m, winnerOf(m))); }
  for (const m of all.slice(2)) assert.ok(!mates(ps2, m.aTp, m.bTp), `${m.aTp} v ${m.bTp}`);
});

test("tournaments run to the end with 2, 3, 5, 7, 9 and 16 players", () => {
  for (const n of [2, 3, 5, 7, 9, 16]) {
    const solo = team("p", "", n), split = team("L", "Lions", Math.ceil(n / 2)).concat(team("H", "Hawks", Math.floor(n / 2), Math.ceil(n / 2)));
    for (const ps of [solo, split]) for (const draw of ["random", "seeded"]) {
      const b = playOut({ mode: "bracket", crossTeam: true, draw, seed: n }, ps);
      assert.ok(b.plan.complete && b.plan.champion, `bracket ${n} ${draw}`);
      assert.equal(b.played.length, n - 1, `bracket ${n}: everyone but the champion loses once`);
    }
    const rr = playOut({ mode: "round_robin", crossTeam: true }, solo);
    assert.equal(rr.played.length, n * (n - 1) / 2); assert.ok(rr.plan.complete && rr.plan.champion);
    const rx = playOut({ mode: "round_robin", crossTeam: true }, split);
    assert.equal(rx.played.length, Math.ceil(n / 2) * Math.floor(n / 2)); assert.ok(rx.plan.complete);
    for (const m of rx.played) assert.ok(!mates(split, m.aTp, m.bTp));
    const k = playOut({ mode: "koth", crossTeam: true }, split, 10);
    assert.equal(k.played.length, 10, `koth ${n}`);
    for (const m of k.played) assert.ok(!mates(split, m.aTp, m.bTp), `koth ${n}: ${m.aTp} v ${m.bTp}`);
  }
});
