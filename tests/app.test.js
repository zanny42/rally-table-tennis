// End-to-end in jsdom: the real index.html and app.js, with a fake Supabase client standing in for the server.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const Rules = require("../www/rules.js");

const www = path.join(__dirname, "..", "www");
const html = fs.readFileSync(path.join(www, "index.html"), "utf8");
const rules = fs.readFileSync(path.join(www, "rules.js"), "utf8");
const app = fs.readFileSync(path.join(www, "app.js"), "utf8");
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)); };
const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });

const ME = { id: "u-me", email: "maya@example.com" };
function liveRow(over) {
  return Object.assign({ id: "11111111-1111-1111-1111-111111111111", owner: ME.id, a_name: "Maya", b_name: "Theo", a_user: ME.id, b_user: "u-theo",
    best_of: 3, target: 11, first_server: 0, keepers: "players", join_code: "4821", games: [""], status: "live", version: 0,
    started_at: new Date().toISOString(), updated_at: new Date().toISOString(), ended_at: null }, over || {});
}
function fakeSupabase(opts = {}) {
  const calls = [];
  let session = opts.session === undefined ? { user: ME } : opts.session;
  let authCb = null; const rt = {};
  const tables = { matches: opts.matches || [], profiles: opts.profiles || [{ id: ME.id, name: "Maya" }, { id: "u-theo", name: "Theo" }], live_matches: opts.live || [], tournaments: opts.tournaments || [], tournament_players: opts.tplayers || [], tournament_keepers: opts.tkeepers || [] };
  let nextId = 1;
  const from = table => {
    const st = { table, op: "select", filters: [], payload: null, single: false };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(c, v) { st.filters.push([c, v]); return q; },
      insert(p) { st.op = "insert"; st.payload = p; return q; }, update(p) { st.op = "update"; st.payload = p; return q; }, delete() { st.op = "delete"; return q; },
      single() { st.single = true; return q; }, maybeSingle() { st.single = true; return q; },
      then(res, rej) {
        // opts.hold(st) may return a promise to hold this query (and its read of the tables) until it resolves
        const held = opts.hold && opts.hold(st);
        if (held) return held.then(() => q.then(res, rej));
        calls.push(st);
        // opts.fault(st) may return an error object to fail this query with
        const fault = opts.fault && opts.fault(st);
        if (fault) return Promise.resolve({ data: null, error: fault }).then(res, rej);
        let data = null;
        if (st.op === "insert" && table === "live_matches" && !st.payload.tournament_id) { data = liveRow(Object.assign({ id: "22222222-2222-2222-2222-222222222222" }, st.payload)); tables.live_matches.push(data); }
        else if (st.op === "insert" && table === "live_matches") {
          if (tables.live_matches.some(r => r.tournament_id === st.payload.tournament_id && r.round === st.payload.round && r.slot === st.payload.slot)) return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate" } }).then(res, rej);
          data = liveRow(Object.assign({ id: "lm" + (nextId++) }, st.payload)); tables.live_matches.push(data);
        }
        else if (st.op === "insert" && table === "tournaments") { data = Object.assign({ id: "t" + (nextId++), owner: ME.id, seed: 12345, join_code: "7777", status: "live", champion: null, created_at: new Date().toISOString(), ended_at: null }, st.payload); tables.tournaments.push(data); }
        else if (st.op === "insert" && table === "tournament_players") { data = [].concat(st.payload).map(p => Object.assign({ id: "tp" + (nextId++), joined_round: 0, user_id: null }, p)); tables.tournament_players.push(...data); }
        else if (st.op === "update") { tables[table].filter(r => st.filters.every(([c, v]) => r[c] === v)).forEach(r => Object.assign(r, st.payload)); }
        else if (st.op === "delete") { tables[table] = tables[table].filter(r => !st.filters.every(([c, v]) => r[c] === v)); }
        else if (st.op === "select") { data = tables[table].filter(r => st.filters.every(([c, v]) => r[c] === v)); if (st.single) data = data[0] || null; }
        return Promise.resolve({ data, error: null }).then(res, rej);
      }
    };
    return q;
  };
  const rpc = async (fn, args) => {
    calls.push({ rpc: fn, args });
    if (opts.rpc) return opts.rpc(fn, args, tables);
    const row = tables.live_matches.find(r => r.id === args.p_id);
    if (fn === "score_point") {
      const r = Rules.applyPoint(row.games, args.p_player, row.best_of, row.target);
      Object.assign(row, { games: r.games, status: r.done ? "done" : "live", version: row.version + 1 });
      return { data: Object.assign({}, row), error: null };
    }
    if (fn === "undo_point") { Object.assign(row, { games: Rules.undoPoint(row.games), status: "live", version: row.version + 1 }); return { data: Object.assign({}, row), error: null }; }
    if (fn === "join_match") return { data: tables.live_matches.find(r => r.join_code === args.p_code)?.id || null, error: null };
    return { data: null, error: null };
  };
  const client = {
    from, rpc,
    auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange: cb => { authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithPassword: async c => { calls.push({ signIn: c.email }); session = { user: Object.assign({}, ME, { email: c.email }) }; authCb && authCb("SIGNED_IN", session); return { data: { session }, error: null }; },
      signUp: async () => ({ data: { session: null }, error: null }),
      signOut: async () => { session = null; authCb && authCb("SIGNED_OUT", null); return { error: null }; }
    },
    channel: () => ({ on(_e, f, h) { rt[f.table] = h; return this; }, subscribe() { return this; } }),
    removeChannel() {}
  };
  return { client, calls, tables, emit: (p, table = "live_matches") => rt[table] && rt[table](p) };
}
function boot(fake) {
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), { url: "https://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window; windows.push(w);
  w.scrollTo = () => {};
  w.RALLY_CONFIG = fake ? { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon" } : {};
  if (fake) w.supabase = { createClient: () => fake.client };
  w.eval(rules); w.eval(app);
  return w;
}
const $ = (w, s) => w.document.querySelector(s);
const text = w => w.document.getElementById("app").textContent;
const tap = (w, p) => $(w, `.pcard[data-p="${p}"]`).click();

test("index.html loads the Supabase client, config, rules and app in order", () => {
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]), ["vendor/supabase.js", "vendor/jspdf.js", "vendor/jspdf-autotable.js", "config.js", "rules.js", "app.js"]);
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /user-scalable=no/, "double-tap zoom is off");
  assert.match(html, /touch-action:manipulation/);
  assert.match(html, /prefers-reduced-motion/);
});

