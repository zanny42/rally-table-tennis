// End-to-end: load the real index.html in jsdom, play a full match by tapping, save it, and check the ladder.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const www = path.join(__dirname, "..", "www");
const html = fs.readFileSync(path.join(www, "index.html"), "utf8");
const rules = fs.readFileSync(path.join(www, "rules.js"), "utf8");
const app = fs.readFileSync(path.join(www, "app.js"), "utf8");
const tick = () => new Promise(r => setTimeout(r, 0));
const windows = [];
test.afterEach(() => { while (windows.length) windows.pop().close(); });

function boot(config, fetchImpl) {
  const dom = new JSDOM(html.replace(/<script src="[^"]+"><\/script>/g, ""), { url: "https://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  windows.push(w);
  w.RALLY_CONFIG = config || {};
  if (fetchImpl) w.fetch = fetchImpl;
  w.eval(rules);
  w.eval(app);
  return w;
}
function startMatch(w, a, b) {
  w.document.querySelector("#pa").value = a;
  w.document.querySelector("#pb").value = b;
  w.document.querySelector("#pa").dispatchEvent(new w.Event("input"));
  w.document.querySelector("#pb").dispatchEvent(new w.Event("input"));
  w.document.querySelector("#setupForm").dispatchEvent(new w.Event("submit", { cancelable: true }));
}
const tap = (w, player) => w.document.querySelector(`.half[data-p="${player}"]`).click();

test("index.html loads config, rules and app in that order", () => {
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ["config.js", "rules.js", "app.js"]);
  assert.match(html, /viewport-fit=cover/);
});

test("plays and saves a best-of-3 match offline", async () => {
  const w = boot();
  const doc = w.document;
  assert.match(doc.querySelector("#sync").textContent, /This phone only/);
  startMatch(w, "Maya", "Theo");
  assert.equal(doc.querySelector("#match").hidden, false);
  // serve indicator starts on the red end
  assert.ok(doc.querySelector('.half[data-p="0"] .srv'));
  for (let i = 0; i < 10; i++) tap(w, 0);
  assert.match(doc.querySelector('.half[data-p="0"] .badge').textContent, /Game point/);
  tap(w, 0); // 11-0, game 1
  assert.match(doc.querySelector(".mbar").textContent, /Game 2 of 3/);
  // undo goes back into game 1
  doc.querySelector("#mUndo").click();
  assert.match(doc.querySelector(".mbar").textContent, /Game 1 of 3/);
  tap(w, 0);
  for (let i = 0; i < 10; i++) tap(w, 0);
  assert.match(doc.querySelector('.half[data-p="0"] .badge').textContent, /Match point/);
  tap(w, 0);
  assert.ok(doc.querySelector("#saveBtn"), "summary sheet opens when the match ends");
  assert.match(doc.querySelector(".sheet h2").textContent, /Maya wins 2–0/);
  doc.querySelector("#saveBtn").click();
  await tick(); await tick();
  assert.equal(w.location.hash, "#leaderboard");
  assert.match(doc.querySelector(".leader").textContent, /Maya/);
  assert.match(doc.querySelector(".leader").textContent, /1020/);
  const pending = JSON.parse(w.localStorage.getItem("rally.pending"));
  assert.equal(pending.length, 1);
  assert.equal(pending[0].winner, 0);
});

test("reads the shared ladder and posts a new match to Supabase", async () => {
  const calls = [];
  const row = { id: "mexisting1", by: "dother", data: { a: "Priya", b: "Sam", aKey: "priya", bKey: "sam", bestOf: 1, target: 11, firstServer: 0, g: ["11111111111"], winner: 1, gw: [0, 1], startedAt: 1, endedAt: 2 } };
  const bad = { id: "mbad000001", by: "x", data: { a: "Hacker", b: "Sam", winner: 0, g: ["<b>"] } };
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if ((opts.method || "GET") === "GET") return { ok: true, status: 200, text: async () => JSON.stringify([row, bad]) };
    return { ok: true, status: 201, text: async () => "" };
  };
  const w = boot({ supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon" }, fetchImpl);
  await tick(); await tick();
  assert.match(w.document.querySelector("#sync").textContent, /Live ladder/);
  w.location.hash = "#leaderboard";
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  assert.match(w.document.querySelector(".leader").textContent, /Sam/);
  assert.doesNotMatch(w.document.body.textContent, /Hacker/, "invalid rows are ignored");
  assert.equal(calls[0].opts.headers.apikey, "anon");
  assert.ok(calls[0].opts.headers["x-device-id"]);

  w.location.hash = "#play";
  w.dispatchEvent(new w.HashChangeEvent("hashchange"));
  w.document.querySelector('[data-best="1"]').click();
  startMatch(w, "Maya", "Theo");
  for (let i = 0; i < 11; i++) tap(w, 1);
  w.document.querySelector("#saveBtn").click();
  await tick(); await tick();
  const post = calls.find(c => c.opts.method === "POST");
  assert.ok(post, "match is posted");
  const body = JSON.parse(post.opts.body);
  assert.equal(body.data.winner, 1);
  assert.equal(body.by, post.opts.headers["x-device-id"]);
  assert.equal(JSON.parse(w.localStorage.getItem("rally.pending") || "[]").length, 0);
});
