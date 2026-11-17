/* Rally 2.0: sign in, club home, shared live scoring, ladder, score sheets. */
(function () {
"use strict";
const R = window.RallyRules;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};
const rand = n => { const a = new Uint8Array(n); try { crypto.getRandomValues(a); } catch (e) { a.forEach((_, i) => a[i] = Math.random() * 256 | 0); } return [...a].map(x => x.toString(16).padStart(2, "0")).join(""); };
const newId = () => "m" + Date.now().toString(36) + rand(4);
const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} };
const fmtDate = t => { try { return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(t)); } catch (e) { return new Date(t).toLocaleString(); } };
const fmtDur = ms => { const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60); return m >= 60 ? Math.floor(m / 60) + "h " + (m % 60) + "m" : m + ":" + String(s % 60).padStart(2, "0"); };
const sign = d => (d >= 0 ? "+" : "−") + Math.abs(d);
const pct = (w, t) => t ? Math.round(w / t * 100) + "%" : "–";
let toastT;
function toast(msg) { const t = $("#toast"); t.hidden = true; void t.offsetWidth; t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2800); }

const ICON = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/></svg>',
  swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  play: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8.5 9h.01M12 9h.01M15.5 9h.01M8.5 12.5h.01M12 12.5h.01M15.5 12.5h.01M10 16h4"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"/></svg>'
};

/* ---------- backend ---------- */
const CFG = window.RALLY_CONFIG || {};
const sb = (CFG.supabaseUrl && CFG.supabaseAnonKey && window.supabase && window.supabase.createClient)
  ? window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } })
  : null;

const S = {
  session: null, me: null, guest: LS.get("rally.guest", false),
  profiles: [], ladder: LS.get("rally.ladderCache", []), live: [], local: LS.get("rally.local", []),
  joined: new Set(LS.get("rally.joined", [])), tkeep: new Set(LS.get("rally.tkeep", [])),
  tournaments: [], tour: null, tdraft: null,
  game: null, screen: null, report: null, draft: null, bump: null,
  pending: 0, booted: !sb, authMode: "signin", lastView: "", net: sb ? "loading" : "offline"
};
const uid = () => (S.session && S.session.user && S.session.user.id) || null;
const myName = () => (S.me && S.me.name) || "";

function fromRow(r) {
  return {
    id: r.id, remote: true, a: r.a_name, b: r.b_name, aUser: r.a_user || null, bUser: r.b_user || null,
    bestOf: r.best_of, target: r.target, firstServer: r.first_server, keepers: r.keepers, code: r.join_code,
    games: r.games && r.games.length ? r.games.slice() : [""], status: r.status, version: r.version || 0, owner: r.owner,
    startedAt: Date.parse(r.started_at) || Date.now(), endedAt: r.ended_at ? Date.parse(r.ended_at) : null, flip: 0,
    tournamentId: r.tournament_id || null, round: r.round == null ? null : r.round, slot: r.slot == null ? null : r.slot, aTp: r.a_tp || null, bTp: r.b_tp || null
  };
}
function toRecord(g) {
  const s = R.summarize(R.toMatch(g.games, g.bestOf, g.target, g.firstServer));
  return { id: g.id, a: g.a, b: g.b, aKey: R.keyOf(g.a), bKey: R.keyOf(g.b), bestOf: g.bestOf, target: g.target, firstServer: g.firstServer,
    g: g.games.filter(x => x.length), winner: s.winner, gw: s.gw, startedAt: g.startedAt, endedAt: g.endedAt || Date.now() };
}
const finished = () => S.ladder.concat(S.local.map(m => Object.assign({ local: true }, m))).filter(m => m && m.aKey && m.g).sort((x, y) => x.endedAt - y.endedAt);
function canScore(g) {
  if (!g.remote) return true;
  const me = uid(); if (!me) return false;
  if (g.keepers === "tournament" && g.tournamentId && isTKeeper(g.tournamentId)) return true;
  return g.owner === me || g.keepers === "club" || (g.keepers === "players" && (g.aUser === me || g.bUser === me)) || S.joined.has(g.id);
}
function isTKeeper(tid) {
  if (!uid()) return false;
  const t = (S.tour && S.tour.t.id === tid) ? S.tour.t : S.tournaments.find(x => x.id === tid);
  return (t && t.owner === uid()) || S.tkeep.has(tid);
}
function keepersText(g) {
  if (!g.remote) return "On this phone";
  if (!canScore(g)) return "Watching";
  if (g.keepers === "tournament") return "Tournament scorekeepers";
  if (g.owner !== uid() && S.joined.has(g.id) && g.keepers !== "club") return "You're a scorekeeper";
  return { owner: "Only the host is scoring", players: "Both players scoring", club: "Anyone in the club can score" }[g.keepers] || "Scoring";
}

