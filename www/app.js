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
  joined: new Set(LS.get("rally.joined", [])),
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
    startedAt: Date.parse(r.started_at) || Date.now(), endedAt: r.ended_at ? Date.parse(r.ended_at) : null, flip: 0
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
  return g.owner === me || g.keepers === "club" || (g.keepers === "players" && (g.aUser === me || g.bUser === me)) || S.joined.has(g.id);
}
function keepersText(g) {
  if (!g.remote) return "On this phone";
  if (!canScore(g)) return "Watching";
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
  if (!error) S.live = (data || []).map(fromRow);
}
async function loadProfiles() {
  if (!sb || !uid()) return;
  const { data, error } = await sb.from("profiles").select("id,name").order("name", { ascending: true });
  if (!error) { S.profiles = data || []; S.me = S.profiles.find(p => p.id === uid()) || S.me; }
}
let channel = null;
function subscribe() {
  if (!sb || channel || !uid()) return;
  channel = sb.channel("rally-live").on("postgres_changes", { event: "*", schema: "public", table: "live_matches" }, onLiveChange).subscribe();
}
function onLiveChange(p) {
  if (p.eventType === "DELETE") {
    const id = p.old && p.old.id;
    S.live = S.live.filter(m => m.id !== id);
    if (S.game && S.game.id === id) { S.game = null; toast("The host removed this match."); }
    return render(true);
  }
  if (!p.new || !p.new.id) return;
  const row = fromRow(p.new);
  S.live = S.live.filter(m => m.id !== row.id);
  if (row.status === "live") S.live.unshift(row);
  if (S.game && S.game.id === row.id && S.pending === 0 && row.version > S.game.version) {
    const prev = S.game;
    S.game = Object.assign(row, { flip: prev.flip });
    const before = prev.games.join("").length, after = row.games.join("").length;
    if (after > before) { const last = row.games.filter(x => x).pop(); S.bump = { p: +last.slice(-1), n: Date.now() }; }
  }
  if (row.status === "done") loadLadder().then(() => render(true));
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
    await Promise.all([loadProfiles(), loadLadder(), loadLive()]);
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
  return `<div class="bar r-grow" style="animation-delay:${delay.toFixed(2)}s;${extra || ""}">${h}</div>`;
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
const TABS = ["home", "ladder", "sheets", "you"];
const route = () => { const h = (location.hash || "").slice(1); return TABS.includes(h) ? h : "home"; };
let timerT = null;

function render(keep) {
  const app = $("#app");
  let view;
  if (!S.booted) view = "loading";
  else if (!uid() && !S.guest) view = "auth";
  else if (S.game) view = "game";
  else if (S.screen === "new") view = "new";
  else if (S.screen === "report" && S.report) view = "report";
  else view = route();
  app.classList.toggle("still", view === S.lastView || keep === true && view === S.lastView);
  if (view !== S.lastView) window.scrollTo(0, 0);
  S.lastView = view;
  const tabbed = TABS.includes(view);
  app.classList.toggle("full", !tabbed);
  $("#tabbar").hidden = !tabbed;
  document.querySelectorAll(".tabbar a").forEach(a => { if (a.dataset.tab === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  $("#glow").className = "glow " + (view === "auth" || view === "report" ? "big" : "tr");
  clearInterval(timerT);
  const V = { loading: vLoading, auth: vAuth, home: vHome, ladder: vLadder, sheets: vSheets, you: vYou, new: vNew, game: vGame, report: vReport }[view];
  V(app);
}

function vLoading(app) {
  app.innerHTML = `<div class="hero"><span class="eyebrow">Table tennis scorer</span><h1>Rally.</h1><p class="soft" style="margin:0">Getting your club…</p></div>`;
}

function vAuth(app) {
  const up = S.authMode === "signup";
  app.innerHTML = `
  <section class="hero" style="min-height:0">
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
  app.innerHTML = `
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
  <button class="btn r-up d4" id="newBtn">${ICON.plus}Start a match</button>`;
  $("#newBtn").onclick = () => { S.draft = null; S.screen = "new"; render(); };
  if ($("#joinBtn")) $("#joinBtn").onclick = openJoin;
  if ($("#resumeBtn")) $("#resumeBtn").onclick = () => { S.game = LS.get("rally.localGame", null); render(); };
  app.querySelectorAll("[data-live]").forEach(b => b.onclick = () => { const m = S.live.find(x => x.id === b.dataset.live); if (m) { S.game = Object.assign({}, m, { flip: 0 }); render(); } });
}

function vNew(app) {
  const signed = !!uid();
  const d = S.draft || (S.draft = { opp: null, oppGuest: "", guestOn: false, a: "", b: "", bestOf: 3, serve: 0, keepers: "players" });
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
      S.game = { id: newId(), remote: false, a, b, bestOf: d.bestOf, target: 11, firstServer: d.serve, games: [""], status: "live", startedAt: Date.now(), endedAt: null, version: 0, flip: 0 };
      saveLocalGame(); S.screen = null; render(); return;
    }
    const btn = $("#startBtn"); btn.disabled = true;
    const { data, error } = await sb.from("live_matches").insert({ a_name: a, b_name: b, a_user: uid(), b_user: opp ? opp.id : null, best_of: d.bestOf, target: 11, first_server: d.serve, keepers: d.keepers }).select().single();
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
  const bump = S.bump; S.bump = null;
  const alt = bump ? (bump.n % 2 ? 1 : 2) : 0;
  const name = i => i ? g.b : g.a;
  const card = i => `<button class="pcard p${i} ${srv === i ? "serving" : ""}" data-p="${i}" ${can && !s.over ? "" : "disabled"} aria-label="Point to ${esc(name(i))}, now ${s.cur[i]}">
      ${srv === i ? '<span class="halo"></span>' : ""}<span class="flash ${bump && bump.p === i ? "fl" + alt : ""}"></span>
      <span class="row">${av(name(i), i ? "b sm" : "a sm")}<span style="flex:1;font-size:18px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name(i))}</span>
        <span class="pips" aria-label="${s.gw[i]} games won">${Array.from({ length: s.need }, (_, k) => `<i class="${k < s.gw[i] ? "on" : ""}"></i>`).join("")}</span></span>
      <span class="foot"><span style="display:flex;flex-direction:column;gap:8px;padding-bottom:12px">
        ${srv === i ? `<span class="serve"><span class="ball"></span>${n >= 2 * (g.target - 1) ? "Serving" : "Serve " + ((n % (g.target === 21 ? 5 : 2)) + 1) + " of " + (g.target === 21 ? 5 : 2)}</span>` : ""}
        ${badge(i) ? `<span class="badge">${badge(i)}</span>` : ""}</span>
        <span class="score ${bump && bump.p === i ? "pop" + alt : ""}">${s.cur[i]}</span></span>
    </button>`;
  const h = g.games[s.g] || "";
  let run = 0; const who = h.slice(-1); for (let i = h.length - 1; i >= 0 && h[i] === who; i--) run++;
  const runText = run >= 2 ? `${esc(name(+who))} · ${run} in a row` : h.length ? "Level game" : `First to ${g.target}`;
  const canUndo = can && g.games.join("").length > 0;
  app.innerHTML = `
  <div class="gtop"><button class="icon-btn" id="leaveBtn" aria-label="Leave match">${ICON.back}</button>
    <div class="mid"><b>Game ${s.g + 1}${g.bestOf > 1 ? " · Best of " + g.bestOf : ""}</b><span>${g.remote ? `<span class="live-dot ok-dot"></span>` : ""}${esc(keepersText(g))}${g.remote ? (S.pending ? " · saving" : " · synced") : ""}</span></div>
    <button class="icon-btn" id="optBtn" aria-label="Match options">${ICON.more}</button></div>
  ${card(order[0])}
  <div class="net">${deuce ? `<span class="deuce">Deuce · serve alternates</span>` : `<span>Games ${s.gw[0]}–${s.gw[1]} · <span id="gtimer">${fmtDur((g.endedAt || Date.now()) - g.startedAt)}</span></span>`}</div>
  ${card(order[1])}
  <div class="card wave"><span class="between small"><span class="muted">Momentum this game</span><span style="font-weight:600">${runText}</span></span>${wave(leadSeries([h || ""]).length ? leadSeries([h]) : [], 324, 62, "gwave", "Lead in this game, point by point")}</div>
  <div class="controls"><button class="icon-btn" id="swapBtn" aria-label="Switch ends on screen">${ICON.swap}</button>
    <button class="main" id="undoBtn" aria-label="Undo last point" ${canUndo ? "" : "disabled"}>${ICON.undo}</button>
    <button class="icon-btn" id="optBtn2" aria-label="Match options">${ICON.more}</button></div>
  ${s.over ? `<div class="overlay"><span class="glow big" style="position:absolute"></span><span style="font-size:14px;color:var(--accent-ink);font-weight:600">Match over</span>
    <h2>${esc(name(s.winner))} wins ${Math.max(...s.gw)}–${Math.min(...s.gw)}</h2>
    <button class="btn" id="reportBtn">See the match report</button>
    ${canUndo ? `<button class="btn ghost" id="overUndo">Undo last point</button>` : ""}
    <button class="link" id="homeBtn" style="align-self:center">Back to home</button></div>` : ""}`;
  app.querySelectorAll(".pcard").forEach(b => b.onclick = () => point(+b.dataset.p));
  $("#leaveBtn").onclick = () => { S.game = null; render(); };
  $("#swapBtn").onclick = () => { g.flip = (g.flip || 0) ^ 1; if (!g.remote) saveLocalGame(); render(true); };
  $("#undoBtn").onclick = undoLast;
  $("#optBtn").onclick = $("#optBtn2").onclick = openGameOptions;
  if ($("#reportBtn")) $("#reportBtn").onclick = () => { const rec = finished().find(x => x.id === g.id) || Object.assign(toRecord(g), { local: !g.remote }); S.report = rec; S.screen = "report"; S.game = null; render(); };
  if ($("#overUndo")) $("#overUndo").onclick = undoLast;
  if ($("#homeBtn")) $("#homeBtn").onclick = () => { S.game = null; render(); };
  if (!s.over) timerT = setInterval(() => { const t = $("#gtimer"); if (t && S.game) t.textContent = fmtDur(Date.now() - S.game.startedAt); }, 1000);
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
  if (data.status === "done") await loadLadder();
  render(true);
}

async function undoLast() {
  const g = S.game; if (!g || !canScore(g)) return;
  const before = { games: g.games.slice(), status: g.status, endedAt: g.endedAt };
  g.games = R.undoPoint(g.games); g.status = "live"; g.endedAt = null; buzz(8);
  if (!g.remote) {
    S.local = S.local.filter(x => x.id !== g.id); LS.set("rally.local", S.local); saveLocalGame();
    return render(true);
  }
  S.pending++; render(true);
  const { data, error } = await sb.rpc("undo_point", { p_id: g.id });
  S.pending--;
  if (error || !data) { if (S.game && S.game.id === g.id) Object.assign(S.game, before); toast("Couldn't undo. Check your connection."); return render(true); }
  if (S.game && S.game.id === g.id && S.pending === 0) S.game = Object.assign(fromRow(data), { flip: g.flip });
  if (before.status === "done") await loadLadder();
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
    ${g.remote ? `<div class="card pad" style="display:flex;flex-direction:column;gap:8px;align-items:center"><span class="small muted">Scorekeeper join code</span><span class="code" id="codeTxt">${esc(g.code)}</span><button class="btn small ghost" id="copyCode">Copy code</button><p class="note" style="text-align:center">Anyone signed in to Rally can enter this code on their home screen to keep score with you.</p></div>` : ""}
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
  app.innerHTML = `
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
  <p class="note r-up d4">${rec.local ? "Saved on this phone." : "Saved to the club ladder."}</p>
  <div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:10px">
    <button class="btn" id="rematch">Rematch</button><button class="btn ghost" id="toLadder">Ladder</button></div>
  ${canDel ? `<button class="link" id="delRec" style="align-self:center;color:var(--bad)">Delete this match</button>` : ""}`;
  $("#closeRep").onclick = () => { S.screen = null; S.report = null; render(); };
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
  app.innerHTML = `
  <header class="between r-up"><h1 style="font-size:28px">Ladder</h1><span class="small muted">${fin.length} match${fin.length === 1 ? "" : "es"} · Elo</span></header>
  ${top ? `<button class="card pad r-up d1" data-k="${esc(top.key)}" style="position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;border-color:rgba(255,90,31,.45);text-align:left;width:100%;border-radius:26px">
    <span style="position:absolute;left:-60px;bottom:-120px;width:280px;height:260px;border-radius:50%;background:radial-gradient(closest-side,rgba(255,90,31,.45),rgba(255,90,31,0))"></span>
    <span style="position:relative;display:flex;flex-direction:column;gap:6px;min-width:0"><span class="small" style="color:#ffd2bf">Top of the ladder</span><span style="font-size:26px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(top.name)}</span><span class="num" style="font-size:44px">${top.r}<small> / rating</small></span></span>
    <span style="position:relative">${ring(104, 7, top.w / Math.max(1, top.w + top.l), "#ff5a1f", `<span style="text-align:center;line-height:1.1;position:relative"><b style="display:block;font-size:24px;font-weight:600">${Math.round(top.w / Math.max(1, top.w + top.l) * 100)}%</b><span style="font-size:11px;color:var(--soft)">win rate</span></span>`)}</span>
  </button>` : `<div class="card empty r-up d1"><b>The ladder is empty</b>Finish a match to put the first name on it.</div>`}
  <div class="card pad r-up d2" style="display:flex;flex-direction:column;gap:10px"><span style="font-size:16px;font-weight:600">Club matches this week</span>
    <div class="bars" style="grid-template-columns:repeat(7,minmax(0,1fr));gap:8px">${counts.map((c, i) => barCol(Math.round(c / maxC * 10), 10, "on", .25 + i * .07)).join("")}</div>
    <div class="axis" style="grid-template-columns:repeat(7,minmax(0,1fr));gap:8px">${labels.map(l => `<span>${l}</span>`).join("")}</div></div>
  <div class="r-up d3" style="display:flex;flex-direction:column;gap:8px">${rest.map(p => `<button class="prow" data-k="${esc(p.key)}"><span class="rk">${p.rank}</span>${av(p.name, "sm")}<span style="display:flex;flex-direction:column;gap:4px;min-width:0"><span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span><span class="dots">${p.res.slice(-5).map(r => `<i class="${r ? "w" : "l"}"></i>`).join("")}</span></span><span style="text-align:right;line-height:1.15"><span style="display:block;font-size:20px;font-weight:500">${p.r}</span><span class="small ${p.lastDelta >= 0 ? "up" : "down"}">${sign(p.lastDelta)}</span></span></button>`).join("")}</div>`;
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
  app.innerHTML = `<header class="between r-up"><h1 style="font-size:28px">Score sheets</h1><span class="small muted">Newest first</span></header>
  ${fin.length ? `<div class="r-up d1" style="display:flex;flex-direction:column;gap:10px">${fin.map(m => `<button class="card sheetcard" data-id="${esc(m.id)}"><span class="between small muted"><span>${fmtDate(m.endedAt)}${m.local ? " · this phone" : ""}</span><span>${m.bestOf === 1 ? "1 game" : "Best of " + m.bestOf}</span></span>
    <span class="between"><span style="font-weight:${m.winner === 0 ? 700 : 500};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.a)}</span><span class="num" style="font-size:28px">${m.gw[0]}–${m.gw[1]}</span><span style="font-weight:${m.winner === 1 ? 700 : 500};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right">${esc(m.b)}</span></span>
    <span class="gpills">${(m.g || []).map(s => { const [a, b] = R.gameScore([...s].map(Number)); return `<span>${a}–${b}</span>`; }).join("")}</span></button>`).join("")}</div>`
    : `<div class="card empty r-up d1"><b>No sheets yet</b>Every match you finish gets a score sheet here.</div>`}`;
  app.querySelectorAll("[data-id]").forEach(b => b.onclick = () => { S.report = finished().find(x => x.id === b.dataset.id); S.screen = "report"; render(); });
}
function vYou(app) {
  const me = myName(), key = R.keyOf(me || ""), p = key ? R.computeBoard(finished()).byKey.get(key) : null;
  app.innerHTML = uid() ? `
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
  ${sb ? `<button class="btn r-up d2" id="toSignIn">Sign in or create an account</button>` : ""}`;
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
