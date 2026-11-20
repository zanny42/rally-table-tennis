// Doubles in the real app (jsdom): setup, the serve rotation on screen, choosing the server between games,
// the deciding-game swap, the report and the pairs ladder, for a guest and for a signed-in club match.
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

const ME = { id: "u-me", email: "ali@example.com" };
function fake() {
  const calls = [], rows = [];
  const from = table => {
    const st = { table, op: "select", filters: [], payload: null, single: false };
    const q = {
      select() { return q; }, order() { return q; }, limit() { return q; }, eq(c, v) { st.filters.push([c, v]); return q; },
      insert(p) { st.op = "insert"; st.payload = p; return q; }, update(p) { st.op = "update"; st.payload = p; return q; }, delete() { st.op = "delete"; return q; },
      single() { st.single = true; return q; }, maybeSingle() { st.single = true; return q; },
      then(res, rej) {
        calls.push(st);
        let data = [];
        if (table === "profiles") data = [{ id: ME.id, name: "Ali" }, { id: "u-jo", name: "Jo" }];
        if (table === "live_matches" && st.op === "insert") {
          data = Object.assign({ id: "d1", owner: ME.id, join_code: "1234", games: [""], status: "live", version: 0, started_at: new Date().toISOString(), ended_at: null, picks: [] }, st.payload);
          rows.push(data);
        }
        if (st.single && Array.isArray(data)) data = data[0] || null;
        return Promise.resolve({ data, error: null }).then(res, rej);
      }
    };
    return q;
  };
  const rpc = async (fn, args) => {
    calls.push({ rpc: fn, args });
    const row = rows.find(r => r.id === args.p_id);
    if (fn === "score_point") { const r = Rules.applyPoint(row.games, args.p_player, row.best_of, row.target); Object.assign(row, { games: r.games, status: r.done ? "done" : "live", version: row.version + 1 }); }
    else if (fn === "set_pick") { const p = (row.picks || []).slice(0, args.p_game); p.push({ s: args.p_server, r: args.p_receiver }); Object.assign(row, { picks: p, version: row.version + 1 }); }
    else return { data: null, error: null };
    return { data: JSON.parse(JSON.stringify(row)), error: null };
  };
  const client = {
    from, rpc,
    auth: { getSession: async () => ({ data: { session: { user: ME } } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), signOut: async () => ({ error: null }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {}
  };
  return { client, calls, rows };
}
function boot(f) {
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), { url: "https://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window; windows.push(w);
  w.scrollTo = () => {};
  w.RALLY_CONFIG = f ? { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon" } : {};
  if (f) w.supabase = { createClient: () => f.client };
  w.eval(rules); w.eval(app);
  return w;
}
const $ = (w, s) => w.document.querySelector(s);
const text = w => w.document.getElementById("app").textContent;
const tap = (w, p) => $(w, `.pcard[data-p="${p}"]`).click();
const servePill = (w, p) => { const e = $(w, `.pcard[data-p="${p}"] .serve:not(.rcv)`); return e ? e.textContent : ""; };
const rcvPill = (w, p) => { const e = $(w, `.pcard[data-p="${p}"] .serve.rcv`); return e ? e.textContent : ""; };
const sheet = w => w.document.getElementById("sheetRoot").textContent;
const type = (w, id, v) => { const e = $(w, "#" + id); e.value = v; e.dispatchEvent(new w.Event("change")); };

async function guestDoubles(w, best) {
  $(w, "#guestBtn").click();
  $(w, "#newBtn").click();
  $(w, '[data-kind="doubles"]').click();
  assert.match(text(w), /Team orange/); assert.match(text(w), /Team white/);
  type(w, "dn0", "Ali"); type(w, "dn1", "Sam"); type(w, "dn2", "Jo"); type(w, "dn3", "Kai");
  if (best) $(w, `[data-best="${best}"]`).click();
  $(w, '[data-ds="1"]').click(); // Sam serves
  $(w, '[data-dr="1"]').click(); // to Kai
  assert.equal($(w, '[data-ds="1"]').textContent, "Sam");
  assert.equal($(w, '[data-dr="1"]').textContent, "Kai");
  $(w, "#startBtn").click(); await settle();
}

test("doubles: a guest sets up 2v2 and the screen follows the serve round all four players", async () => {
  const w = boot(null); await settle();
  await guestDoubles(w);
  assert.match(text(w), /Ali & Sam/); assert.match(text(w), /Jo & Kai/);
  assert.match(servePill(w, 0), /Sam · serve 1 of 2/);
  assert.match(rcvPill(w, 1), /Kai receiving/);
  assert.match($(w, ".dorder .now").textContent, /Sam → Kai/);
  assert.deepEqual([...w.document.querySelectorAll(".dorder span")].map(e => e.textContent), ["Sam → Kai", "Kai → Ali", "Ali → Jo", "Jo → Sam"]);
  tap(w, 0);
  assert.match(servePill(w, 0), /Sam · serve 2 of 2/);
  tap(w, 1);
  assert.match(servePill(w, 1), /Kai · serve 1 of 2/, "the receiver serves next");
  assert.match(rcvPill(w, 0), /Ali receiving/, "to the last server's partner");
  tap(w, 1); tap(w, 0);
  assert.match(servePill(w, 0), /Ali/); assert.match(rcvPill(w, 1), /Jo receiving/);
  assert.equal(w.document.getElementById("app").textContent.includes("undefined"), false);
});

test("doubles: between games the serving pair picks a server and Rally sets the receiver", async () => {
  const w = boot(null); await settle();
  await guestDoubles(w);
  for (let i = 0; i < 11; i++) tap(w, 0);
  assert.match(text(w), /Game 2/);
  assert.match(sheet(w), /Game 2: Team white serves/, "the picker opens by itself");
  // game 1 went Sam>Kai, Kai>Ali, Ali>Jo, Jo>Sam: so Jo would serve to Ali, Kai to Sam
  assert.match(sheet(w), /Jo serves.*to Ali, who served to Jo last game/s);
  $(w, '[data-ps="1"]').click();
  assert.match(sheet(w), /Kai serves.*to Sam/s);
  $(w, "#pickSave").click(); await settle();
  assert.equal(sheet(w), "");
  assert.match(servePill(w, 1), /Kai · serve 1 of 2/);
  assert.match(rcvPill(w, 0), /Sam receiving/);
  for (let i = 0; i < 11; i++) tap(w, 0);
  assert.match($(w, ".overlay").textContent, /Ali & Sam win 2–0/);
  $(w, "#reportBtn").click();
  assert.match(text(w), /Ali & Sam win/); assert.match(text(w), /Pair rating/); assert.match(text(w), /Doubles ladder/);
  const rec = JSON.parse(w.localStorage.getItem("rally.local"))[0];
  assert.equal(rec.kind, "doubles"); assert.deepEqual(rec.ap, ["Ali", "Sam"]); assert.deepEqual(rec.picks, [{ s: 1, r: 1 }, { s: 1, r: 0 }]);
  assert.equal(Rules.validRecord(rec), true);
  $(w, "#toLadder").click(); await settle();
  assert.match(text(w), /Doubles pairs/);
  assert.match(text(w), /Ali & Sam/);
  $(w, '[data-lk="singles"]').click();
  assert.doesNotMatch(text(w), /Ali & Sam/, "pairs stay off the singles ladder");
});

test("doubles: closing the picker keeps the default, and Who serves? reopens it before the first point", async () => {
  const w = boot(null); await settle();
  await guestDoubles(w);
  for (let i = 0; i < 11; i++) tap(w, 0);
  w.document.querySelector("#sheetRoot [data-close]").click();
  assert.match(servePill(w, 1), /Jo · serve 1 of 2/);
  $(w, "#pickBtn").click();
  assert.match(sheet(w), /Game 2: Team white serves/);
  $(w, '[data-ps="1"]').click(); $(w, "#pickSave").click(); await settle();
  assert.match(servePill(w, 1), /Kai/);
  tap(w, 1);
  assert.equal($(w, "#pickBtn"), null, "no changing the server once the game has started");
});

test("doubles: in the deciding game the receivers swap when a pair reaches 5", async () => {
  const w = boot(null); await settle();
  await guestDoubles(w, 1);
  for (let i = 0; i < 4; i++) tap(w, 0);
  assert.match(servePill(w, 0), /Ali/); assert.match(rcvPill(w, 1), /Jo receiving/);
  tap(w, 0);
  assert.match($(w, "#toast").textContent, /Change ends\. The receiving pair swap: Kai receives now/);
  assert.match(servePill(w, 0), /Ali · serve 2 of 2/);
  assert.match(rcvPill(w, 1), /Kai receiving/);
  assert.match(text(w), /Receivers swapped for the deciding game/);
  tap(w, 0);
  assert.match(servePill(w, 1), /Kai/); assert.match(rcvPill(w, 0), /Sam receiving/);
});

test("doubles: the serve guide opens from the game screen", async () => {
  const w = boot(null); await settle();
  await guestDoubles(w);
  $(w, "#guideBtn").click();
  assert.match(sheet(w), /How doubles serve works/);
  assert.match(sheet(w), /Always diagonal/); assert.match(sheet(w), /Deciding game/);
});

test("doubles: needs four different names", async () => {
  const w = boot(null); await settle();
  $(w, "#guestBtn").click(); $(w, "#newBtn").click(); $(w, '[data-kind="doubles"]').click();
  type(w, "dn0", "Ali"); type(w, "dn1", "Sam"); type(w, "dn2", "Jo");
  $(w, "#startBtn").click(); await settle();
  assert.match($(w, "#newErr").textContent, /all four players/);
  type(w, "dn3", "ali ");
  $(w, "#startBtn").click(); await settle();
  assert.match($(w, "#newErr").textContent, /different names/);
});

test("doubles: a signed-in club match saves the pairs and the server choice to the server", async () => {
  const f = fake(); const w = boot(f); await settle(20);
  $(w, "#newBtn").click(); $(w, '[data-kind="doubles"]').click();
  assert.match(text(w), /Ali/); assert.equal($(w, "#dn0"), null, "you are player 1");
  type(w, "dn1", "Sam"); type(w, "dn2", "Jo"); type(w, "dn3", "Kai");
  $(w, "#startBtn").click(); await settle(20);
  const ins = f.calls.find(c => c.table === "live_matches" && c.op === "insert").payload;
  assert.equal(ins.kind, "doubles");
  assert.deepEqual([ins.a_name, ins.a2_name, ins.b_name, ins.b2_name], ["Ali", "Sam", "Jo", "Kai"]);
  assert.equal(ins.b_user, "u-jo", "a club member on the other side can keep score");
  assert.equal(JSON.stringify(ins.picks), JSON.stringify([{ s: 0, r: 0 }]));
  assert.match(servePill(w, 0), /Ali/);
  for (let i = 0; i < 11; i++) { tap(w, 0); await settle(); }
  assert.match(sheet(w), /Game 2: Team white serves/);
  $(w, '[data-ps="1"]').click(); $(w, "#pickSave").click(); await settle(20);
  const pick = f.calls.find(c => c.rpc === "set_pick");
  assert.equal(JSON.stringify(pick.args), JSON.stringify({ p_id: "d1", p_game: 1, p_server: 1, p_receiver: 0 }));
  assert.match(servePill(w, 1), /Kai/);
});