async function loadLadder() {
  if (!sb) return;
  const { data, error } = await sb.from("matches").select("id,data,by").order("ended_at", { ascending: true }).limit(5000);
  if (error) { S.net = "slow"; return; }
  S.ladder = (data || []).map(r => Object.assign({}, r.data, { id: r.id, by: r.by })).filter(R.validRecord);
  LS.set("rally.ladderCache", S.ladder); S.net = "ready";
}
async function loadLive() {
  if (!sb || !uid()) { S.live = []; return; }
  const { data, error } = await sb.from("live_matches").select("*").eq("status", "live").order("updated_at", { ascending: false }).limit(30);
  if (!error) S.live = (data || []).map(fromRow).filter(liveShown);
}
/* A match of a finished tournament is never "live now", even if it was left half-played when the tournament ended. */
const tourDone = tid => { const t = (S.tour && S.tour.t.id === tid) ? S.tour.t : S.tournaments.find(x => x.id === tid); return !!t && t.status === "done"; };
const liveShown = m => !(m.tournamentId && tourDone(m.tournamentId));
const pruneLive = () => { S.live = S.live.filter(liveShown); };
async function loadProfiles() {
  if (!sb || !uid()) return;
  const { data, error } = await sb.from("profiles").select("id,name").order("name", { ascending: true });
  if (!error) { S.profiles = data || []; S.me = S.profiles.find(p => p.id === uid()) || S.me; }
}
let channel = null;
function subscribe() {
  if (!sb || channel || !uid()) return;
  channel = sb.channel("rally-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "live_matches" }, onLiveChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "tournaments" }, onTourChange)
    .on("postgres_changes", { event: "*", schema: "public", table: "tournament_players" }, onTourChange)
    .subscribe();
}
let tourT = null;
/* Tournament and player changes arrive in bursts (a whole player list, several phones at once), so they are
   coalesced into one reload. The open tournament is always reloaded: a DELETE event only carries the row's own id,
   and a later event for another tournament must not cancel the reload this one needed. */
function onTourChange() {
  clearTimeout(tourT);
  tourT = setTimeout(async () => {
    const open = S.tour && S.tour.t.id;
    await loadTournaments();
    if (open) {
      await loadTour(open);
      if (!S.tour && S.screen === "tour") { S.screen = null; toast("This tournament was deleted."); }
    }
    render(true);
  }, 300);
}
function onLiveChange(p) {
  if (p.eventType === "DELETE") {
    const id = p.old && p.old.id;
    S.live = S.live.filter(m => m.id !== id);
    if (S.game && S.game.id === id) { S.game = null; toast("The host removed this match."); }
    if (S.tour && S.tour.matches.some(m => m.id === id)) { S.tour.matches = S.tour.matches.filter(m => m.id !== id); soonReconcile(S.tour.t.id); }
    return render(true);
  }
  if (!p.new || !p.new.id) return;
  const row = fromRow(p.new);
  S.live = S.live.filter(m => m.id !== row.id);
  if (row.status === "live" && liveShown(row)) S.live.unshift(row);
  if (S.game && S.game.id === row.id && S.pending === 0 && row.version > S.game.version) {
    const prev = S.game;
    S.game = Object.assign(row, { flip: prev.flip });
    const before = prev.games.join("").length, after = row.games.join("").length;
    if (after > before) { const last = row.games.filter(x => x).pop(); S.bump = { p: +last.slice(-1), n: Date.now() }; } else S.bump = null;
  }
  if (row.status === "done") loadLadder().then(() => render(true));
  if (row.tournamentId && S.tour && S.tour.t.id === row.tournamentId) {
    // realtime events can arrive out of order: never let an older version overwrite a newer one
    const i = S.tour.matches.findIndex(m => m.id === row.id), copy = fromRow(p.new);
    if (i < 0) S.tour.matches.push(copy); else if (copy.version >= S.tour.matches[i].version) S.tour.matches[i] = copy;
    if (row.status === "done") afterTourMatch(row.tournamentId);
  }
  render(true);
}

/* ---------- auth ---------- */
async function initAuth() {
  if (!sb) { S.booted = true; render(); return; }
  try { const { data } = await sb.auth.getSession(); S.session = data && data.session; } catch (e) {}
  sb.auth.onAuthStateChange((ev, session) => { const was = uid(); S.session = session; if (uid() !== was) afterAuth(); });
  await afterAuth();
}
async function afterAuth() {
  if (uid()) {
    S.guest = false; LS.set("rally.guest", false);
    await Promise.all([loadProfiles(), loadLadder(), loadLive(), loadTournaments(), loadTKeepers()]);
    pruneLive();
    subscribe();
  } else {
    if (channel) { try { sb.removeChannel(channel); } catch (e) {} channel = null; }
    S.me = null; S.live = [];
    await loadLadder();
  }
  S.booted = true; render();
}

/* ---------- shared drawing helpers ---------- */
function ring(size, stroke, frac, color, inner) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - Math.max(0, Math.min(1, frac)));
  return `<span class="ring" style="width:${size}px;height:${size}px"><svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#2a2a30" stroke-width="${stroke}"/><circle class="r-draw" style="--c:${c.toFixed(1)}" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}"/></svg>${inner || ""}</span>`;
}
function barCol(on, total, cls, delay, extra) {
  let h = ""; for (let k = 0; k < total; k++) h += `<i class="${k < on ? cls : ""}"></i>`;
  return `<div class="bar r-grow" style="--d:${delay.toFixed(2)}s;${extra || ""}">${h}</div>`;
}
function leadSeries(games) {
  return games.filter(s => s.length).map(s => { let l = 0; const out = [0]; for (const c of s) { l += c === "0" ? 1 : -1; out.push(l); } return out; });
}
function wave(series, W, H, id, label) {
  const total = series.reduce((t, s) => t + s.length - 1, 0), n = Math.max(total, 12), xs = W / n, mid = H / 2;
  let m = 4; series.forEach(s => s.forEach(v => { if (Math.abs(v) > m) m = Math.abs(v); }));
  const ys = (mid - 6) / m;
  let x = 0, line = "", area = "", divs = "";
  series.forEach((s, gi) => {
    if (gi) divs += `<line x1="${(x * xs).toFixed(1)}" x2="${(x * xs).toFixed(1)}" y1="4" y2="${H}" stroke="rgba(255,255,255,.18)" stroke-dasharray="3 4"/>`;
    const x0 = x; let seg = "";
    s.forEach((v, k) => { if (k) x++; seg += (k ? "L" : "M") + (x * xs).toFixed(1) + "," + (mid - v * ys).toFixed(1) + " "; });
    line += seg; area += seg + `L${(x * xs).toFixed(1)},${H} L${(x0 * xs).toFixed(1)},${H} Z `;
  });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(label)}">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5a1f" stop-opacity=".75"/><stop offset="1" stop-color="#ff5a1f" stop-opacity="0"/></linearGradient></defs>
    <line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="rgba(255,255,255,.12)" stroke-dasharray="3 4"/>${divs}
    ${area ? `<path d="${area}" fill="url(#${id})"/><path d="${line}" fill="none" stroke="#ff7a45" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>` : ""}
  </svg>`;
}
const av = (name, cls) => `<span class="av ${cls || ""}">${esc(R.initials(name))}</span>`;
function weekStart() { const d = new Date(); const day = (d.getDay() + 6) % 7; return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day); }

/* ---------- views ---------- */
const TABS = ["home", "ladder", "cups", "sheets", "you"];
const route = () => { const h = (location.hash || "").slice(1); return TABS.includes(h) ? h : "home"; };
let timerT = null;
/* In-place updates without twitching: a view is only written to the DOM when its markup actually changed,
   and when it is rewritten the new nodes pick up the animations where the old ones were:
   --age (seconds this screen has been up) offsets the entrance animations, --ph keeps looping ones in phase. */
let viewAt = 0;
const PAINTED = new Set(["home", "ladder", "sheets", "you", "game", "report"]);
function stamp(el) {
  try {
    const now = performance.now();
    el.style.setProperty("--ph", (-now / 1000).toFixed(3) + "s");
    if (el.id === "app") el.style.setProperty("--age", ((now - viewAt) / 1000).toFixed(3) + "s");
  } catch (e) {}
}
function paint(el, html, key) {
  key = key == null ? html : key;
  if (el.__key === key && el.__first === el.firstChild) return false;
  stamp(el); el.innerHTML = html; el.__key = key; el.__first = el.firstChild;
  return true;
}

function render(keep) {
  const app = $("#app");
  let view;
  if (!S.booted) view = "loading";
  else if (!uid() && !S.guest) view = "auth";
  else if (S.game) view = "game";
  else if (S.screen === "new") view = "new";
  else if (S.screen === "report" && S.report) view = "report";
  else if (S.screen === "tnew") view = "tnew";
  else if (S.screen === "tour" && S.tour) view = "tour";
  else view = route();
  if (view !== S.lastView) { window.scrollTo(0, 0); viewAt = performance.now(); }
  S.lastView = view;
  const tabbed = TABS.includes(view);
  app.classList.toggle("full", !tabbed);
  $("#tabbar").hidden = !tabbed;
  document.querySelectorAll(".tabbar a").forEach(a => { if (a.dataset.tab === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  $("#glow").className = "glow " + (view === "auth" || view === "report" ? "big" : "tr");
  clearInterval(timerT);
  if (view !== "game") paint($("#overRoot"), "");
  if (!PAINTED.has(view)) stamp(app);
  const V = { loading: vLoading, auth: vAuth, home: vHome, ladder: vLadder, sheets: vSheets, you: vYou, new: vNew, game: vGame, report: vReport, cups: vCups, tnew: vTourNew, tour: vTour }[view];
  V(app);
}

function vLoading(app) {
  app.innerHTML = `<div class="hero"><span class="eyebrow">Table tennis scorer</span><h1>Rally.</h1><p class="soft" style="margin:0">Getting your club…</p></div>`;
}

function vAuth(app) {
  const up = S.authMode === "signup";
  app.innerHTML = `
  <section class="hero" style="min-height:0">
    <img src="icon.svg" alt="" width="64" height="62" class="r-up" style="display:block;margin-bottom:6px">
    <span class="eyebrow r-up">Table tennis scorer</span>
    <h1 class="r-up d1">Let&#39;s rally.</h1>
    <p class="soft r-up d2" style="margin:0;max-width:290px">Score every point, play with your club, climb the ladder.</p>
  </section>
  <div class="court" aria-hidden="true"><div class="line"></div><div class="shadow"></div><div class="bx"><div class="by"></div></div></div>
  <form class="card pad r-up d3" id="authForm" style="display:flex;flex-direction:column;gap:12px;border-radius:28px" autocomplete="on">
    ${sb ? `<div class="pills" role="group" aria-label="Account">
      <button type="button" data-mode="signin" aria-pressed="${!up}">Sign in</button>
      <button type="button" data-mode="signup" aria-pressed="${up}">Create account</button></div>
    ${up ? `<div class="field"><label for="aName">Your name on the ladder</label><input class="input" id="aName" autocomplete="nickname" maxlength="32" required></div>` : ""}
    <div class="field"><label for="aEmail">Email</label><input class="input" id="aEmail" type="email" autocomplete="email" required></div>
    <div class="field"><label for="aPass">Password</label><input class="input" id="aPass" type="password" minlength="6" autocomplete="${up ? "new-password" : "current-password"}" required></div>
    <p class="err" id="authErr"></p>
    <button class="btn" type="submit" id="authBtn">${up ? "Create account" : "Sign in"}</button>`
    : `<p class="note">This build isn't connected to a club server, so matches stay on this phone.</p>`}
    <button type="button" class="link" id="guestBtn" style="align-self:center">${sb ? "Just keeping score? Play as a guest" : "Start playing"}</button>
  </form>`;
  app.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { S.authMode = b.dataset.mode; S.lastView = "auth"; render(true); });
  $("#guestBtn").onclick = () => { S.guest = true; LS.set("rally.guest", true); render(); };
  const f = $("#authForm");
  if (sb) f.onsubmit = async e => {
    e.preventDefault();
    const err = $("#authErr"), btn = $("#authBtn");
    const email = $("#aEmail").value.trim(), password = $("#aPass").value;
    err.textContent = ""; btn.disabled = true; btn.textContent = up ? "Creating…" : "Signing in…";
    try {
      if (up) {
        const name = $("#aName").value.trim();
        if (!name) throw new Error("Add the name you want on the ladder.");
        const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name } } });
        if (error) throw error;
        if (!data.session) { S.authMode = "signin"; render(true); $("#authErr").textContent = ""; toast("Check your inbox and tap the confirmation link, then sign in here."); return; }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (x) {
      const msg = String(x && x.message || x);
      err.textContent = /confirm/i.test(msg) ? "Confirm your email first: open the link we sent you, then sign in."
        : /invalid login/i.test(msg) ? "That email and password don't match an account."
        : /already registered/i.test(msg) ? "There's already an account with that email. Sign in instead."
        : msg;
      btn.disabled = false; btn.textContent = up ? "Create account" : "Sign in";
    }
  };
}

function vHome(app) {
  const me = myName(), key = me ? R.keyOf(me) : "";
  const fin = finished();
  const mine = key ? fin.filter(m => m.aKey === key || m.bKey === key) : S.local.slice();
  const ws = weekStart(), labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const days = labels.map((l, i) => {
    const d0 = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i), d1 = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i + 1);
    const c = mine.filter(m => m.endedAt >= d0 && m.endedAt < d1).length;
    return `<div class="day">${l}${ring(36, 3, c / 3, "#ff5a1f", `<b style="color:${c ? "#f5f5f7" : "#6b6b75"}">${d0.getDate()}</b>`)}</div>`;
  }).join("");
  const last7 = mine.slice(-7);
  const bars = last7.map((m, i) => {
    const me0 = key ? (m.aKey === key ? 0 : 1) : 0, st = R.stats(R.fromRecord(m)), tot = st.pts[0] + st.pts[1];
    return { col: barCol(Math.round((tot ? st.pts[me0] / tot : 0) * 12), 12, "on", .25 + i * .07), who: R.initials(me0 ? m.a : m.b) };
  });
  const live = S.live.filter(m => m.status === "live");
  const localGame = LS.get("rally.localGame", null);
  if (!paint(app, `
  <header class="row r-up">
    ${av(me || "Guest", "a")}
    <span style="flex:1;display:flex;flex-direction:column;line-height:1.3"><span class="small muted">Ready to rally?</span><span style="font-size:20px;font-weight:600">${esc(me || "Guest")}</span></span>
    ${uid() ? `<button class="icon-btn" id="joinBtn" aria-label="Join a match with a code">${ICON.key}</button>` : ""}
  </header>
  <div class="card week r-up d1" aria-label="Matches you played this week">${days}</div>
  ${localGame && localGame.status === "live" ? `<button class="card pad between r-up d1" id="resumeBtn" style="border-color:rgba(255,90,31,.5);text-align:left;width:100%"><span><b>${esc(localGame.a)} v ${esc(localGame.b)}</b><br><span class="small muted">Match in progress on this phone</span></span><span class="tag">Resume</span></button>` : ""}
  ${uid() ? `<div class="sec r-up d2"><h2>Live now</h2><span class="small" style="color:var(--accent-ink);display:flex;align-items:center;gap:6px">${live.length ? `<span class="live-dot"></span>${live.length} table${live.length > 1 ? "s" : ""}` : ""}</span></div>
  ${live.length ? `<div class="scroller r-up d2">${live.map((m, i) => { const s = R.summarize(R.toMatch(m.games, m.bestOf, m.target, m.firstServer)); return `<button class="live-card" data-live="${esc(m.id)}">${i === 0 ? '<span class="hot"></span>' : ""}<span class="small soft">Game ${s.g + 1} · best of ${m.bestOf}</span><span class="num" style="font-size:44px">${s.cur[0]}<span style="color:#6b6b75">–</span>${s.cur[1]}</span><span class="between"><span style="font-weight:600;font-size:15px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.a)} v ${esc(m.b)}</span><span class="tag ${canScore(m) ? "" : "ghost"}">${canScore(m) ? "Score" : "Watch"}</span></span></button>`; }).join("")}</div>`
    : `<div class="card empty r-up d2">No one is playing right now. Start a match and it shows up here for the club.</div>`}` : ""}
  <div class="card pad r-up d3" style="display:flex;flex-direction:column;gap:12px">
    <div class="row"><span class="icon-btn" style="width:36px;height:36px" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></span><span style="font-size:17px;font-weight:600">Points you won, last ${bars.length || 7} matches</span></div>
    ${bars.length ? `<div class="bars" style="grid-template-columns:30px repeat(${bars.length},minmax(0,1fr));height:122px"><div style="display:flex;flex-direction:column;justify-content:space-between;font-size:10px;color:var(--dim);height:100%"><span>100%</span><span>50%</span><span>0%</span></div>${bars.map(b => b.col).join("")}</div>
    <div class="axis" style="grid-template-columns:30px repeat(${bars.length},minmax(0,1fr))"><span></span>${bars.map(b => `<span>${esc(b.who)}</span>`).join("")}</div>`
    : `<p class="note">Finish a match and your points-won chart starts here.</p>`}
  </div>
  <button class="btn r-up d4" id="newBtn">${ICON.plus}Start a match</button>`)) return;
  $("#newBtn").onclick = () => { S.draft = null; S.screen = "new"; render(); };
  if ($("#joinBtn")) $("#joinBtn").onclick = openJoin;
  if ($("#resumeBtn")) $("#resumeBtn").onclick = () => { S.game = LS.get("rally.localGame", null); render(); };
  app.querySelectorAll("[data-live]").forEach(b => b.onclick = () => { const m = S.live.find(x => x.id === b.dataset.live); if (m) { S.game = Object.assign({}, m, { flip: 0 }); render(); } });
}

function vNew(app) {
  const signed = !!uid();
  const d = S.draft || (S.draft = { opp: null, oppGuest: "", guestOn: false, a: "", b: "", bestOf: 3, target: 11, serve: 0, keepers: "players" });
  if (d.target !== 21) d.target = 11;
  const others = S.profiles.filter(p => p.id !== uid());
  const opp = d.opp ? others.find(p => p.id === d.opp) : null;
  const aName = signed ? myName() : d.a, bName = signed ? (opp ? opp.name : d.oppGuest) : d.b;
  app.innerHTML = `
  <header class="row r-up"><button class="icon-btn" id="backBtn" aria-label="Back">${ICON.back}</button><h1 style="flex:1;text-align:center;font-size:19px;font-weight:600">New match</h1><span style="width:46px"></span></header>
  ${signed ? `
  <div class="r-up d1" style="position:relative;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px">
    <div class="card pad" style="display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center">${av(aName, "a")}<b style="font-size:17px;max-width:100%;overflow:hidden;text-overflow:ellipsis">${esc(aName)}</b><span class="small muted">You · orange</span></div>
    <div class="card pad" style="display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center">${av(bName || "?", "b")}<b style="font-size:17px;max-width:100%;overflow:hidden;text-overflow:ellipsis">${esc(bName || "Pick a player")}</b><span class="small muted">White</span></div>
    <span style="position:absolute;left:50%;top:50%;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;background:var(--bg);border:1px solid var(--edge-2);display:grid;place-items:center;font-size:13px;font-weight:700">VS</span>
  </div>
  <div class="field r-up d2"><span class="small muted">Opponent</span><div class="chips">
    ${others.map(p => `<button class="chip" data-opp="${esc(p.id)}" aria-pressed="${d.opp === p.id}">${av(p.name)}${esc(p.name)}</button>`).join("")}
    <button class="chip plain" id="guestChip" aria-pressed="${d.guestOn}">+ Guest</button></div>
    ${d.guestOn ? `<input class="input" id="oppGuest" maxlength="32" placeholder="Guest's name" value="${esc(d.oppGuest)}" aria-label="Guest's name">` : ""}
    ${!others.length && !d.guestOn ? `<p class="note">No one else from your club has signed up yet. Add a guest, or ask a friend to create an account.</p>` : ""}
  </div>` : `
  <div class="card pad r-up d1" style="display:flex;flex-direction:column;gap:12px">
    <div class="field"><label for="gA">Orange player</label><input class="input" id="gA" maxlength="32" value="${esc(d.a)}" placeholder="Name"></div>
    <div class="field"><label for="gB">White player</label><input class="input" id="gB" maxlength="32" value="${esc(d.b)}" placeholder="Name"></div>
  </div>`}
  <div class="field r-up d3"><span class="small muted">Format</span><div class="pills">${[1, 3, 5, 7].map(n => `<button type="button" data-best="${n}" aria-pressed="${d.bestOf === n}">${n === 1 ? "1 game" : "Best of " + n}</button>`).join("")}</div></div>
  <div class="field r-up d3"><span class="small muted">Points per game</span><div class="pills">${[11, 21].map(n => `<button type="button" data-target="${n}" aria-pressed="${d.target === n}">${n}</button>`).join("")}</div></div>
  <div class="field r-up d3"><span class="small muted">First serve</span><div class="pills">
    <button type="button" data-serve="0" aria-pressed="${d.serve === 0}">${esc(aName || "Orange")}</button><button type="button" data-serve="1" aria-pressed="${d.serve === 1}">${esc(bName || "White")}</button><button type="button" data-serve="toss">Toss</button></div></div>
  ${signed ? `<fieldset class="card r-up d4" style="margin:0;padding:6px;display:flex;flex-direction:column;gap:2px"><legend class="small muted" style="padding:0 8px">Who can keep score</legend>
    ${[["owner", "Only me"], ["players", "Both players"], ["club", "Anyone in the club"]].map(([v, l]) => `<label class="radio ${d.keepers === v ? "on" : ""}"><input type="radio" name="keepers" value="${v}" ${d.keepers === v ? "checked" : ""}>${l}</label>`).join("")}
    <p class="note" style="padding:4px 12px 8px">You also get a 4-digit code that lets anyone else join as scorekeeper.</p></fieldset>` : ""}
  <p class="err" id="newErr"></p>
  <button class="btn r-up d5" id="startBtn">${ICON.play}Start match</button>`;
  const keepInputs = () => { if ($("#oppGuest")) d.oppGuest = $("#oppGuest").value; if ($("#gA")) { d.a = $("#gA").value; d.b = $("#gB").value; } };
  const again = () => { keepInputs(); render(true); };
  $("#backBtn").onclick = () => { S.screen = null; render(); };
  app.querySelectorAll("[data-opp]").forEach(b => b.onclick = () => { d.opp = b.dataset.opp; d.guestOn = false; again(); });
  if ($("#guestChip")) $("#guestChip").onclick = () => { d.guestOn = !d.guestOn; if (d.guestOn) d.opp = null; again(); if ($("#oppGuest")) $("#oppGuest").focus(); };
  app.querySelectorAll("[data-best]").forEach(b => b.onclick = () => { d.bestOf = +b.dataset.best; again(); });
  app.querySelectorAll("[data-target]").forEach(b => b.onclick = () => { d.target = +b.dataset.target; again(); });
  app.querySelectorAll("[data-serve]").forEach(b => b.onclick = () => {
    if (b.dataset.serve === "toss") { d.serve = Math.random() < .5 ? 0 : 1; keepInputs(); toast("Coin toss: " + ((d.serve ? (signed ? bName : d.b) : (signed ? aName : d.a)) || (d.serve ? "White" : "Orange")) + " serves first"); }
    else d.serve = +b.dataset.serve;
    again();
  });
  app.querySelectorAll('input[name="keepers"]').forEach(r => r.onchange = () => { d.keepers = r.value; again(); });
  $("#startBtn").onclick = async () => {
    keepInputs();
    const err = $("#newErr");
    const a = (signed ? myName() : d.a).trim(), b = (signed ? (opp ? opp.name : d.oppGuest) : d.b).trim();
    if (!a || !b) { err.textContent = signed ? "Pick an opponent or add a guest's name." : "Add a name for both players."; return; }
    if (R.keyOf(a) === R.keyOf(b)) { err.textContent = "The two players need different names."; return; }
    if (!signed) {
      S.game = { id: newId(), remote: false, a, b, bestOf: d.bestOf, target: d.target, firstServer: d.serve, games: [""], status: "live", startedAt: Date.now(), endedAt: null, version: 0, flip: 0 };
      saveLocalGame(); S.screen = null; render(); return;
    }
    const btn = $("#startBtn"); btn.disabled = true;
    const { data, error } = await sb.from("live_matches").insert({ a_name: a, b_name: b, a_user: uid(), b_user: opp ? opp.id : null, best_of: d.bestOf, target: d.target, first_server: d.serve, keepers: d.keepers }).select().single();
    btn.disabled = false;
    if (error || !data) { err.textContent = "Couldn't start the match. Check your connection and try again."; return; }
    S.game = fromRow(data); S.live.unshift(fromRow(data)); S.screen = null; render();
  };
}

function vGame(app) {
  const g = S.game, m = R.toMatch(g.games, g.bestOf, g.target, g.firstServer), s = R.summarize(m);
  const n = s.cur[0] + s.cur[1], srv = s.over ? -1 : R.serverAt(m, s.g, n);
  const order = R.switchCount(Object.assign({}, m, { flip: g.flip || 0 }), s) % 2 === 0 ? [0, 1] : [1, 0];
  const can = canScore(g);
  const deuce = !s.over && s.cur[0] >= g.target - 1 && s.cur[1] >= g.target - 1 && s.cur[0] === s.cur[1];
  const badge = i => { const me = s.cur[i], op = s.cur[1 - i]; return !s.over && !deuce && me >= g.target - 1 && me > op ? (s.gw[i] === s.need - 1 ? "Match point" : "Game point") : ""; };
  // the point flash/pop stays on for its length, so a repaint mid-animation (server reply, realtime) continues it
  const bump = S.bump && Date.now() - S.bump.n < 500 ? S.bump : (S.bump = null);
  const alt = bump ? (bump.n % 2 ? 1 : 2) : 0, ago = bump ? Date.now() - bump.n : 0;
  const hit = i => bump && bump.p === i ? ` style="animation-delay:-${ago}ms"` : "";
  if (fx.id !== g.id) fx = { id: g.id };
  const bd = [badge(0), badge(1)], be = [enter("b0", bd[0]), enter("b1", bd[1])], de = enter("deuce", deuce ? "1" : "");
  const name = i => i ? g.b : g.a;
  const card = i => `<button class="pcard p${i} ${srv === i ? "serving" : ""}" data-p="${i}" ${can && !s.over ? "" : "disabled"} aria-label="Point to ${esc(name(i))}, now ${s.cur[i]}">
      ${srv === i ? '<span class="halo"></span>' : ""}<span class="flash ${bump && bump.p === i ? "fl" + alt : ""}"${hit(i)}></span>
      <span class="row">${av(name(i), i ? "b sm" : "a sm")}<span style="flex:1;font-size:18px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name(i))}</span>
        <span class="pips" aria-label="${s.gw[i]} games won">${Array.from({ length: s.need }, (_, k) => `<i class="${k < s.gw[i] ? "on" : ""}"></i>`).join("")}</span></span>
      <span class="foot"><span style="display:flex;flex-direction:column;gap:8px;padding-bottom:12px">
        ${srv === i ? `<span class="serve"><span class="ball"></span>${n >= 2 * (g.target - 1) ? "Serving" : "Serve " + ((n % (g.target === 21 ? 5 : 2)) + 1) + " of " + (g.target === 21 ? 5 : 2)}</span>` : ""}
        ${bd[i] ? `<span class="badge${be[i].c}"${be[i].s}>${bd[i]}</span>` : ""}</span>
        <span class="score ${bump && bump.p === i ? "pop" + alt : ""}"${hit(i)}>${s.cur[i]}</span></span>
    </button>`;
  const h = g.games[s.g] || "";
  let run = 0; const who = h.slice(-1); for (let i = h.length - 1; i >= 0 && h[i] === who; i--) run++;
  const runText = run >= 2 ? `${esc(name(+who))} · ${run} in a row` : h.length ? "Level game" : `First to ${g.target}`;
  const canUndo = can && g.games.join("").length > 0;
  const CLOCK = "\u0001";
  const tpl = `
  <div class="gtop"><button class="icon-btn" id="leaveBtn" aria-label="Leave match">${ICON.back}</button>
    <div class="mid"><b>Game ${s.g + 1}${g.bestOf > 1 ? " · Best of " + g.bestOf : ""}</b><span>${g.remote ? `<span class="live-dot ok-dot"></span>` : ""}${esc(keepersText(g))}${g.remote ? (S.pending ? " · saving" : " · synced") : ""}</span></div>
    <button class="icon-btn" id="optBtn" aria-label="Match options">${ICON.more}</button></div>
  ${card(order[0])}
  <div class="net">${deuce ? `<span class="deuce${de.c}"${de.s}>Deuce · serve alternates</span>` : `<span>Games ${s.gw[0]}–${s.gw[1]} · <span id="gtimer">${CLOCK}</span></span>`}</div>
  ${card(order[1])}
  <div class="card wave"><span class="between small"><span class="muted">Momentum this game</span><span style="font-weight:600">${runText}</span></span>${wave(leadSeries([h || ""]).length ? leadSeries([h]) : [], 324, 62, "gwave", "Lead in this game, point by point")}</div>
  <div class="controls"><button class="icon-btn" id="swapBtn" aria-label="Switch ends on screen">${ICON.swap}</button>
    <button class="main" id="undoBtn" aria-label="Undo last point" ${canUndo ? "" : "disabled"}>${ICON.undo}</button>
    <button class="icon-btn" id="optBtn2" aria-label="Match options">${ICON.more}</button></div>`;
  // the clock ticks in place (timerT) and the pop offsets only matter to fresh nodes, so neither counts as a change
  paint(app, tpl.replace(CLOCK, fmtDur((g.endedAt || Date.now()) - g.startedAt)), tpl.replace(/ style="animation-delay:-\d+ms"/g, ""));
  /* The result card sits in its own root: game-screen updates (sync state, realtime, ladder reloads) don't rebuild it,
     and its fade-in plays once per finished match. */
  const over = $("#overRoot");
  const inner = s.over ? `<span class="glow big" style="position:absolute"></span><span style="font-size:14px;color:var(--accent-ink);font-weight:600">Match over</span>
    <h2>${esc(name(s.winner))} wins ${Math.max(...s.gw)}–${Math.min(...s.gw)}</h2>
    <button class="btn" id="reportBtn">See the match report</button>
    ${g.tournamentId ? `<button class="btn ghost" id="toTour">Back to the tournament</button>` : ""}
    ${canUndo ? `<button class="btn ghost" id="overUndo">Undo last point</button>` : ""}
    <button class="link" id="homeBtn" style="align-self:center">Back to home</button>` : "";
  paint(over, inner ? `<div class="overlay${over.__gid === g.id ? " again" : ""}" role="dialog" aria-modal="true" aria-label="Match over">${inner}</div>` : "", inner);
  over.__gid = inner ? g.id : null;
  app.querySelectorAll(".pcard").forEach(b => b.onclick = () => point(+b.dataset.p));
  $("#leaveBtn").onclick = () => { S.game = null; render(); };
  $("#swapBtn").onclick = () => { g.flip = (g.flip || 0) ^ 1; if (!g.remote) saveLocalGame(); render(true); };
  $("#undoBtn").onclick = undoLast;
  $("#optBtn").onclick = $("#optBtn2").onclick = openGameOptions;
  if ($("#reportBtn")) $("#reportBtn").onclick = () => { const rec = finished().find(x => x.id === g.id) || Object.assign(toRecord(g), { local: !g.remote }); S.report = rec; S.screen = "report"; S.game = null; render(); };
  if ($("#overUndo")) $("#overUndo").onclick = undoLast;
  if ($("#toTour")) $("#toTour").onclick = () => { const tid = g.tournamentId; S.game = null; openTour(tid); };
  if ($("#homeBtn")) $("#homeBtn").onclick = () => { S.game = null; render(); };
  if (!s.over) timerT = setInterval(() => { const t = $("#gtimer"); if (t && S.game) t.textContent = fmtDur(Date.now() - S.game.startedAt); }, 1000);
}

let fx = { id: null };
function enter(k, v) {
  if (!v) { fx[k] = null; return { c: "", s: "" }; }
  if (!fx[k] || fx[k].v !== v) fx[k] = { v, t: Date.now() };
  const ago = Date.now() - fx[k].t;
  return ago < 400 ? { c: " enter", s: ` style="animation-delay:-${ago}ms"` } : { c: "", s: "" };
}
function saveLocalGame() { if (S.game && !S.game.remote) LS.set("rally.localGame", S.game); }

async function point(p) {
  const g = S.game; if (!g) return;
  if (!canScore(g)) return toast("You're watching this match. Ask the host for the join code to keep score.");
  if (g.status !== "live") return;
  const before = { games: g.games.slice(), status: g.status, endedAt: g.endedAt };
  const gamesBefore = g.games.length;
  const r = R.applyPoint(g.games, p, g.bestOf, g.target);
  g.games = r.games;
  if (r.done) { g.status = "done"; g.endedAt = Date.now(); }
  buzz(r.done ? [30, 40, 30] : 12);
  if (!r.done && g.games.length > gamesBefore) { const [a, b] = R.gameScore([...g.games[gamesBefore - 1]].map(Number)); toast(`${p ? g.b : g.a} takes game ${gamesBefore}, ${Math.max(a, b)}–${Math.min(a, b)}. Change ends.`); }
  S.bump = { p, n: Date.now() };
  if (!g.remote) {
    if (r.done) { S.local.push(toRecord(g)); LS.set("rally.local", S.local); LS.del("rally.localGame"); } else saveLocalGame();
    return render(true);
  }
  S.pending++; render(true);
  const { data, error } = await sb.rpc("score_point", { p_id: g.id, p_player: p });
  S.pending--;
  if (error || !data) {
    if (S.game && S.game.id === g.id) Object.assign(S.game, before);
    toast(error && error.code === "42501" ? "You're not a scorekeeper on this match." : "Couldn't save that point. Check your connection.");
    return render(true);
  }
  if (S.game && S.game.id === g.id && S.pending === 0) S.game = Object.assign(fromRow(data), { flip: g.flip });
  if (data.status === "done") { await loadLadder(); if (data.tournament_id) afterTourMatch(data.tournament_id); }
  render(true);
}

async function undoLast() {
  const g = S.game; if (!g || !canScore(g)) return;
  const before = { games: g.games.slice(), status: g.status, endedAt: g.endedAt };
  g.games = R.undoPoint(g.games); g.status = "live"; g.endedAt = null; S.bump = null; buzz(8);
  if (!g.remote) {
    S.local = S.local.filter(x => x.id !== g.id); LS.set("rally.local", S.local); saveLocalGame();
    return render(true);
  }
  S.pending++; render(true);
  const { data, error } = await sb.rpc("undo_point", { p_id: g.id });
  S.pending--;
  if (error || !data) { if (S.game && S.game.id === g.id) Object.assign(S.game, before); toast("Couldn't undo. Check your connection."); return render(true); }
  if (S.game && S.game.id === g.id && S.pending === 0) S.game = Object.assign(fromRow(data), { flip: g.flip });
  if (before.status === "done") { await loadLadder(); if (data.tournament_id) afterTourMatch(data.tournament_id); }
  render(true);
}

/* ---------- sheets ---------- */
function openSheet(html, mount) {
  const root = $("#sheetRoot");
  root.innerHTML = `<div class="backdrop" id="bd"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const close = () => { root.innerHTML = ""; };
  $("#bd").onclick = e => { if (e.target.id === "bd") close(); };
  root.querySelectorAll("[data-close]").forEach(b => b.onclick = close);
  mount && mount(close);
}
function openGameOptions() {
  const g = S.game; if (!g) return;
  const owner = !g.remote || g.owner === uid();
  openSheet(`<div class="between"><h2 style="font-size:22px">Match options</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    ${g.remote && canScore(g) ? `<div class="card pad" style="display:flex;flex-direction:column;gap:8px;align-items:center"><span class="small muted">Scorekeeper join code</span><span class="code" id="codeTxt">${esc(g.code)}</span><button class="btn small ghost" id="copyCode">Copy code</button><p class="note" style="text-align:center">Anyone signed in to Rally can enter this code on their home screen to keep score with you.</p></div>` : ""}
    ${owner ? `<button class="btn ghost" id="delMatch" style="color:var(--bad)">${g.remote ? "End and delete this match" : "Discard this match"}</button>` : ""}`,
  close => {
    if ($("#copyCode")) $("#copyCode").onclick = async () => { try { await navigator.clipboard.writeText(g.code); toast("Code copied"); } catch (e) { const r = document.createRange(); r.selectNodeContents($("#codeTxt")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast("Code selected. Copy it from here."); } };
    let armed = false;
    if ($("#delMatch")) $("#delMatch").onclick = async e => {
      if (!armed) { armed = true; e.currentTarget.textContent = "Tap again to delete"; return; }
      if (g.remote) {
        const { error } = await sb.from("live_matches").delete().eq("id", g.id);
        if (error) return toast("Couldn't delete the match.");
        if (g.status === "done") await sb.from("matches").delete().eq("id", g.id);
        S.live = S.live.filter(x => x.id !== g.id); await loadLadder();
      } else { LS.del("rally.localGame"); S.local = S.local.filter(x => x.id !== g.id); LS.set("rally.local", S.local); }
      close(); S.game = null; render(); toast("Match deleted");
    };
  });
}
function openJoin() {
  openSheet(`<div class="between"><h2 style="font-size:22px">Join a match</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <form id="joinForm" style="display:flex;flex-direction:column;gap:12px"><div class="field"><label for="joinCode">4-digit code from the host</label><input class="input code" id="joinCode" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="one-time-code" style="height:72px"></div>
    <p class="err" id="joinErr"></p><button class="btn" type="submit">Join as scorekeeper</button></form>`,
  close => {
    $("#joinCode").focus();
    $("#joinForm").onsubmit = async e => {
      e.preventDefault();
      const code = $("#joinCode").value.trim();
      if (!/^\d{4}$/.test(code)) { $("#joinErr").textContent = "Enter the 4 digits shown on the host's phone."; return; }
      const { data, error } = await sb.rpc("join_match", { p_code: code });
      if (error || !data) { $("#joinErr").textContent = "No live match has that code. Check it with the host."; return; }
      S.joined.add(data); LS.set("rally.joined", [...S.joined].slice(-50));
      const res = await sb.from("live_matches").select("*").eq("id", data).single();
      if (res.error || !res.data) { $("#joinErr").textContent = "Joined, but couldn't open the match. Try again from Live now."; return; }
      close(); S.game = fromRow(res.data); render(); toast("You're a scorekeeper on this match");
    };
  });
}

/* ---------- report ---------- */
function vReport(app) {
  const rec = S.report, m = R.fromRecord(rec), st = R.stats(m);
  const board = R.computeBoard(finished()), d = board.deltas.get(rec.id) || [0, 0];
  const w = rec.winner, wn = w ? rec.b : rec.a, wKey = w ? rec.bKey : rec.aKey, wp = board.byKey.get(wKey);
  const scores = (rec.g || []).map(s => R.gameScore([...s].map(Number)));
  const top = Math.max(11, ...scores.flat());
  const canDel = rec.local || (uid() && rec.by === uid());
  if (!paint(app, `
  <header class="row"><button class="icon-btn" id="closeRep" aria-label="Close">${ICON.close}</button><span style="flex:1;text-align:center;font-size:17px;font-weight:600">Match report</span><span style="width:46px"></span></header>
  <div class="r-up" style="padding:6px 4px 2px"><span style="font-size:14px;color:#ffd2bf">${fmtDate(rec.endedAt)} · ${fmtDur(rec.endedAt - rec.startedAt)}</span>
    <h1 style="font-size:clamp(42px,14vw,56px);line-height:.95;letter-spacing:-.03em">${esc(wn)} wins<br>${Math.max(...rec.gw)}–${Math.min(...rec.gw)}</h1>
    <span class="soft">against ${esc(w ? rec.a : rec.b)}</span></div>
  <div class="r-up d1" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">
    <div class="card pad"><span class="small soft">${esc(wn)}'s rating</span><div class="num" style="margin-top:12px;font-size:38px">${wp ? wp.r : "–"}<small> / <span class="${d[w] >= 0 ? "up" : "down"}">${sign(d[w])}</span></small></div></div>
    <div class="card pad"><span class="small soft">Ladder</span><div class="num" style="margin-top:12px;font-size:38px">${wp ? ordinal(wp.rank) : "–"}<small> / ${board.players.length}</small></div></div>
  </div>
  <div class="card pad r-up d2" style="display:flex;flex-direction:column;gap:10px">
    <div class="between"><span style="font-size:16px;font-weight:600">Points per game</span><span class="row small soft" style="gap:12px"><span class="row" style="gap:5px"><i style="width:8px;height:8px;border-radius:2px;background:var(--accent)"></i>${esc(rec.a)}</span><span class="row" style="gap:5px"><i style="width:8px;height:8px;border-radius:2px;background:var(--pb)"></i>${esc(rec.b)}</span></span></div>
    <div style="display:grid;grid-template-columns:repeat(${Math.max(scores.length, 1)},minmax(0,1fr));gap:16px">
      ${scores.map((sc, i) => `<div style="display:flex;flex-direction:column;gap:6px"><div style="display:flex;gap:6px;align-items:flex-end">${barCol(sc[0], top, "on", .3 + i * .15, "flex:1")}${barCol(sc[1], top, "w", .38 + i * .15, "flex:1")}</div><span class="between small muted"><span>Game ${i + 1}</span><b style="color:var(--ink)">${sc[0]}–${sc[1]}</b></span></div>`).join("")}
    </div>
  </div>
  <div class="card wave r-up d3" style="height:130px"><span class="between small"><span class="soft">Momentum</span><span class="soft">Best run <b style="color:var(--ink)">${Math.max(st.run[0], st.run[1])}</b> · own serve <b style="color:var(--ink)">${pct(st.srvWon[0], st.srvTot[0])}</b> / <b style="color:var(--ink)">${pct(st.srvWon[1], st.srvTot[1])}</b></span></span><div style="flex:1;display:flex;align-items:flex-end">${wave(leadSeries(rec.g || []), 326, 84, "rwave", "Lead across the match, point by point").replace("<svg ", '<svg style="height:84px" ')}</div></div>
  <p class="note r-up d4">${rec.local ? "Saved on this phone." : "Saved to the club ladder."}${rec.tournament ? " Part of " + esc(rec.tournament) + "." : ""}</p>
  <button class="btn ghost small" id="repPdf" style="align-self:flex-start">${ICON.share.replace("<svg ", '<svg width="18" height="18" ')}Export this match as a PDF</button>
  <div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:10px">
    <button class="btn" id="rematch">Rematch</button><button class="btn ghost" id="toLadder">Ladder</button></div>
  ${canDel ? `<button class="link" id="delRec" style="align-self:center;color:var(--bad)">Delete this match</button>` : ""}`)) return;
  $("#closeRep").onclick = () => { S.screen = S.tour && rec.tournament ? "tour" : null; S.report = null; render(); };
  $("#repPdf").onclick = () => exportHistoryPdf([rec], `${rec.a} v ${rec.b}`);
  $("#toLadder").onclick = () => { S.screen = null; S.report = null; location.hash = "#ladder"; render(); };
  $("#rematch").onclick = () => {
    const opp = uid() ? S.profiles.find(p => p.id !== uid() && R.keyOf(p.name) === (R.keyOf(myName()) === rec.aKey ? rec.bKey : rec.aKey)) : null;
    S.draft = { opp: opp ? opp.id : null, oppGuest: opp ? "" : (R.keyOf(myName()) === rec.aKey ? rec.b : rec.a), guestOn: !opp, a: rec.a, b: rec.b, bestOf: rec.bestOf, serve: rec.firstServer ? 0 : 1, keepers: "players" };
    S.screen = "new"; S.report = null; render();
  };
  if ($("#delRec")) {
    let armed = false;
    $("#delRec").onclick = async e => {
      if (!armed) { armed = true; e.currentTarget.textContent = rec.local ? "Tap again to delete" : "Tap again to delete for everyone"; return; }
      if (rec.local) { S.local = S.local.filter(x => x.id !== rec.id); LS.set("rally.local", S.local); }
      else {
        const { error } = await sb.from("matches").delete().eq("id", rec.id);
        if (error) return toast("Couldn't delete this match.");
        await sb.from("live_matches").delete().eq("id", rec.id);
        await loadLadder();
      }
      S.screen = null; S.report = null; render(); toast("Match deleted");
    };
  }
}
const ordinal = n => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");

/* ---------- ladder, sheets, you ---------- */
function vLadder(app) {
  const fin = finished(), board = R.computeBoard(fin), top = board.players[0], rest = board.players.slice(1);
  const ws = weekStart(), labels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const counts = labels.map((_, i) => { const d0 = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i), d1 = new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + i + 1); return fin.filter(m => m.endedAt >= d0 && m.endedAt < d1).length; });
  const maxC = Math.max(10, ...counts);
  if (!paint(app, `
  <header class="between r-up"><h1 style="font-size:28px">Ladder</h1><span class="small muted">${fin.length} match${fin.length === 1 ? "" : "es"} · Elo</span></header>
  ${top ? `<button class="card pad r-up d1" data-k="${esc(top.key)}" style="position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;border-color:rgba(255,90,31,.45);text-align:left;width:100%;border-radius:26px">
    <span style="position:absolute;left:-60px;bottom:-120px;width:280px;height:260px;border-radius:50%;background:radial-gradient(closest-side,rgba(255,90,31,.45),rgba(255,90,31,0))"></span>
    <span style="position:relative;display:flex;flex-direction:column;gap:6px;min-width:0"><span class="small" style="color:#ffd2bf">Top of the ladder</span><span style="font-size:26px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(top.name)}</span><span class="num" style="font-size:44px">${top.r}<small> / rating</small></span></span>
    <span style="position:relative">${ring(104, 7, top.w / Math.max(1, top.w + top.l), "#ff5a1f", `<span style="text-align:center;line-height:1.1;position:relative"><b style="display:block;font-size:24px;font-weight:600">${Math.round(top.w / Math.max(1, top.w + top.l) * 100)}%</b><span style="font-size:11px;color:var(--soft)">win rate</span></span>`)}</span>
  </button>` : `<div class="card empty r-up d1"><b>The ladder is empty</b>Finish a match to put the first name on it.</div>`}
  <div class="card pad r-up d2" style="display:flex;flex-direction:column;gap:10px"><span style="font-size:16px;font-weight:600">Club matches this week</span>
    <div class="bars" style="grid-template-columns:repeat(7,minmax(0,1fr));gap:8px">${counts.map((c, i) => barCol(Math.round(c / maxC * 10), 10, "on", .25 + i * .07)).join("")}</div>
    <div class="axis" style="grid-template-columns:repeat(7,minmax(0,1fr));gap:8px">${labels.map(l => `<span>${l}</span>`).join("")}</div></div>
  <div class="r-up d3" style="display:flex;flex-direction:column;gap:8px">${rest.map(p => `<button class="prow" data-k="${esc(p.key)}"><span class="rk">${p.rank}</span>${av(p.name, "sm")}<span style="display:flex;flex-direction:column;gap:4px;min-width:0"><span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span><span class="dots">${p.res.slice(-5).map(r => `<i class="${r ? "w" : "l"}"></i>`).join("")}</span></span><span style="text-align:right;line-height:1.15"><span style="display:block;font-size:20px;font-weight:500">${p.r}</span><span class="small ${p.lastDelta >= 0 ? "up" : "down"}">${sign(p.lastDelta)}</span></span></button>`).join("")}</div>`)) return;
  app.querySelectorAll("[data-k]").forEach(b => b.onclick = () => openPlayer(b.dataset.k));
}
function openPlayer(k) {
  const fin = finished(), { byKey, deltas } = R.computeBoard(fin), p = byKey.get(k); if (!p) return;
  const opp = [...p.opp.values()].sort((a, b) => (b.w + b.l) - (a.w + a.l));
  const recent = fin.filter(m => m.aKey === k || m.bKey === k).slice(-5).reverse();
  openSheet(`<div class="between"><div class="row">${av(p.name, "a")}<div><h2 style="font-size:22px">${esc(p.name)}</h2><span class="small muted">${ordinal(p.rank)} · ${p.w}–${p.l}</span></div></div><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px"><div class="card pad"><span class="small soft">Rating</span><div class="num" style="font-size:34px;margin-top:8px">${p.r}</div></div><div class="card pad"><span class="small soft">Peak</span><div class="num" style="font-size:34px;margin-top:8px">${Math.max(...p.hist)}</div></div></div>
    <div class="card pad" style="display:flex;flex-direction:column;gap:6px"><span class="small muted">Head to head</span>${opp.map(o => `<div class="between"><span>v ${esc(o.name)}</span><b>${o.w}–${o.l}</b></div>`).join("")}</div>
    <div class="card pad" style="display:flex;flex-direction:column;gap:6px"><span class="small muted">Recent</span>${recent.map(m => { const me = m.aKey === k ? 0 : 1, dd = (deltas.get(m.id) || [0, 0])[me]; return `<div class="between"><span>${m.winner === me ? "Beat" : "Lost to"} ${esc(me ? m.a : m.b)} ${m.gw[me]}–${m.gw[1 - me]}</span><span class="${dd >= 0 ? "up" : "down"}">${sign(dd)}</span></div>`; }).join("")}</div>`);
}
function vSheets(app) {
  const fin = finished().slice().reverse();
  if (!paint(app, `<header class="between r-up"><h1 style="font-size:28px">Score sheets</h1>${fin.length ? `<button class="btn small ghost" id="sheetPdf">${ICON.share.replace("<svg ", '<svg width="18" height="18" ')}PDF</button>` : `<span class="small muted">Newest first</span>`}</header>
  ${fin.length ? `<div class="r-up d1" style="display:flex;flex-direction:column;gap:10px">${fin.map(m => `<button class="card sheetcard" data-id="${esc(m.id)}"><span class="between small muted"><span>${fmtDate(m.endedAt)}${m.local ? " · this phone" : ""}</span><span>${m.bestOf === 1 ? "1 game" : "Best of " + m.bestOf}</span></span>
    <span class="between"><span style="font-weight:${m.winner === 0 ? 700 : 500};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.a)}</span><span class="num" style="font-size:28px">${m.gw[0]}–${m.gw[1]}</span><span style="font-weight:${m.winner === 1 ? 700 : 500};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right">${esc(m.b)}</span></span>
    <span class="gpills">${(m.g || []).map(s => { const [a, b] = R.gameScore([...s].map(Number)); return `<span>${a}–${b}</span>`; }).join("")}</span></button>`).join("")}</div>`
    : `<div class="card empty r-up d1"><b>No sheets yet</b>Every match you finish gets a score sheet here.</div>`}`)) return;
  app.querySelectorAll("[data-id]").forEach(b => b.onclick = () => { S.report = finished().find(x => x.id === b.dataset.id); S.screen = "report"; render(); });
  if ($("#sheetPdf")) $("#sheetPdf").onclick = () => exportHistoryPdf(finished(), "Match history");
}
function vYou(app) {
  const me = myName(), key = R.keyOf(me || ""), p = key ? R.computeBoard(finished()).byKey.get(key) : null;
  if (!paint(app, uid() ? `
  <header class="row r-up">${av(me, "a")}<div style="flex:1;min-width:0"><h1 style="font-size:24px;overflow:hidden;text-overflow:ellipsis">${esc(me)}</h1><span class="small muted">${esc(S.session.user.email || "")}</span></div></header>
  <div class="r-up d1" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px">
    <div class="card pad"><span class="small soft">Rating</span><div class="num" style="font-size:30px;margin-top:8px">${p ? p.r : 1000}</div></div>
    <div class="card pad"><span class="small soft">Won</span><div class="num" style="font-size:30px;margin-top:8px">${p ? p.w : 0}</div></div>
    <div class="card pad"><span class="small soft">Lost</span><div class="num" style="font-size:30px;margin-top:8px">${p ? p.l : 0}</div></div></div>
  <form class="card pad r-up d2" id="nameForm" style="display:flex;flex-direction:column;gap:10px"><div class="field"><label for="myName">Name on the ladder</label><input class="input" id="myName" maxlength="32" value="${esc(me)}"></div>
    <p class="note">Your ladder history is matched by name, so keep it the same one you play under.</p><p class="err" id="nameErr"></p><button class="btn ghost" type="submit">Save name</button></form>
  <button class="btn ghost r-up d3" id="signOut">Sign out</button>`
  : `<header class="r-up"><h1 style="font-size:28px">You're playing as a guest</h1></header>
  <div class="card pad r-up d1"><p class="soft" style="margin:0">Guest matches stay on this phone. Sign in to start shared matches, keep score with friends and get on the club ladder.</p></div>
  ${sb ? `<button class="btn r-up d2" id="toSignIn">Sign in or create an account</button>` : ""}`)) return;
  if ($("#toSignIn")) $("#toSignIn").onclick = () => { S.guest = false; LS.set("rally.guest", false); render(); };
  if ($("#signOut")) $("#signOut").onclick = async () => { await sb.auth.signOut(); S.session = null; location.hash = "#home"; render(); };
  if ($("#nameForm")) $("#nameForm").onsubmit = async e => {
    e.preventDefault();
    const name = $("#myName").value.trim(); if (!name) { $("#nameErr").textContent = "Your name can't be empty."; return; }
    const { error } = await sb.from("profiles").update({ name }).eq("id", uid());
    if (error) { $("#nameErr").textContent = "Couldn't save your name."; return; }
    await loadProfiles(); render(true); toast("Name saved");
  };
}