test("guest plays a full best-of-3 match on the phone", async () => {
  const w = boot(null);
  await settle();
  assert.match(text(w), /Let's rally/);
  $(w, "#guestBtn").click();
  assert.match(text(w), /Ready to rally/);
  $(w, "#newBtn").click();
  $(w, "#gA").value = "Maya"; $(w, "#gB").value = "Theo";
  $(w, "#startBtn").click(); await settle();
  assert.match(text(w), /Game 1 · Best of 3/);
  assert.ok($(w, '.pcard[data-p="0"] .serve'), "orange serves first");
  for (let i = 0; i < 10; i++) tap(w, 0);
  assert.match($(w, '.pcard[data-p="0"] .badge').textContent, /Game point/);
  tap(w, 0);
  assert.match(text(w), /Game 2 · Best of 3/);
  $(w, "#undoBtn").click();
  assert.match(text(w), /Game 1 · Best of 3/);
  tap(w, 0);
  for (let i = 0; i < 10; i++) tap(w, 1);
  for (let i = 0; i < 10; i++) tap(w, 0);
  assert.match($(w, ".net").textContent, /Deuce/);
  tap(w, 1); tap(w, 1);
  assert.match(text(w), /Game 3 · Best of 3/);
  for (let i = 0; i < 11; i++) tap(w, 0);
  assert.match($(w, ".overlay").textContent, /Maya wins 2–1/);
  $(w, "#reportBtn").click();
  assert.match(text(w), /Maya wins2–1/);
  assert.match(text(w), /Saved on this phone/);
  assert.equal(JSON.parse(w.localStorage.getItem("rally.local")).length, 1);
  w.location.hash = "#sheets"; w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  $(w, "#closeRep") && $(w, "#closeRep").click();
  assert.match(text(w), /Score sheets/);
  assert.match(text(w), /11–0/);
});

test("signing in calls Supabase and lands on the club home", async () => {
  const fake = fakeSupabase({ session: null });
  const w = boot(fake);
  await settle();
  $(w, "#aEmail").value = "maya@example.com"; $(w, "#aPass").value = "secret12";
  $(w, "#authForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
  await settle();
  assert.ok(fake.calls.find(c => c.signIn === "maya@example.com"));
  assert.match(text(w), /Maya/);
  assert.match(text(w), /Live now/);
});

test("starts a shared match and scores through the server", async () => {
  const fake = fakeSupabase();
  const w = boot(fake);
  await settle();
  $(w, "#newBtn").click();
  $(w, '[data-opp="u-theo"]').click();
  $(w, '[data-best="1"]').click();
  $(w, "#startBtn").click(); await settle();
  const ins = fake.calls.find(c => c.op === "insert");
  assert.deepEqual(JSON.parse(JSON.stringify([ins.payload.a_name, ins.payload.b_name, ins.payload.b_user, ins.payload.best_of, ins.payload.keepers])), ["Maya", "Theo", "u-theo", 1, "players"]);
  assert.match(text(w), /Both players scoring/);
  tap(w, 1); await settle();
  const r = fake.calls.find(c => c.rpc === "score_point");
  assert.deepEqual(JSON.parse(JSON.stringify(r.args)), { p_id: "22222222-2222-2222-2222-222222222222", p_player: 1 });
  assert.equal($(w, '.pcard[data-p="1"] .score').textContent, "1");
  // another phone scores: realtime pushes a newer version
  const row = fake.tables.live_matches[0];
  fake.emit({ eventType: "UPDATE", new: Object.assign({}, row, { games: ["11"], version: row.version + 1 }) });
  await settle();
  assert.equal($(w, '.pcard[data-p="1"] .score').textContent, "2");
  $(w, "#optBtn").click();
  assert.match($(w, "#codeTxt").textContent, /4821/);
});

test("a club member who isn't a scorekeeper can watch but not score", async () => {
  const fake = fakeSupabase({ live: [liveRow({ owner: "u-priya", a_name: "Priya", b_name: "Jonah", a_user: "u-priya", b_user: "u-jonah", games: ["0101"] })] });
  const w = boot(fake);
  await settle();
  assert.match(text(w), /Priya v Jonah/);
  $(w, "[data-live]").click();
  assert.match(text(w), /Watching/);
  assert.ok($(w, '.pcard[data-p="0"]').disabled);
  assert.equal(fake.calls.filter(c => c.rpc === "score_point").length, 0);
});

test("a rejected point is rolled back on screen", async () => {
  const fake = fakeSupabase({ live: [liveRow()], rpc: async () => ({ data: null, error: { code: "42501", message: "no" } }) });
  const w = boot(fake);
  await settle();
  $(w, "[data-live]").click();
  tap(w, 0);
  assert.equal($(w, '.pcard[data-p="0"] .score').textContent, "1", "optimistic update");
  await settle();
  assert.equal($(w, '.pcard[data-p="0"] .score').textContent, "0", "rolled back");
  assert.match($(w, "#toast").textContent, /not a scorekeeper/);
});

test("the ladder ranks finished matches from the server", async () => {
  const rec = (id, a, b, winner, t) => ({ id, by: ME.id, data: { a, b, aKey: Rules.keyOf(a), bKey: Rules.keyOf(b), bestOf: 1, target: 11, firstServer: 0, g: [winner ? "1".repeat(11) : "0".repeat(11)], winner, gw: winner ? [0, 1] : [1, 0], startedAt: t - 1000, endedAt: t } });
  const fake = fakeSupabase({ matches: [rec("m1", "Maya", "Theo", 0, 1), rec("m2", "Theo", "Sam", 0, 2)] });
  const w = boot(fake);
  await settle();
  w.location.hash = "#ladder"; w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  assert.match(text(w), /Top of the ladder/);
  assert.match(text(w), /Maya1020/);
  assert.match(text(w), /Sam/);
});

/* ---------- tournaments ---------- */
const go = (w, h) => { w.location.hash = h; w.dispatchEvent(new w.HashChangeEvent("hashchange")); };
const type = (w, sel, v) => { const el = $(w, sel); el.value = v; el.dispatchEvent(new w.Event("input", { bubbles: true })); };
const wait = ms => new Promise(r => setTimeout(r, ms));
/* Fills in the New tournament form: teams first, then { team: [names] } ("" = no team). */
function fillTour(w, { name = "Club night", mode, draw, teams = [], players = {} }) {
  type(w, "#tnName", name);
  if (mode) $(w, `[data-mode="${mode}"]`).click();
  if (draw) $(w, `[data-draw="${draw}"]`).click();
  for (const t of teams) { type(w, "#tnTeam", t); $(w, "#tnAddTeam").click(); }
  for (const [team, names] of Object.entries(players)) {
    if (teams.length) $(w, `[data-pteam="${team}"]`).click();
    for (const n of names) { type(w, "#tnPlayer", n); $(w, "#tnAddPlayer").click(); }
  }
}
async function hostTour(fake, form) {
  const w = boot(fake);
  await settle();
  go(w, "#cups");
  $(w, "#tNewBtn").click();
  fillTour(w, form);
  $(w, "#tnStart").click();
  await settle(30);
  return w;
}
const tourOf = fake => fake.tables.tournaments[fake.tables.tournaments.length - 1];
const tmatches = (fake, round) => fake.tables.live_matches.filter(m => m.tournament_id === tourOf(fake).id && (round == null || m.round === round));
const finish = (fake, m, winner = 0) => Object.assign(m, { games: [String(winner).repeat(11)], status: "done", version: 11, ended_at: new Date().toISOString() });

test("hosts a Lions v Hawks knockout: every first-round match crosses teams", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const w = boot(fake);
  await settle();
  w.location.hash = "#cups"; w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  $(w, "#tNewBtn").click();
  type(w, "#tnName", "Lions v Hawks");
  for (const team of ["Lions", "Hawks"]) { type(w, "#tnTeam", team); $(w, "#tnAddTeam").click(); }
  const add = (team, names) => { $(w, `[data-pteam="${team}"]`).click(); for (const n of names) { type(w, "#tnPlayer", n); $(w, "#tnAddPlayer").click(); } };
  add("Lions", ["Ali", "Bea", "Cai", "Dev"]);
  add("Hawks", ["Eve", "Fin", "Gus", "Hal"]);
  assert.equal(w.document.querySelectorAll(".pitem").length, 8);
  assert.ok($(w, "#tnCross").checked, "cross-team pairing is on by default");
  $(w, "#tnStart").click();
  await settle(30);
  const t = fake.tables.tournaments[0];
  assert.equal(t.mode, "bracket"); assert.equal(t.cross_team, true);
  const team = Object.fromEntries(fake.tables.tournament_players.map(p => [p.id, p.team]));
  const first = fake.tables.live_matches.filter(m => m.tournament_id === t.id && m.round === 0);
  assert.equal(first.length, 4);
  for (const m of first) assert.notEqual(team[m.a_tp], team[m.b_tp], `${m.a_name} v ${m.b_name}`);
  assert.match(text(w), /Quarter-finals/);
  assert.match(text(w), /Scorekeeper code/);
  // score the first match through and the next round appears
  const m0 = first[0];
  $(w, `[data-m="${m0.id}"]`).click();
  for (let i = 0; i < 11; i++) tap(w, 0);
  await settle(30);
  assert.ok(fake.calls.filter(c => c.rpc === "score_point").length >= 11);
  // back on the bracket, the finished match opens its score sheet, not a scoring screen
  Object.assign(w.__rally.S, { game: null, screen: "tour" }); go(w, "#cups");
  assert.ok($(w, `.bm[data-m="${m0.id}"]`), "finished match is in the bracket");
  $(w, `.bm[data-m="${m0.id}"]`).click();
  assert.equal(w.__rally.S.game, null);
  assert.equal(w.__rally.S.screen, "report");
});

test("King of the hill keeps the winner on and queues the loser", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const w = boot(fake);
  await settle();
  w.location.hash = "#cups"; w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  $(w, "#tNewBtn").click();
  $(w, "#tnName").value = "Friday hill";
  $(w, '[data-mode="koth"]').click();
  $(w, '[data-draw="seeded"]').click();
  for (const n of ["Ali", "Bea", "Cai"]) { $(w, "#tnPlayer").value = n; $(w, "#tnAddPlayer").click(); }
  $(w, "#tnStart").click();
  await settle(30);
  assert.match(text(w), /On the table/);
  assert.match(text(w), /Ali/);
  const m0 = fake.tables.live_matches.find(m => m.round === 0);
  assert.deepEqual([m0.a_name, m0.b_name], ["Ali", "Bea"]);
  // Bea is on the table, so only Cai is waiting in the queue
  assert.match(text(w), /v Bea/);
  assert.match(text(w), /1 waiting/);
  assert.deepEqual([...w.document.querySelectorAll(".plist .nm")].map(e => e.textContent), ["Cai"]);
  // Bea wins: she stays on, Cai challenges next
  $(w, `[data-m="${m0.id}"]`).click();
  for (let i = 0; i < 11; i++) tap(w, 1);
  await settle(40);
  const m1 = fake.tables.live_matches.find(m => m.round === 1);
  assert.ok(m1, "next match created");
  assert.deepEqual([m1.a_name, m1.b_name], ["Bea", "Cai"]);
  // ending it crowns whoever is on the table and sweeps away the match nobody started
  Object.assign(w.__rally.S, { game: null, screen: "tour" }); go(w, "#cups");
  $(w, "#tEnd").click();
  fake.emit({ eventType: "UPDATE", new: Object.assign({}, m0) }); // a refresh between the two taps
  await settle();
  assert.match($(w, "#tEnd").textContent, /Tap again/);
  $(w, "#tEnd").click();
  await settle(30);
  const t = tourOf(fake), bea = fake.tables.tournament_players.find(p => p.name === "Bea");
  assert.equal(t.status, "done");
  assert.equal(t.champion, bea.id);
  assert.ok(!fake.tables.live_matches.some(m => m.id === m1.id), "unstarted match removed");
  assert.match(text(w), /Last one standing/);
});

