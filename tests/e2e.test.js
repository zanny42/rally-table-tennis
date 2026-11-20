// QA end-to-end suite: drives the real index.html + rules.js + app.js in jsdom the way a person would,
// against a shared in-memory fake of the Supabase backend (tables, RLS-ish permissions, RPCs and realtime
// broadcast to every connected "phone"). Each window gets a fake clock so timers and intervals are controlled.
// Tests that fail here are bugs (or missing behaviour) found by QA; they are real assertions, not skips.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const www = path.join(__dirname, "..", "www");
const read = f => fs.readFileSync(path.join(www, f), "utf8");
const HTML = read("index.html").replace(/<script src="[^"]+"><\/script>/g, "");
const RULES = read("rules.js");
const APP = read("app.js");
const JSPDF = fs.existsSync(path.join(www, "vendor", "jspdf.js")) ? read("vendor/jspdf.js") : null;
const AUTOTABLE = fs.existsSync(path.join(www, "vendor", "jspdf-autotable.js")) ? read("vendor/jspdf-autotable.js") : null;

/* ---------------- error capture ---------------- */
const ERR = [];
process.on("unhandledRejection", e => ERR.push("unhandled rejection: " + (e && e.stack || e)));
const windows = [], clocks = [], clients = [];
test.beforeEach(() => { ERR.length = 0; });
test.afterEach(() => {
  clients.splice(0).forEach(c => { c.dead = true; });
  clocks.length = 0;
  while (windows.length) { try { windows.pop().close(); } catch (e) {} }
});

/* ---------------- independent scoring helpers (not from rules.js) ---------------- */
const ptsOf = s => { let a = 0, b = 0; for (const c of s || "") c === "0" ? a++ : b++; return [a, b]; };
const gameOver = (s, t) => { const [a, b] = ptsOf(s); return Math.max(a, b) >= t && Math.abs(a - b) >= 2; };
const gamesWon = (games, t) => { const gw = [0, 0]; for (const g of games) if (g && gameOver(g, t)) { const [a, b] = ptsOf(g); gw[a > b ? 0 : 1]++; } return gw; };
const winnerSide = m => { const gw = gamesWon(m.games, m.target); return gw[0] > gw[1] ? 0 : 1; };
const winnerTp = m => winnerSide(m) ? m.b_tp : m.a_tp;
const loserTp = m => winnerSide(m) ? m.a_tp : m.b_tp;
function eloRef(list) { // [aName, bName, winnerSide] in time order; start 1000, K=40 for first 10 then 24
  const P = new Map(), g = n => { if (!P.has(n)) P.set(n, { r: 1000, n: 0, w: 0, l: 0 }); return P.get(n); };
  for (const [a, b, w] of list) {
    const A = g(a), B = g(b), ea = 1 / (1 + Math.pow(10, (B.r - A.r) / 400)), sa = w === 0 ? 1 : 0;
    const kA = A.n < 10 ? 40 : 24, kB = B.n < 10 ? 40 : 24;
    A.r += Math.round(kA * (sa - ea)); B.r += Math.round(kB * ((1 - sa) - (1 - ea)));
    A.n++; B.n++; (sa ? A : B).w++; (sa ? B : A).l++;
  }
  return P;
}

/* ---------------- fake Supabase backend shared by every phone ---------------- */
let seq = 0;
const uuid = () => "00000000-0000-4000-8000-" + (++seq).toString(16).padStart(12, "0");
const clone = x => x == null ? x : JSON.parse(JSON.stringify(x));
function makeBackend() {
  const db = { profiles: [], live_matches: [], matches: [], tournaments: [], tournament_players: [], match_keepers: [], tournament_keepers: [] };
  const users = new Map(), subs = [], rpcLog = [];
  let code = 4820;
  const B = { db, users, rpcLog, rpcHook: null, confirmEmail: false };
  B.addUser = (id, name, email) => { users.set(email, { id, email, password: "secret12" }); db.profiles.push({ id, name }); return { id, email }; };
  const emit = (table, eventType, row, old) => {
    const payload = { schema: "public", table, eventType, new: eventType === "DELETE" ? {} : clone(row), old: old ? clone(old) : {}, commit_timestamp: new Date().toISOString() };
    for (const s of subs.slice()) if (s.table === table && !s.client.dead && !s.dead) setImmediate(() => {
      if (s.client.dead || s.dead) return;
      try { s.h(clone(payload)); } catch (e) { ERR.push("realtime handler threw: " + (e && e.stack || e)); }
    });
  };
  B.emit = emit;
  const isTKeeper = (uid, tid) => !!uid && (db.tournaments.some(t => t.id === tid && t.owner === uid) || db.tournament_keepers.some(k => k.tournament_id === tid && k.user_id === uid));
  const canScore = (uid, m) => !!uid && (m.owner === uid || m.keepers === "club" || (m.keepers === "players" && (m.a_user === uid || m.b_user === uid))
    || (m.keepers === "tournament" && m.tournament_id && isTKeeper(uid, m.tournament_id)) || db.match_keepers.some(k => k.match_id === m.id && k.user_id === uid));
  B.isTKeeper = isTKeeper;
  const publish = m => {
    const gw = gamesWon(m.games, m.target), t = m.tournament_id ? db.tournaments.find(x => x.id === m.tournament_id) : null;
    const k = n => n.trim().toLowerCase().replace(/\s+/g, " "), dbl = m.kind === "doubles";
    const pk = (x, y) => [k(x), k(y)].sort().join(" & ");
    const data = { a: dbl ? m.a_name.trim() + " & " + m.a2_name.trim() : m.a_name.trim(), b: dbl ? m.b_name.trim() + " & " + m.b2_name.trim() : m.b_name.trim(),
      aKey: dbl ? pk(m.a_name, m.a2_name) : k(m.a_name), bKey: dbl ? pk(m.b_name, m.b2_name) : k(m.b_name),
      bestOf: m.best_of, target: m.target, firstServer: m.first_server, g: m.games.filter(x => x !== ""), winner: gw[0] > gw[1] ? 0 : 1, gw,
      startedAt: Date.parse(m.started_at), endedAt: Date.parse(m.ended_at || new Date().toISOString()) };
    if (t) { data.tournament = t.name; data.tournamentId = t.id; }
    if (dbl) Object.assign(data, { kind: "doubles", ap: [m.a_name.trim(), m.a2_name.trim()], bp: [m.b_name.trim(), m.b2_name.trim()], picks: clone(m.picks || []) });
    db.matches = db.matches.filter(x => x.id !== m.id);
    db.matches.push({ id: m.id, data, ended_at: data.endedAt, by: m.owner });
  };
  const defaults = {
    live_matches: uid => ({ id: uuid(), owner: uid, games: [""], status: "live", version: 0, join_code: String(code++), started_at: new Date().toISOString(), updated_at: new Date().toISOString(), ended_at: null, tournament_id: null, round: null, slot: null, a_tp: null, b_tp: null, a_user: null, b_user: null, keepers: "players", first_server: 0, target: 11, best_of: 3, kind: "singles", a2_name: null, b2_name: null, picks: [] }),
    tournaments: uid => ({ id: uuid(), owner: uid, seed: 987654321, join_code: String(code++), status: "live", champion: null, created_at: new Date().toISOString(), ended_at: null, cross_team: false, draw: "random", best_of: 1, target: 11 }),
    tournament_players: () => ({ id: uuid(), joined_round: 0, user_id: null, team: "", position: 0 }),
    profiles: () => ({}), matches: () => ({}), match_keepers: () => ({}), tournament_keepers: () => ({})
  };
  const insertCheck = (table, row, uid) => {
    if (!uid) return { code: "42501", message: "new row violates row-level security policy" };
    if (table === "live_matches") {
      if (row.owner !== uid || row.status !== "live" || row.version !== 0) return { code: "42501", message: "rls" };
      if (row.tournament_id) {
        if (row.keepers !== "tournament" || !isTKeeper(uid, row.tournament_id)) return { code: "42501", message: "rls: not a tournament keeper" };
        const tp = db.tournament_players.filter(p => p.tournament_id === row.tournament_id && (p.id === row.a_tp || p.id === row.b_tp));
        if (!row.a_tp || !row.b_tp || row.a_tp === row.b_tp || tp.length !== 2) return { code: "42501", message: "rls: tp_ok" };
        if (db.live_matches.some(r => r.tournament_id === row.tournament_id && r.round === row.round && r.slot === row.slot)) return { code: "23505", message: "duplicate key value violates unique constraint live_matches_tslot" };
      }
    }
    if (table === "tournaments" && row.owner !== uid) return { code: "42501", message: "rls" };
    if (table === "tournament_players" && !isTKeeper(uid, row.tournament_id)) return { code: "42501", message: "rls: keepers manage players" };
    return null;
  };
  const mayUpdate = (table, r, uid) => !!uid && (table === "tournaments" ? isTKeeper(uid, r.id) : table === "profiles" ? r.id === uid : table === "tournament_players" ? isTKeeper(uid, r.tournament_id) : false);
  const mayDelete = (table, r, uid) => !!uid && (table === "live_matches" ? (r.owner === uid || (r.tournament_id && r.games.join("") === "" && isTKeeper(uid, r.tournament_id)))
    : table === "matches" ? r.by === uid : table === "tournaments" ? r.owner === uid : table === "tournament_players" ? isTKeeper(uid, r.tournament_id) : false);
  const removeRows = (table, pred) => {
    const gone = db[table].filter(pred); db[table] = db[table].filter(r => !pred(r));
    for (const r of gone) {
      emit(table, "DELETE", null, { id: r.id }); // default replica identity: only the primary key in old
      if (table === "tournaments") { removeRows("live_matches", m => m.tournament_id === r.id); removeRows("tournament_players", p => p.tournament_id === r.id); db.tournament_keepers = db.tournament_keepers.filter(k => k.tournament_id !== r.id); }
      if (table === "tournament_players") removeRows("live_matches", m => m.a_tp === r.id || m.b_tp === r.id);
      if (table === "live_matches") db.match_keepers = db.match_keepers.filter(k => k.match_id !== r.id);
    }
    return gone;
  };
  B.client = (o = {}) => {
    let session = o.as ? { user: { id: o.as.id, email: o.as.email }, access_token: "t" } : null, authCb = null;
    const uid = () => session && session.user.id;
    const client = { dead: false, calls: [] };
    const from = table => {
      const st = { table, op: "select", filters: [], orders: [], lim: null, payload: null, single: null, selected: false };
      const q = {
        select() { if (st.op !== "select") st.selected = true; return q; },
        order(c, opt) { st.orders.push([c, !opt || opt.ascending !== false]); return q; }, limit(n) { st.lim = n; return q; },
        eq(c, v) { st.filters.push(r => r[c] === v); return q; }, neq(c, v) { st.filters.push(r => r[c] !== v); return q; },
        in(c, v) { st.filters.push(r => v.includes(r[c])); return q; }, is(c, v) { st.filters.push(r => r[c] === v); return q; },
        gt(c, v) { st.filters.push(r => r[c] > v); return q; }, lt(c, v) { st.filters.push(r => r[c] < v); return q; },
        insert(p) { st.op = "insert"; st.payload = p; return q; }, upsert(p) { st.op = "upsert"; st.payload = p; return q; },
        update(p) { st.op = "update"; st.payload = p; return q; }, delete() { st.op = "delete"; return q; },
        single() { st.single = "single"; return q; }, maybeSingle() { st.single = "maybe"; return q; },
        then(res, rej) { return new Promise(r => setImmediate(r)).then(() => exec()).then(res, rej); }
      };
      const exec = () => {
        client.calls.push({ table, op: st.op, payload: clone(st.payload) });
        const me = uid(), match = r => st.filters.every(f => f(r));
        let data = null;
        if (st.op === "select") {
          if (!me && table !== "matches") data = [];
          else data = db[table].filter(match).map(clone);
          for (const [c, asc] of st.orders.slice().reverse()) data.sort((x, y) => (x[c] > y[c] ? 1 : x[c] < y[c] ? -1 : 0) * (asc ? 1 : -1));
          if (st.lim != null) data = data.slice(0, st.lim);
        } else if (st.op === "insert" || st.op === "upsert") {
          const rows = [].concat(st.payload).map(p => Object.assign(defaults[table](me), clone(p)));
          for (const r of rows) {
            if (st.op === "upsert" && db[table].some(x => x.id === r.id)) continue;
            const e = insertCheck(table, r, me); if (e) return { data: null, error: e };
          }
          for (const r of rows) {
            const ex = st.op === "upsert" && db[table].find(x => x.id === r.id);
            if (ex) { Object.assign(ex, r); emit(table, "UPDATE", ex, { id: ex.id }); } else { db[table].push(r); emit(table, "INSERT", r); }
          }
          data = st.selected ? rows.map(clone) : null;
        } else if (st.op === "update") {
          const rows = db[table].filter(r => match(r) && mayUpdate(table, r, me));
          rows.forEach(r => { Object.assign(r, clone(st.payload)); emit(table, "UPDATE", r, { id: r.id }); });
          data = st.selected ? rows.map(clone) : null;
        } else if (st.op === "delete") {
          const gone = removeRows(table, r => match(r) && mayDelete(table, r, me));
          data = st.selected ? gone.map(clone) : null;
        }
        if (st.single && Array.isArray(data)) {
          if (data.length === 1) data = data[0];
          else if (st.single === "maybe" && data.length === 0) data = null;
          else return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        }
        return { data, error: null };
      };
      return q;
    };
    const rpc = async (fn, args) => {
      await new Promise(r => setImmediate(r));
      const me = uid(); rpcLog.push({ fn, args: clone(args), by: me }); client.calls.push({ rpc: fn, args: clone(args) });
      if (B.rpcHook) { const r = B.rpcHook(fn, args, me); if (r) return r; }
      if (fn === "score_point" || fn === "undo_point") {
        const m = db.live_matches.find(r => r.id === args.p_id);
        if (!m) return { data: null, error: { code: "P0001", message: "match not found" } };
        if (!canScore(me, m)) return { data: null, error: { code: "42501", message: "not allowed to score this match" } };
        if (fn === "score_point") {
          if (m.status !== "live") return { data: clone(m), error: null };
          const g = m.games.slice(); g[g.length - 1] += String(args.p_player);
          const gw = gamesWon(g, m.target), need = (m.best_of + 1) / 2;
          if (gw[0] >= need || gw[1] >= need) { Object.assign(m, { games: g, status: "done", ended_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: m.version + 1 }); publish(m); }
          else { if (gameOver(g[g.length - 1], m.target)) g.push(""); Object.assign(m, { games: g, updated_at: new Date().toISOString(), version: m.version + 1 }); }
        } else {
          let g = m.games.slice();
          if (g.length > 1 && g[g.length - 1] === "") g = g.slice(0, -1);
          if (g[g.length - 1] === "") return { data: clone(m), error: null };
          g[g.length - 1] = g[g.length - 1].slice(0, -1);
          if (m.status === "done") db.matches = db.matches.filter(x => x.id !== m.id);
          Object.assign(m, { games: g, status: "live", ended_at: null, updated_at: new Date().toISOString(), version: m.version + 1 });
        }
        emit("live_matches", "UPDATE", m, { id: m.id });
        return { data: clone(m), error: null };
      }
      if (fn === "set_pick") {
        const m = db.live_matches.find(r => r.id === args.p_id);
        if (!m) return { data: null, error: { code: "P0001", message: "match not found" } };
        if (!canScore(me, m)) return { data: null, error: { code: "42501", message: "not allowed to score this match" } };
        if (m.kind !== "doubles" || m.status !== "live") return { data: null, error: { code: "P0001", message: "not a live doubles match" } };
        if (args.p_game !== m.games.length - 1 || m.games[m.games.length - 1] !== "") return { data: null, error: { code: "P0001", message: "the server is chosen before the first point of a game" } };
        const p = []; for (let i = 0; i < args.p_game; i++) p.push((m.picks || [])[i] || { s: 0, r: 0 });
        p.push({ s: args.p_server, r: args.p_receiver });
        Object.assign(m, { picks: p, updated_at: new Date().toISOString(), version: m.version + 1 });
        emit("live_matches", "UPDATE", m, { id: m.id });
        return { data: clone(m), error: null };
      }
      if (fn === "join_match") {
        if (!me) return { data: null, error: { code: "42501", message: "sign in first" } };
        const m = db.live_matches.filter(r => r.join_code === args.p_code && r.status === "live").pop();
        if (!m) return { data: null, error: { code: "P0001", message: "no live match with that code" } };
        if (!db.match_keepers.some(k => k.match_id === m.id && k.user_id === me)) db.match_keepers.push({ match_id: m.id, user_id: me });
        return { data: m.id, error: null };
      }
      if (fn === "join_tournament") {
        if (!me) return { data: null, error: { code: "42501", message: "sign in first" } };
        const t = db.tournaments.filter(r => r.join_code === args.p_code && r.status === "live").pop();
        if (!t) return { data: null, error: { code: "P0001", message: "no live tournament with that code" } };
        if (!db.tournament_keepers.some(k => k.tournament_id === t.id && k.user_id === me)) db.tournament_keepers.push({ tournament_id: t.id, user_id: me });
        return { data: t.id, error: null };
      }
      return { data: null, error: { code: "PGRST202", message: "unknown function " + fn } };
    };
    Object.assign(client, {
      from, rpc,
      auth: {
        getSession: async () => ({ data: { session } }),
        onAuthStateChange: cb => { authCb = cb; return { data: { subscription: { unsubscribe() { authCb = null; } } } }; },
        signInWithPassword: async c => {
          const u = users.get(c.email);
          if (!u || u.password !== c.password) return { data: { session: null }, error: { message: "Invalid login credentials" } };
          session = { user: { id: u.id, email: u.email }, access_token: "t" }; setImmediate(() => authCb && authCb("SIGNED_IN", session));
          return { data: { session }, error: null };
        },
        signUp: async c => {
          if (users.has(c.email)) return { data: { session: null }, error: { message: "User already registered" } };
          const id = uuid(); users.set(c.email, { id, email: c.email, password: c.password });
          db.profiles.push({ id, name: (c.options && c.options.data && c.options.data.name) || c.email.split("@")[0] });
          if (B.confirmEmail) return { data: { session: null, user: { id } }, error: null };
          session = { user: { id, email: c.email }, access_token: "t" }; setImmediate(() => authCb && authCb("SIGNED_IN", session));
          return { data: { session, user: { id } }, error: null };
        },
        signOut: async () => { session = null; setImmediate(() => authCb && authCb("SIGNED_OUT", null)); return { error: null }; }
      },
      channel: () => {
        const mine = [];
        const ch = { on(_e, f, h) { const s = { table: f.table, h, client, ch }; subs.push(s); mine.push(s); return ch; }, subscribe() { return ch; }, _subs: mine };
        return ch;
      },
      removeChannel(ch) { (ch && ch._subs || []).forEach(s => { s.dead = true; }); }
    });
    clients.push(client);
    return client;
  };
  return B;
}