/* ---------- tournaments ---------- */
const MODE = {
  koth: ["King of the hill", "The winner stays on the table and the next challenger steps up."],
  round_robin: ["Everyone plays everyone", "Each player meets every other player once."],
  bracket: ["Knockout bracket", "Single elimination. Byes go to the top of the draw."]
};
const fmtFormat = (b, t) => (b === 1 ? "1 game" : "Best of " + b) + (t === 21 ? " · to 21" : "");
const toT = r => ({ id: r.id, name: r.name, mode: r.mode, crossTeam: r.cross_team, draw: r.draw, seed: r.seed, bestOf: r.best_of, target: r.target, code: r.join_code, status: r.status, owner: r.owner, champion: r.champion, createdAt: Date.parse(r.created_at) || 0, endedAt: r.ended_at ? Date.parse(r.ended_at) : null });
const toTP = r => ({ id: r.id, name: r.name, team: r.team || "", userId: r.user_id || null, position: r.position, joinedRound: r.joined_round || 0 });
async function loadTournaments() {
  if (!sb || !uid()) { S.tournaments = []; return; }
  const { data, error } = await sb.from("tournaments").select("*").order("created_at", { ascending: false }).limit(50);
  if (!error) { S.tournaments = (data || []).map(toT); pruneLive(); }
}
/* Scorekeeper rights live on the server; a player who joined by code on another phone is a keeper here too. */
async function loadTKeepers() {
  if (!sb || !uid()) return;
  try {
    const { data, error } = await sb.from("tournament_keepers").select("tournament_id");
    if (error || !data) return;
    data.forEach(r => r && r.tournament_id && S.tkeep.add(r.tournament_id));
    LS.set("rally.tkeep", [...S.tkeep].slice(-50));
  } catch (e) {}
}
/* One read of a tournament: undefined when the server couldn't be reached (keep what's on screen),
   null when the tournament no longer exists. */