test("new tournament: team picks stick to players, removing a team frees its players, names are checked", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const w = boot(fake);
  await settle();
  go(w, "#cups"); $(w, "#tNewBtn").click();
  type(w, "#tnName", "Derby");
  $(w, "#tnAddTeam").click();
  assert.match($(w, "#toast").textContent, /team name/, "an empty team name is refused out loud");
  for (const t of ["Lions", "  lions ", "Hawks", "Bears"]) { type(w, "#tnTeam", t); $(w, "#tnAddTeam").click(); }
  assert.match($(w, "#toast").textContent, /already a team/);
  assert.equal(w.document.querySelectorAll("[data-rmteam]").length, 3);
  assert.equal($(w, '[data-pteam="Lions"]').getAttribute("aria-pressed"), "true", "the first team is picked for new players");
  type(w, "#tnPlayer", "Ali"); $(w, "#tnAddPlayer").click();
  $(w, '[data-pteam="Hawks"]').click();
  type(w, "#tnPlayer", "Eve"); $(w, "#tnAddPlayer").click();
  type(w, "#tnPlayer", " ali "); $(w, "#tnAddPlayer").click();
  assert.match($(w, "#toast").textContent, /already in the tournament/);
  assert.equal($(w, "#tnPlayer").value, " ali ", "a refused name stays in the box to fix");
  type(w, "#tnPlayer", "Bo"); $(w, '[data-pteam="Bears"]').click(); $(w, "#tnAddPlayer").click();
  const teamOf = () => [...w.document.querySelectorAll("[data-pteamsel]")].map(s => s.value);
  assert.deepEqual(teamOf(), ["Lions", "Hawks", "Bears"]);
  // move Eve to Lions from her own row
  const sel = w.document.querySelectorAll("[data-pteamsel]")[1];
  sel.value = "Lions"; sel.dispatchEvent(new w.Event("change"));
  assert.deepEqual(teamOf(), ["Lions", "Lions", "Bears"]);
  // removing Lions leaves nobody pointing at it
  $(w, '[data-rmteam="0"]').click();
  assert.deepEqual(teamOf(), ["", "", "Bears"]);
  assert.equal(w.__rally.S.tdraft.team, "Bears", "the picked team survives removing another team");
  assert.ok(!w.__rally.S.tdraft.players.some(p => p.team === "Lions"));
  $(w, "#tnCross").checked = false; $(w, "#tnCross").dispatchEvent(new w.Event("change"));
  $(w, "#tnStart").click();
  await settle(30);
  assert.deepEqual(fake.tables.tournament_players.map(p => [p.name, p.team, p.position]), [["Ali", "", 0], ["Eve", "", 1], ["Bo", "Bears", 2]]);
  assert.equal(tourOf(fake).cross_team, false);
});