/* ---------------- phones ---------------- */
const tick = async (n = 25) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };
function installClock(w) {
  const timers = new Map(); let id = 0, now = 0;
  w.setTimeout = (f, ms, ...a) => { const i = ++id; timers.set(i, { at: now + Math.max(0, +ms || 0), f, a, every: 0 }); return i; };
  w.setInterval = (f, ms, ...a) => { const i = ++id; const e = Math.max(1, +ms || 0); timers.set(i, { at: now + e, f, a, every: e }); return i; };
  w.clearTimeout = w.clearInterval = i => { timers.delete(i); };
  const c = {
    timers,
    async run(ms) {
      const end = now + ms;
      for (;;) {
        let nx = null; for (const [i, t] of timers) if (t.at <= end && (!nx || t.at < nx[1].at)) nx = [i, t];
        if (!nx) break;
        const [i, t] = nx; now = t.at; if (t.every) t.at += t.every; else timers.delete(i);
        try { typeof t.f === "function" && t.f(...t.a); } catch (e) { ERR.push("timer callback threw: " + (e && e.stack || e)); }
        await tick(3);
      }
      now = end;
    }
  };
  clocks.push(c);
  return c;
}
/* Let fake time pass on every phone, in 50 ms steps, flushing promises and realtime between steps. */
async function wait(ms = 400) { for (let t = 0; t < ms; t += 50) { await tick(4); for (const c of clocks.slice()) await c.run(50); } await tick(25); }