let tourSeq = 0, tourApplied = 0, tourOpening = null;
async function readTour(id) {
  const n = ++tourSeq;
  if (!sb) return { T: undefined, n };
  const [t, p, m] = await Promise.all([
    sb.from("tournaments").select("*").eq("id", id).maybeSingle(),
    sb.from("tournament_players").select("*").eq("tournament_id", id).order("position", { ascending: true }),
    sb.from("live_matches").select("*").eq("tournament_id", id)
  ]);
  if (t.error || p.error || m.error) return { T: undefined, n };
  return { T: t.data ? { t: toT(t.data), players: (p.data || []).map(toTP), matches: (m.data || []).map(fromRow) } : null, n };
}
/* Shows a read only if it is for the tournament on screen (or the one being opened) and is newer than the one shown,
   so a slow older reply can't roll the screen back, and a background sync never swaps in another tournament. */
function applyTour(id, T, n) {
  if (T === undefined || n < tourApplied) return;
  if (!(S.tour ? S.tour.t.id === id : S.screen === "tour" && tourOpening === id)) return;
  tourApplied = n; S.tour = T;
}
async function loadTour(id) {
  const { T, n } = await readTour(id);
  applyTour(id, T, n);
  return T === undefined ? (S.tour && S.tour.t.id === id ? S.tour : null) : T;
}
const planOf = T => R.tournamentPlan(T.t, T.players, T.matches);
const tpName = (T, id) => (T.players.find(p => p.id === id) || {}).name || "To be decided";
const teamList = T => [...new Set(T.players.map(p => p.team).filter(Boolean))];
const teamTag = (teams, team) => team ? `<span class="tt t${Math.max(0, teams.indexOf(team)) % 4}" style="max-width:40%;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;flex:none">${esc(team)}</span>` : "";
const tkey = x => x.round + ":" + x.slot;
/* The server match for a planned slot, only if it really is that pairing (a stale row can sit in a slot until it's swept). */
const slotMatch = (byKey, d) => { const m = byKey.get(tkey(d)); return m && m.aTp === d.aTp && m.bTp === d.bTp ? m : null; };