test("new tournament: cross-team pairing needs players in two teams, in every format", async () => {
  for (const mode of ["bracket", "koth", "round_robin"]) {
    const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
    const w = await hostTour(fake, { mode, teams: ["Lions", "Hawks"], players: { Lions: ["Ali", "Bea", "Cai"] } });
    assert.equal(fake.tables.tournaments.length, 0, mode);
    assert.match($(w, "#tnErr").textContent, /two teams/, mode);
  }
});

test("new tournament: the draft survives realtime refreshes and leaving the screen", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const w = boot(fake);
  await settle();
  go(w, "#cups"); $(w, "#tNewBtn").click();
  type(w, "#tnName", "Friday cup");
  type(w, "#tnPlayer", "Ali"); $(w, "#tnAddPlayer").click();
  type(w, "#tnPlayer", "Be");
  $(w, "#tnPlayer").focus();
  fake.emit({ eventType: "INSERT", new: liveRow({ id: "x1", owner: "u-theo" }) });
  fake.emit({ eventType: "INSERT", new: { id: "t-other", mode: "koth" } }, "tournaments");
  await wait(350); await settle();
  assert.equal($(w, "#tnName").value, "Friday cup", "typed name kept");
  assert.equal($(w, "#tnPlayer").value, "Be", "half-typed player kept");
  assert.equal(w.document.activeElement && w.document.activeElement.id, "tnPlayer", "focus kept");
  $(w, "#tnBack").click();
  go(w, "#home"); go(w, "#cups");
  $(w, "#tNewBtn").click();
  assert.equal($(w, "#tnName").value, "Friday cup");
  assert.equal(w.document.querySelectorAll(".pitem").length, 1);
  assert.ok(JSON.parse(w.localStorage.getItem("rally.tdraft")).d.players.length === 1, "kept on the phone too");
});