const BAD = /\b(undefined|NaN|null|Infinity)\b|\[object Object\]/;
let phoneN = 0;
function boot(client, o = {}) {
  const vc = new VirtualConsole();
  vc.on("error", (...a) => ERR.push("console.error: " + a.map(x => x && x.stack || String(x)).join(" ")));
  vc.on("warn", (...a) => ERR.push("console.warn: " + a.map(String).join(" ")));
  vc.on("jsdomError", e => ERR.push("jsdomError: " + (e && (e.stack || e.message) || e) + (e && e.detail ? " " + (e.detail.stack || e.detail) : "")));
  const dom = new JSDOM(HTML, { url: `https://phone${++phoneN}.localhost/`, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window; windows.push(w);
  w.scrollTo = () => {};
  w.navigator.vibrate = () => true;
  w.addEventListener("error", e => ERR.push("window error: " + (e.error && e.error.stack || e.message)));
  for (const [k, v] of Object.entries(o.storage || {})) w.localStorage.setItem(k, v);
  w.__clock = installClock(w);
  w.RALLY_CONFIG = client ? { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon" } : {};
  if (client) w.supabase = { createClient: () => client };
  w.__pdfs = [];
  if (o.pdf) {
    w.eval(JSPDF); w.eval(AUTOTABLE);
    w.jspdf.jsPDF.API.save = function (name) { w.__pdfs.push({ name, pdf: this.output() }); };
  }
  w.eval(RULES); w.eval(APP);
  // watch #app: count whole-screen replacements and catch any render that shows undefined / NaN / null
  const app = w.document.getElementById("app"), sheet = w.document.getElementById("sheetRoot"), toastEl = w.document.getElementById("toast");
  w.__renders = 0; w.__bad = []; w.__log = [];
  const check = () => {
    for (const [where, el] of [["screen", app], ["sheet", sheet], ["toast", toastEl]]) {
      const txt = el.textContent || "", mm = txt.match(BAD);
      if (mm) { const at = txt.indexOf(mm[0]), view = w.__rally ? w.__rally.S.lastView : "?"; const msg = `[${where} on ${view}] shows "${mm[0]}": …${txt.slice(Math.max(0, at - 60), at + 30).replace(/\s+/g, " ")}…`; if (!w.__bad.includes(msg)) w.__bad.push(msg); }
    }
  };
  const mo = new w.MutationObserver(recs => { for (const r of recs) if (r.type === "childList" && r.target === app && r.addedNodes.length) w.__renders++; check(); });
  mo.observe(app, { childList: true, subtree: true, characterData: true });
  mo.observe(sheet, { childList: true, subtree: true, characterData: true });
  mo.observe(toastEl, { childList: true, subtree: true, characterData: true });
  return w;
}
const $ = (w, s) => w.document.querySelector(s);
const $$ = (w, s) => [...w.document.querySelectorAll(s)];
const text = w => w.document.getElementById("app").textContent.replace(/\s+/g, " ");
const view = w => w.__rally.S.lastView;
const where = w => `(screen "${view(w)}": ${text(w).slice(0, 160)}…; toast: ${$(w, "#toast").hidden ? "-" : $(w, "#toast").textContent})`;
function click(w, sel) { const el = typeof sel === "string" ? $(w, sel) : sel; assert.ok(el, `expected ${sel} on screen ${where(w)}`); el.click(); return el; }
async function go(w, hash) { w.location.hash = hash; w.dispatchEvent(new w.HashChangeEvent("hashchange")); await tick(); }
const tap = (w, p) => click(w, `.pcard[data-p="${p}"]`);
const score = (w, p) => +$(w, `.pcard[data-p="${p}"] .score`).textContent;
const firstCard = w => +$(w, ".pcard").dataset.p;
const serverOnScreen = w => { const s = $(w, ".pcard .serve"); return s ? +s.closest(".pcard").dataset.p : -1; };
async function submit(w, sel) { const f = $(w, sel); assert.ok(f, `expected form ${sel} ${where(w)}`); f.dispatchEvent(new w.Event("submit", { cancelable: true, bubbles: true })); await wait(200); }
function healthy(...ws) {
  const bad = ws.flatMap(w => w.__bad);
  assert.deepEqual({ errors: ERR.slice(), badText: bad }, { errors: [], badText: [] }, "no thrown errors / console errors / undefined-NaN-null on screen");
}

async function signedPhone(B, user) { const w = boot(B.client({ as: user })); await wait(200); return w; }
async function guestPhone(o = {}) { const w = boot(null, o); await tick(); click(w, "#guestBtn"); await tick(); return w; }
async function guestStart(w, a, b, bestOf = 3, serve = 0) {
  click(w, "#newBtn"); await tick();
  $(w, "#gA").value = a; $(w, "#gB").value = b;
  if (bestOf !== 3) click(w, `[data-best="${bestOf}"]`);
  if (serve !== 0) click(w, `[data-serve="${serve}"]`);
  click(w, "#startBtn"); await tick();
  assert.equal(view(w), "game", where(w));
}
/* Score one game: loser takes `lose` points first, then the winner runs it out. */
function playGame(w, winner, lose = 0, target = 11) { for (let i = 0; i < lose; i++) tap(w, 1 - winner); for (let i = 0; i < target; i++) tap(w, winner); }

/* ================================================================
   GUEST
   ================================================================ */
test("guest: best-of-3 with deuce, serve rotation, undo across a game boundary, end switching and swap", async () => {
  const w = await guestPhone();
  await guestStart(w, "Maya", "Theo", 3, 0);
  assert.match(text(w), /Game 1 · Best of 3/);
  assert.equal(serverOnScreen(w), 0); assert.match($(w, ".pcard .serve").textContent, /Serve 1 of 2/);
  tap(w, 0); assert.match($(w, ".pcard .serve").textContent, /Serve 2 of 2/); assert.equal(serverOnScreen(w), 0);
  tap(w, 0); assert.equal(serverOnScreen(w), 1, "serve passes after 2 points");
  for (let i = 0; i < 10; i++) tap(w, 1);
  for (let i = 0; i < 8; i++) tap(w, 0);
  assert.deepEqual([score(w, 0), score(w, 1)], [10, 10]);
  assert.match($(w, ".net").textContent, /Deuce/);
  assert.match($(w, ".pcard .serve").textContent, /Serving/);
  const s20 = serverOnScreen(w); tap(w, 0);
  assert.notEqual(serverOnScreen(w), s20, "serve alternates every point at deuce");
  assert.match($(w, '.pcard[data-p="0"] .badge').textContent, /Game point/);
  tap(w, 1); assert.match($(w, ".net").textContent, /Deuce/);
  tap(w, 0); tap(w, 0);
  assert.match(text(w), /Game 2 · Best of 3/);
  assert.match($(w, "#toast").textContent, /Maya takes game 1, 13–11/);
  assert.equal(firstCard(w), 1, "players change ends after game 1");
  assert.equal(serverOnScreen(w), 1, "other player serves first in game 2");
  click(w, "#undoBtn");
  assert.match(text(w), /Game 1 · Best of 3/);
  assert.deepEqual([score(w, 0), score(w, 1)], [12, 11], "undo crosses back into game 1");
  assert.equal(firstCard(w), 0, "ends switch back after undo");
  tap(w, 0);
  playGame(w, 1, 3);
  assert.match(text(w), /Game 3 · Best of 3/);
  assert.equal(firstCard(w), 0, "two switches = original ends");
  for (let i = 0; i < 4; i++) { tap(w, 0); tap(w, 1); }
  assert.equal(firstCard(w), 0);
  tap(w, 0);
  assert.equal(firstCard(w), 1, "deciding game: change ends when a player reaches 5");
  click(w, "#swapBtn"); assert.equal(firstCard(w), 0, "manual swap");
  click(w, "#swapBtn"); assert.equal(firstCard(w), 1);
  for (let i = 0; i < 6; i++) tap(w, 0);
  assert.match($(w, ".overlay").textContent, /Maya wins 2–1/);
  assert.equal(JSON.parse(w.localStorage.getItem("rally.local")).length, 1);
  click(w, "#overUndo");
  assert.ok(!$(w, ".overlay"), "undo from the result reopens the match");
  assert.equal(JSON.parse(w.localStorage.getItem("rally.local")).length, 0);
  tap(w, 0);
  assert.equal(JSON.parse(w.localStorage.getItem("rally.local")).length, 1, "finishing again saves exactly one record");
  click(w, "#reportBtn"); await tick();
  assert.match(text(w), /Maya wins\s*2–1/);
  for (const g of ["13–11", "3–11", "11–4"]) assert.ok(text(w).includes(g), "report game score " + g);
  assert.match(text(w), /1020/, "Maya's guest Elo 1000 + 20");
  assert.match(text(w), /1st\s*\/ 2/);
  assert.match(text(w), /Saved on this phone/);
  healthy(w);
});

test("guest: best-of-5 that goes to a fifth game", async () => {
  const w = await guestPhone();
  await guestStart(w, "Maya", "Theo", 5, 1);
  assert.match(text(w), /Game 1 · Best of 5/);
  assert.equal(serverOnScreen(w), 1, "Theo picked to serve first");
  assert.equal($$(w, '.pcard[data-p="0"] .pips i').length, 3, "3 pips: first to 3 games");
  playGame(w, 0, 5); playGame(w, 1, 6); playGame(w, 0, 9); playGame(w, 1, 2);
  assert.match(text(w), /Game 5 · Best of 5/);
  assert.equal(firstCard(w), 0, "four switches");
  for (let i = 0; i < 10; i++) tap(w, 1);
  assert.match($(w, '.pcard[data-p="1"] .badge') ? $(w, '.pcard[data-p="1"] .badge').textContent : "", /Match point/, "10th point away = match point");
  tap(w, 1);
  assert.match($(w, ".overlay").textContent, /Theo wins 3–2/);
  click(w, "#reportBtn"); await tick();
  assert.match(text(w), /Theo wins\s*3–2/);
  healthy(w);
});

test("guest: can choose a 21-point game when starting a match", async () => {
  const w = await guestPhone();
  click(w, "#newBtn"); await tick();
  $(w, "#gA").value = "Maya"; $(w, "#gB").value = "Theo";
  click(w, '[data-target="21"]');
  click(w, "#startBtn"); await tick();
  assert.equal(view(w), "game", where(w));
  assert.match(text(w), /First to 21/);
  for (let i = 0; i < 11; i++) tap(w, 0);
  assert.equal(score(w, 0), 11, "11 points does not end a 21-point game");
});

test("guest: leave mid-match, resume from home, and resume after the app is reopened", async () => {
  const w = await guestPhone();
  await guestStart(w, "Maya", "Theo", 3);
  playGame(w, 0, 2);
  tap(w, 1); tap(w, 1); tap(w, 0);
  click(w, "#swapBtn");
  const order = firstCard(w);
  click(w, "#leaveBtn"); await tick();
  assert.equal(view(w), "home");
  assert.match(text(w), /Maya v Theo/); assert.match(text(w), /Match in progress/);
  click(w, "#resumeBtn"); await tick();
  assert.match(text(w), /Game 2/);
  assert.deepEqual([score(w, 0), score(w, 1)], [1, 2]);
  assert.equal(firstCard(w), order, "manual swap is remembered");
  // reopen the app: a new window with the same storage
  const storage = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); storage[k] = w.localStorage.getItem(k); }
  const w2 = boot(null, { storage }); await tick();
  assert.equal(view(w2), "home", "guest flag remembered");
  click(w2, "#resumeBtn"); await tick();
  assert.deepEqual([score(w2, 0), score(w2, 1)], [1, 2]);
  playGame(w2, 0);
  assert.match($(w2, ".overlay").textContent, /Maya wins 2–0/);
  click(w2, "#homeBtn"); await tick();
  assert.ok(!$(w2, "#resumeBtn"), "finished match no longer offered to resume");
  healthy(w, w2);
});

test("guest: discard a match from options, sheets list and opening a sheet", async () => {
  const w = await guestPhone();
  await guestStart(w, "Ana", "Bo", 1);
  tap(w, 0);
  click(w, "#optBtn"); click(w, "#delMatch"); click(w, "#delMatch"); await tick();
  assert.equal(view(w), "home"); assert.ok(!$(w, "#resumeBtn"));
  await guestStart(w, "Maya", "Theo", 1);
  playGame(w, 0, 4);
  click(w, "#homeBtn"); await tick();
  await guestStart(w, "Maya", "Sam", 1);
  playGame(w, 1, 7);
  click(w, "#homeBtn"); await tick();
  await go(w, "#sheets");
  assert.match(text(w), /Score sheets/);
  const cards = $$(w, ".sheetcard");
  assert.equal(cards.length, 2);
  assert.match(cards[0].textContent, /Maya.*Sam/s, "newest first");
  assert.match(cards[1].textContent, /11–4/);
  click(w, cards[1]); await tick();
  assert.equal(view(w), "report"); assert.match(text(w), /Maya wins/);
  click(w, "#delRec"); click(w, "#delRec"); await tick();
  await go(w, "#sheets");
  assert.equal($$(w, ".sheetcard").length, 1, "deleted record gone");
  healthy(w);
});

test("guest: PDF export of the whole history and of one match", async () => {
  const w = boot(null, { pdf: true }); await tick(); click(w, "#guestBtn"); await tick();
  await guestStart(w, "Maya", "Theo", 3);
  playGame(w, 0, 5); playGame(w, 0, 9);
  click(w, "#homeBtn"); await tick();
  await guestStart(w, "Sam", "Theo", 1);
  playGame(w, 1, 3);
  click(w, "#reportBtn"); await tick();
  click(w, "#repPdf"); await wait(100);
  assert.equal(w.__pdfs.length, 1, "one-match PDF produced; toast: " + $(w, "#toast").textContent);
  assert.ok(w.__pdfs[0].pdf.startsWith("%PDF-"));
  assert.match(w.__pdfs[0].pdf, /Sam v Theo/); assert.match(w.__pdfs[0].pdf, /3-11/);
  assert.doesNotMatch(w.__pdfs[0].pdf, /Maya v Theo/, "single-match PDF only has that match");
  click(w, "#closeRep"); await tick();
  await go(w, "#sheets");
  click(w, "#sheetPdf"); await wait(100);
  assert.equal(w.__pdfs.length, 2);
  const h = w.__pdfs[1];
  assert.match(h.name, /^rally-history-\d{4}-\d{2}-\d{2}\.pdf$/);
  assert.match(h.pdf, /Maya v Theo/); assert.match(h.pdf, /Sam v Theo/); assert.match(h.pdf, /11-5, 11-9/);
  assert.doesNotMatch(h.pdf, /undefined|NaN/);
  healthy(w);
});

/* ================================================================
   SIGNED IN
   ================================================================ */
function club() {
  const B = makeBackend();
  const maya = B.addUser("u-maya", "Maya", "maya@example.com"), theo = B.addUser("u-theo", "Theo", "theo@example.com"), priya = B.addUser("u-priya", "Priya", "priya@example.com");
  return { B, maya, theo, priya };
}
async function clubStart(w, { opp, guest, bestOf = 3, keepers = "players", serve = 0 }) {
  click(w, "#newBtn"); await tick();
  if (opp) click(w, `[data-opp="${opp}"]`);
  if (guest) { click(w, "#guestChip"); $(w, "#oppGuest").value = guest; }
  if (bestOf !== 3) click(w, `[data-best="${bestOf}"]`);
  if (serve) click(w, `[data-serve="${serve}"]`);
  if (keepers !== "players") { const r = $(w, `input[name="keepers"][value="${keepers}"]`); r.checked = true; r.dispatchEvent(new w.Event("change")); }
  click(w, "#startBtn"); await wait(200);
  assert.equal(view(w), "game", where(w));
  return w.__rally.S.game.id;
}

test("signed in: create an account (instant session) lands on home with the new name", async () => {
  const { B } = club();
  const w = boot(B.client()); await wait(100);
  assert.equal(view(w), "auth");
  click(w, '[data-mode="signup"]'); await tick();
  $(w, "#aName").value = "Nina"; $(w, "#aEmail").value = "nina@example.com"; $(w, "#aPass").value = "secret12";
  await submit(w, "#authForm");
  assert.equal(view(w), "home", where(w));
  assert.match(text(w), /Nina/);
  assert.match(text(w), /Live now/);
  await go(w, "#you");
  assert.match(text(w), /nina@example.com/);
  assert.match(text(w), /Rating\s*1000/);
  healthy(w);
});

test("signed in: create an account that needs email confirmation, then a wrong password, then sign in", async () => {
  const { B } = club(); B.confirmEmail = true;
  const w = boot(B.client()); await wait(100);
  click(w, '[data-mode="signup"]'); await tick();
  $(w, "#aName").value = "Nina"; $(w, "#aEmail").value = "nina@example.com"; $(w, "#aPass").value = "secret12";
  await submit(w, "#authForm");
  assert.equal(view(w), "auth");
  assert.match($(w, "#toast").textContent, /Check your inbox/);
  assert.equal($(w, "#authBtn").textContent, "Sign in", "switched to the sign-in form");
  $(w, "#aEmail").value = "nina@example.com"; $(w, "#aPass").value = "wrongpass";
  await submit(w, "#authForm");
  assert.match($(w, "#authErr").textContent, /don't match/);
  assert.equal($(w, "#authBtn").disabled, false);
  $(w, "#aPass").value = "secret12";
  await submit(w, "#authForm");
  assert.equal(view(w), "home", where(w));
  assert.match(text(w), /Nina/);
  healthy(w);
});

test("signed in: sign in, sign out, sign in as someone else on the same phone", async () => {
  const { B, priya } = club();
  const pc = B.client({ as: priya });
  await pc.from("live_matches").insert({ a_name: "Priya", b_name: "Jonah", a_user: priya.id, best_of: 3, target: 11, first_server: 0, keepers: "owner" });
  const w = boot(B.client()); await wait(100);
  $(w, "#aEmail").value = "maya@example.com"; $(w, "#aPass").value = "secret12";
  await submit(w, "#authForm"); await wait(100);
  assert.equal(view(w), "home"); assert.match(text(w), /Maya/); assert.match(text(w), /Priya v Jonah/);
  await go(w, "#you");
  click(w, "#signOut"); await wait(200);
  assert.equal(view(w), "auth", where(w));
  assert.ok($(w, "#tabbar").hidden, "no tab bar on the sign-in screen");
  $(w, "#aEmail").value = "theo@example.com"; $(w, "#aPass").value = "secret12";
  await submit(w, "#authForm"); await wait(100);
  assert.equal(view(w), "home", where(w));
  assert.match($(w, "header").textContent, /Theo/, "home greets the new user");
  assert.doesNotMatch($(w, "header").textContent, /Maya/);
  healthy(w);
});

test("signed in: ladder ranks, Elo, home chart and profile after several matches", async () => {
  const { B, maya, theo } = club();
  const w = await signedPhone(B, maya);
  // Maya beats Theo, Maya beats guest Sam, Theo beats Maya (Maya is always orange / side a)
  await clubStart(w, { opp: theo.id, bestOf: 1 }); playGame(w, 0, 3); await wait(300); click(w, "#homeBtn"); await tick();
  await clubStart(w, { guest: "Sam", bestOf: 1 }); playGame(w, 0, 6); await wait(300); click(w, "#homeBtn"); await tick();
  await clubStart(w, { opp: theo.id, bestOf: 3 }); playGame(w, 1, 4); playGame(w, 0, 4); playGame(w, 1, 9); await wait(300);
  assert.match($(w, ".overlay").textContent, /Theo wins 2–1/);
  assert.equal(B.db.matches.length, 3, "server published 3 finished matches");
  const ref = eloRef([["Maya", "Theo", 0], ["Maya", "Sam", 0], ["Maya", "Theo", 1]]);
  click(w, "#reportBtn"); await tick();
  assert.match(text(w), /Theo wins\s*2–1/);
  assert.match(text(w), new RegExp("Theo's rating\\s*" + ref.get("Theo").r));
  click(w, "#closeRep"); await tick();
  await go(w, "#ladder");
  const order = [...ref.entries()].sort((x, y) => y[1].r - x[1].r);
  assert.match($(w, "[data-k]").textContent, new RegExp(order[0][0] + ".*" + order[0][1].r), "top of the ladder");
  const rows = $$(w, ".prow").map(r => r.textContent.replace(/\s+/g, " ").trim());
  assert.equal(rows.length, 2);
  rows.forEach((r, i) => { assert.match(r, new RegExp("^" + (i + 2) + "\\D.*" + order[i + 1][0] + ".*" + order[i + 1][1].r), "rank " + (i + 2)); });
  assert.match(text(w), /3 matches · Elo/);
  click(w, $$(w, ".prow").find(r => /Theo/.test(r.textContent))); await tick();
  assert.match($(w, "#sheetRoot").textContent, /v Maya\s*1–1/, "head to head in player sheet");
  click(w, "#sheetRoot [data-close]");
  await go(w, "#you");
  assert.match(text(w), new RegExp("Rating\\s*" + ref.get("Maya").r));
  assert.match(text(w), /Won\s*2/); assert.match(text(w), /Lost\s*1/);
  await go(w, "#home");
  assert.equal($$(w, ".bars .bar").length, 3, "points-won chart has the 3 matches");
  await go(w, "#you");
  $(w, "#myName").value = "Maya K"; await submit(w, "#nameForm");
  assert.equal(B.db.profiles.find(p => p.id === maya.id).name, "Maya K");
  assert.match(text(w), /Maya K/);
  healthy(w);
});

test("signed in: two phones score the same match with realtime and stay in sync", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya), b = await signedPhone(B, theo);
  const id = await clubStart(a, { opp: theo.id, bestOf: 3 });
  await wait(200);
  assert.match(text(b), /Maya v Theo/, "Theo's home shows the new live match");
  click(b, `[data-live="${id}"]`); await tick();
  assert.match(text(b), /Both players scoring/);
  tap(a, 0); await wait(200);
  assert.deepEqual([score(b, 0), score(b, 1)], [1, 0], "Theo's phone sees Maya's point");
  tap(b, 1); await wait(200);
  assert.deepEqual([score(a, 0), score(a, 1)], [1, 1], "Maya's phone sees Theo's point");
  // both tap in the same instant
  tap(a, 0); tap(b, 1); await wait(300);
  const row = B.db.live_matches.find(m => m.id === id);
  const sv = ptsOf(row.games[row.games.length - 1]);
  assert.deepEqual([score(a, 0), score(a, 1)], sv, "phone A matches the server after a collision");
  assert.deepEqual([score(b, 0), score(b, 1)], sv, "phone B matches the server after a collision");
  // finish game 1 from A, game 2 from B
  while (B.db.live_matches.find(m => m.id === id).games.length === 1) { tap(a, 0); await wait(60); }
  await wait(200);
  assert.match(text(b), /Game 2 · Best of 3/);
  for (let i = 0; i < 11; i++) tap(b, 0);
  await wait(400);
  assert.equal(B.db.live_matches.find(m => m.id === id).status, "done");
  assert.match($(a, ".overlay") ? $(a, ".overlay").textContent : "(no overlay) " + where(a), /Maya wins 2–0/);
  assert.match($(b, ".overlay") ? $(b, ".overlay").textContent : "(no overlay) " + where(b), /Maya wins 2–0/);
  click(b, "#homeBtn"); await tick();
  assert.doesNotMatch(text(b), /Maya v Theo/, "finished match leaves Live now");
  await go(b, "#ladder");
  assert.match(text(b), /Maya\s*1020/);
  healthy(a, b);
});