/* Brings the server in line with the plan: removes unstarted matches that no longer belong, creates the next ones,
   and finishes (or reopens, after an undo) the tournament. Every pass works from a fresh read, never from what's on
   screen, so a phone with stale data can't delete the next round another phone just created. Passes for one
   tournament run one at a time; a request that arrives mid-pass queues one more pass instead of being dropped.
   Safe to run on several phones at once: each slot is unique on the server. */
const reconRun = new Map(), reconAgain = new Set();
function reconcile(tid) {
  tid = tid || (S.tour && S.tour.t.id);
  if (!tid || !sb || !uid()) return Promise.resolve();
  if (reconRun.has(tid)) { reconAgain.add(tid); return reconRun.get(tid); }
  const run = (async () => {
    try { do { reconAgain.delete(tid); await reconcileOnce(tid); } while (reconAgain.has(tid)); }
    catch (e) { console.warn("Rally: could not sync the tournament", e && e.message); }
    finally { reconRun.delete(tid); }
  })();
  reconRun.set(tid, run);
  return run;
}
async function reconcileOnce(tid) {
  let { T, n } = await readTour(tid);
  if (!T || !(T.t.owner === uid() || S.tkeep.has(tid))) return applyTour(tid, T, n);
  const plan = planOf(T), want = new Map(plan.desired.map(d => [tkey(d), d]));
  const fits = m => { const d = want.get(tkey(m)); return !!d && d.aTp === m.aTp && d.bTp === m.bTp; };
  let changed = false, status = false;
  // once a tournament is over, a half-played match left on the table goes too (the server lets its creator remove it),
  // so it doesn't linger in Live now; while it's running, only unstarted matches are ever swept
  const sweep = m => m.status !== "done" && !fits(m) && (m.games.join("") === "" || (T.t.status === "done" && m.owner === uid()));
  for (const m of T.matches) {
    if (!sweep(m)) continue;
    const { error } = await sb.from("live_matches").delete().eq("id", m.id);
    if (!error) changed = true;
  }
  if (T.t.status === "live") {
    const have = new Set(T.matches.filter(fits).map(tkey));
    for (const d of plan.desired) {
      if (have.has(tkey(d))) continue;
      const A = T.players.find(p => p.id === d.aTp), B = T.players.find(p => p.id === d.bTp);
      if (!A || !B) continue;
      const row = { a_name: A.name, b_name: B.name, a_user: A.userId, b_user: B.userId, best_of: T.t.bestOf, target: T.t.target, first_server: (d.round + d.slot) % 2, keepers: "tournament", tournament_id: T.t.id, round: d.round, slot: d.slot, a_tp: d.aTp, b_tp: d.bTp };
      let { error } = await sb.from("live_matches").insert(row);
      // 23505 is either the slot already made by another phone or a join code clash; one retry settles which
      if (error && error.code === "23505") ({ error } = await sb.from("live_matches").insert(row));
      if (!error || error.code === "23505") changed = true;
      else console.warn("Rally: could not create a tournament match", error.message);
    }
    if (plan.complete && T.t.mode !== "koth") {
      const { error } = await sb.from("tournaments").update({ status: "done", ended_at: new Date().toISOString(), champion: plan.champion }).eq("id", tid);
      if (!error) changed = status = true;
    }
  } else if (T.t.mode !== "koth" && !plan.complete) {
    // the deciding result was undone after the finish: the tournament is live again
    const { error } = await sb.from("tournaments").update({ status: "live", ended_at: null, champion: null }).eq("id", tid);
    if (!error) changed = status = true;
  }
  if (changed) ({ T, n } = await readTour(tid));
  if (status && T && T.t.status === "live") reconAgain.add(tid); // reopened: one more pass recreates the matches
  if (status) await loadTournaments();
  applyTour(tid, T, n);
}
/* A tournament match finished (or was undone, or vanished): keepers bring the tournament up to date even when
   they scored it from another screen, so a bracket never waits for someone to open the tournament. */
async function afterTourMatch(tid) {
  if (!tid || !(isTKeeper(tid) || (S.tour && S.tour.t.id === tid))) return;
  await reconcile(tid);
  render(true);
}
const reconT = new Map();
function soonReconcile(tid) { clearTimeout(reconT.get(tid)); reconT.set(tid, setTimeout(() => { reconT.delete(tid); afterTourMatch(tid); }, 60)); }
async function openTour(id) {
  S.screen = "tour"; tourOpening = id; if (S.tour && S.tour.t.id !== id) S.tour = null;
  if (!S.tour) $("#app").innerHTML = `<div class="empty">Loading the tournament…</div>`;
  const T = await loadTour(id);
  if (S.screen !== "tour") return; // they moved on while it loaded
  if (!T) { S.screen = null; render(); return toast("That tournament isn't available any more."); }
  render();
  await reconcile(id);
  if (S.screen === "tour" && S.tour && S.tour.t.id === id) render(true);
}
/* Realtime pauses while the phone sleeps: catch up on the open tournament when it wakes. */
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.tour && uid()) afterTourMatch(S.tour.t.id); });
function openTourJoin() {
  openSheet(`<div class="between"><h2 style="font-size:22px">Join a tournament</h2><button class="icon-btn" data-close aria-label="Close">${ICON.close}</button></div>
    <form id="tjForm" style="display:flex;flex-direction:column;gap:12px"><div class="field"><label for="tjCode">4-digit tournament code</label><input class="input code" id="tjCode" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" style="height:72px"></div>
    <p class="err" id="tjErr"></p><button class="btn" type="submit">Join as scorekeeper</button></form>`,
  close => {
    $("#tjCode").focus();
    $("#tjForm").onsubmit = async e => {
      e.preventDefault();
      const code = $("#tjCode").value.trim();
      if (!/^\d{4}$/.test(code)) { $("#tjErr").textContent = "Enter the 4 digits from the host's phone."; return; }
      const { data, error } = await sb.rpc("join_tournament", { p_code: code });
      if (error || !data) { $("#tjErr").textContent = "No live tournament has that code."; return; }
      S.tkeep.add(data); LS.set("rally.tkeep", [...S.tkeep].slice(-50));
      close(); await loadTournaments(); toast("You can now score this tournament's matches"); openTour(data);
    };
  });
}