test("new tournament: a double tap on Start creates one tournament", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const w = boot(fake);
  await settle();
  go(w, "#cups"); $(w, "#tNewBtn").click();
  fillTour(w, { players: { "": ["Ali", "Bea"] } });
  $(w, "#tnStart").click();
  fake.emit({ eventType: "INSERT", new: liveRow({ id: "x1", owner: "u-theo" }) }); // a refresh redraws the button mid-start
  $(w, "#tnStart") && $(w, "#tnStart").click();
  await settle(30);
  assert.equal(fake.tables.tournaments.length, 1);
  assert.equal(fake.tables.tournament_players.length, 2);
  assert.equal(w.localStorage.getItem("rally.tdraft"), null, "draft cleared once started");
});

test("seeded knockout: players on equal ratings alternate teams, so teammates don't meet in round one", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  await hostTour(fake, { mode: "bracket", draw: "seeded", teams: ["Lions", "Hawks"], players: { Lions: ["Ali", "Bea", "Cai"], Hawks: ["Eve", "Fin", "Gus"] } });
  const team = Object.fromEntries(fake.tables.tournament_players.map(p => [p.id, p.team]));
  assert.deepEqual(fake.tables.tournament_players.map(p => p.name), ["Ali", "Eve", "Bea", "Fin", "Cai", "Gus"]);
  const first = tmatches(fake, 0);
  assert.equal(first.length, 2);
  for (const m of first) assert.notEqual(team[m.a_tp], team[m.b_tp], `${m.a_name} v ${m.b_name}`);
});

test("a tournament match finished from the Home list still advances the tournament", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const w = await hostTour(fake, { mode: "bracket", players: { "": ["Ali", "Bea"] } });
  const [fin] = tmatches(fake, 0);
  $(w, "#tBack").click(); go(w, "#home");
  fake.emit({ eventType: "INSERT", new: Object.assign({}, fin) });
  $(w, `[data-live="${fin.id}"]`).click();
  for (let i = 0; i < 11; i++) tap(w, 0);
  await settle(40);
  const t = tourOf(fake);
  assert.equal(t.status, "done", "not stuck live");
  assert.equal(t.champion, fin.a_tp);
});

test("a semi-final finishing while the other result is being processed still creates the final", async () => {
  const opts = { profiles: [{ id: ME.id, name: "Maya" }] };
  const fake = fakeSupabase(opts);
  const w = await hostTour(fake, { mode: "bracket", players: { "": ["Ali", "Bea", "Cai", "Dev"] } });
  const [a, b] = tmatches(fake, 0);
  // hold the second read of the tournament after the first result, so that pass is still running when the second arrives
  let release, n = 0; const gate = new Promise(r => release = r), seen = new WeakSet();
  opts.hold = st => { if (st.table !== "tournaments" || st.op !== "select" || !st.single || seen.has(st)) return null; seen.add(st); return ++n === 2 ? gate : null; };
  finish(fake, a); fake.emit({ eventType: "UPDATE", new: Object.assign({}, a) });
  await settle(20);
  finish(fake, b); fake.emit({ eventType: "UPDATE", new: Object.assign({}, b) });
  await settle(20);
  release(); await settle(40);
  const final = tmatches(fake, 1);
  assert.equal(final.length, 1, "final created");
  assert.deepEqual([final[0].a_tp, final[0].b_tp].sort(), [a.a_tp, b.a_tp].sort());
  assert.match(text(w), /Final/);
});

test("a tournament match removed by another phone is put back, and old realtime updates don't overwrite new ones", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const w = await hostTour(fake, { mode: "bracket", players: { "": ["Ali", "Bea", "Cai", "Dev"] } });
  const [a] = tmatches(fake, 0);
  fake.emit({ eventType: "UPDATE", new: Object.assign({}, a, { games: ["00"], version: 2 }) });
  fake.emit({ eventType: "UPDATE", new: Object.assign({}, a, { games: ["0"], version: 1 }) });
  assert.deepEqual(w.__rally.S.tour.matches.find(m => m.id === a.id).games, ["00"]);
  fake.tables.live_matches = fake.tables.live_matches.filter(m => m.id !== a.id);
  fake.emit({ eventType: "DELETE", old: { id: a.id } });
  await wait(120); await settle(30);
  const back = tmatches(fake, 0).filter(m => m.slot === a.slot);
  assert.equal(back.length, 1, "slot filled again");
  assert.deepEqual([back[0].a_tp, back[0].b_tp], [a.a_tp, a.b_tp]);
  assert.ok(w.__rally.S.tour.matches.some(m => m.id === back[0].id));
});

test("tournament realtime: a change isn't lost behind an event for another tournament, and a deleted tournament closes", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const w = await hostTour(fake, { name: "Hill", mode: "koth", players: { "": ["Ali", "Bea", "Cai"] } });
  const t = tourOf(fake);
  Object.assign(t, { status: "done", ended_at: new Date().toISOString() }); // another keeper ended it
  fake.emit({ eventType: "UPDATE", new: Object.assign({}, t) }, "tournaments");
  fake.emit({ eventType: "UPDATE", new: { id: "t-other", mode: "bracket", status: "live" } }, "tournaments");
  await wait(350); await settle(20);
  assert.match(text(w), /finished/);
  fake.tables.tournaments = [];
  fake.emit({ eventType: "DELETE", old: { id: t.id } }, "tournaments");
  await wait(350); await settle(20);
  assert.equal(w.__rally.S.screen, null);
  assert.match($(w, "#toast").textContent, /deleted/);
  assert.match(text(w), /Tournaments/);
});