test("signed in: a third member joins a match by code and scores (and the label says they can score)", async () => {
  const { B, maya, priya } = club();
  const a = await signedPhone(B, maya), c = await signedPhone(B, priya);
  const id = await clubStart(a, { guest: "Jonah", bestOf: 1, keepers: "owner" });
  click(a, "#optBtn"); const code = $(a, "#codeTxt").textContent; click(a, "#sheetRoot [data-close]");
  assert.match(code, /^\d{4}$/);
  await wait(200);
  click(c, "#joinBtn");
  $(c, "#joinCode").value = "0000"; await submit(c, "#joinForm");
  assert.match($(c, "#joinErr").textContent, /No live match/);
  $(c, "#joinCode").value = code; await submit(c, "#joinForm"); await wait(100);
  assert.equal(view(c), "game", where(c));
  assert.equal(c.__rally.S.game.id, id);
  assert.ok(!$(c, '.pcard[data-p="0"]').disabled, "joined scorekeeper can tap");
  tap(c, 1); await wait(200);
  assert.equal(score(a, 1), 1, "host sees the joined keeper's point");
  assert.doesNotMatch($(c, ".gtop").textContent, /Only the host is scoring|Watching/, "joined scorekeeper's header should not say only the host scores");
  healthy(a, c);
});

test("signed in: a club member who is not a scorekeeper can only watch", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya), b = await signedPhone(B, theo);
  const id = await clubStart(a, { opp: theo.id, bestOf: 1, keepers: "owner" });
  tap(a, 0); await wait(200);
  assert.match($(b, `[data-live="${id}"]`).textContent, /Watch/);
  click(b, `[data-live="${id}"]`); await tick();
  assert.match(text(b), /Watching/);
  assert.ok($(b, '.pcard[data-p="0"]').disabled && $(b, '.pcard[data-p="1"]').disabled, "cards disabled");
  assert.ok($(b, "#undoBtn").disabled, "undo disabled");
  $(b, '.pcard[data-p="1"]').disabled = false; tap(b, 1); await wait(200); // even a forced tap must not score
  assert.equal(B.rpcLog.filter(r => r.by === theo.id).length, 0, "watcher never calls score_point");
  tap(a, 0); await wait(200);
  assert.equal(score(b, 0), 2, "watcher follows the score live");
  healthy(a, b);
});

test("signed in: a watcher's match options must not hand out the scorekeeper code", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya), b = await signedPhone(B, theo);
  const id = await clubStart(a, { opp: theo.id, bestOf: 1, keepers: "owner" });
  await wait(200);
  click(b, `[data-live="${id}"]`); await tick();
  click(b, "#optBtn");
  const code = B.db.live_matches.find(m => m.id === id).join_code;
  assert.ok(!($(b, "#sheetRoot").textContent || "").includes(code), "host picked 'Only me' but a watcher can read the join code and make themselves a scorekeeper");
});

test("signed in: a point the server rejects is rolled back on screen", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya);
  await clubStart(a, { opp: theo.id, bestOf: 1 });
  tap(a, 0); await wait(100);
  B.rpcHook = fn => fn === "score_point" ? { data: null, error: { code: "42501", message: "not allowed" } } : null;
  tap(a, 0);
  assert.equal(score(a, 0), 2, "optimistic");
  await wait(100);
  assert.equal(score(a, 0), 1, "rolled back");
  assert.match($(a, "#toast").textContent, /not a scorekeeper/);
  B.rpcHook = fn => fn === "score_point" ? { data: null, error: { code: "08006", message: "network" } } : null;
  tap(a, 1); await wait(100);
  assert.equal(score(a, 1), 0); assert.match($(a, "#toast").textContent, /Couldn't save that point/);
  B.rpcHook = null;
  tap(a, 1); await wait(100);
  assert.deepEqual([score(a, 0), score(a, 1)], [1, 1]);
  healthy(a);
});