function vCups(app) {
  if (!uid()) {
    app.innerHTML = `<header class="r-up"><h1 style="font-size:28px">Tournaments</h1></header>
      <div class="card pad r-up d1"><p class="soft" style="margin:0">Sign in to host tournaments, bring in another team and keep score together.</p></div>
      ${sb ? `<button class="btn r-up d2" id="toSignIn2">Sign in or create an account</button>` : ""}`;
    if ($("#toSignIn2")) $("#toSignIn2").onclick = () => { S.guest = false; LS.set("rally.guest", false); render(); };
    return;
  }
  const live = S.tournaments.filter(t => t.status === "live"), done = S.tournaments.filter(t => t.status !== "live");
  const card = (t, i) => `<button class="card pad r-up d${Math.min(5, i + 2)}" data-tour="${esc(t.id)}" style="display:flex;flex-direction:column;gap:6px;text-align:left;width:100%;${t.status === "live" ? "border-color:rgba(255,90,31,.4)" : ""}">
      <span class="between"><b style="font-size:17px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</b><span class="tag ${t.status === "live" ? "" : "ghost"}" style="flex:none">${t.status === "live" ? "Live" : "Finished"}</span></span>
      <span class="small muted">${MODE[t.mode][0]} · ${fmtFormat(t.bestOf, t.target)} · ${fmtDate(t.createdAt)}</span></button>`;
  app.innerHTML = `<header class="between r-up"><h1 style="font-size:28px">Tournaments</h1><button class="icon-btn" id="tJoinBtn" aria-label="Join a tournament with a code">${ICON.key}</button></header>
    <button class="btn r-up d1" id="tNewBtn">${ICON.plus}Host a tournament</button>
    ${live.length ? `<div class="sec r-up d2"><h2>Live</h2></div>${live.map(card).join("")}` : ""}
    ${done.length ? `<div class="sec r-up d3"><h2>Finished</h2></div>${done.map(card).join("")}` : ""}
    ${!S.tournaments.length ? `<div class="card empty r-up d2"><b>No tournaments yet</b>Host one for your club, or put two teams head to head.</div>` : ""}`;
  $("#tNewBtn").onclick = () => { S.screen = "tnew"; render(); }; // a half-made tournament is picked up where it was left
  $("#tJoinBtn").onclick = openTourJoin;
  app.querySelectorAll("[data-tour]").forEach(b => b.onclick = () => openTour(b.dataset.tour));
}

const newDraft = () => ({ name: "", mode: "bracket", draw: "random", crossTeam: true, bestOf: 1, target: 11, teams: [], team: "", players: [], newName: "", newTeam: "" });
/* The half-made tournament survives leaving the screen and restarting the app (per signed-in player). */
function tourDraft() {
  if (S.tdraft) return S.tdraft;
  const saved = LS.get("rally.tdraft", null), d = newDraft();
  if (saved && saved.by === uid() && saved.d) {
    const s = saved.d;
    if (MODE[s.mode]) d.mode = s.mode;
    ["name", "newName", "newTeam"].forEach(k => { if (typeof s[k] === "string") d[k] = s[k]; });
    if (["random", "seeded"].includes(s.draw)) d.draw = s.draw;
    if ([1, 3, 5].includes(s.bestOf)) d.bestOf = s.bestOf;
    if ([11, 21].includes(s.target)) d.target = s.target;
    d.crossTeam = s.crossTeam !== false;
    d.teams = (Array.isArray(s.teams) ? s.teams : []).filter(t => typeof t === "string" && t.trim());
    d.team = d.teams.includes(s.team) ? s.team : "";
    d.players = (Array.isArray(s.players) ? s.players : []).filter(p => p && typeof p.name === "string" && p.name.trim())
      .map(p => ({ name: p.name, team: d.teams.includes(p.team) ? p.team : "", userId: p.userId || null }));
  }
  return (S.tdraft = d);
}
const saveDraft = () => { const d = S.tdraft; if (d) LS.set("rally.tdraft", { by: uid(), d: Object.assign({}, d, { busy: false }) }); };
const tidyName = s => String(s || "").replace(/\s+/g, " ").trim();
/* The order sent as each player's position, which is what the draw is built from.
   Seeded knockouts go by ladder rating; players on the same rating alternate between teams (in the order added),
   so the top seeds and byes aren't all handed to whichever team was typed in first. A random King of the hill
   queue is shuffled here; a random knockout is shuffled by the draw itself from the tournament's seed. */
function tourOrder(d) {
  const list = d.players.map((p, i) => ({ name: p.name, team: d.teams.includes(p.team) ? p.team : "", userId: p.userId || null, i }));
  if (d.mode === "bracket" && d.draw === "seeded") {
    const board = R.computeBoard(finished()).byKey, rating = p => (board.get(R.keyOf(p.name)) || { r: 1000 }).r;
    const nth = new Map(), count = new Map();
    list.forEach(p => { const k = rating(p) + "|" + p.team; nth.set(p, p.team ? (count.get(k) || 0) : 0); count.set(k, (count.get(k) || 0) + 1); });
    const tix = p => p.team ? d.teams.indexOf(p.team) : d.teams.length;
    return list.sort((x, y) => rating(y) - rating(x) || nth.get(x) - nth.get(y) || tix(x) - tix(y) || x.i - y.i);
  }
  if (d.mode === "koth" && d.draw === "random") return R.shuffled(list, parseInt(rand(4), 16) || 1);
  return list;
}
/* Repaints only when the markup changed, so realtime refreshes don't wipe what's being typed or steal focus;
   when it does repaint, focus and the cursor go back where they were. */
function paintForm(app, html, values) {
  const ae = document.activeElement, fid = ae && ae.id && app.contains(ae) ? ae.id : null;
  let s0 = null, s1 = null; try { s0 = ae.selectionStart; s1 = ae.selectionEnd; } catch (e) {}
  const full = html.replace(/\u0001(\w+)\u0001/g, (_, k) => esc(values[k] || ""));
  if (!paint(app, full, html)) return false;
  const el = fid && document.getElementById(fid);
  if (el) { el.focus(); try { if (s0 != null) el.setSelectionRange(s0, s1); } catch (e) {} }
  return true;
}
const slotVal = k => "\u0001" + k + "\u0001";

function vTourNew(app) {
  const d = tourDraft();
  const added = new Set(d.players.map(p => R.keyOf(p.name)));
  const members = S.profiles.filter(p => !added.has(R.keyOf(p.name)));
  const drawOpts = d.mode === "bracket" ? [["random", "Random draw"], ["seeded", "Seeded by rating"]] : d.mode === "koth" ? [["random", "Random queue"], ["seeded", "Order added"]] : [];
  const cut = "min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  const teamSel = (p, i) => `<select class="tt ${p.team ? "t" + (d.teams.indexOf(p.team) % 4) : ""}" data-pteamsel="${i}" aria-label="Team for ${esc(p.name)}" style="border:0;font:inherit;font-size:12px;font-weight:700;max-width:40%;flex:none;${cut}">${[""].concat(d.teams).map(t => `<option value="${esc(t)}"${p.team === t ? " selected" : ""}>${t ? esc(t) : "No team"}</option>`).join("")}</select>`;
  const dirty = d.name.trim() || d.players.length || d.teams.length;
  const html = `
  <header class="row r-up"><button class="icon-btn" id="tnBack" aria-label="Back">${ICON.back}</button><h1 style="flex:1;text-align:center;font-size:19px;font-weight:600">New tournament</h1><span style="width:46px"></span></header>
  <div class="field r-up d1"><label for="tnName">Name</label><input class="input" id="tnName" maxlength="60" placeholder="Club night" value="${slotVal("name")}"></div>
  <div class="field r-up d1"><span class="small muted">Format</span>${Object.keys(MODE).map(k => `<button type="button" class="opt" data-mode="${k}" aria-pressed="${d.mode === k}"><b>${MODE[k][0]}</b><span>${MODE[k][1]}</span></button>`).join("")}</div>
  <div class="row r-up d2" style="gap:10px"><div class="field" style="flex:1.4;min-width:0"><span class="small muted">Each match</span><div class="pills">${[1, 3, 5].map(n => `<button type="button" data-tbest="${n}" aria-pressed="${d.bestOf === n}">${n === 1 ? "1 game" : "Bo" + n}</button>`).join("")}</div></div>
    <div class="field" style="flex:1;min-width:0"><span class="small muted">Points</span><div class="pills">${[11, 21].map(n => `<button type="button" data-ttarget="${n}" aria-pressed="${d.target === n}">${n}</button>`).join("")}</div></div></div>
  ${drawOpts.length ? `<div class="field r-up d2"><span class="small muted">${d.mode === "bracket" ? "Draw" : "Queue"}</span><div class="pills">${drawOpts.map(([v, l]) => `<button type="button" data-draw="${v}" aria-pressed="${d.draw === v}">${l}</button>`).join("")}</div></div>` : ""}
  <div class="card pad r-up d3" style="display:flex;flex-direction:column;gap:10px">
    <span style="font-weight:600">Teams <span class="small muted">(optional)</span></span>
    ${d.teams.length ? `<div class="chips">${d.teams.map((t, i) => `<span class="tt t${i % 4}" style="font-size:13px;padding:6px 6px 6px 10px;display:inline-flex;align-items:center;gap:4px;max-width:100%"><span style="${cut}">${esc(t)}</span><button class="xbtn" style="width:24px;height:24px;flex:none" data-rmteam="${i}" aria-label="Remove team ${esc(t)}">${ICON.close}</button></span>`).join("")}</div>` : ""}
    <div class="row" style="gap:8px"><input class="input" id="tnTeam" maxlength="32" placeholder="Team name" value="${slotVal("newTeam")}" style="flex:1;min-width:0"><button class="btn small ghost" id="tnAddTeam">Add</button></div>
    ${d.teams.length >= 2 ? `<label class="toggle"><input type="checkbox" id="tnCross" ${d.crossTeam ? "checked" : ""}>Pair players from different teams${d.mode === "round_robin" ? " only" : ""}</label>` : ""}
  </div>
  <div class="card pad r-up d4" style="display:flex;flex-direction:column;gap:10px">
    <span class="between"><span style="font-weight:600">Players</span><span class="small muted">${d.players.length} added</span></span>
    ${d.teams.length ? `<span class="small muted">New players join</span><div class="chips" role="group" aria-label="Team for new players">${[""].concat(d.teams).map(t => `<button type="button" class="chip plain" style="max-width:100%" data-pteam="${esc(t)}" aria-pressed="${d.team === t}"><span style="${cut}">${t ? esc(t) : "No team"}</span></button>`).join("")}</div>` : ""}
    <div class="row" style="gap:8px"><input class="input" id="tnPlayer" maxlength="32" placeholder="Player name" value="${slotVal("newName")}" style="flex:1;min-width:0"><button class="btn small" id="tnAddPlayer">Add</button></div>
    ${members.length ? `<span class="small muted" style="${cut}">From your club${d.team ? " · adds to " + esc(d.team) : ""}</span><div class="chips">${members.map(p => `<button class="chip" style="max-width:100%" data-member="${esc(p.id)}">${av(p.name)}<span style="${cut}">${esc(p.name)}</span></button>`).join("")}</div>` : ""}
    <div class="plist">${d.players.map((p, i) => `<div class="pitem">${av(p.name, "sm")}<span class="nm">${esc(p.name)}</span>${d.teams.length ? teamSel(p, i) : ""}<button class="xbtn" style="flex:none" data-rmp="${i}" aria-label="Remove ${esc(p.name)}">${ICON.close}</button></div>`).join("")}</div>
  </div>
  <p class="err" id="tnErr"></p>
  <button class="btn r-up d5" id="tnStart" ${d.busy ? "disabled" : ""}>${ICON.play}${d.busy ? "Starting…" : "Start tournament"}</button>
  ${dirty && !d.busy ? `<button class="link" id="tnReset" style="align-self:center">Start over</button>` : ""}`;
  paintForm(app, html, d);
  // what is on screen is the truth for the typed fields (input events can be skipped by autofill or IME)
  const sync = () => { d.name = $("#tnName").value; d.newName = $("#tnPlayer").value; d.newTeam = $("#tnTeam").value; };
  const again = () => { sync(); saveDraft(); render(true); };
  $("#tnName").oninput = e => { d.name = e.target.value; saveDraft(); };
  $("#tnPlayer").oninput = e => { d.newName = e.target.value; saveDraft(); };
  $("#tnTeam").oninput = e => { d.newTeam = e.target.value; saveDraft(); };
  if ($("#tnCross")) $("#tnCross").onchange = e => { d.crossTeam = e.target.checked; again(); };
  $("#tnBack").onclick = () => { S.screen = null; render(); };
  if ($("#tnReset")) $("#tnReset").onclick = () => { S.tdraft = newDraft(); LS.del("rally.tdraft"); app.innerHTML = ""; render(true); };
  app.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => { d.mode = b.dataset.mode; again(); });
  app.querySelectorAll("[data-tbest]").forEach(b => b.onclick = () => { d.bestOf = +b.dataset.tbest; again(); });
  app.querySelectorAll("[data-ttarget]").forEach(b => b.onclick = () => { d.target = +b.dataset.ttarget; again(); });
  app.querySelectorAll("[data-draw]").forEach(b => b.onclick = () => { d.draw = b.dataset.draw; again(); });
  app.querySelectorAll("[data-pteam]").forEach(b => b.onclick = () => { d.team = d.teams.includes(b.dataset.pteam) ? b.dataset.pteam : ""; again(); });
  app.querySelectorAll("[data-pteamsel]").forEach(s => s.onchange = () => { const p = d.players[+s.dataset.pteamsel]; if (p) p.team = d.teams.includes(s.value) ? s.value : ""; again(); });
  app.querySelectorAll("[data-rmteam]").forEach(b => b.onclick = () => {
    const t = d.teams.splice(+b.dataset.rmteam, 1)[0];
    d.players.forEach(p => { if (p.team === t) p.team = ""; });
    if (d.team === t) d.team = "";
    again();
  });
  app.querySelectorAll("[data-rmp]").forEach(b => b.onclick = () => { d.players.splice(+b.dataset.rmp, 1); again(); });
  const addPlayer = (name, userId) => {
    name = tidyName(name);
    if (!name) { toast("Type a player's name first."); return false; }
    if (d.players.some(p => R.keyOf(p.name) === R.keyOf(name))) { toast(name + " is already in the tournament."); return false; }
    d.players.push({ name, team: d.teams.includes(d.team) ? d.team : "", userId: userId || null });
    return true;
  };
  $("#tnAddTeam").onclick = () => {
    sync(); const t = tidyName(d.newTeam);
    if (!t) return toast("Type a team name first.");
    if (d.teams.some(x => x.toLowerCase() === t.toLowerCase())) return toast(t + " is already a team.");
    d.teams.push(t); $("#tnTeam").value = ""; if (!d.team) d.team = t;
    again(); $("#tnTeam").focus();
  };
  $("#tnAddPlayer").onclick = () => { sync(); if (addPlayer(d.newName)) $("#tnPlayer").value = ""; again(); $("#tnPlayer").focus(); };
  $("#tnPlayer").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); $("#tnAddPlayer").click(); } };
  $("#tnTeam").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); $("#tnAddTeam").click(); } };
  app.querySelectorAll("[data-member]").forEach(b => b.onclick = () => { const p = S.profiles.find(x => x.id === b.dataset.member); if (p) addPlayer(p.name, p.id); again(); });
  $("#tnStart").onclick = async () => {
    if (d.busy) return; // a second tap (or a tap on a button redrawn by a refresh) mustn't create a second tournament
    sync();
    const fail = msg => { $("#tnErr").textContent = msg; };
    const name = tidyName(d.name);
    if (!name) return fail("Give the tournament a name.");
    if (d.players.length < 2) return fail("Add at least two players.");
    const order = tourOrder(d), cross = !!d.crossTeam && d.teams.length >= 2;
    if (cross && new Set(order.map(p => p.team).filter(Boolean)).size < 2) return fail("Put players in at least two teams, or turn off pairing players from different teams.");
    d.busy = true; render(true);
    let msg = "Couldn't create the tournament. Check your connection.";
    try {
      const row = { name, mode: d.mode, cross_team: cross, draw: d.mode === "round_robin" ? "random" : d.draw, best_of: d.bestOf, target: d.target };
      let ins = await sb.from("tournaments").insert(row).select().single();
      if (ins.error && ins.error.code === "23505") ins = await sb.from("tournaments").insert(row).select().single(); // join code clash: the server picks another
      if (!ins.error && ins.data) {
        const tid = ins.data.id;
        // exactly the team names the draw compares: trimmed, one of this tournament's teams, or "" for no team
        const pl = await sb.from("tournament_players").insert(order.map((p, i) => ({ tournament_id: tid, name: p.name, team: p.team, user_id: p.userId, position: i })));
        if (!pl.error) {
          if (S.tdraft === d) S.tdraft = null;
          LS.del("rally.tdraft");
          await loadTournaments(); openTour(tid);
          return;
        }
        await sb.from("tournaments").delete().eq("id", tid); // don't leave an empty tournament behind
        msg = "Couldn't save the players. Check your connection and try again.";
      }
    } catch (e) {}
    d.busy = false; saveDraft(); render(true);
    if ($("#tnErr")) $("#tnErr").textContent = msg;
  };
}

