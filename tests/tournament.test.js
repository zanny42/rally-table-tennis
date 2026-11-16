const test = require("node:test");
const assert = require("node:assert/strict");
const R = require("../www/rules.js");

const team = (prefix, teamName, n, start = 0) => Array.from({ length: n }, (_, i) => ({ id: prefix + i, name: prefix + i, team: teamName, position: start + i }));
// a finished match won by side w ("a" or "b") in a 1-game format
const done = (d, w) => Object.assign({}, d, { games: [w === "a" ? "0".repeat(11) : "1".repeat(11)], bestOf: 1, target: 11, status: "done" });
const P = ps => id => ps.find(p => p.id === id);

test("bracket: every first-round match is UOGM v Curtin when teams are balanced", () => {
  const ps = team("U", "UOGM", 4).concat(team("C", "Curtin", 4, 4));
  for (const draw of ["random", "seeded"]) for (let seed = 1; seed <= 25; seed++) {
    const d = R.bracketDraw({ mode: "bracket", crossTeam: true, draw, seed }, ps);
    assert.equal(d.size, 8);
    for (const [a, b] of d.slots) assert.notEqual(P(ps)(a).team, P(ps)(b).team, `${draw} seed ${seed}`);
  }
});

test("bracket: without cross-team, teammates can meet", () => {
  const ps = team("U", "UOGM", 4).concat(team("C", "Curtin", 4, 4));
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
  const ps = team("U", "UOGM", 3).concat(team("C", "Curtin", 4, 3));
  const ms = R.roundRobin({ mode: "round_robin", crossTeam: true }, ps);
  assert.equal(ms.length, 12);
  for (const m of ms) assert.notEqual(P(ps)(m.aTp).team, P(ps)(m.bTp).team);
});

test("king of the hill: winner stays on, loser queues, challengers come from the other team", () => {
  const ps = [{ id: "U1", name: "U1", team: "UOGM", position: 0 }, { id: "U2", name: "U2", team: "UOGM", position: 1 }, { id: "C1", name: "C1", team: "Curtin", position: 2 }, { id: "C2", name: "C2", team: "Curtin", position: 3 }];
  const t = { mode: "koth", crossTeam: true };
  let plan = R.kothPlan(t, ps, []);
  assert.deepEqual([plan.matches[0].aTp, plan.matches[0].bTp], ["U1", "C1"], "first challenger is from the other team");
  let played = [done(plan.matches[0], "a")];
  plan = R.kothPlan(t, ps, played);
  assert.deepEqual([plan.matches[1].aTp, plan.matches[1].bTp], ["U1", "C2"]);
  played.push(done(plan.matches[1], "a"));
  plan = R.kothPlan(t, ps, played);
  assert.equal(plan.streaks.get("U1").cur, 2);
  assert.deepEqual([plan.matches[2].aTp, plan.matches[2].bTp], ["U1", "C1"], "C1 is the next Curtin player in the queue");
  played.push(done(plan.matches[2], "b"));
  plan = R.kothPlan(t, ps, played);
  assert.equal(plan.champion, "C1");
  assert.equal(plan.streaks.get("U1").best, 2);
  assert.equal(plan.matches[3].aTp, "C1");
  assert.equal(P(ps)(plan.matches[3].bTp).team, "UOGM");
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
  const ps = team("U", "UOGM", 2).concat(team("C", "Curtin", 2, 2));
  const ms = R.roundRobin({ crossTeam: true }, ps).map((m, i) => done(m, i % 3 ? "a" : "b"));
  const s = R.standings(ps, ms);
  assert.equal(s.players.length, 4);
  assert.ok(s.players[0].w >= s.players[3].w);
  assert.equal(s.teams.reduce((t, x) => t + x.wins, 0), ms.length);
});
