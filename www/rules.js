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

  const api = { keyOf, gameScore, gameOver, serverAt, summarize, switchCount, stats, fromRecord, computeBoard, streakOf, validRecord };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RallyRules = api;
})(typeof window !== "undefined" ? window : globalThis);