function openTourMatch(id) {
  const T = S.tour, m = T && T.matches.find(x => x.id === id);
  if (!m) return;
  if (m.status === "done") { // a finished match opens its score sheet, not a scoring screen
    const rec = finished().find(x => x.id === id);
    S.report = rec || Object.assign(toRecord(m), { tournament: T.t.name });
    S.screen = "report"; return render();
  }
  S.game = Object.assign({}, m, { flip: 0 }); render();
}
function vTour(app) {
  const T = S.tour, t = T.t, plan = planOf(T), keeper = isTKeeper(t.id), owner = t.owner === uid(), on = t.status === "live";
  const teams = teamList(T), st = R.standings(T.players, T.matches);
  const byKey = new Map(T.matches.map(m => [tkey(m), m])), at = d => slotMatch(byKey, d);
  const live = plan.desired.map(at).filter(m => m && m.status === "live");
  const waiting = on ? plan.desired.filter(d => !at(d)) : [];
  const doneM = T.matches.filter(m => m.status === "done").sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
  const champ = plan.champion && (plan.complete || t.mode === "koth") ? tpName(T, plan.champion) : "";
  const cut = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  const mrow = m => { const s = R.summarize(R.toMatch(m.games, m.bestOf, m.target, m.firstServer)); const started = m.games.join("") !== "";
    return `<button class="mrow" data-m="${esc(m.id)}"><span class="who"><span style="font-weight:600">${esc(m.a)} <span class="muted">v</span> ${esc(m.b)}</span><span class="small muted">${t.mode === "bracket" ? roundName(m.round, plan) : t.mode === "round_robin" ? "Round " + (m.round + 1) : "Match " + (m.round + 1)}${started ? ` · game ${s.g + 1}: ${s.cur[0]}–${s.cur[1]}` : ""}</span></span><span class="tag ${keeper ? "" : "ghost"}" style="flex:none">${keeper ? (started ? "Score" : "Start") : "Watch"}</span></button>`; };
  let body = "";
  if (t.mode === "koth") {
    const k = plan.koth, cur = k.champion ? k.streaks.get(k.champion) : null;
    // the challenger of the match on the table is shown there, not as first in the queue
    const last = k.matches[k.matches.length - 1], open = on && last && !R.matchWinnerTp(at(last)) ? last : null;
    const queue = k.queue.filter(id => !open || id !== open.bTp);
    const kteam = S.kteam === "" || teams.includes(S.kteam) ? S.kteam : (teams[0] || "");
    body = `<div class="card pad r-up d2" style="position:relative;overflow:hidden;border-color:rgba(255,90,31,.45)"><span style="position:absolute;right:-60px;top:-80px;width:240px;height:220px;border-radius:50%;background:radial-gradient(closest-side,rgba(255,90,31,.45),rgba(255,90,31,0))"></span>
      <span class="small" style="position:relative;color:#ffd2bf">${on ? "On the table" : "Last one standing"}</span>
      <div class="row" style="position:relative;margin-top:6px">${av(champ || "?", "a")}<span style="flex:1;min-width:0"><b style="font-size:24px;display:block;${cut}">${esc(champ || "Waiting for players")}</b><span class="small soft" style="display:block;${cut}">${open ? "v " + esc(tpName(T, open.bTp)) + (cur ? " · " : "") : ""}${cur ? `${cur.cur} win${cur.cur === 1 ? "" : "s"} in a row · best ${cur.best}` : ""}</span></span></div></div>
      <div class="card pad r-up d3" style="display:flex;flex-direction:column;gap:8px"><span class="between"><span style="font-weight:600">Queue</span><span class="small muted">${queue.length} waiting</span></span>
      ${queue.length ? `<div class="plist">${queue.slice(0, 8).map((id, i) => { const p = T.players.find(x => x.id === id) || {}; return `<div class="pitem"><span class="muted" style="width:18px;flex:none">${i + 1}</span>${av(p.name, "sm")}<span class="nm">${esc(p.name)}</span>${teamTag(teams, p.team)}</div>`; }).join("")}</div>${queue.length > 8 ? `<span class="small muted">+${queue.length - 8} more</span>` : ""}` : `<span class="small muted">${on ? "Nobody waiting." : "The tournament is over."}</span>`}
      ${keeper && on ? `<div class="row" style="gap:8px"><input class="input" id="kAdd" maxlength="32" placeholder="Add a player to the queue" value="${slotVal("kname")}" style="flex:1;min-width:0"><button class="btn small ghost" id="kAddBtn" ${S.kbusy ? "disabled" : ""}>Add</button></div>${teams.length ? `<div class="chips" role="group" aria-label="Team for the new player">${[""].concat(teams).map(tm => `<button type="button" class="chip plain" style="max-width:100%" data-kteam="${esc(tm)}" aria-pressed="${kteam === tm}"><span style="min-width:0;${cut}">${tm ? esc(tm) : "No team"}</span></button>`).join("")}</div>` : ""}` : ""}</div>`;
  } else if (t.mode === "bracket") {
    body = `<div class="bracket r-up d2">${(plan.tree || []).map((row, r) => `<div class="bcol"><h3>${roundName(r, plan)}</h3>${row.map(s => { const m = s.aTp && s.bTp ? at(s) : null; const sum = m ? R.summarize(R.toMatch(m.games, m.bestOf, m.target)) : null;
        const ln = (id, side) => `<span class="ln ${s.winner ? (s.winner === id ? "w" : "") : ""} ${id ? "" : "tbd"}"><span>${esc(id ? tpName(T, id) : (s.bye && side === 1 ? "Bye" : "To be decided"))}</span><span>${sum ? sum.gw[side] : ""}</span></span>`;
        return `<button class="bm ${m && m.status === "live" && m.games.join("") ? "live" : ""}" ${m ? `data-m="${esc(m.id)}"` : "disabled"}>${ln(s.aTp, 0)}${ln(s.bTp, 1)}</button>`; }).join("")}</div>`).join("")}</div>`;
  }
  const empty = on && !plan.desired.length && t.mode !== "koth" ? `<div class="card empty r-up d2"><b>No matches to play</b>There aren't enough players to make a match.</div>` : "";
  const table = `<div class="card pad r-up d3" style="overflow-x:auto"><table class="tbl"><thead><tr><th>Player</th><th>P</th><th>W</th><th>L</th><th>Games</th><th>Pts</th></tr></thead><tbody>${st.players.map((p, i) => `<tr><td>${i + 1}. ${esc(p.name)} ${teamTag(teams, p.team)}</td><td>${p.p}</td><td>${p.w}</td><td>${p.l}</td><td>${p.gw}–${p.gl}</td><td>${sign(p.pf - p.pa).replace("−", "-")}</td></tr>`).join("")}</tbody></table></div>`;
  const html = `
  <header class="row r-up"><button class="icon-btn" id="tBack" aria-label="Back">${ICON.back}</button>
    <div style="flex:1;min-width:0;text-align:center"><b style="display:block;font-size:18px;${cut}">${esc(t.name)}</b><span class="small muted" style="display:block;${cut}">${MODE[t.mode][0]} · ${fmtFormat(t.bestOf, t.target)}${on ? "" : " · finished"}</span></div>
    <button class="icon-btn" id="tPdf" aria-label="Export this tournament as a PDF">${ICON.share}</button></header>
  ${keeper && on ? `<div class="card pad between r-up d1"><span><span class="small muted">Scorekeeper code</span><br><span class="num" style="font-size:30px;letter-spacing:.25em" id="tCodeTxt">${esc(t.code)}</span></span><button class="btn small ghost" id="tCopy">Copy</button></div>` : ""}
  ${teams.length >= 2 ? `<div class="card pad teams r-up d1">${st.teams.slice(0, 2).map(x => `<span style="min-width:0"><b style="display:block">${esc(x.team)}</b><span class="num" style="font-size:40px">${x.wins}</span></span>`).join('<span class="muted small">match wins</span>')}</div>${teams.length > 2 ? `<p class="note">${st.teams.slice(2).map(x => esc(x.team) + " " + x.wins).join(" · ")}</p>` : ""}` : ""}
  ${champ && t.mode !== "koth" ? `<div class="card pad r-up d1" style="border-color:rgba(255,90,31,.5);text-align:center"><span class="small" style="color:#ffd2bf">Champion</span><div style="font-size:28px;font-weight:700;overflow-wrap:anywhere">${esc(champ)}</div></div>` : ""}
  ${body}${empty}
  ${t.mode !== "bracket" || plan.complete ? table : ""}
  ${live.length ? `<div class="sec r-up d3"><h2>Play now</h2><span class="small muted">${live.length}</span></div><div style="display:flex;flex-direction:column;gap:8px" class="r-up d3">${live.map(mrow).join("")}</div>` : ""}
  ${waiting.length && !keeper ? `<p class="note">${waiting.length} match${waiting.length > 1 ? "es are" : " is"} waiting for a scorekeeper to open ${waiting.length > 1 ? "them" : "it"}.</p>` : ""}
  ${doneM.length ? `<div class="sec r-up d4"><h2>Finished</h2><span class="small muted">${doneM.length}</span></div><div style="display:flex;flex-direction:column;gap:8px" class="r-up d4">${doneM.map(m => { const s = R.summarize(R.toMatch(m.games, m.bestOf, m.target)); return `<button class="mrow" data-rec="${esc(m.id)}"><span class="who"><span><b style="font-weight:${s.winner === 0 ? 700 : 400}">${esc(m.a)}</b> <span class="muted">v</span> <b style="font-weight:${s.winner === 1 ? 700 : 400}">${esc(m.b)}</b></span><span class="small muted">${m.games.filter(Boolean).map(g => R.gameScore([...g].map(Number)).join("–")).join("  ")}</span></span><span class="num" style="font-size:22px;flex:none">${s.gw[0]}–${s.gw[1]}</span></button>`; }).join("")}</div>` : ""}
  ${keeper && on && t.mode === "koth" ? `<button class="btn ghost" id="tEnd">${S.tArm === "end:" + t.id ? "Tap again to end" : "End the tournament"}</button>` : ""}
  <button class="btn ghost" id="tPdf2">Export tournament PDF</button>
  ${owner ? `<button class="link" id="tDel" style="align-self:center;color:var(--bad)">${S.tArm === "del:" + t.id ? "Tap again: delete it for everyone, and its results leave the ladder" : "Delete tournament"}</button>` : ""}`;
  paintForm(app, html, { kname: S.kname });
  $("#tBack").onclick = () => { S.tArm = null; S.screen = null; S.tour = null; location.hash = "#cups"; render(); };
  $("#tPdf").onclick = $("#tPdf2").onclick = () => exportTournamentPdf(S.tour || T);
  if ($("#tCopy")) $("#tCopy").onclick = async () => { try { await navigator.clipboard.writeText(t.code); toast("Code copied"); } catch (e) { toast("Code: " + t.code); } };
  app.querySelectorAll("[data-m]").forEach(b => b.onclick = () => openTourMatch(b.dataset.m));
  app.querySelectorAll("[data-rec]").forEach(b => b.onclick = () => openTourMatch(b.dataset.rec));
  app.querySelectorAll("[data-kteam]").forEach(b => b.onclick = () => { S.kteam = b.dataset.kteam; render(true); });
  if ($("#kAdd")) {
    $("#kAdd").oninput = e => { S.kname = e.target.value; };
    $("#kAdd").onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); $("#kAddBtn").click(); } };
  }
  if ($("#kAddBtn")) $("#kAddBtn").onclick = async () => {
    if (S.kbusy) return;
    const T2 = S.tour; if (!T2 || T2.t.id !== t.id) return;
    const name = tidyName($("#kAdd").value);
    if (!name) return toast("Type a player's name first.");
    if (T2.players.some(p => R.keyOf(p.name) === R.keyOf(name))) return toast(name + " is already in the tournament.");
    const tl = teamList(T2), team = S.kteam === "" || tl.includes(S.kteam) ? S.kteam : (tl[0] || "");
    const pos = T2.players.reduce((m, p) => Math.max(m, p.position || 0), -1) + 1;
    S.kbusy = true; S.kname = $("#kAdd").value; render(true);
    const { error } = await sb.from("tournament_players").insert({ tournament_id: t.id, name, team: team || "", position: pos, joined_round: planOf(T2).koth.nextRound });
    S.kbusy = false;
    if (error) { render(true); return toast("Couldn't add the player."); }
    S.kname = ""; if ($("#kAdd")) $("#kAdd").value = "";
    await reconcile(t.id); render(true); toast(name + " joined the queue");
  };
  // the two-tap confirm lives in S, so a realtime repaint between the taps neither loses nor fakes it
  const arm = (what, then) => async () => {
    if (S.tArm !== what + ":" + t.id) { S.tArm = what + ":" + t.id; clearTimeout(S.tArmT); S.tArmT = setTimeout(() => { S.tArm = null; render(true); }, 4000); return render(true); }
    if (S.tBusy) return;
    S.tBusy = true; clearTimeout(S.tArmT); S.tArm = null;
    try { await then(); } finally { S.tBusy = false; }
  };
  if ($("#tEnd")) $("#tEnd").onclick = arm("end", async () => {
    const T2 = S.tour && S.tour.t.id === t.id ? S.tour : T;
    const { error } = await sb.from("tournaments").update({ status: "done", ended_at: new Date().toISOString(), champion: planOf(T2).champion }).eq("id", t.id);
    if (error) { render(true); return toast("Couldn't end the tournament."); }
    await reconcile(t.id); await loadTournaments(); render(true); toast("Tournament finished");
  });
  if ($("#tDel")) $("#tDel").onclick = arm("del", async () => {
    const { error } = await sb.from("tournaments").delete().eq("id", t.id);
    if (error) { render(true); return toast("Couldn't delete the tournament."); }
    S.tour = null; S.screen = null; await Promise.all([loadTournaments(), loadLadder()]); location.hash = "#cups"; render(); toast("Tournament deleted");
  });
}
function roundName(r, plan) {
  const n = (plan.tree || []).length; if (!n) return "Round " + (r + 1);
  const left = n - r; return left === 1 ? "Final" : left === 2 ? "Semi-finals" : left === 3 ? "Quarter-finals" : "Round " + (r + 1);
}

