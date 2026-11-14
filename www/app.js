/* Rally app: UI, live scoring, and sync with the shared ladder (Supabase REST). */
(function(){
"use strict";
const R=window.RallyRules;
const {keyOf,gameScore,gameOver,serverAt,summarize,switchCount,stats,fromRecord,computeBoard,streakOf,validRecord}=R;
const $=s=>document.querySelector(s);
const esc=s=>String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const LS={get(k,d){try{const v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}},del(k){try{localStorage.removeItem(k)}catch(e){}}};
const rand=n=>{const a=new Uint8Array(n);(window.crypto||{}).getRandomValues?crypto.getRandomValues(a):a.forEach((_,i)=>a[i]=Math.random()*256|0);return[...a].map(x=>x.toString(16).padStart(2,"0")).join("")};
const newId=()=>"m"+Date.now().toString(36)+rand(4);
const buzz=ms=>{try{navigator.vibrate&&navigator.vibrate(ms)}catch(e){}};
const fmtDate=t=>{try{return new Intl.DateTimeFormat(undefined,{day:"numeric",month:"short",hour:"numeric",minute:"2-digit"}).format(new Date(t))}catch(e){return new Date(t).toLocaleString()}};
const fmtDur=ms=>{const s=Math.max(0,Math.round(ms/1000));const m=Math.floor(s/60);return m>=60?Math.floor(m/60)+"h "+(m%60)+"m":m+":"+String(s%60).padStart(2,"0")};
const sign=d=>(d>=0?"+":"−")+Math.abs(d);
let toastT;
function toast(msg,top){const t=$("#toast");t.hidden=true;void t.offsetWidth;t.textContent=msg;t.classList.toggle("top",!!top);t.hidden=false;clearTimeout(toastT);toastT=setTimeout(()=>t.hidden=true,2800)}

/* ---------- shared ladder (Supabase REST) ---------- */
const CFG=window.RALLY_CONFIG||{};
const REMOTE=!!(CFG.supabaseUrl&&CFG.supabaseAnonKey);
let deviceId=LS.get("rally.device",null);
if(!deviceId){deviceId="d"+rand(12);LS.set("rally.device",deviceId)}
async function api(path,opts){
  opts=opts||{};
  const ctl=typeof AbortController!=="undefined"?new AbortController():null;
  const timer=setTimeout(()=>ctl&&ctl.abort(),12000);
  try{
    const res=await fetch(CFG.supabaseUrl+"/rest/v1/"+path,{method:opts.method||"GET",signal:ctl&&ctl.signal,body:opts.body,
      headers:Object.assign({apikey:CFG.supabaseAnonKey,Authorization:"Bearer "+CFG.supabaseAnonKey,"Content-Type":"application/json","x-device-id":deviceId},opts.headers||{})});
    if(!res.ok){const e=new Error("HTTP "+res.status);e.status=res.status;throw e}
    const txt=await res.text();return txt?JSON.parse(txt):null;
  }finally{clearTimeout(timer)}
}
const Remote={
  async list(){const rows=await api("matches?select=id,data,by&order=ended_at.asc&limit=5000");return(rows||[]).map(r=>Object.assign({},r.data,{id:r.id,by:r.by})).filter(validRecord)},
  async add(id,rec){await api("matches?on_conflict=id",{method:"POST",headers:{Prefer:"resolution=ignore-duplicates,return=minimal"},body:JSON.stringify({id,data:rec,ended_at:rec.endedAt,by:deviceId})})},
  async remove(id){const rows=await api("matches?id=eq."+encodeURIComponent(id),{method:"DELETE",headers:{Prefer:"return=representation"}});if(!rows||!rows.length)throw new Error("not allowed")}
};

/* ---------- state ---------- */
let remote=LS.get("rally.cache",[]);
let pending=LS.get("rally.pending",[]);
let live=LS.get("rally.live",null);
let setup=Object.assign({a:"",b:"",bestOf:3,target:11,first:0},LS.get("rally.setup",{}));
let dbState=REMOTE?"loading":"offline";
let histFilter="";
let summaryOpen=false;
let confirmReplace=false;

function allMatches(){
  const ids=new Set(remote.map(r=>r.id));
  const before=pending.length;
  pending=pending.filter(p=>!ids.has(p.id));
  if(pending.length!==before)LS.set("rally.pending",pending);
  return remote.concat(pending.map(p=>Object.assign({local:true},p))).filter(m=>m&&m.aKey&&m.bKey&&m.g).sort((x,y)=>x.endedAt-y.endedAt);
}

/* ---------- routing ---------- */
const TABS=["play","leaderboard","history"];
function route(){const h=(location.hash||"").slice(1);return TABS.includes(h)?h:"play"}
function render(){
  const r=route();
  TABS.forEach(t=>{$("#v-"+t).hidden=t!==r});
  document.querySelectorAll(".tabs a").forEach(a=>{if(a.dataset.tab===r)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current")});
  renderSync();
  if(r==="play")renderPlay();else if(r==="leaderboard")renderBoard();else renderHistory();
}
function renderSync(){
  const el=$("#sync");let cls="",txt="Connecting";
  if(dbState==="ready"){cls="ok";txt="Live ladder"}
  else if(dbState==="offline"){cls="warn";txt="This phone only"}
  else if(dbState==="slow"){cls="warn";txt="Ladder unreachable"}
  if(pending.length&&dbState==="ready"){cls="warn";txt=pending.length+" not synced"}
  el.className="chip "+cls;el.querySelector("span").textContent=txt;
}

/* ---------- play: the table ---------- */
function renderPlay(){
  const v=$("#v-play"),list=allMatches();
  const known=[...new Map(list.slice().reverse().flatMap(m=>[[m.aKey,m.a],[m.bKey,m.b]])).values()];
  const pairs=[];const seen=new Set();
  for(const m of list.slice().reverse()){const k=[m.aKey,m.bKey].sort().join("|");if(seen.has(k))continue;seen.add(k);pairs.push([m.a,m.b]);if(pairs.length>=4)break}
  let resume="";
  if(live){const s=summarize(live);resume=`<div class="resume"><p><b>${esc(live.a)} v ${esc(live.b)}</b>Game ${s.g+1} at ${s.cur[0]}–${s.cur[1]}, games ${s.gw[0]}–${s.gw[1]}</p><button class="btn small" id="resumeBtn">Resume</button></div>`}
  const segB=[1,3,5,7].map(n=>`<button type="button" data-best="${n}" aria-pressed="${setup.bestOf===n}">${n===1?"1 game":"Best of "+n}</button>`).join("");
  v.innerHTML=`${resume}
  <form id="setupForm" autocomplete="off" class="view">
    <div class="sec-h"><h2>New match</h2><span class="mono muted">Name both ends</span></div>
    <div class="tabletop">
      <div class="end"><label class="mono" for="pa"><span class="rub a"></span>Red end</label><input id="pa" list="known" maxlength="32" placeholder="Player name" value="${esc(setup.a)}"></div>
      <div class="net"><span>VS</span></div>
      <div class="end"><label class="mono" for="pb"><span class="rub b"></span>Black end</label><input id="pb" list="known" maxlength="32" placeholder="Player name" value="${esc(setup.b)}"></div>
    </div>
    <datalist id="known">${known.map(n=>`<option value="${esc(n)}"></option>`).join("")}</datalist>
    <div class="field"><span class="mono muted">Format</span><div class="seg">${segB}</div></div>
    <div class="row2">
      <div class="field"><span class="mono muted">Points per game</span><div class="seg">
        <button type="button" data-t="11" aria-pressed="${setup.target===11}">11</button><button type="button" data-t="21" aria-pressed="${setup.target===21}">21 classic</button></div></div>
      <div class="field"><span class="mono muted">First serve</span><div class="seg">
        <button type="button" data-f="0" aria-pressed="${setup.first===0}">Red</button><button type="button" data-f="1" aria-pressed="${setup.first===1}">Black</button><button type="button" data-f="toss">Toss</button></div></div>
    </div>
    <p class="err" id="setupErr"></p>
    <button class="btn" type="submit"><span class="ballx"></span>Start match</button>
  </form>
  ${pairs.length?`<div class="field"><span class="mono muted">Rematch</span><div class="chips">${pairs.map((p,i)=>`<button class="pill" data-pair="${i}">${esc(p[0])} v ${esc(p[1])}</button>`).join("")}</div></div>`:""}
  <p class="note">Tap a player's half of the screen to give them the point. Rally calls the serve, deuce and change of ends, and every saved match goes onto the club ladder.</p>`;
  const save=()=>{setup.a=$("#pa").value;setup.b=$("#pb").value;LS.set("rally.setup",setup)};
  $("#pa").oninput=save;$("#pb").oninput=save;
  v.querySelectorAll("[data-best]").forEach(b=>b.onclick=()=>{save();setup.bestOf=+b.dataset.best;LS.set("rally.setup",setup);renderPlay()});
  v.querySelectorAll("[data-t]").forEach(b=>b.onclick=()=>{save();setup.target=+b.dataset.t;LS.set("rally.setup",setup);renderPlay()});
  v.querySelectorAll("[data-f]").forEach(b=>b.onclick=()=>{save();
    if(b.dataset.f==="toss"){setup.first=Math.random()<.5?0:1;const n=(setup.first?setup.b:setup.a)||(setup.first?"Black end":"Red end");toast("Coin toss: "+n+" serves first")}
    else setup.first=+b.dataset.f;
    LS.set("rally.setup",setup);renderPlay()});
  v.querySelectorAll("[data-pair]").forEach(b=>b.onclick=()=>{const p=pairs[+b.dataset.pair];setup.a=p[0];setup.b=p[1];LS.set("rally.setup",setup);renderPlay()});
  if($("#resumeBtn"))$("#resumeBtn").onclick=openMatch;
  $("#setupForm").onsubmit=e=>{e.preventDefault();save();
    const a=setup.a.trim(),b=setup.b.trim();
    if(!a||!b){$("#setupErr").textContent="Write a name at both ends of the table.";return}
    if(keyOf(a)===keyOf(b)){$("#setupErr").textContent="The two players need different names.";return}
    if(live&&!confirmReplace){confirmReplace=true;$("#setupErr").textContent="A match is already in progress. Tap Start again to discard it and begin this one.";return}
    confirmReplace=false;
    live={id:newId(),a,b,bestOf:setup.bestOf,target:setup.target,firstServer:setup.first,games:[[]],startedAt:Date.now(),flip:0};
    persistLive();openMatch();
  };
}

/* ---------- live match ---------- */
let tick=null,wake=null;
function persistLive(){live?LS.set("rally.live",live):LS.del("rally.live")}
async function getWake(){try{if(navigator.wakeLock&&document.visibilityState==="visible")wake=await navigator.wakeLock.request("screen")}catch(e){}}
function openMatch(){
  if(!live)return;
  $("#match").hidden=false;document.body.style.overflow="hidden";
  getWake();clearInterval(tick);tick=setInterval(updTimer,1000);
  renderMatch();
  if(summarize(live).over)openSummary();
}
function closeMatch(){$("#match").hidden=true;document.body.style.overflow="";clearInterval(tick);try{wake&&wake.release()}catch(e){}wake=null;render()}
function updTimer(){const t=$("#mtimer");if(t&&live)t.textContent=fmtDur((live.endedAt||Date.now())-live.startedAt)}
const ICON={
  close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  undo:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/></svg>',
  swap:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M3 8l4-4 4 4M17 20V4M13 16l4 4 4-4"/></svg>'
};
function renderMatch(bumped){
  const m=live,s=summarize(m),el=$("#match");
  const order=switchCount(m,s)%2===0?[0,1]:[1,0];
  const n=s.cur[0]+s.cur[1],srv=s.over?-1:serverAt(m,s.g,n);
  const per=m.target===21?5:2,ds=2*(m.target-1);
  const srvNote=n>=ds?"Serve":"Serve "+((n%per)+1)+" of "+per;
  const deuce=!s.over&&s.cur[0]>=m.target-1&&s.cur[1]>=m.target-1&&s.cur[0]===s.cur[1];
  const badge=i=>{
    if(s.over)return s.winner===i?"Winner":"";
    if(deuce)return"Deuce";
    const me=s.cur[i],op=s.cur[1-i];
    if(me>=m.target-1&&me>op)return s.gw[i]===s.need-1?"Match point":"Game point";
    return"";
  };
  const half=i=>`<button class="half p${i}" data-p="${i}" aria-label="Point to ${esc(i?m.b:m.a)}, now ${s.cur[i]}">
      <div class="htop"><span class="pname">${esc(i?m.b:m.a)}</span>${srv===i?`<span class="srv"><span class="ballx"></span>${srvNote}</span>`:""}</div>
      <div class="cardwrap"><div class="card${bumped===i?" flip":""}">${s.cur[i]}</div></div>
      <div class="hbot"><span class="pips" aria-label="${s.gw[i]} games won">${Array.from({length:s.need},(_,k)=>`<i class="${k<s.gw[i]?"on":""}"></i>`).join("")}</span><span class="badge">${badge(i)}</span></div>
    </button>`;
  const nothing=m.games.length===1&&!m.games[0].length;
  el.innerHTML=`<div class="mbar">
      <button class="ib" id="mClose" aria-label="Leave match">${ICON.close}</button>
      <div class="mid"><b>Game ${s.g+1}${m.bestOf>1?" of "+m.bestOf:""}</b><span>Games ${s.gw[0]}–${s.gw[1]} · <span id="mtimer">${fmtDur((m.endedAt||Date.now())-m.startedAt)}</span></span></div>
      <button class="ib" id="mSwap" aria-label="Switch ends on screen">${ICON.swap}</button>
      <button class="ib" id="mUndo" aria-label="Undo last point" ${nothing?"disabled":""}>${ICON.undo}</button>
    </div>
    <div class="halves">${half(order[0])}${half(order[1])}</div>`;
  el.querySelectorAll(".half").forEach(b=>b.onclick=()=>addPoint(+b.dataset.p));
  $("#mUndo").onclick=undo;
  $("#mSwap").onclick=()=>{m.flip=(m.flip||0)^1;persistLive();renderMatch()};
  $("#mClose").onclick=openLeave;
}
function addPoint(i){
  const m=live;let s=summarize(m);if(s.over){openSummary();return}
  const sw0=switchCount(m,s),gBefore=s.g;
  m.games[s.g].push(i);
  const[a,b]=gameScore(m.games[s.g]);
  const s2=summarize(m);
  if(gameOver(a,b,m.target)){
    buzz([30,40,30]);
    if(s2.over){m.endedAt=Date.now();persistLive();renderMatch(i);openSummary();return}
    m.games.push([]);
    toast((i?m.b:m.a)+" takes game "+(gBefore+1)+", "+Math.max(a,b)+"–"+Math.min(a,b)+". Change ends.",true);
  }else{
    buzz(12);
    if(switchCount(m,s2)!==sw0)toast("Deciding game: change ends",true);
  }
  persistLive();renderMatch(i);
}
function undo(){
  const m=live;delete m.endedAt;
  let g=m.games.length-1;
  if(!m.games[g].length&&g>0){m.games.pop();g--}
  if(m.games[g].length)m.games[g].pop();
  buzz(8);persistLive();renderMatch();
}

/* ---------- sheets ---------- */
function openSheet(html,onMount,onClose){
  const root=$("#sheetRoot");
  root.innerHTML=`<div class="backdrop" id="bd"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  const close=()=>{root.innerHTML="";onClose&&onClose()};
  $("#bd").onclick=e=>{if(e.target.id==="bd")close()};
  root.querySelectorAll("[data-close]").forEach(b=>b.onclick=close);
  onMount&&onMount(root,close);
}
const closeBtn='<button class="ib" data-close aria-label="Close">'+ICON.close+'</button>';
function openLeave(){
  openSheet(`<div class="shead"><div><span class="mono">Match in progress</span><h2>Leave the table?</h2></div>${closeBtn}</div>
    <p class="note">The score stays on this phone. Pick it up again from the Play tab.</p>
    <div class="actions"><button class="btn" data-close>Keep playing</button><button class="btn ghost" id="lvPause">Pause and leave</button><button class="btn danger" id="lvDiscard">Discard match</button></div>`,
  (root,close)=>{
    $("#lvPause").onclick=()=>{close();closeMatch()};
    let armed=false;
    $("#lvDiscard").onclick=e=>{if(!armed){armed=true;e.target.textContent="Tap again to discard";return}live=null;persistLive();close();closeMatch();toast("Match discarded")};
  });
}
function momentumSVG(m,st){
  const series=st.series;const N=series.reduce((t,s)=>t+s.length-1,0)||1;
  const M=Math.max(3,...series.flat().map(Math.abs));
  const W=320,H=130,mid=H/2,pad=8,xs=W/N,ys=(mid-pad)/M;
  let x=0;const pts=[],divs=[];
  series.forEach((s,gi)=>{if(gi)divs.push(x);s.forEach((v,k)=>{if(k)x++;pts.push([x*xs,mid-v*ys])})});
  const line=pts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+","+p[1].toFixed(1)).join("");
  const area=line+"L"+(x*xs).toFixed(1)+","+mid+"L0,"+mid+"Z";
  const id="c"+rand(3);
  return `<div class="field"><span class="mono muted">Momentum, point by point</span><svg class="chart" viewBox="0 0 ${W} ${H+18}" role="img" aria-label="Lead within each game, point by point">
    <defs><clipPath id="${id}t"><rect x="0" y="0" width="${W}" height="${mid}"/></clipPath><clipPath id="${id}b"><rect x="0" y="${mid}" width="${W}" height="${mid}"/></clipPath></defs>
    <rect x="0" y="0" width="${W}" height="${H}" rx="4" fill="var(--paper)" stroke="var(--rule)"/>
    <path d="${area}" fill="var(--pa)" opacity=".4" clip-path="url(#${id}t)"/>
    <path d="${area}" fill="var(--pb-mark)" opacity=".3" clip-path="url(#${id}b)"/>
    <line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="var(--rule)" stroke-width="1"/>
    ${divs.map(d=>`<line x1="${(d*xs).toFixed(1)}" x2="${(d*xs).toFixed(1)}" y1="4" y2="${H-4}" stroke="var(--muted)" stroke-dasharray="3 3" stroke-width="1"/>`).join("")}
    <path d="${line}" fill="none" stroke="var(--ink)" stroke-width="1.6" stroke-linejoin="round"/>
    <text x="8" y="17" font-size="11" fill="var(--pa)" font-family="Fragment Mono, monospace">${esc(m.a)} ahead</text>
    <text x="8" y="${H-8}" font-size="11" fill="var(--muted)" font-family="Fragment Mono, monospace">${esc(m.b)} ahead</text>
    ${series.map((s,gi)=>{const start=series.slice(0,gi).reduce((t,q)=>t+q.length-1,0);const len=s.length-1;return `<text x="${((start+len/2)*xs).toFixed(1)}" y="${H+14}" font-size="11" text-anchor="middle" fill="var(--muted)" font-family="Fragment Mono, monospace">G${gi+1}</text>`}).join("")}
  </svg></div>`;
}
function scoreSheet(r){
  const sc=(r.g||[]).map(s=>gameScore([...s].map(Number)));
  const cols=`grid-template-columns:minmax(0,1fr) repeat(${sc.length},2.1em) 2.6em`;
  const row=(i)=>`<span class="nm${r.winner===i?" win":""}"><span class="${i?"dotB":"dotA"}"></span>${esc(i?r.b:r.a)}${r.winner===i?' <span class="ballx" style="width:11px;height:11px" aria-label="winner"></span>':""}</span>${sc.map(g=>`<span class="g ${g[i]>g[1-i]?"w":"lo"}">${g[i]}</span>`).join("")}<span class="tot">${r.gw[i]}</span>`;
  return `<div class="ssheet" style="${cols}"><span class="nm hd">Player</span>${sc.map((_,k)=>`<span class="hd">G${k+1}</span>`).join("")}<span class="hd">Gms</span>${row(0)}${row(1)}</div>`;
}
function matchBody(r,m,st){
  const pct=(w,t)=>t?Math.round(w/t*100)+"%":"–";
  return `${scoreSheet(r)}
    ${momentumSVG(m,st)}
    <div class="stats4">
      <div class="stat"><span>Points won</span><b>${st.pts[0]}–${st.pts[1]}</b></div>
      <div class="stat"><span>Longest run</span><b>${st.run[0]}–${st.run[1]}</b></div>
      <div class="stat"><span>Won on own serve</span><b>${pct(st.srvWon[0],st.srvTot[0])}–${pct(st.srvWon[1],st.srvTot[1])}</b></div>
      <div class="stat"><span>Format</span><b>${r.bestOf===1?"1 game":"Best of "+r.bestOf}</b></div>
    </div>`;
}
function liveRecord(m){
  const s=summarize(m);
  return{a:m.a,b:m.b,aKey:keyOf(m.a),bKey:keyOf(m.b),bestOf:m.bestOf,target:m.target,firstServer:m.firstServer,
    g:m.games.filter(x=>x.length).map(x=>x.join("")),winner:s.winner,gw:s.gw,startedAt:m.startedAt,endedAt:m.endedAt||Date.now()};
}
function openSummary(){
  if(summaryOpen)return;summaryOpen=true;
  const m=live,s=summarize(m),st=stats(m),rec=liveRecord(m),wn=s.winner?m.b:m.a;
  openSheet(`<div class="shead"><div><span class="mono">Match over · ${fmtDur((m.endedAt||Date.now())-m.startedAt)}</span><h2>${esc(wn)} wins ${Math.max(...s.gw)}–${Math.min(...s.gw)}</h2></div></div>
    ${matchBody(rec,m,st)}
    <div class="actions"><button class="btn" id="saveBtn"><span class="ballx"></span>Put it on the ladder</button><button class="btn ghost" id="undoLast">Undo last point</button></div>`,
  (root,close)=>{
    $("#undoLast").onclick=()=>{close();undo()};
    $("#saveBtn").onclick=async e=>{const b=e.currentTarget;b.disabled=true;b.textContent="Saving…";await saveMatch();close()};
  },()=>{summaryOpen=false});
}
async function saveMatch(){
  const m=live,rec=liveRecord(m);
  let ok=false;
  if(REMOTE){try{await Remote.add(m.id,rec);ok=true;remote.push(Object.assign({id:m.id,by:deviceId},rec));LS.set("rally.cache",remote)}catch(e){}}
  if(!ok){pending.push(Object.assign({id:m.id},rec));LS.set("rally.pending",pending)}
  live=null;persistLive();closeMatch();
  location.hash="#leaderboard";render();
  toast(ok?"Saved. The ladder is updated for everyone.":REMOTE?"Saved on this phone. It will sync when the ladder is reachable.":"Saved on this phone.");
  if(ok)refresh();
}
async function syncPending(quiet){
  if(!REMOTE)return toast("This build has no shared ladder set up.");
  let n=0;
  for(const p of pending.slice()){const{id,...rec}=p;try{await Remote.add(id,rec);n++;pending=pending.filter(x=>x.id!==id);remote.push(Object.assign({id,by:deviceId},rec))}catch(e){break}}
  LS.set("rally.pending",pending);LS.set("rally.cache",remote);render();
  if(quiet&&!n)return;
  toast(n?n+" match"+(n>1?"es":"")+" synced":"Couldn't reach the ladder. Try again shortly.");
  if(n)refresh();
}

/* ---------- ladder ---------- */
function renderBoard(){
  const v=$("#v-leaderboard"),list=allMatches(),{players}=computeBoard(list);
  if(!players.length){
    v.innerHTML=`<div class="sec-h"><h2>The ladder</h2><span class="mono muted">Elo · starts at 1000</span></div>
      <div class="empty"><b>${dbState==="loading"?"Reading the ladder":"The ladder is empty"}</b><span>${dbState==="loading"?"Fetching everyone's results.":"Win a match on the Play tab to put the first name on it."}</span></div>`;return;
  }
  const top=players[0],rest=players.slice(1);
  const row=p=>{const st=streakOf(p.res);const form=p.res.slice(-5);
    return `<button class="prow${p.rank<=3?" top":""}" data-k="${esc(p.key)}">
      <span class="rank">${p.rank}</span>
      <span class="pn"><b>${esc(p.name)}</b><span class="form">${form.map(r=>`<i class="${r?"w":"l"}"></i>`).join("")}${st&&st.n>=2?`<span class="streak${st.win?"":" l"}">${st.win?"W":"L"}${st.n}</span>`:""}</span></span>
      <span class="wl">${p.w}–${p.l}<br>${Math.round(p.w/(p.w+p.l)*100)}%</span>
      <span class="rating">${p.r}<small class="delta ${p.lastDelta>=0?"up":"down"}">${sign(p.lastDelta)}</small></span>
    </button>`};
  v.innerHTML=`<div class="sec-h"><h2>The ladder</h2><span class="mono muted">${list.length} match${list.length>1?"es":""} · Elo</span></div>
    <button class="leader" data-k="${esc(top.key)}"><span class="mono">Top of the ladder · ${top.w}–${top.l}</span><b>${esc(top.name)}</b><span class="lr">${top.r}<small>rating</small></span></button>
    ${rest.length?`<div class="ladder">${rest.map(row).join("")}</div>`:""}
    <p class="note">Everyone starts at 1000. Beating a higher-rated player moves you further. Tap a name for head-to-head records.</p>`;
  v.querySelectorAll("[data-k]").forEach(b=>b.onclick=()=>openPlayer(b.dataset.k));
}
function sparkSVG(h){
  const W=320,H=90,min=Math.min(...h)-10,max=Math.max(...h)+10,xs=W/Math.max(1,h.length-1);
  const y=v=>H-6-(v-min)/(max-min)*(H-12);
  const line=h.map((v,i)=>(i?"L":"M")+(i*xs).toFixed(1)+","+y(v).toFixed(1)).join("");
  const last=h[h.length-1];
  return `<div class="field"><span class="mono muted">Rating over time</span><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating over time">
    <rect width="${W}" height="${H}" rx="4" fill="var(--paper)" stroke="var(--rule)"/>
    <line x1="0" x2="${W}" y1="${y(1000).toFixed(1)}" y2="${y(1000).toFixed(1)}" stroke="var(--rule)" stroke-dasharray="3 3"/>
    <path d="${line}L${W},${H}L0,${H}Z" fill="var(--table)" opacity=".14"/>
    <path d="${line}" fill="none" stroke="var(--table-ink)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${((h.length-1)*xs).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4.5" fill="var(--ball)"/>
  </svg></div>`;
}
function openPlayer(k){
  const list=allMatches(),{byKey,deltas}=computeBoard(list),p=byKey.get(k);if(!p)return;
  const st=streakOf(p.res),opp=[...p.opp.values()].sort((a,b)=>(b.w+b.l)-(a.w+a.l));
  const recent=list.filter(m=>m.aKey===k||m.bKey===k).slice(-5).reverse();
  openSheet(`<div class="shead"><div><span class="mono">Rung ${p.rank} · ${p.w+p.l} match${p.w+p.l>1?"es":""}</span><h2>${esc(p.name)}</h2></div>${closeBtn}</div>
    <div class="stats4">
      <div class="stat"><span>Rating</span><b>${p.r}</b></div>
      <div class="stat"><span>Record</span><b>${p.w}–${p.l}</b></div>
      <div class="stat"><span>Streak</span><b>${st?(st.win?"W":"L")+st.n:"–"}</b></div>
      <div class="stat"><span>Peak rating</span><b>${Math.max(...p.hist)}</b></div>
    </div>
    ${p.hist.length>2?sparkSVG(p.hist):""}
    <div class="field"><span class="mono muted">Head to head</span><div class="h2h">${opp.map(o=>`<div><span>v ${esc(o.name)}</span><b>${o.w}–${o.l}</b></div>`).join("")}</div></div>
    <div class="field"><span class="mono muted">Recent matches</span><div class="h2h">${recent.map(m=>{const me=m.aKey===k?0:1,won=m.winner===me,d=(deltas.get(m.id)||[0,0])[me];
      return `<div><span>${won?"Beat":"Lost to"} ${esc(me?m.a:m.b)} ${m.gw[me]}–${m.gw[1-me]}</span><span class="mono delta ${d>=0?"up":"down"}">${sign(d)}</span></div>`}).join("")}</div></div>`);
}

/* ---------- score sheets ---------- */
function renderHistory(){
  const v=$("#v-history"),list=allMatches(),{deltas}=computeBoard(list);
  const f=keyOf(histFilter);
  const shown=list.slice().reverse().filter(m=>!f||m.aKey.includes(f)||m.bKey.includes(f));
  v.innerHTML=`<div class="sec-h"><h2>Score sheets</h2><span class="mono muted">Newest first</span></div>
    <div class="search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="hq" type="search" placeholder="Filter by player" value="${esc(histFilter)}" aria-label="Filter by player"></div>
    ${pending.length&&REMOTE?`<div class="resume"><p><b>${pending.length} only on this phone</b>Not on the shared ladder yet.</p><button class="btn small" id="syncBtn">Sync now</button></div>`:""}
    <div class="mlist">${shown.length?shown.map(m=>{const d=deltas.get(m.id)||[0,0];
      return `<button class="sheetcard" data-id="${esc(m.id)}">
        <span class="stop mono"><span>${fmtDate(m.endedAt)}${m.local&&REMOTE?' · <span class="tag">Not synced</span>':""}</span><span><span class="delta ${d[0]>=0?"up":"down"}">${sign(d[0])}</span> / <span class="delta ${d[1]>=0?"up":"down"}">${sign(d[1])}</span></span></span>
        ${scoreSheet(m)}
      </button>`}).join(""):`<div class="empty"><b>${f?"No sheets for that name":dbState==="loading"?"Fetching sheets":"No sheets yet"}</b><span>${f?"Try part of a first name.":"Every match you save gets a score sheet here."}</span></div>`}</div>`;
  const q=$("#hq");q.oninput=()=>{histFilter=q.value;const pos=q.selectionStart;renderHistory();const n=$("#hq");n.focus();try{n.setSelectionRange(pos,pos)}catch(e){}};
  if($("#syncBtn"))$("#syncBtn").onclick=syncPending;
  v.querySelectorAll("[data-id]").forEach(b=>b.onclick=()=>openDetail(b.dataset.id));
}
function openDetail(id){
  const r=allMatches().find(x=>x.id===id);if(!r)return;
  const m=fromRecord(r),st=stats(m);
  const W=r.winner?r.b:r.a,L=r.winner?r.a:r.b;
  const canDel=r.local||r.by===deviceId;
  openSheet(`<div class="shead"><div><span class="mono">${fmtDate(r.endedAt)} · ${fmtDur(r.endedAt-r.startedAt)}</span><h2>${esc(W)} beat ${esc(L)} ${Math.max(...r.gw)}–${Math.min(...r.gw)}</h2></div>${closeBtn}</div>
    ${matchBody(r,m,st)}
    ${canDel?`<p class="err" id="delErr"></p><button class="btn danger" id="delBtn">Delete match</button>`:`<p class="note">Only the phone that logged this match can delete it.</p>`}`,
  (root,close)=>{
    if(!canDel)return;let armed=false;
    $("#delBtn").onclick=async e=>{
      if(!armed){armed=true;e.currentTarget.textContent=r.local?"Tap again to delete":"Tap again to delete for everyone";return}
      if(r.local){pending=pending.filter(p=>p.id!==id);LS.set("rally.pending",pending);close();render();return toast("Match deleted")}
      try{await Remote.remove(id);remote=remote.filter(x=>x.id!==id);LS.set("rally.cache",remote);close();render();toast("Match deleted")}
      catch(err){$("#delErr").textContent="Couldn't delete this match. Check your connection and try again."}
    };
  });
}

/* ---------- sync loop ---------- */
let busy=false;
async function refresh(){
  if(!REMOTE||busy)return;busy=true;
  try{
    remote=await Remote.list();LS.set("rally.cache",remote);dbState="ready";
    if(pending.length)syncPending(true);
  }catch(e){dbState="slow"}
  finally{busy=false}
  const ae=document.activeElement;
  if(!$("#sheetRoot").innerHTML&&!(ae&&ae.tagName==="INPUT"))render();else renderSync();
}
document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible"){if(!$("#match").hidden)getWake();refresh()}});
setInterval(()=>{if(document.visibilityState==="visible"&&$("#match").hidden)refresh()},20000);

window.addEventListener("hashchange",render);
render();
if(live&&!live.endedAt&&summarize(live).cur.join()!=="0,0")toast("You have a match in progress. Tap Resume on the Play tab.");
refresh();
})();