test("King of the hill: a late player joins one of this tournament's teams, never a stale pick", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const w = await hostTour(fake, { mode: "koth", draw: "seeded", teams: ["Lions", "Hawks"], players: { Lions: ["Ali"], Hawks: ["Eve"] } });
  w.__rally.S.kteam = "Bears"; // picked in another tournament
  go(w, "#cups");
  assert.equal($(w, '[data-kteam="Lions"]').getAttribute("aria-pressed"), "true");
  type(w, "#kAdd", "Zed");
  $(w, "#kAddBtn").click(); $(w, "#kAddBtn").click();
  await settle(30);
  const zed = fake.tables.tournament_players.filter(p => p.name === "Zed");
  assert.equal(zed.length, 1, "added once");
  assert.equal(zed[0].team, "Lions");
  assert.equal(zed[0].joined_round, 1);
  assert.match(text(w), /Zed/);
});

test("someone who isn't a scorekeeper can follow a tournament but not run it", async () => {
  const tour = { id: "t9", owner: "u-priya", name: "Priya's cup", mode: "bracket", cross_team: false, draw: "seeded", seed: 1, best_of: 1, target: 11, join_code: "1234", status: "live", champion: null, created_at: new Date().toISOString(), ended_at: null };
  const long = "Bartholomew-Fitzgerald Longname";
  const tplayers = [["p1", "Ali"], ["p2", long], ["p3", "Cai"], ["p4", "Dev"]].map(([id, name], i) => ({ id, tournament_id: "t9", name, team: "", position: i, joined_round: 0, user_id: null }));
  const live = [liveRow({ id: "lmA", owner: "u-priya", keepers: "tournament", tournament_id: "t9", round: 0, slot: 0, a_tp: "p1", b_tp: "p4", a_name: "Ali", b_name: "Dev" })];
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }], tournaments: [tour], tplayers, live });
  const w = boot(fake);
  await settle();
  go(w, "#cups");
  $(w, '[data-tour="t9"]').click();
  await settle(20);
  assert.match(text(w), /Semi-finals/);
  assert.ok(!$(w, "#tCodeTxt") && !$(w, "#tDel") && !$(w, "#tEnd"), "no host controls");
  assert.match($(w, '.mrow[data-m="lmA"] .tag').textContent, /Watch/);
  assert.match(text(w), /1 match is waiting for a scorekeeper/);
  assert.equal(fake.tables.live_matches.length, 1, "a watcher's phone creates nothing");
  $(w, "#tBack").click();
  assert.equal(w.location.hash, "#cups");
  assert.match(text(w), /Priya's cup/);
});

test("scorekeepers are recognised from the server on any phone, and tournament codes that clash are retried", async () => {
  const tour = { id: "t9", owner: "u-priya", name: "Priya's cup", mode: "koth", cross_team: false, draw: "seeded", seed: 1, best_of: 1, target: 11, join_code: "1234", status: "live", champion: null, created_at: new Date().toISOString(), ended_at: null };
  const tplayers = ["Ali", "Bea"].map((name, i) => ({ id: "p" + i, tournament_id: "t9", name, team: "", position: i, joined_round: 0, user_id: null }));
  let clashes = 0;
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }], tournaments: [tour], tplayers, tkeepers: [{ tournament_id: "t9", user_id: ME.id }],
    fault: st => st.table === "tournaments" && st.op === "insert" && !clashes++ ? { code: "23505", message: "join code taken" } : null });
  const w = boot(fake);
  await settle();
  assert.ok(w.__rally.S.tkeep.has("t9"), "keeper row loaded after sign-in");
  go(w, "#cups"); $(w, '[data-tour="t9"]').click(); await settle(30);
  assert.ok($(w, "#tCodeTxt"), "joined on another phone, still a scorekeeper here");
  assert.equal(tmatches(fake).length, 1, "and this phone runs the table");
  $(w, "#tBack").click();
  $(w, "#tNewBtn").click();
  fillTour(w, { name: "Retry cup", players: { "": ["Cai", "Dev"] } });
  $(w, "#tnStart").click(); await settle(30);
  assert.equal(fake.tables.tournaments.filter(t => t.name === "Retry cup").length, 1, "created on the second try");
  assert.equal(w.__rally.S.screen, "tour");
});

test("a match left half-played when King of the hill ends drops out of Live now", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const w = await hostTour(fake, { name: "Hill stop", mode: "koth", players: { "": ["Ali", "Bea", "Cai"] } });
  const [m] = tmatches(fake, 0);
  Object.assign(m, { games: ["010"], version: 3 });
  fake.emit({ eventType: "UPDATE", new: Object.assign({}, m) });
  await settle();
  $(w, "#tEnd").click(); $(w, "#tEnd").click(); await settle(30);
  assert.equal(tourOf(fake).status, "done");
  assert.ok(!fake.tables.live_matches.some(x => x.id === m.id), "half-played match removed");
  // even if another phone still reports it live, Home doesn't list a finished tournament's match
  fake.emit({ eventType: "UPDATE", new: Object.assign({}, m, { version: 4 }) });
  $(w, "#tBack").click(); go(w, "#home"); await settle();
  assert.ok(!$(w, `[data-live="${m.id}"]`));
});