/* ---------- PDF export ---------- */
const pdfText = s => String(s == null ? "" : s).replace(/−/g, "-").replace(/[^\x20-\x7E -ÿ–—·]/g, "?");
function pdfDoc(title, subtitle) {
  const J = window.jspdf && window.jspdf.jsPDF;
  if (!J) throw new Error("The PDF tools didn't load.");
  const doc = new J({ orientation: "landscape", unit: "pt", format: "a4" }), W = doc.internal.pageSize.getWidth();
  doc.setFillColor(9, 9, 11); doc.rect(0, 0, W, 74, "F");
  doc.setFillColor(255, 90, 31); doc.circle(48, 37, 13, "F");
  doc.setFont("helvetica", "bold"); doc.setFontSize(20); doc.setTextColor(245, 245, 247); doc.text("RALLY", 70, 44);
  doc.setFontSize(15); doc.text(pdfText(title), 160, 36);
  doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(170, 170, 180); doc.text(pdfText(subtitle), 160, 54);
  doc.setTextColor(20, 20, 24);
  return doc;
}
function pdfTable(doc, opts) {
  const base = { theme: "grid", styles: { font: "helvetica", fontSize: 8.5, cellPadding: 4, lineColor: [225, 225, 230], lineWidth: 0.5, textColor: [24, 24, 28] }, headStyles: { fillColor: [255, 90, 31], textColor: 255, fontStyle: "bold" }, alternateRowStyles: { fillColor: [247, 247, 249] }, margin: { left: 36, right: 36 } };
  const o = Object.assign({}, base, opts, { body: opts.body.map(r => r.map(pdfText)), head: opts.head.map(r => r.map(pdfText)) });
  if (typeof doc.autoTable === "function") doc.autoTable(o);
  else { const g = window.jspdfAutoTable; const f = g && (g.autoTable || g.default || g); f(doc, o); }
  return doc.lastAutoTable ? doc.lastAutoTable.finalY : 100;
}
function pdfHeading(doc, y, text) { doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(24, 24, 28); doc.text(pdfText(text), 36, y); return y + 8; }
function matchRows(list) {
  const board = R.computeBoard(finished());
  return list.map(m => {
    const st = R.stats(R.fromRecord(m)), d = board.deltas.get(m.id), scores = (m.g || []).map(s => R.gameScore([...s].map(Number)).join("-"));
    return [fmtDate(m.endedAt), m.tournament || "", m.a + " v " + m.b, m.gw[0] + "-" + m.gw[1], m.winner ? m.b : m.a, scores.join(", "),
      st.pts[0] + "-" + st.pts[1], st.run[0] + "-" + st.run[1], pct(st.srvWon[0], st.srvTot[0]) + " / " + pct(st.srvWon[1], st.srvTot[1]),
      fmtDur(m.endedAt - m.startedAt), d ? (d[0] >= 0 ? "+" : "") + d[0] + " / " + (d[1] >= 0 ? "+" : "") + d[1] : ""];
  });
}
const MATCH_HEAD = [["Date", "Tournament", "Match", "Games", "Winner", "Game scores", "Points", "Best run", "Won on own serve", "Time", "Rating +/-"]];
function pageNumbers(doc) {
  const n = doc.internal.getNumberOfPages(), W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= n; i++) { doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(140, 140, 150); doc.text("Rally · page " + i + " of " + n, W - 36, H - 18, { align: "right" }); }
}
async function savePdf(doc, filename) {
  const C = window.Capacitor, FS = C && C.Plugins && C.Plugins.Filesystem, SH = C && C.Plugins && C.Plugins.Share;
  if (C && C.isNativePlatform && C.isNativePlatform() && FS) {
    const data = doc.output("datauristring").split(",")[1];
    const res = await FS.writeFile({ path: filename, data, directory: "CACHE" });
    if (SH) { try { await SH.share({ title: filename, url: res.uri, dialogTitle: "Save or send the PDF" }); } catch (e) { /* share sheet closed */ } }
    else toast("Saved " + filename);
    return;
  }
  doc.save(filename);
}
async function exportHistoryPdf(list, label) {
  try {
    if (!list.length) return toast("There are no matches to export yet.");
    const players = new Set(); list.forEach(m => { players.add(m.a); players.add(m.b); });
    const doc = pdfDoc(label || "Match history", `${list.length} match${list.length > 1 ? "es" : ""} · ${players.size} players · ${fmtDate(list[0].endedAt)} to ${fmtDate(list[list.length - 1].endedAt)} · exported ${fmtDate(Date.now())}`);
    pdfTable(doc, { startY: 92, head: MATCH_HEAD, body: matchRows(list) });
    pageNumbers(doc);
    await savePdf(doc, "rally-history-" + new Date().toISOString().slice(0, 10) + ".pdf");
  } catch (e) { toast("Couldn't make the PDF: " + (e.message || e)); }
}
async function exportTournamentPdf(T) {
  try {
    const t = T.t, plan = planOf(T), st = R.standings(T.players, T.matches), teams = teamList(T);
    const champ = plan.champion && (plan.complete || t.mode === "koth") ? tpName(T, plan.champion) : "";
    const doc = pdfDoc(t.name, `${MODE[t.mode][0]} · ${fmtFormat(t.bestOf, t.target)} · ${T.players.length} players · ${t.status === "done" ? "finished" : "in progress"} · started ${fmtDate(t.createdAt)}${champ ? " · " + (t.mode === "koth" ? "on the table: " : "champion: ") + champ : ""}`);
    let y = 96;
    if (teams.length >= 2) { y = pdfHeading(doc, y, "Teams"); y = pdfTable(doc, { startY: y, head: [["Team", "Players", "Match wins"]], body: st.teams.map(x => [x.team, T.players.filter(p => p.team === x.team).map(p => p.name).join(", "), String(x.wins)]), columnStyles: { 1: { cellWidth: 420 } } }) + 22; }
    y = pdfHeading(doc, y, "Standings");
    y = pdfTable(doc, { startY: y, head: [["#", "Player", "Team", "Played", "Won", "Lost", "Games", "Points for", "Points against"]], body: st.players.map((p, i) => [String(i + 1), p.name, p.team, String(p.p), String(p.w), String(p.l), p.gw + "-" + p.gl, String(p.pf), String(p.pa)]) }) + 22;
    if (t.mode === "bracket" && plan.tree) {
      y = pdfHeading(doc, y, "Bracket");
      const byKey = new Map(T.matches.map(m => [m.round + ":" + m.slot, m]));
      y = pdfTable(doc, { startY: y, head: [["Round", "Match", "Result", "Winner"]], body: plan.tree.flatMap((row, r) => row.map(s => { const m = byKey.get(r + ":" + s.slot), sum = m ? R.summarize(R.toMatch(m.games, m.bestOf, m.target)) : null; return [roundName(r, plan), (s.aTp ? tpName(T, s.aTp) : "TBD") + " v " + (s.bTp ? tpName(T, s.bTp) : (s.bye ? "bye" : "TBD")), sum ? sum.gw[0] + "-" + sum.gw[1] : "", s.winner ? tpName(T, s.winner) : ""]; })) }) + 22;
    }
    const recs = T.matches.filter(m => m.status === "done").sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0)).map(m => Object.assign(toRecord(m), { tournament: t.name }));
    if (recs.length) { y = pdfHeading(doc, y, "Matches"); pdfTable(doc, { startY: y, head: MATCH_HEAD, body: matchRows(recs) }); }
    pageNumbers(doc);
    await savePdf(doc, "rally-" + (t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "tournament") + ".pdf");
  } catch (e) { toast("Couldn't make the PDF: " + (e.message || e)); }
}

/* ---------- boot ---------- */
try { const SB = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.StatusBar; if (SB) { SB.setStyle({ style: "DARK" }); if (SB.setBackgroundColor) SB.setBackgroundColor({ color: "#09090b" }).catch(() => {}); } } catch (e) {}
let wake = null;
async function keepAwake() { try { if (S.game && navigator.wakeLock && document.visibilityState === "visible" && !wake) { wake = await navigator.wakeLock.request("screen"); wake.addEventListener("release", () => wake = null); } } catch (e) {} }
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  keepAwake();
  if (uid()) { await Promise.all([loadLive(), loadLadder()]); if (S.game && S.game.remote && S.pending === 0) { const { data } = await sb.from("live_matches").select("*").eq("id", S.game.id).maybeSingle(); if (data) S.game = Object.assign(fromRow(data), { flip: S.game.flip }); } render(true); }
});
setInterval(() => { if (uid() && document.visibilityState === "visible" && !S.game) { Promise.all([loadLive(), loadLadder()]).then(() => { const ae = document.activeElement; if (!(ae && ae.tagName === "INPUT") && !$("#sheetRoot").innerHTML) render(true); }); } }, 30000);
window.addEventListener("hashchange", () => render());
const _render = render;
render = function (keep) { _render(keep); if (S.game) keepAwake(); };
window.__rally = { S };
render();
initAuth();
})();
