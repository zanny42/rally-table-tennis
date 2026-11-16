/* Rally scoring rules and ladder maths. Shared by the app (window.RallyRules) and the tests (require). */
(function (root) {
  "use strict";
  const keyOf = n => String(n).trim().toLowerCase().replace(/\s+/g, " ");

  function gameScore(seq) { let a = 0, b = 0; for (const w of seq) { if (w) b++; else a++; } return [a, b]; }
  function gameOver(a, b, t) { return (a >= t || b >= t) && Math.abs(a - b) >= 2; }

  /* Server for point n (0-based) of game g. Serve changes every 2 points (every 5 in 21-point games),
     then every point from deuce. The first server alternates each game. */
  function serverAt(m, g, n) {
    const base = m.firstServer ^ (g % 2), per = m.target === 21 ? 5 : 2, ds = 2 * (m.target - 1);
    const k = n < ds ? Math.floor(n / per) : Math.floor(ds / per) + (n - ds);
    return base ^ (k % 2);
  }

  function summarize(m) {
    const need = Math.ceil(m.bestOf / 2), gw = [0, 0];
    for (const seq of m.games) { const [a, b] = gameScore(seq); if (gameOver(a, b, m.target)) gw[a > b ? 0 : 1]++; }
    const g = m.games.length - 1, cur = gameScore(m.games[g]);
    const over = gw[0] >= need || gw[1] >= need;
    return { need, gw, g, cur, over, winner: over ? (gw[0] > gw[1] ? 0 : 1) : null };
  }

  /* Number of times the players have changed ends: after every game, plus once in the deciding game
     when a player first reaches 5 (10 in 21-point games). m.flip is a manual on-screen swap. */
  function switchCount(m, s) {
    const half = m.target === 21 ? 10 : 5;
    const decider = s.g === m.bestOf - 1 && Math.max(s.cur[0], s.cur[1]) >= half;
    return s.g + (decider ? 1 : 0) + (m.flip || 0);
  }

  function stats(m) {
    const r = { pts: [0, 0], srvWon: [0, 0], srvTot: [0, 0], run: [0, 0], series: [] };
    let rp = -1, rl = 0;
    m.games.forEach((seq, g) => {
      if (!seq.length) return;
      let lead = 0; const s = [0];
      seq.forEach((w, n) => {
        const sv = serverAt(m, g, n); r.srvTot[sv]++; if (w === sv) r.srvWon[sv]++;
        r.pts[w]++; lead += w ? -1 : 1; s.push(lead);
        if (w === rp) rl++; else { rp = w; rl = 1; }
        if (rl > r.run[w]) r.run[w] = rl;
      });
      r.series.push(s);
    });
    return r;
  }

  const fromRecord = r => ({ a: r.a, b: r.b, bestOf: r.bestOf, target: r.target, firstServer: r.firstServer, games: (r.g || []).map(s => [...s].map(Number)) });

  /* Elo ladder replayed from every match in time order. Start 1000, K=40 for a player's first 10 matches, then 24. */
  function computeBoard(list) {
    const P = new Map();
    const get = (k, name) => { if (!P.has(k)) P.set(k, { key: k, name, r: 1000, w: 0, l: 0, hist: [1000], res: [], opp: new Map(), lastDelta: 0 }); const p = P.get(k); p.name = name; return p; };
    const deltas = new Map();
    for (const m of list) {
      const A = get(m.aKey, m.a), B = get(m.bKey, m.b);
      const ea = 1 / (1 + Math.pow(10, (B.r - A.r) / 400)), sa = m.winner === 0 ? 1 : 0;
      const kA = A.w + A.l < 10 ? 40 : 24, kB = B.w + B.l < 10 ? 40 : 24;
      const dA = Math.round(kA * (sa - ea)), dB = Math.round(kB * ((1 - sa) - (1 - ea)));
      A.r += dA; B.r += dB; A.hist.push(A.r); B.hist.push(B.r);
      deltas.set(m.id, [dA, dB]);
      const W = sa ? A : B, L = sa ? B : A; W.w++; L.l++; W.res.push(1); L.res.push(0);
      for (const [me, op, won] of [[A, B, sa], [B, A, 1 - sa]]) { const o = me.opp.get(op.key) || { name: op.name, w: 0, l: 0 }; o.name = op.name; won ? o.w++ : o.l++; me.opp.set(op.key, o); }
      A.lastDelta = dA; B.lastDelta = dB;
    }
    const players = [...P.values()].sort((x, y) => y.r - x.r || y.w - x.w);
    players.forEach((p, i) => p.rank = i + 1);
    return { players, deltas, byKey: P };
  }

  function streakOf(res) { if (!res.length) return null; const v = res[res.length - 1]; let n = 0; for (let i = res.length - 1; i >= 0 && res[i] === v; i--) n++; return { win: !!v, n }; }

  /* A saved record must be internally consistent before it reaches the shared ladder. */
  function validRecord(r) {
    try {
      if (!r || typeof r.a !== "string" || typeof r.b !== "string" || !r.a.trim() || !r.b.trim()) return false;
      if (r.aKey !== keyOf(r.a) || r.bKey !== keyOf(r.b) || r.aKey === r.bKey) return false;
      if (![1, 3, 5, 7].includes(r.bestOf) || ![11, 21].includes(r.target) || ![0, 1].includes(r.firstServer)) return false;
      if (!Array.isArray(r.g) || !r.g.every(s => typeof s === "string" && /^[01]+$/.test(s))) return false;
      const s = summarize(fromRecord(r));
      return s.over && s.winner === r.winner && s.gw[0] === r.gw[0] && s.gw[1] === r.gw[1] && typeof r.endedAt === "number";
    } catch (e) { return false; }
  }

  /* Live matches store each game as a string of point winners ("0" or "1"), with an empty string
     for a game not started yet. These mirror the score_point / undo_point database functions. */
  const toMatch = (games, bestOf, target, firstServer) => ({ bestOf, target, firstServer: firstServer || 0, games: (games.length ? games : [""]).map(s => [...s].map(Number)) });

  function applyPoint(games, p, bestOf, target) {
    const g = games.length ? games.slice() : [""];
    g[g.length - 1] += String(p);
    const s = summarize(toMatch(g, bestOf, target));
    if (s.over) return { games: g, done: true };
    const [a, b] = gameScore([...g[g.length - 1]].map(Number));
    if (gameOver(a, b, target)) g.push("");
    return { games: g, done: false };
  }

  function undoPoint(games) {
    const g = games.length ? games.slice() : [""];
    if (g.length > 1 && g[g.length - 1] === "") g.pop();
    if (g[g.length - 1] === "") return g;
    g[g.length - 1] = g[g.length - 1].slice(0, -1);
    return g;
  }

  const initials = n => String(n || "?").trim().split(/\s+/).map(w => w[0] || "").slice(0, 2).join("").toUpperCase() || "?";

  /* ---------- Tournaments ----------
     t: {mode: "koth"|"round_robin"|"bracket", crossTeam, draw: "random"|"seeded", seed, status}
     players: [{id, name, team, position, joinedRound}]
     matches: [{round, slot, aTp, bTp, games, bestOf, target, status}]
     Every function is deterministic, so any phone can work out the same next matches. */
  function prng(seed) { let s = (seed >>> 0) || 0x9e3779b9; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function shuffled(list, seed) { const a = list.slice(), r = prng(seed); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
  const byPos = (x, y) => (x.position || 0) - (y.position || 0) || String(x.id).localeCompare(String(y.id));
  const teamsOf = ps => [...new Set(ps.map(p => (p.team || "").trim()).filter(Boolean))];
  const crossOn = (t, ps) => !!t.crossTeam && teamsOf(ps).length >= 2;
  const sameTeam = (a, b) => !!a && !!b && !!(a.team || "").trim() && (a.team || "").trim().toLowerCase() === (b.team || "").trim().toLowerCase();

  /* Pairs players in order; with cross-team on, each player takes the first opponent from another team. */
  function pairUp(list, cross) {
    const left = list.slice(), pairs = [];
    while (left.length > 1) {
      const p = left.shift();
      let j = cross ? left.findIndex(q => !sameTeam(p, q)) : -1;
      if (j < 0) j = 0;
      pairs.push([p, left.splice(j, 1)[0]]);
    }
    return { pairs, rest: left };
  }
  function matchWinnerTp(m) {
    if (!m || m.status !== "done") return null;
    const s = summarize(toMatch(m.games || [""], m.bestOf, m.target));
    return s.over ? (s.winner === 0 ? m.aTp : m.bTp) : null;
  }

  /* Everyone plays everyone, arranged in rounds (circle method). Cross-team keeps only matches between teams. */
  function roundRobin(t, players) {
    const ps = players.slice().sort(byPos), cross = crossOn(t, ps), list = ps.slice(), out = [];
    if (list.length < 2) return out;
    if (list.length % 2) list.push(null);
    const n = list.length;
    for (let r = 0; r < n - 1; r++) {
      let slot = 0;
      for (let i = 0; i < n / 2; i++) {
        const a = list[i], b = list[n - 1 - i];
        if (a && b && (!cross || !sameTeam(a, b))) out.push({ round: r, slot: slot++, aTp: a.id, bTp: b.id });
      }
      list.splice(1, 0, list.pop());
    }
    return out;
  }

  const bitrev = (i, bits) => { let r = 0; for (let b = 0; b < bits; b++) { r = (r << 1) | (i & 1); i >>= 1; } return r; };
  /* Single-elimination draw. Top seeds (or the first drawn when random) get byes; first-round pairs prefer opposite teams. */
  function bracketDraw(t, players) {
    let ps = players.slice().sort(byPos);
    if (t.draw === "random") ps = shuffled(ps, t.seed);
    const n = ps.length;
    if (n < 2) return { size: n, rounds: 0, slots: [] };
    let size = 1; while (size < n) size *= 2;
    const byes = size - n, byePlayers = ps.slice(0, byes);
    let rest = ps.slice(byes);
    if (t.draw !== "random") { const o = []; for (let i = 0, j = rest.length - 1; i <= j; i++, j--) { o.push(rest[i]); if (i !== j) o.push(rest[j]); } rest = o; }
    const { pairs } = pairUp(rest, crossOn(t, ps));
    const items = byePlayers.map(p => [p.id, null]).concat(pairs.map(([a, b]) => [a.id, b.id]));
    const m = size / 2, bits = Math.round(Math.log2(m)), slots = new Array(m);
    items.forEach((it, i) => { slots[bitrev(i, bits)] = it; });
    return { size, rounds: Math.round(Math.log2(size)), slots };
  }
  function bracketPlan(t, players, matches) {
    const d = bracketDraw(t, players), byKey = new Map(matches.map(m => [m.round + ":" + m.slot, m]));
    const out = [], tree = [];
    let prev = d.slots.map(s => ({ a: s[0], b: s[1] })), champion = null;
    for (let r = 0; r < d.rounds; r++) {
      const winners = [], row = [];
      prev.forEach((s, k) => {
        let w = null, bye = false;
        if (r === 0 && s.a && !s.b) { w = s.a; bye = true; }
        else if (s.a && s.b) {
          out.push({ round: r, slot: k, aTp: s.a, bTp: s.b });
          const m = byKey.get(r + ":" + k);
          if (m && m.aTp === s.a && m.bTp === s.b) w = matchWinnerTp(m);
        }
        row.push({ round: r, slot: k, aTp: s.a || null, bTp: s.b || null, winner: w, bye });
        winners.push(w);
      });
      tree.push(row);
      if (r === d.rounds - 1) champion = winners[0] || null;
      prev = [];
      for (let k = 0; k < winners.length; k += 2) prev.push({ a: winners[k], b: winners[k + 1] });
    }
    return { matches: out, champion, tree, size: d.size };
  }

  /* King of the hill: the winner stays on. Losers go to the back of the queue; with cross-team on,
     the next challenger is the first in the queue from another team. Late joiners enter the queue
     at the round they joined. */
  function kothPlan(t, players, matches) {
    const ps = players.slice().sort(byPos), cross = crossOn(t, ps), byRound = new Map(matches.map(m => [m.round, m]));
    const P = id => ps.find(p => p.id === id);
    const queue = ps.filter(p => !p.joinedRound).map(p => p.id);
    const st = new Map(ps.map(p => [p.id, { w: 0, l: 0, best: 0, cur: 0 }]));
    const out = [];
    let champ = queue.shift() || null, k = 0, open = false;
    for (;;) {
      if (k > 0) ps.filter(p => (p.joinedRound || 0) === k).forEach(p => queue.push(p.id));
      if (!champ || !queue.length) break;
      const m = byRound.get(k);
      if (t.status === "done" && !(m && m.status === "done")) break;
      let j = cross ? queue.findIndex(id => !sameTeam(P(id), P(champ))) : -1;
      if (j < 0) j = 0;
      const ch = queue.splice(j, 1)[0];
      out.push({ round: k, slot: 0, aTp: champ, bTp: ch });
      const w = m && m.aTp === champ && m.bTp === ch ? matchWinnerTp(m) : null;
      if (!w) { open = true; queue.unshift(ch); break; }
      const lo = w === champ ? ch : champ, sw = st.get(w), sl = st.get(lo);
      sw.w++; sl.l++; sl.cur = 0;
      sw.cur = w === champ ? sw.cur + 1 : 1; sw.best = Math.max(sw.best, sw.cur);
      queue.push(lo); champ = w; k++;
    }
    ps.filter(p => (p.joinedRound || 0) > k).forEach(p => queue.push(p.id));
    return { matches: out, champion: champ, streaks: st, queue, nextRound: out.length };
  }

  function standings(players, matches) {
    const row = new Map(players.map(p => [p.id, { id: p.id, name: p.name, team: p.team || "", p: 0, w: 0, l: 0, gw: 0, gl: 0, pf: 0, pa: 0 }]));
    const teams = new Map();
    for (const m of matches) {
      const win = matchWinnerTp(m); if (!win) continue;
      const A = row.get(m.aTp), B = row.get(m.bTp); if (!A || !B) continue;
      const s = summarize(toMatch(m.games, m.bestOf, m.target));
      let pa = 0, pb = 0; for (const g of m.games) for (const c of g) c === "0" ? pa++ : pb++;
      A.p++; B.p++; A.gw += s.gw[0]; A.gl += s.gw[1]; B.gw += s.gw[1]; B.gl += s.gw[0]; A.pf += pa; A.pa += pb; B.pf += pb; B.pa += pa;
      const W = win === m.aTp ? A : B, L = W === A ? B : A; W.w++; L.l++;
      if (W.team && L.team && W.team !== L.team) teams.set(W.team, (teams.get(W.team) || 0) + 1);
    }
    const list = [...row.values()].sort((x, y) => y.w - x.w || (y.gw - y.gl) - (x.gw - x.gl) || (y.pf - y.pa) - (x.pf - x.pa) || x.name.localeCompare(y.name));
    const tnames = teamsOf(players);
    return { players: list, teams: tnames.map(n => ({ team: n, wins: teams.get(n) || 0 })).sort((a, b) => b.wins - a.wins) };
  }

  /* What should exist now: the matches to create, and whether the tournament is finished. */
  function tournamentPlan(t, players, matches) {
    if (t.mode === "round_robin") {
      const desired = roundRobin(t, players), byKey = new Map(matches.map(m => [m.round + ":" + m.slot, m]));
      const complete = desired.length > 0 && desired.every(d => matchWinnerTp(byKey.get(d.round + ":" + d.slot)));
      return { desired, complete, champion: complete ? standings(players, matches).players[0].id : null };
    }
    if (t.mode === "bracket") { const b = bracketPlan(t, players, matches); return { desired: b.matches, complete: !!b.champion, champion: b.champion, tree: b.tree }; }
    const k = kothPlan(t, players, matches);
    return { desired: k.matches, complete: t.status === "done", champion: k.champion, koth: k };
  }

  const api = { keyOf, gameScore, gameOver, serverAt, summarize, switchCount, stats, fromRecord, computeBoard, streakOf, validRecord, toMatch, applyPoint, undoPoint, initials,
    prng, shuffled, pairUp, sameTeam, roundRobin, bracketDraw, bracketPlan, kothPlan, standings, tournamentPlan, matchWinnerTp };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RallyRules = api;
})(typeof window !== "undefined" ? window : globalThis);