test("signed in: the host deleting a live match kicks the other phone out cleanly", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya), b = await signedPhone(B, theo);
  const id = await clubStart(a, { opp: theo.id, bestOf: 1 });
  await wait(200); click(b, `[data-live="${id}"]`); await tick();
  click(a, "#optBtn"); click(a, "#delMatch"); click(a, "#delMatch"); await wait(300);
  assert.equal(view(a), "home"); assert.equal(B.db.live_matches.length, 0);
  assert.equal(view(b), "home", where(b));
  assert.match($(b, "#toast").textContent, /removed this match/);
  healthy(a, b);
});

/* ================================================================
   TOURNAMENTS
   ================================================================ */
const NAMES = { Lions: ["Ali", "Bea", "Cai", "Dev", "Eli", "Fay"], Hawks: ["Gus", "Hal", "Ivy", "Jo", "Kai", "Lu"], Owls: ["Max", "Ned", "Oli"], "": ["Pat", "Quin", "Ray"] };
const roster = spec => Object.fromEntries(Object.entries(spec).map(([t, n]) => [t, NAMES[t].slice(0, n)]));
async function hostTournament(w, B, { name, mode = "bracket", draw, bestOf = 1, target = 11, teams, cross }) {
  await go(w, "#cups");
  click(w, "#tNewBtn"); await tick();
  $(w, "#tnName").value = name;
  click(w, `[data-mode="${mode}"]`);
  if (draw) click(w, `[data-draw="${draw}"]`);
  if (bestOf !== 1) click(w, `[data-tbest="${bestOf}"]`);
  if (target !== 11) click(w, `[data-ttarget="${target}"]`);
  for (const t of Object.keys(teams)) if (t) { $(w, "#tnTeam").value = t; click(w, "#tnAddTeam"); }
  for (const [t, names] of Object.entries(teams)) {
    if ($(w, `[data-pteam="${t}"]`)) click(w, `[data-pteam="${t}"]`);
    for (const n of names) { $(w, "#tnPlayer").value = n; click(w, "#tnAddPlayer"); }
  }
  const total = Object.values(teams).flat().length;
  assert.equal($$(w, ".pitem").length, total);
  if (cross !== undefined && $(w, "#tnCross") && $(w, "#tnCross").checked !== cross) {
    $(w, "#tnCross").checked = cross; $(w, "#tnCross").dispatchEvent(new w.Event("change", { bubbles: true })); await tick();
    assert.equal($(w, "#tnCross").checked, cross, "cross-team toggle stays as set");
  }
  click(w, "#tnStart"); await wait(800);
  assert.equal(view(w), "tour", where(w));
  const t = B.db.tournaments.find(x => x.name === name);
  assert.ok(t, "tournament row created");
  return t;
}
const tPlayers = (B, tid) => B.db.tournament_players.filter(p => p.tournament_id === tid);
const tMatches = (B, tid) => B.db.live_matches.filter(m => m.tournament_id === tid);
/* Plays the open match on screen to the end through the UI. pick(m) -> {winner: 0|1, lose: points for the loser per game}. */
async function playMatchUI(w, B, id, pick) {
  const m = B.db.live_matches.find(x => x.id === id);
  const { winner, lose } = pick(m);
  const need = (m.best_of + 1) / 2;
  for (let g = 0; g < need; g++) { playGame(w, winner, lose, m.target); await wait(100); }
  await wait(300);
  assert.ok($(w, ".overlay"), "match over overlay " + where(w));
}
async function playOne(w, B, pick) {
  const row = $(w, ".mrow[data-m]");
  if (!row) return null;
  const id = row.dataset.m; click(w, row); await tick();
  assert.equal(view(w), "game", where(w));
  await playMatchUI(w, B, id, pick);
  click(w, "#toTour"); await wait(800);
  assert.equal(view(w), "tour", where(w));
  return id;
}
async function playAll(w, B, pick, max = 80) {
  let n = 0;
  while (n < max && await playOne(w, B, pick)) n++;
  return n;
}
const defaultPick = m => ({ winner: (m.round + m.slot) % 3 === 2 ? 1 : 0, lose: (m.round * 3 + m.slot) % 9 });
function expectedStandings(B, tid) {
  const ps = tPlayers(B, tid), by = new Map(ps.map(p => [p.id, { name: p.name, team: p.team, w: 0, l: 0, gw: 0, gl: 0, pf: 0, pa: 0 }])), teamWins = {};
  for (const m of tMatches(B, tid).filter(m => m.status === "done")) {
    const W = by.get(winnerTp(m)), L = by.get(loserTp(m)); W.w++; L.l++;
    const gw = gamesWon(m.games, m.target), A = by.get(m.a_tp), Bb = by.get(m.b_tp);
    A.gw += gw[0]; A.gl += gw[1]; Bb.gw += gw[1]; Bb.gl += gw[0];
    let pa = 0, pb = 0; for (const g of m.games) { const [x, y] = ptsOf(g); pa += x; pb += y; }
    A.pf += pa; A.pa += pb; Bb.pf += pb; Bb.pa += pa;
    if (W.team && L.team && W.team !== L.team) teamWins[W.team] = (teamWins[W.team] || 0) + 1;
  }
  return { rows: [...by.values()], teamWins };
}
function checkStandingsUI(w, B, tid) {
  const exp = expectedStandings(B, tid);
  const trs = $$(w, ".tbl tbody tr");
  assert.equal(trs.length, exp.rows.length, "a standings row per player");
  const got = trs.map(tr => { const td = [...tr.children], tt = td[0].querySelector(".tt"); return { name: td[0].textContent.replace(tt ? tt.textContent : "", "").replace(/^\s*\d+\.\s*/, "").trim(), w: +td[2].textContent, l: +td[3].textContent }; });
  const want = exp.rows.map(r => ({ name: r.name, w: r.w, l: r.l }));
  assert.deepEqual([...got].sort((x, y) => x.name.localeCompare(y.name)), [...want].sort((x, y) => x.name.localeCompare(y.name)), "standings W/L match the results");
  for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].w >= got[i].w, "standings sorted by wins");
  const teams = [...new Set(tPlayers(B, tid).map(p => p.team).filter(Boolean))];
  if (teams.length >= 2) {
    const shown = Object.fromEntries($$(w, ".teams > span").filter(s => s.querySelector("b")).map(s => [s.querySelector("b").textContent, +s.querySelector(".num").textContent]));
    const note = $$(w, "p.note").map(p => p.textContent).join(" ");
    for (const t of teams) {
      const want = exp.teamWins[t] || 0;
      if (t in shown) assert.equal(shown[t], want, `team score for ${t}`);
      else assert.match(note, new RegExp(t + " " + want), `team score for ${t} in the note`);
    }
  }
  return exp;
}
/* Cross-team: the most cross-team pairs possible among the players drawn into first-round matches. */
function checkCrossFirstRound(B, tid, firstRound) {
  const team = new Map(tPlayers(B, tid).map(p => [p.id, p.team]));
  const players = firstRound.flatMap(m => [m.a_tp, m.b_tp]), count = {};
  players.forEach(p => { count[team.get(p)] = (count[team.get(p)] || 0) + 1; });
  const largest = Math.max(...Object.values(count)), n = players.length;
  const maxCross = Math.min(Math.floor(n / 2), n - largest);
  const cross = firstRound.filter(m => team.get(m.a_tp) !== team.get(m.b_tp)).length;
  const desc = firstRound.map(m => `${m.a_name}(${team.get(m.a_tp)}) v ${m.b_name}(${team.get(m.b_tp)})`).join(", ");
  assert.equal(cross, maxCross, `first round should have ${maxCross} cross-team matches, got ${cross}: ${desc}`);
}

async function bracketTournament({ name, draw, spec, cross = true, bestOf = 1, target = 11, pick = defaultPick, pdf = false }) {
  const { B, maya } = club();
  const w = pdf ? boot(B.client({ as: maya }), { pdf: true }) : boot(B.client({ as: maya }));
  await wait(200);
  const teams = roster(spec), n = Object.values(teams).flat().length;
  const t = await hostTournament(w, B, { name, mode: "bracket", draw, bestOf, target, teams, cross });
  assert.equal(t.mode, "bracket"); assert.equal(t.cross_team, cross && Object.keys(teams).filter(Boolean).length >= 2);
  let size = 1; while (size < n) size *= 2;
  const first = tMatches(B, t.id).filter(m => m.round === 0);
  assert.equal(first.length, n - size / 2, `${n} players in a ${size} draw: ${size - n} byes`);
  if (cross && Object.keys(teams).filter(Boolean).length >= 2) checkCrossFirstRound(B, t.id, first);
  const played = await playAll(w, B, pick);
  const all = tMatches(B, t.id);
  assert.equal(played, n - 1, "a knockout of n players has n-1 matches");
  assert.equal(all.length, n - 1); assert.ok(all.every(m => m.status === "done"));
  // advancement: nobody plays after losing; the final winner is the champion
  const lost = new Set();
  for (const m of all.slice().sort((x, y) => x.round - y.round)) {
    assert.ok(!lost.has(m.a_tp) && !lost.has(m.b_tp), `${m.a_name} v ${m.b_name} in round ${m.round + 1}: a player who already lost`);
    lost.add(loserTp(m));
  }
  const final = all.reduce((x, y) => y.round > x.round ? y : x);
  const champ = tPlayers(B, t.id).find(p => p.id === winnerTp(final));
  const tr = B.db.tournaments.find(x => x.id === t.id);
  assert.equal(tr.status, "done", "tournament marked finished");
  assert.equal(tr.champion, champ.id, "champion saved");
  assert.match(text(w), new RegExp("Champion\\s*" + champ.name), "champion crowned on screen");
  checkStandingsUI(w, B, t.id);
  return { w, B, t, champ };
}

test("tournament: knockout, random draw, Lions 4 v Hawks 4, cross-team, played to a champion, PDF", async () => {
  const { w, t, champ } = await bracketTournament({ name: "Lions v Hawks cup", draw: "random", spec: { Lions: 4, Hawks: 4 }, pdf: true });
  assert.match(text(w), /Quarter-finals/); assert.match(text(w), /Semi-finals/); assert.match(text(w), /Final/);
  click(w, "#tPdf2"); await wait(100);
  assert.equal(w.__pdfs.length, 1, "tournament PDF produced; toast: " + $(w, "#toast").textContent);
  const pdf = w.__pdfs[0];
  assert.equal(pdf.name, "rally-lions-v-hawks-cup.pdf");
  for (const s of ["Lions v Hawks cup", "Lions", "Hawks", "Standings", "Bracket", "champion: " + champ.name]) assert.ok(pdf.pdf.includes(s), "PDF has " + s);
  assert.doesNotMatch(pdf.pdf, /undefined|NaN/);
  healthy(w);
});

test("tournament: knockout, seeded draw, Lions 5 v Hawks 3, cross-team", async () => {
  const { w } = await bracketTournament({ name: "Seeded 5v3", draw: "seeded", spec: { Lions: 5, Hawks: 3 } });
  healthy(w);
});

test("tournament: knockout, random draw, Lions 6 v Hawks 2 (unbalanced), cross-team", async () => {
  const { w } = await bracketTournament({ name: "Random 6v2", draw: "random", spec: { Lions: 6, Hawks: 2 } });
  healthy(w);
});

test("tournament: knockout, seeded draw, Lions 6 v Hawks 2 (unbalanced), cross-team", async () => {
  const { w } = await bracketTournament({ name: "Seeded 6v2", draw: "seeded", spec: { Lions: 6, Hawks: 2 } });
  healthy(w);
});