test("exports a tournament as a real PDF", async () => {
  const fake = fakeSupabase({ profiles: [{ id: ME.id, name: "Maya" }] });
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), { url: "https://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window; windows.push(w); w.scrollTo = () => {};
  w.RALLY_CONFIG = { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon" }; w.supabase = { createClient: () => fake.client };
  w.eval(fs.readFileSync(path.join(www, "vendor", "jspdf.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(www, "vendor", "jspdf-autotable.js"), "utf8"));
  let saved = null;
  w.jspdf.jsPDF.API.save = function (name) { saved = { name, pdf: this.output() }; };
  w.eval(rules); w.eval(app);
  await settle();
  go(w, "#cups"); $(w, "#tNewBtn").click();
  fillTour(w, { name: "Lions v Hawks", teams: ["Lions", "Hawks"], players: { Lions: ["Ali", "Bea"], Hawks: ["Eve", "Fin"] } });
  $(w, "#tnStart").click(); await settle(30);
  const [a] = tmatches(fake, 0);
  finish(fake, a); fake.emit({ eventType: "UPDATE", new: Object.assign({}, a) }); await settle(30);
  $(w, "#tPdf2").click(); await settle(10);
  assert.ok(saved, "PDF made; toast: " + $(w, "#toast").textContent);
  assert.equal(saved.name, "rally-lions-v-hawks.pdf");
  assert.ok(saved.pdf.startsWith("%PDF-"));
  assert.match(saved.pdf, /Semi-finals/);
});

test("exports match history as a real PDF", async () => {
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), { url: "https://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window; windows.push(w); w.scrollTo = () => {};
  w.RALLY_CONFIG = {};
  w.eval(fs.readFileSync(path.join(www, "vendor", "jspdf.js"), "utf8"));
  w.eval(fs.readFileSync(path.join(www, "vendor", "jspdf-autotable.js"), "utf8"));
  let saved = null;
  w.jspdf.jsPDF.API.save = function (name) { saved = { name, pdf: this.output() }; };
  w.eval(rules); w.eval(app);
  await settle();
  $(w, "#guestBtn").click();
  $(w, "#newBtn").click();
  $(w, '[data-best="1"]').click();
  $(w, "#gA").value = "Maya"; $(w, "#gB").value = "Theo";
  $(w, "#startBtn").click(); await settle();
  for (let i = 0; i < 11; i++) tap(w, 0);
  w.location.hash = "#sheets"; w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  $(w, "#homeBtn") && $(w, "#homeBtn").click();
  w.location.hash = "#sheets"; w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  $(w, "#sheetPdf").click();
  await settle(10);
  assert.ok(saved, "PDF was produced; toast: " + $(w, "#toast").textContent + " view: " + text(w).slice(0, 80));
  assert.match(saved.name, /^rally-history-\d{4}-\d{2}-\d{2}\.pdf$/);
  assert.ok(saved.pdf.startsWith("%PDF-"));
  assert.match(saved.pdf, /Maya v Theo/);
  assert.match(saved.pdf, /11-0/);
});

/* ---------- result screen twitch: no needless repaints, no replayed animations ---------- */
function writes(w, id) {
  const el = w.document.getElementById(id), d = Object.getOwnPropertyDescriptor(w.Element.prototype, "innerHTML"), log = { n: 0 };
  Object.defineProperty(el, "innerHTML", { configurable: true, get() { return d.get.call(this); }, set(v) { log.n++; d.set.call(this, v); } });
  return log;
}
const otherRow = i => liveRow({ id: "other-" + i, owner: "u-priya", a_name: "Priya", b_name: "Jonah", a_user: "u-priya", b_user: "u-jonah", games: ["01".repeat(i % 4)] });
async function finishRemote() {
  const fake = fakeSupabase({ live: [liveRow({ best_of: 1, games: ["0000000000"] })] });
  const w = boot(fake); await settle();
  $(w, "[data-live]").click();
  tap(w, 0); await settle(20);
  return { fake, w };
}

test("twitch: the finished-match card is built once and stays put while realtime updates arrive", async () => {
  const { fake, w } = await finishRemote();
  const card = $(w, ".overlay");
  assert.ok(card, "result card shown");
  assert.match(card.textContent, /Maya wins 1–0/);
  assert.ok(!card.classList.contains("again"), "the first showing fades in");
  assert.ok(!$(w, "#app .overlay"), "the card lives outside the game view, so game repaints can't rebuild it");
  const app = writes(w, "app"), over = writes(w, "overRoot");
  const row = fake.tables.live_matches[0];
  for (let i = 0; i < 6; i++) {
    fake.emit({ eventType: "UPDATE", new: Object.assign({}, row) }); // our own finished row echoed back (also reloads the ladder)
    fake.emit({ eventType: "UPDATE", new: otherRow(i) });            // other tables in the club scoring
    fake.emit({ eventType: "INSERT", new: otherRow(10 + i) });
  }
  await settle(30);
  assert.equal(over.n, 0, "result card never rewritten");
  assert.equal(app.n, 0, "game view underneath never rewritten either");
  assert.equal($(w, ".overlay"), card, "same DOM node, so its fade-in never replays");
});

test("twitch: undo from the result card and finishing again shows the card fresh; a rebuild for the same match doesn't fade again", async () => {
  const { w } = await finishRemote();
  $(w, "#overUndo").click(); await settle(20);
  assert.equal($(w, ".overlay"), null, "card gone after undo");
  assert.equal($(w, '.pcard[data-p="0"] .score').textContent, "10");
  assert.ok(!$(w, ".pcard .pop1, .pcard .pop2"), "undo doesn't pop the score that was taken back");
  tap(w, 0); await settle(20);
  const card = $(w, ".overlay");
  assert.ok(card && !card.classList.contains("again"), "fades in for the new finish");
  // something on the card really changes (this phone stops being a scorekeeper): rebuilt, without replaying the entrance
  const g = w.__rally.S.game; w.__rally.S.joined = new Set(); g.aUser = "u-x"; g.owner = "u-x";
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  const again = $(w, ".overlay");
  assert.notEqual(again, card);
  assert.ok(again.classList.contains("again"), "rebuilt card doesn't animate in a second time");
  assert.ok(!$(w, "#overUndo"), "and it reflects the change");
});

test("twitch: leaving the result clears the card; the match report isn't rewritten by unchanged updates", async () => {
  const { fake, w } = await finishRemote();
  $(w, "#reportBtn").click(); await settle(20);
  assert.equal($(w, "#overRoot").innerHTML, "", "card removed with the game screen");
  assert.match(text(w), /Match report/);
  const app = writes(w, "app");
  for (let i = 0; i < 5; i++) fake.emit({ eventType: "UPDATE", new: otherRow(i) });
  await settle(30);
  assert.equal(app.n, 0, "report left alone, its entrance animations run undisturbed");
  // a real change (another finished match moves the ladder) repaints, resuming the entrance animations instead of replaying or cutting them
  fake.tables.matches.push({ id: "m-old", by: ME.id, data: { a: "Sam", b: "Theo", aKey: "sam", bKey: "theo", bestOf: 1, target: 11, firstServer: 0, g: ["0".repeat(11)], winner: 0, gw: [1, 0], startedAt: 1, endedAt: 2 } });
  fake.emit({ eventType: "UPDATE", new: liveRow({ id: "m-old", status: "done" }) });
  await settle(30);
  assert.ok(app.n >= 1, "repainted for the ladder change");
  const age = parseFloat($(w, "#app").style.getPropertyValue("--age"));
  assert.ok(age >= 0, "entrance animations are offset by how long the screen has been up: " + age);
  assert.ok(!$(w, "#app").classList.contains("still"), "no animation:none snap");
});

test("twitch: CSS never replays entrance animations on the result card, badges or score", () => {
  assert.match(html, /\.overlay\.again\{animation:none\}/);
  assert.match(html, /\.r-up,\.r-grow,\.r-draw\{animation-delay:calc\(var\(--d,0s\) - var\(--age,0s\)\)\}/);
  assert.match(html, /\.badge\.enter\{animation:rIn/);
  assert.doesNotMatch(html, /\.badge\{[^}]*animation/, "badge has no unconditional entrance");
  assert.doesNotMatch(html, /\.overlay\{[^}]*animation:rIn/, "result card doesn't move or scale a full-screen blur layer");
  for (const sel of ["\\.pcard \\.halo", "\\.ball", "\\.live-dot"]) assert.match(html, new RegExp(sel + "\\{[^}]*animation-delay:var\\(--ph,0s\\)"), sel + " keeps its phase across repaints");
});

test("twitch: score pop continues across a repaint and the game-point badge pops only when it first appears", async () => {
  const w = boot(null); await settle();
  let now = 1000000; w.Date.now = () => now;
  $(w, "#guestBtn").click(); $(w, "#newBtn").click();
  $(w, '[data-best="1"]').click();
  $(w, "#gA").value = "Maya"; $(w, "#gB").value = "Theo";
  $(w, "#startBtn").click(); await settle();
  tap(w, 0);
  assert.match($(w, '.pcard[data-p="0"] .score').className, /pop[12]/);
  now += 200; tap(w, 1);
  now += 600; w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  assert.ok(!$(w, ".pcard .pop1, .pcard .pop2"), "pop is gone once it has run");
  // a repaint 150ms into a pop keeps it going at 150ms rather than restarting it
  tap(w, 0); now += 150; $(w, "#swapBtn").click();
  const sc = $(w, '.pcard[data-p="0"] .score');
  assert.match(sc.className, /pop[12]/);
  assert.equal(sc.style.animationDelay, "-150ms");
  for (let i = 0; i < 7; i++) { now += 1000; tap(w, 0); } // 9–1
  now += 1000; tap(w, 0);                                 // 10–1: match point appears
  let b = $(w, '.pcard[data-p="0"] .badge');
  assert.match(b.textContent, /Match point/);
  assert.ok(b.classList.contains("enter"), "badge pops in when it appears");
  now += 1000; tap(w, 1);                                 // 10–2: still match point
  b = $(w, '.pcard[data-p="0"] .badge');
  assert.ok(b && !b.classList.contains("enter"), "a badge that was already there doesn't pop in again");
});

test("twitch: the match clock stops at the finish and isn't part of the change check", async () => {
  const { w } = await finishRemote();
  const real = w.Date.now; w.Date.now = () => real() + 1000;
  w.dispatchEvent(new w.HashChangeEvent("hashchange")); // the final point's pop has run out
  const t = $(w, "#gtimer").textContent;
  const app = writes(w, "app");
  w.Date.now = () => real() + 120000;
  w.dispatchEvent(new w.HashChangeEvent("hashchange")); await settle();
  assert.equal(app.n, 0, "two minutes later the finished game is still not repainted");
  assert.equal($(w, "#gtimer").textContent, t);
});

test("twitch: realtime updates don't wipe what you're typing on the You screen", async () => {
  const fake = fakeSupabase();
  const w = boot(fake); await settle();
  w.location.hash = "#you"; w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  $(w, "#myName").value = "Maya Q";
  fake.emit({ eventType: "INSERT", new: otherRow(1) });
  await settle();
  assert.equal($(w, "#myName").value, "Maya Q");
});
