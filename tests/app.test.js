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
  let authCb = null, rt = null;
  const tables = { matches: opts.matches || [], profiles: opts.profiles || [{ id: ME.id, name: "Maya" }, { id: "u-theo", name: "Theo" }], live_matches: opts.live || [] };
  const from = table => {
    const st = { table, op: "select", filters: [], payload: null, single: false };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; },
      eq(c, v) { st.filters.push([c, v]); return q; },
      insert(p) { st.op = "insert"; st.payload = p; return q; }, update(p) { st.op = "update"; st.payload = p; return q; }, delete() { st.op = "delete"; return q; },
      single() { st.single = true; return q; }, maybeSingle() { st.single = true; return q; },
      then(res, rej) {
        calls.push(st);
        let data = null;
        if (st.op === "insert" && table === "live_matches") { data = liveRow(Object.assign({ id: "22222222-2222-2222-2222-222222222222" }, st.payload)); tables.live_matches.push(data); }
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
    channel: () => ({ on(_e, _f, h) { rt = h; return this; }, subscribe() { return this; } }),
    removeChannel() {}
  };
  return { client, calls, tables, emit: p => rt && rt(p) };
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
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]), ["vendor/supabase.js", "config.js", "rules.js", "app.js"]);
  assert.match(html, /viewport-fit=cover/);
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