test("tournament: knockout, seeded draw, three teams 3v3v2, cross-team: no teammates in round one", async () => {
  const { w } = await bracketTournament({ name: "Three teams seeded", draw: "seeded", spec: { Lions: 3, Hawks: 3, Owls: 2 } });
  healthy(w);
});

test("tournament: knockout, random draw, three teams 3v3v2, cross-team", async () => {
  const { w } = await bracketTournament({ name: "Three teams random", draw: "random", spec: { Lions: 3, Hawks: 3, Owls: 2 } });
  healthy(w);
});

test("tournament: knockout with byes, odd counts 3v2 (5 players) and 4v3 (7 players), best of 3", async () => {
  const r1 = await bracketTournament({ name: "Five", draw: "seeded", spec: { Lions: 3, Hawks: 2 }, bestOf: 3 });
  const tree = r1.w.document.querySelector(".bracket").textContent;
  assert.match(tree, /Bye/, "byes shown in the bracket");
  healthy(r1.w);
  const r2 = await bracketTournament({ name: "Seven", draw: "random", spec: { Lions: 4, Hawks: 3 } });
  healthy(r2.w);
});

test("tournament: knockout with cross-team off still runs to a champion", async () => {
  const { w, B, t } = await bracketTournament({ name: "No cross", draw: "random", spec: { Lions: 4, Hawks: 4 }, cross: false });
  assert.equal(B.db.tournaments.find(x => x.id === t.id).cross_team, false);
  healthy(w);
});

test("tournament: knockout to 21 points, best of 3 (serve every 5, deuce at 20-all)", async () => {
  const { B, maya } = club();
  const w = await signedPhone(B, maya);
  const t = await hostTournament(w, B, { name: "Twenty one", mode: "bracket", draw: "seeded", bestOf: 3, target: 21, teams: roster({ Lions: 1, Hawks: 1 }) });
  assert.equal(t.target, 21); assert.match(text(w), /Best of 3 · to 21/);
  click(w, ".mrow[data-m]"); await tick();
  assert.match($(w, ".pcard .serve").textContent, /Serve 1 of 5/);
  const s0 = serverOnScreen(w);
  for (let i = 0; i < 4; i++) tap(w, 0);
  assert.equal(serverOnScreen(w), s0); assert.match($(w, ".pcard .serve").textContent, /Serve 5 of 5/);
  tap(w, 0); assert.notEqual(serverOnScreen(w), s0, "serve passes after 5 points");
  for (let i = 0; i < 20; i++) tap(w, 1);
  for (let i = 0; i < 15; i++) tap(w, 0);
  await wait(200);
  assert.deepEqual([score(w, 0), score(w, 1)], [20, 20]);
  assert.match($(w, ".net").textContent, /Deuce/);
  tap(w, 1); tap(w, 1); await wait(200);
  assert.match(text(w), /Game 2 · Best of 3/);
  playGame(w, 0, 10, 21); await wait(100); playGame(w, 0, 19, 21); await wait(300);
  assert.match($(w, ".overlay").textContent, /wins 2–1/);
  click(w, "#toTour"); await wait(600);
  assert.match(text(w), /Champion/);
  healthy(w);
});

async function rrTournament({ name, spec, cross = true, bestOf = 1 }) {
  const { B, maya } = club();
  const w = await signedPhone(B, maya);
  const teams = roster(spec), ps = Object.entries(teams).flatMap(([t, ns]) => ns.map(n => ({ n, t })));
  const t = await hostTournament(w, B, { name, mode: "round_robin", bestOf, teams, cross });
  const on = cross && Object.keys(teams).filter(Boolean).length >= 2;
  let want = 0; for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) if (!on || ps[i].t !== ps[j].t) want++;
  const played = await playAll(w, B, defaultPick, 200);
  const all = tMatches(B, t.id);
  const team = new Map(tPlayers(B, t.id).map(p => [p.id, p.team]));
  const pairs = all.map(m => [m.a_tp, m.b_tp].sort().join("|"));
  assert.equal(new Set(pairs).size, pairs.length, "each pair meets once");
  assert.equal(played, want, `${want} round-robin matches`);
  if (on) for (const m of all) assert.notEqual(team.get(m.a_tp), team.get(m.b_tp), `${m.a_name} v ${m.b_name} are teammates`);
  const exp = checkStandingsUI(w, B, t.id);
  const top = exp.rows.slice().sort((x, y) => y.w - x.w || (y.gw - y.gl) - (x.gw - x.gl) || (y.pf - y.pa) - (x.pf - x.pa) || x.name.localeCompare(y.name))[0];
  const tr = B.db.tournaments.find(x => x.id === t.id);
  assert.equal(tr.status, "done");
  assert.equal(tPlayers(B, t.id).find(p => p.id === tr.champion).name, top.name, "round-robin champion is the standings leader");
  assert.match(text(w), new RegExp("Champion\\s*" + top.name));
  return { w, B, t };
}
test("tournament: round robin Lions 4 v Hawks 4, cross-team only", async () => { const { w } = await rrTournament({ name: "RR 4v4", spec: { Lions: 4, Hawks: 4 } }); healthy(w); });
test("tournament: round robin Lions 5 v Hawks 3, cross-team only", async () => { const { w } = await rrTournament({ name: "RR 5v3", spec: { Lions: 5, Hawks: 3 } }); healthy(w); });
test("tournament: round robin three teams 3v3v2, cross-team only", async () => { const { w } = await rrTournament({ name: "RR 3v3v2", spec: { Lions: 3, Hawks: 3, Owls: 2 } }); healthy(w); });
test("tournament: round robin odd count 3v2 with cross-team off (everyone plays everyone, byes each round)", async () => { const { w } = await rrTournament({ name: "RR odd", spec: { Lions: 3, Hawks: 2 }, cross: false }); healthy(w); });
test("tournament: round robin 6v2, best of 3, cross-team only", async () => { const { w } = await rrTournament({ name: "RR 6v2", spec: { Lions: 6, Hawks: 2 }, bestOf: 3 }); healthy(w); });

async function kothRun({ name, spec, cross = true, draw = "random", matches = 10, late }) {
  const { B, maya } = club();
  const w = await signedPhone(B, maya);
  const teams = roster(spec);
  const t = await hostTournament(w, B, { name, mode: "koth", draw, teams, cross });
  assert.match(text(w), /On the table/);
  const pick = m => ({ winner: m.round % 3 === 2 ? 1 : 0, lose: m.round % 7 });
  for (let i = 0; i < matches; i++) {
    if (late && i === late.after) {
      if (late.team) click(w, `[data-kteam="${late.team}"]`);
      $(w, "#kAdd").value = late.name; click(w, "#kAddBtn"); await wait(400);
      assert.match($(w, ".plist").textContent, new RegExp(late.name), "late joiner shows in the queue");
    }
    assert.ok(await playOne(w, B, pick), `koth match ${i + 1} available ${where(w)}`);
  }
  const all = tMatches(B, t.id).filter(m => m.status === "done").sort((x, y) => x.round - y.round);
  assert.equal(all.length, matches);
  for (let i = 1; i < all.length; i++) {
    assert.equal(all[i].round, i);
    assert.equal(all[i].a_tp, winnerTp(all[i - 1]), `winner of match ${i} stays on the table`);
  }
  const team = new Map(tPlayers(B, t.id).map(p => [p.id, p.team]));
  if (cross && Object.keys(teams).filter(Boolean).length >= 2) for (const m of all) assert.notEqual(team.get(m.a_tp), team.get(m.b_tp), `KOTH match ${m.round + 1}: ${m.a_name} v ${m.b_name} are teammates while the other team is in the queue`);
  const champ = tPlayers(B, t.id).find(p => p.id === winnerTp(all[all.length - 1]));
  assert.match(text(w), new RegExp("On the table\\s*\\S*\\s*" + champ.name));
  checkStandingsUI(w, B, t.id);
  return { w, B, t, champ, all };
}

test("tournament: King of the hill 4v4 cross-team, late joiner, End tournament", async () => {
  const { w, B, t, champ, all } = await kothRun({ name: "Hill 4v4", spec: { Lions: 4, Hawks: 4 }, matches: 16, late: { after: 3, name: "Zed", team: "Hawks" } });
  const zed = tPlayers(B, t.id).find(p => p.name === "Zed");
  assert.equal(zed.team, "Hawks");
  assert.ok(all.some(m => m.a_tp === zed.id || m.b_tp === zed.id), "late joiner (joined_round " + zed.joined_round + ") never played: " + all.map(m => `${m.round}:${m.a_name}v${m.b_name}`).join(" ") + " | queue: " + $(w, ".plist").textContent + " | app players: " + w.__rally.S.tour.players.map(p => `${p.name}@${p.position}/j${p.joinedRound}`).join(",") + " | db: " + tPlayers(B, t.id).map(p => `${p.name}@${p.position}/j${p.joined_round}`).join(","));
  click(w, "#tEnd"); click(w, "#tEnd"); await wait(600);
  const tr = B.db.tournaments.find(x => x.id === t.id);
  assert.equal(tr.status, "done"); assert.equal(tr.champion, champ.id);
  assert.match(text(w), /Last one standing/); assert.match(text(w), new RegExp(champ.name));
  assert.ok(!$(w, ".mrow[data-m]"), "no matches to play after the end");
  assert.equal(tMatches(B, t.id).filter(m => m.status === "live").length, 0, "no unplayed match left behind");
  healthy(w);
});

test("tournament: King of the hill 6v2 seeded queue, cross-team", async () => { const { w } = await kothRun({ name: "Hill 6v2", spec: { Lions: 6, Hawks: 2 }, draw: "seeded", matches: 10 }); healthy(w); });
test("tournament: King of the hill 3v3v2, cross-team", async () => { const { w } = await kothRun({ name: "Hill 3v3v2", spec: { Lions: 3, Hawks: 3, Owls: 2 }, matches: 10 }); healthy(w); });
test("tournament: King of the hill 5 players cross-team off", async () => { const { w } = await kothRun({ name: "Hill odd", spec: { Lions: 3, Hawks: 2 }, cross: false, matches: 8 }); healthy(w); });

test("tournament: ending King of the hill mid-match leaves no half-played match in Live now", async () => {
  const { B, maya } = club();
  const w = await signedPhone(B, maya);
  const t = await hostTournament(w, B, { name: "Hill stop", mode: "koth", draw: "seeded", teams: roster({ Lions: 2, Hawks: 2 }) });
  const row = $(w, ".mrow[data-m]"); const id = row.dataset.m; click(w, row); await tick();
  tap(w, 0); tap(w, 1); tap(w, 0); await wait(200);
  click(w, "#leaveBtn"); await wait(400);
  assert.equal(view(w), "tour", where(w));
  click(w, "#tEnd"); click(w, "#tEnd"); await wait(600);
  assert.equal(B.db.tournaments.find(x => x.id === t.id).status, "done");
  click(w, "#tBack"); await go(w, "#home"); await wait(100);
  assert.ok(!$(w, `[data-live="${id}"]`), "the ended tournament's half-played match still shows in Live now: " + text(w).slice(0, 200));
  healthy(w);
});

test("tournament: a second phone joins by code, scores a match, and the host's bracket advances", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya), b = await signedPhone(B, theo);
  const t = await hostTournament(a, B, { name: "Two phones", mode: "bracket", draw: "random", teams: roster({ Lions: 2, Hawks: 2 }) });
  assert.equal($(a, "#tCodeTxt").textContent, t.join_code);
  await wait(400);
  await go(b, "#cups");
  assert.match(text(b), /Two phones/);
  click(b, "#tJoinBtn"); $(b, "#tjCode").value = t.join_code; await submit(b, "#tjForm"); await wait(600);
  assert.equal(view(b), "tour", where(b));
  assert.ok($(b, "#tCodeTxt"), "joined phone is a scorekeeper");
  const semis = tMatches(B, t.id).filter(m => m.round === 0);
  assert.equal(semis.length, 2);
  // Theo plays semi 1 on his phone while Maya plays semi 2 on hers
  click(b, `.mrow[data-m="${semis[0].id}"]`); click(a, `.mrow[data-m="${semis[1].id}"]`); await tick();
  playGame(b, 0, 4); playGame(a, 1, 6);
  await wait(1200);
  assert.equal(tMatches(B, t.id).filter(m => m.status === "done").length, 2);
  const finals = tMatches(B, t.id).filter(m => m.round === 1);
  assert.equal(finals.length, 1, "exactly one final created even though both phones reconcile");
  click(a, "#toTour"); click(b, "#toTour"); await wait(800);
  assert.ok($(a, `.mrow[data-m="${finals[0].id}"]`), "host sees the final to play " + where(a));
  assert.ok($(b, `.mrow[data-m="${finals[0].id}"]`), "second phone sees the final to play " + where(b));
  click(b, `.mrow[data-m="${finals[0].id}"]`); await tick();
  playGame(b, 1, 2); await wait(800);
  click(b, "#toTour"); await wait(800);
  const champ = tPlayers(B, t.id).find(p => p.id === winnerTp(B.db.live_matches.find(m => m.id === finals[0].id)));
  assert.match(text(a), new RegExp("Champion\\s*" + champ.name), "host phone crowns the champion " + where(a));
  assert.match(text(b), new RegExp("Champion\\s*" + champ.name));
  assert.ok(!$(a, "#tCodeTxt"), "code hidden once finished");
  healthy(a, b);
});

test("tournament: a member who has not joined by code can only watch the tournament", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya), b = await signedPhone(B, theo);
  const t = await hostTournament(a, B, { name: "Watch only", mode: "round_robin", teams: roster({ Lions: 2, Hawks: 2 }) });
  await wait(400);
  await go(b, "#cups"); click(b, `[data-tour="${t.id}"]`); await wait(400);
  assert.ok(!$(b, "#tCodeTxt"), "code not shown to a watcher");
  assert.ok(!$(b, "#tDel"), "watcher cannot delete");
  const row = $(b, ".mrow[data-m]"); assert.match(row.textContent, /Watch/);
  click(b, row); await tick();
  assert.match(text(b), /Watching/);
  assert.ok($(b, '.pcard[data-p="0"]').disabled);
  healthy(a, b);
});

test("tournament: Delete tournament removes it everywhere, including a phone that is watching it", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya), b = await signedPhone(B, theo);
  const t = await hostTournament(a, B, { name: "Doomed", mode: "round_robin", teams: roster({ Lions: 2, Hawks: 2 }) });
  await wait(400);
  await go(b, "#cups"); click(b, `[data-tour="${t.id}"]`); await wait(400);
  assert.equal(view(b), "tour");
  await playOne(a, B, defaultPick);
  click(a, "#tDel"); assert.match($(a, "#tDel").textContent, /Tap again/); click(a, "#tDel"); await wait(800);
  assert.equal(B.db.tournaments.length, 0); assert.equal(tMatches(B, t.id).length, 0); assert.equal(tPlayers(B, t.id).length, 0);
  assert.equal(view(a), "cups"); assert.doesNotMatch(text(a), /Doomed/);
  assert.match($(a, "#toast").textContent, /Tournament deleted/);
  assert.notEqual(view(b), "tour", "watching phone leaves the deleted tournament " + where(b));
  await go(b, "#home"); await wait(100);
  assert.ok(!$$(b, "[data-live]").length, "deleted tournament's matches gone from Live now on the other phone");
  await go(b, "#cups"); assert.doesNotMatch(text(b), /Doomed/);
  healthy(a, b);
});

test("tournament: scorekeeper on a match when the tournament is deleted is sent out cleanly", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya), b = await signedPhone(B, theo);
  const t = await hostTournament(a, B, { name: "Pulled", mode: "bracket", teams: roster({ Lions: 1, Hawks: 1 }) });
  await wait(300);
  await go(b, "#cups"); click(b, "#tJoinBtn"); $(b, "#tjCode").value = t.join_code; await submit(b, "#tjForm"); await wait(500);
  click(b, ".mrow[data-m]"); await tick(); tap(b, 0); await wait(200);
  click(a, "#tDel"); click(a, "#tDel"); await wait(800);
  assert.notEqual(view(b), "game", "the scorer is not left on a deleted match " + where(b));
  healthy(a, b);
});

/* ================================================================
   EVERY SCREEN / NO TWITCHING
   ================================================================ */
test("every screen: guest and signed-in tours of every tab and sheet show no undefined/NaN/null and throw nothing", async () => {
  const g = await guestPhone();
  for (const h of ["#home", "#ladder", "#cups", "#sheets", "#you"]) await go(g, h);
  await go(g, "#home"); await guestStart(g, "Maya", "Theo", 1); click(g, "#optBtn"); click(g, "#sheetRoot [data-close]");
  playGame(g, 0, 2); click(g, "#reportBtn"); await tick(); click(g, "#rematch"); await tick();
  assert.equal(view(g), "new"); assert.equal($(g, "#gA").value, "Maya"); assert.equal($(g, "#gB").value, "Theo");
  click(g, "#backBtn");
  for (const h of ["#home", "#ladder", "#sheets", "#you"]) await go(g, h);
  await go(g, "#ladder"); click(g, "[data-k]"); await tick(); click(g, "#sheetRoot [data-close]");

  const { B, maya, theo } = club();
  const w = await signedPhone(B, maya);
  for (const h of ["#home", "#ladder", "#cups", "#sheets", "#you"]) await go(w, h);
  await go(w, "#home"); click(w, "#joinBtn"); click(w, "#sheetRoot [data-close]");
  await clubStart(w, { opp: theo.id, bestOf: 1 }); click(w, "#optBtn"); click(w, "#sheetRoot [data-close]");
  playGame(w, 1, 5); await wait(300); click(w, "#reportBtn"); await tick(); click(w, "#rematch"); await tick();
  assert.equal(view(w), "new"); assert.equal($(w, `[data-opp="${theo.id}"]`).getAttribute("aria-pressed"), "true", "rematch picks Theo");
  click(w, "#backBtn"); await tick();
  for (const h of ["#home", "#ladder", "#cups", "#sheets", "#you"]) await go(w, h);
  await go(w, "#ladder"); for (const k of $$(w, "[data-k]").map(b => b.dataset.k)) { click(w, `[data-k="${k}"]`); await tick(); click(w, "#sheetRoot [data-close]"); }
  await hostTournament(w, B, { name: "Sweep", mode: "koth", teams: roster({ Lions: 2, Hawks: 1 }) });
  click(w, "#tBack"); await tick(); click(w, "#tJoinBtn"); click(w, "#sheetRoot [data-close]");
  healthy(g, w);
});

test("no twitching: an idle guest result screen is never redrawn", async () => {
  const w = await guestPhone();
  await guestStart(w, "Maya", "Theo", 1);
  const rs = w.__renders; tap(w, 1); await tick(); assert.ok(w.__renders > rs, "render counter works");
  playGame(w, 0, 3); await tick();
  const ov = $(w, ".overlay"); assert.ok(ov);
  const r0 = w.__renders; await wait(5000);
  assert.equal(w.__renders - r0, 0, "result overlay redrawn while idle");
  assert.equal($(w, ".overlay"), ov);
  click(w, "#reportBtn"); await tick();
  const r1 = w.__renders; await wait(5000);
  assert.equal(w.__renders - r1, 0, "report redrawn while idle");
});

test("no twitching: signed-in result screen is not redrawn after it appears (own echo, ladder reload)", async () => {
  const { B, maya, theo } = club();
  const w = await signedPhone(B, maya);
  await clubStart(w, { opp: theo.id, bestOf: 1 });
  playGame(w, 0, 3); await tick(2);
  const ov = $(w, ".overlay"); assert.ok(ov, "overlay appears right after the last tap");
  const r0 = w.__renders; await wait(3000);
  assert.equal(w.__renders - r0, 0, `result screen redrawn ${w.__renders - r0} times after the match ended (each redraw replays the overlay's fade-in animation)`);
});

test("no twitching: idle result screen and report while other tables in the club are scoring", async () => {
  const { B, maya, theo, priya } = club();
  const w = await signedPhone(B, maya);
  const pc = B.client({ as: priya });
  const { data: other } = await pc.from("live_matches").insert({ a_name: "Priya", b_name: "Jonah", a_user: priya.id, best_of: 5, target: 11, first_server: 0, keepers: "owner" }).select().single();
  await clubStart(w, { opp: theo.id, bestOf: 1 });
  playGame(w, 0, 3); await wait(1500);
  const ov = $(w, ".overlay"), r0 = w.__renders;
  for (let i = 0; i < 10; i++) { await pc.rpc("score_point", { p_id: other.id, p_player: i % 2 }); await wait(500); }
  assert.equal(w.__renders - r0, 0, `result overlay redrawn ${w.__renders - r0} times by another table's points`);
  assert.equal($(w, ".overlay"), ov);
  click(w, "#reportBtn"); await tick();
  const r1 = w.__renders;
  for (let i = 0; i < 10; i++) { await pc.rpc("score_point", { p_id: other.id, p_player: i % 2 }); await wait(500); }
  assert.equal(w.__renders - r1, 0, `match report redrawn ${w.__renders - r1} times by another table's points`);
});

test("no twitching: live game screen is not redrawn by other tables' points", async () => {
  const { B, maya, theo, priya } = club();
  const w = await signedPhone(B, maya);
  const pc = B.client({ as: priya });
  const { data: other } = await pc.from("live_matches").insert({ a_name: "Priya", b_name: "Jonah", a_user: priya.id, best_of: 5, target: 11, first_server: 0, keepers: "owner" }).select().single();
  await clubStart(w, { opp: theo.id, bestOf: 1 }); tap(w, 0); await wait(500);
  const r0 = w.__renders;
  for (let i = 0; i < 10; i++) { await pc.rpc("score_point", { p_id: other.id, p_player: i % 2 }); await wait(300); }
  assert.equal(w.__renders - r0, 0, `game screen redrawn ${w.__renders - r0} times by points on another table`);
});

test("no twitching: tournament match result and tournament screen while another table in the tournament scores", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya);
  const t = await hostTournament(a, B, { name: "Busy night", mode: "round_robin", teams: roster({ Lions: 2, Hawks: 2 }) });
  // host's second device scores another table headlessly
  const hc = B.client({ as: maya });
  const ms = tMatches(B, t.id).filter(m => m.round === 0);
  assert.equal(ms.length, 2);
  click(a, `.mrow[data-m="${ms[0].id}"]`); await tick();
  playGame(a, 0, 2); await wait(1500);
  const ov = $(a, ".overlay"); assert.ok(ov);
  const r0 = a.__renders;
  for (let i = 0; i < 6; i++) { await hc.rpc("score_point", { p_id: ms[1].id, p_player: 1 }); await wait(400); }
  assert.equal(a.__renders - r0, 0, `tournament result overlay redrawn ${a.__renders - r0} times while idle`);
  assert.equal($(a, ".overlay"), ov);
  click(a, "#toTour"); await wait(800);
  const r1 = a.__renders; await wait(5000);
  assert.equal(a.__renders - r1, 0, "tournament screen redrawn while nothing happened");
});

test("no twitching: idle home and ladder do not redraw without new data", async () => {
  const { B, maya } = club();
  const w = await signedPhone(B, maya);
  const r0 = w.__renders; await wait(65000);
  assert.equal(w.__renders - r0, 0, `home redrawn ${w.__renders - r0} times in 65 s with nothing new (30 s refresh)`);
});

/* ================================================================
   EXTRA PROBES
   ================================================================ */
test("signed in: undo across a game boundary on a shared match syncs to the other phone", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya), b = await signedPhone(B, theo);
  const id = await clubStart(a, { opp: theo.id, bestOf: 3 });
  await wait(200); click(b, `[data-live="${id}"]`); await tick();
  playGame(a, 0, 3); await wait(400);
  assert.match(text(b), /Game 2 · Best of 3/);
  click(b, "#undoBtn"); await wait(400);
  assert.deepEqual(B.db.live_matches.find(m => m.id === id).games, ["111" + "0".repeat(10)], "server back in game 1 at 10-3");
  for (const w of [a, b]) { assert.match(text(w), /Game 1 · Best of 3/, where(w)); assert.deepEqual([score(w, 0), score(w, 1)], [10, 3]); }
  healthy(a, b);
});

test("tournament: undoing a finished match takes back the next-round match that has not started", async () => {
  const { B, maya } = club();
  const w = await signedPhone(B, maya);
  const t = await hostTournament(w, B, { name: "Take back", mode: "bracket", draw: "seeded", teams: roster({ Lions: 2, Hawks: 2 }) });
  await playOne(w, B, defaultPick);
  const second = $(w, ".mrow[data-m]").dataset.m;
  click(w, `.mrow[data-m="${second}"]`); await tick();
  playGame(w, 1, 5); await wait(800);
  const final = tMatches(B, t.id).find(m => m.round === 1);
  assert.ok(final, "final created");
  click(w, "#overUndo"); await wait(800);
  assert.equal(B.db.live_matches.find(m => m.id === second).status, "live");
  assert.ok(!B.db.live_matches.some(m => m.id === final.id), "unstarted final with the undone winner is removed");
  tap(w, 0); for (let i = 0; i < 12; i++) tap(w, 0); await wait(800); // the other player now comes back to win
  click(w, "#toTour"); await wait(800);
  const f2 = tMatches(B, t.id).filter(m => m.round === 1);
  assert.equal(f2.length, 1, "one final");
  const won = winnerTp(B.db.live_matches.find(m => m.id === second));
  assert.ok(f2[0].a_tp === won || f2[0].b_tp === won, "final has the new winner of the undone match");
  healthy(w);
});

test("tournament: a finished tournament match opens its report and closing returns to the tournament", async () => {
  const { B, maya } = club();
  const w = await signedPhone(B, maya);
  await hostTournament(w, B, { name: "Report back", mode: "round_robin", teams: roster({ Lions: 2, Hawks: 2 }) });
  await playOne(w, B, defaultPick);
  click(w, ".mrow[data-rec]"); await tick();
  assert.equal(view(w), "report", where(w));
  assert.match(text(w), /Part of Report back/);
  click(w, "#closeRep"); await tick();
  assert.equal(view(w), "tour", where(w));
  healthy(w);
});

/* ================================================================
   DOUBLES
   ================================================================ */
const servingName = w => { const s = $(w, ".pcard .serve:not(.rcv)"); return s ? s.textContent.split(" · ")[0].trim() : ""; };
const receivingName = w => { const s = $(w, ".pcard .serve.rcv"); return s ? s.textContent.replace(/receiving/, "").trim() : ""; };
const sheetText = w => w.document.getElementById("sheetRoot").textContent.replace(/\s+/g, " ");
function typeIn(w, id, v) { const e = $(w, "#" + id); assert.ok(e, `expected #${id} ${where(w)}`); e.value = v; e.dispatchEvent(new w.Event("change")); }
async function clubDoubles(w, names, o = {}) {
  click(w, "#newBtn"); await tick();
  click(w, '[data-kind="doubles"]');
  names.forEach((n, i) => typeIn(w, "dn" + (i + 1), n));
  if (o.ds) click(w, '[data-ds="1"]');
  if (o.dr) click(w, '[data-dr="1"]');
  click(w, "#startBtn"); await wait(200);
  assert.equal(view(w), "game", where(w));
  return w.__rally.S.game.id;
}

test("doubles: two phones score a club doubles match together and agree on every server", async () => {
  const { B, maya, theo } = club();
  const a = await signedPhone(B, maya), b = await signedPhone(B, theo);
  const id = await clubDoubles(a, ["Priya", "Theo", "Sam"], { ds: 1 });
  const row = () => B.db.live_matches.find(m => m.id === id);
  assert.equal(row().kind, "doubles"); assert.equal(row().b_user, theo.id);
  await wait(200);
  assert.match(text(b), /Maya & Priya v Theo & Sam/, "Theo sees the doubles match live");
  click(b, `[data-live="${id}"]`); await tick();
  assert.match(text(b), /Both players scoring/);
  assert.equal(servingName(a), "Priya"); assert.equal(receivingName(a), "Theo");
  assert.equal(servingName(b), "Priya"); assert.equal(receivingName(b), "Theo");
  // score from both phones; after every point both show the same server and receiver
  const seq = [0, 1, 1, 0, 0, 0, 1, 0, 1, 0];
  for (let i = 0; i < seq.length; i++) {
    tap(i % 2 ? b : a, seq[i]); await wait(150);
    assert.equal(servingName(a), servingName(b), "same server after point " + (i + 1));
    assert.equal(receivingName(a), receivingName(b), "same receiver after point " + (i + 1));
  }
  // 10 points = 5 turns done (Priya>Theo, Theo>Maya, Maya>Sam, Sam>Priya, Priya>Theo): turn 6 is Theo>Maya
  assert.equal(servingName(a), "Theo"); assert.equal(receivingName(a), "Maya");
  while (row().games.length === 1) { tap(a, 0); await wait(80); }
  await wait(300);
  assert.match(sheetText(a), /Game 2: Team white serves/, "the picker opens on Maya's phone");
  assert.match(sheetText(b), /Game 2: Team white serves/, "and on Theo's");
  click(b, '[data-ps="1"]'); click(b, "#pickSave"); await wait(300);
  assert.equal(JSON.stringify(row().picks[1]), JSON.stringify({ s: 1, r: 0 }));
  assert.equal(sheetText(a), "", "Maya's out-of-date picker closes");
  assert.match($(a, "#toast").textContent, /Sam serves to .* \(chosen on another phone\)/);
  assert.equal(servingName(a), "Sam"); assert.equal(servingName(b), "Sam");
  assert.equal(receivingName(a), receivingName(b));
  for (let i = 0; i < 11; i++) { tap(i % 2 ? a : b, 1); await wait(60); }
  await wait(300);
  // game 3 is the decider: orange serves; Maya picks herself
  assert.match(sheetText(a), /Game 3: Team orange serves/);
  click(a, '[data-ps="0"]'); click(a, "#pickSave"); await wait(300);
  assert.equal(servingName(b), "Maya");
  for (let i = 0; i < 4; i++) { tap(a, 0); await wait(60); }
  const before = receivingName(b);
  tap(a, 0); await wait(200);
  assert.match($(a, "#toast").textContent, /receiving pair swap/);
  assert.notEqual(receivingName(b), before, "the receivers swapped on Theo's phone too");
  assert.equal(receivingName(a), receivingName(b));
  while (row().status !== "done") { tap(b, 0); await wait(60); }
  await wait(400);
  assert.match($(a, ".overlay").textContent, /Maya & Priya win 2–1/);
  assert.match($(b, ".overlay").textContent, /Maya & Priya win 2–1/);
  const rec = B.db.matches.find(m => m.id === id).data;
  assert.equal(rec.kind, "doubles"); assert.equal(rec.picks.length, 3);
  click(b, "#homeBtn"); await tick();
  await go(b, "#ladder");
  assert.doesNotMatch(text(b), /Maya & Priya/, "singles ladder has no pairs");
  click(b, '[data-lk="doubles"]'); await tick();
  assert.match(text(b), /Maya & Priya\s*1020/);
  assert.match(text(b), /Theo & Sam\s*980/);
  healthy(a, b);
});

test("doubles: a club member who is not a scorekeeper watches and cannot pick the server", async () => {
  const { B, maya, priya } = club();
  const a = await signedPhone(B, maya), p = await signedPhone(B, priya);
  const id = await clubDoubles(a, ["Priya", "Theo", "Sam"]);
  await wait(200);
  click(p, `[data-live="${id}"]`); await tick();
  assert.match(text(p), /Watching/);
  assert.equal($(p, "#pickBtn"), null);
  while (B.db.live_matches.find(m => m.id === id).games.length === 1) { tap(a, 0); await wait(60); }
  await wait(300);
  assert.equal(sheetText(p), "", "no picker for a watcher");
  assert.match(sheetText(a), /Game 2/);
  healthy(a, p);
});

test("doubles: guest best of 5 to 21 points, decider swap at 10, report, PDF and rematch", async () => {
  const w = boot(null, { pdf: true }); await tick(); click(w, "#guestBtn"); await tick();
  click(w, "#newBtn"); await tick(); click(w, '[data-kind="doubles"]');
  ["Ali", "Sam", "Jo", "Kai"].forEach((n, i) => typeIn(w, "dn" + i, n));
  click(w, '[data-best="5"]'); click(w, '[data-target="21"]');
  click(w, "#startBtn"); await tick();
  assert.match($(w, ".pcard .serve").textContent, /Ali · serve 1 of 5/);
  for (let i = 0; i < 4; i++) tap(w, 0);
  assert.match($(w, ".pcard .serve").textContent, /Ali · serve 5 of 5/);
  tap(w, 0);
  assert.equal(servingName(w), "Jo", "21-point games pass the serve after 5");
  const win = (p, n = 21) => { for (let i = 0; i < n; i++) tap(w, p); };
  const dismiss = () => { const x = w.document.querySelector("#sheetRoot [data-close]"); if (x) x.click(); };
  win(0, 16);
  for (const p of [1, 0, 1]) { dismiss(); win(p); }
  assert.match(text(w), /Game 5/);
  dismiss();
  for (let i = 0; i < 9; i++) tap(w, 1);
  const before = receivingName(w);
  tap(w, 1);
  assert.match($(w, "#toast").textContent, /receiving pair swap/, "21-point decider swaps at 10");
  assert.notEqual(receivingName(w), before);
  win(1, 11);
  assert.match($(w, ".overlay").textContent, /Jo & Kai win 3–2/);
  click(w, "#reportBtn"); await tick();
  assert.match(text(w), /Jo & Kai win/);
  assert.match(text(w), /Doubles ladder/);
  click(w, "#repPdf"); await wait(100);
  assert.equal(w.__pdfs.length, 1, "PDF made: " + $(w, "#toast").textContent);
  assert.ok(w.__pdfs[0].pdf.includes("Doubles"), "PDF labels the doubles match");
  click(w, "#rematch"); await tick();
  assert.equal(view(w), "new");
  assert.equal(JSON.stringify(["dn0", "dn1", "dn2", "dn3"].map(id => $(w, "#" + id).value)), JSON.stringify(["Ali", "Sam", "Jo", "Kai"]));
  assert.equal($(w, '[data-kind="doubles"]').getAttribute("aria-pressed"), "true");
  healthy(w);
});

test("doubles: undo across a game boundary keeps the chosen server for the next game", async () => {
  const w = await guestPhone();
  click(w, "#newBtn"); await tick(); click(w, '[data-kind="doubles"]');
  ["Ali", "Sam", "Jo", "Kai"].forEach((n, i) => typeIn(w, "dn" + i, n));
  click(w, "#startBtn"); await tick();
  for (let i = 0; i < 11; i++) tap(w, 0);
  click(w, '[data-ps="1"]'); click(w, "#pickSave"); await tick();
  assert.equal(servingName(w), "Kai");
  click(w, "#undoBtn");
  assert.match(text(w), /Game 1/);
  assert.equal(servingName(w), "Jo", "back in game 1 at 10-0 (turn 6: Jo to Sam) the rotation is game 1's"); assert.equal(receivingName(w), "Sam");
  tap(w, 0);
  assert.match(text(w), /Game 2/);
  assert.equal(sheetText(w), "", "the server for game 2 was already chosen");
  assert.equal(servingName(w), "Kai");
  healthy(w);
});
