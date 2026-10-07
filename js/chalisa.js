// Hanuman Chalisa — add your own audio files and play them on repeat.
//
// Audio files are far larger than a Firestore document (1 MiB) can hold, so
// they are kept on this device in IndexedDB rather than synced. The player
// lives at module level, so playback continues when you switch tabs.
import { toast, fmtClock } from "./ui.js";

const DB_NAME = 'tapas-turiya-chalisa';
const STORE = 'tracks';
// Bundled with the app, so there is always something to play. Not stored in
// IndexedDB and not removable.
const BUILTIN = {
  id: 'builtin-krishna-das',
  name: 'Hanuman Chalisa — Krishna Das',
  sub: 'Kakrighat, India · September 2009',
  url: 'assets/hanuman-chalisa-krishna-das.mp3',
  builtin: true
};
const SPEEDS = [0.75, 1, 1.25, 1.5];
const MODES = [
  { key:'one', label:'Repeat one', ico:'🔂' },
  { key:'all', label:'Repeat all', ico:'🔁' },
  { key:'off', label:'No repeat',  ico:'➡️' }
];

let ctx = null;
let tracks = [];            // [{id, name, size, type, added}] — blobs stay in IndexedDB
let currentId = null;
let mode = 'one';
let speed = 1;              // playback rate, 0.5–2
let plays = 0;              // completed playthroughs this session
let objectUrl = null;
const audio = new Audio();
audio.preload = 'metadata';

const esc = s => ctx.escapeHtml(s == null ? '' : String(s));
const root = () => document.getElementById('tab-chalisa');

export function initChalisa(c){
  ctx = c;
  try{ mode = localStorage.getItem('tt-chalisa-mode') || 'one'; }catch(e){ /* private mode */ }
  if(!MODES.some(m=>m.key===mode)) mode = 'one';
  try{ speed = clampSpeed(parseFloat(localStorage.getItem('tt-chalisa-speed'))); }catch(e){ /* private mode */ }
  audio.preservesPitch = true;     // slowing down / speeding up keeps the voice natural
  audio.addEventListener('loadedmetadata', applySpeed);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('timeupdate', updateProgress);
  audio.addEventListener('loadedmetadata', updateProgress);
  audio.addEventListener('play', refreshPlayState);
  audio.addEventListener('pause', refreshPlayState);
}

/* ---------- IndexedDB ---------- */
function openDb(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ()=> req.result.createObjectStore(STORE, { keyPath:'id' });
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}
async function dbRun(mode_, fn){
  const db = await openDb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE, mode_);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = ()=>{ db.close(); resolve(result && result.result !== undefined ? result.result : undefined); };
    tx.onerror = ()=>{ db.close(); reject(tx.error); };
    tx.onabort = ()=>{ db.close(); reject(tx.error); };
  });
}
const dbAll = ()=> dbRun('readonly', s=> s.getAll());
const dbPut = rec => dbRun('readwrite', s=> s.put(rec));
const dbDel = id => dbRun('readwrite', s=> s.delete(id));
const dbGet = id => dbRun('readonly', s=> s.get(id));

/* ---------- tab ---------- */
let loaded = false;

export async function renderChalisaTab(){
  if(!root().dataset.built){
    root().dataset.built = '1';
    root().innerHTML = `
      <div class="sec-head">
        <div>
          <h2>Hanuman Chalisa</h2>
          <div class="desc">Add your recordings and let them play on repeat</div>
        </div>
      </div>
      <div class="ch-player" id="chPlayer"></div>
      <div class="sec-head" style="margin-top:22px;">
        <div><h2 style="font-size:16px;">Your recordings</h2></div>
        <div>
          <input type="file" id="chFileInput" accept="audio/*,.mp3,.m4a,.wav,.ogg,.aac" multiple style="display:none;">
          <button class="pill" id="chAddBtn" type="button">＋ Add audio files</button>
        </div>
      </div>
      <div id="chList"></div>
      <div class="empty-note" style="margin-top:12px;">Files are stored privately on this device (they are too large to sync). Add them again on any other device you use.</div>`;
    document.getElementById('chAddBtn').addEventListener('click', ()=> document.getElementById('chFileInput').click());
    document.getElementById('chFileInput').addEventListener('change', onFiles);
  }
  if(!loaded){
    try{ tracks = [BUILTIN, ...(await dbAll()).map(({blob, ...meta})=>meta).sort((a,b)=>a.added-b.added)]; loaded = true; }
    catch(e){
      console.error(e); toast('Could not open local storage for audio files.');
      tracks = [BUILTIN]; loaded = true;
    }
  }
  if(!currentId) selectTrack(BUILTIN);     // ready to play, but never auto-plays
  renderList();
  renderPlayer();
}

async function onFiles(ev){
  const files = Array.from(ev.target.files || []);
  ev.target.value = '';
  let added = 0;
  for(const f of files){
    if(!(f.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|aac|flac|opus)$/i.test(f.name))){
      toast(`“${f.name}” is not an audio file.`);
      continue;
    }
    const rec = { id: ctx.uid(), name: f.name.replace(/\.[^.]+$/, ''), size: f.size, type: f.type, added: Date.now() + added, blob: f };
    try{ await dbPut(rec); }
    catch(e){ console.error(e); toast(`Could not store “${f.name}”.`); continue; }
    const { blob, ...meta } = rec;
    tracks.push(meta);
    added++;
  }
  if(added){
    toast(added === 1 ? 'Audio added 🙏' : `${added} audio files added 🙏`);
    renderList();
  }
}

function fmtSize(b){ return b > 1048576 ? (b/1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b/1024)) + ' KB'; }

function renderList(){
  const el = document.getElementById('chList');
  if(!el) return;
  if(!tracks.length){
    el.innerHTML = '';
    return;
  }
  el.innerHTML = tracks.map((t, i)=>`
    <div class="ch-track${t.id===currentId?' playing':''}" data-id="${esc(t.id)}">
      <button class="ch-track-main" type="button" data-play="${esc(t.id)}">
        <span class="ch-track-num">${t.id===currentId && !audio.paused ? '<span class="ch-eq"><i></i><i></i><i></i></span>' : i+1}</span>
        <span class="ch-track-name">${esc(t.name)}<small>${t.builtin ? esc(t.sub) : fmtSize(t.size)}</small></span>
      </button>
      ${t.builtin ? '<span class="ch-builtin" title="Included with the app">Default</span>' : `<button class="edit-icon-btn" type="button" data-del="${esc(t.id)}" title="Remove" aria-label="Remove ${esc(t.name)}">🗑</button>`}
    </div>`).join('');
  el.querySelectorAll('[data-play]').forEach(b=> b.addEventListener('click', ()=>{
    const id = b.dataset.play;
    if(id === currentId) togglePlay(); else playTrack(id, true);
  }));
  el.querySelectorAll('[data-del]').forEach(b=> b.addEventListener('click', ()=> removeTrack(b.dataset.del)));
}

function renderPlayer(){
  const el = document.getElementById('chPlayer');
  if(!el) return;
  const t = tracks.find(x=>x.id===currentId);
  const m = MODES.find(x=>x.key===mode);
  el.innerHTML = `
    <div class="ch-art"><span class="ch-om">ॐ</span></div>
    <div class="ch-now">${t ? esc(t.name) : 'Choose a recording'}</div>
    <div class="ch-plays" id="chPlays">${plays ? `🔁 Played ${plays} time${plays===1?'':'s'} this session` : '&nbsp;'}</div>
    <input type="range" class="ch-seek" id="chSeek" min="0" max="1000" value="0" aria-label="Seek" ${t?'':'disabled'}>
    <div class="ch-times"><span id="chCur">0:00</span><span id="chDur">0:00</span></div>
    <div class="ch-controls">
      <button class="ch-btn" id="chMode" type="button" title="${m.label}" aria-label="${m.label}"><span>${m.ico}</span><small>${m.label}</small></button>
      <button class="ch-btn" id="chPrev" type="button" aria-label="Previous">⏮</button>
      <button class="ch-btn ch-btn-main" id="chPlay" type="button" aria-label="Play or pause" ${tracks.length?'':'disabled'}>▶</button>
      <button class="ch-btn" id="chNext" type="button" aria-label="Next">⏭</button>
      <span class="ch-btn-spacer"></span>
    </div>
    <div class="ch-speed">
      <div class="ch-speed-top"><span>Speed</span><b id="chSpeedVal">${speed.toFixed(2)}×</b></div>
      <input type="range" class="ch-seek" id="chSpeed" min="0.5" max="2" step="0.05" value="${speed}" aria-label="Playback speed">
      <div class="km-chips ch-speed-chips">${SPEEDS.map(v=>`<button type="button" class="km-chip${v===speed?' on':''}" data-speed="${v}">${v}×</button>`).join('')}</div>
    </div>`;
  document.getElementById('chPlay').addEventListener('click', ()=>{
    if(!currentId && tracks.length) playTrack(tracks[0].id, true); else togglePlay();
  });
  document.getElementById('chPrev').addEventListener('click', ()=> step(-1));
  document.getElementById('chNext').addEventListener('click', ()=> step(1));
  document.getElementById('chMode').addEventListener('click', ()=>{
    mode = MODES[(MODES.findIndex(x=>x.key===mode)+1) % MODES.length].key;
    try{ localStorage.setItem('tt-chalisa-mode', mode); }catch(e){ /* private mode */ }
    audio.loop = mode === 'one';
    renderPlayer();
  });
  const speedEl = document.getElementById('chSpeed');
  speedEl.addEventListener('input', ()=> setSpeed(parseFloat(speedEl.value)));
  document.querySelectorAll('#chPlayer [data-speed]').forEach(b=> b.addEventListener('click', ()=> setSpeed(parseFloat(b.dataset.speed))));
  const seek = document.getElementById('chSeek');
  seek.addEventListener('input', ()=>{ if(audio.duration) audio.currentTime = audio.duration * seek.value / 1000; });
  setSpeed(speed);
  updateProgress();
  refreshPlayState();
}

function updateProgress(){
  const seek = document.getElementById('chSeek');
  if(!seek) return;
  const dur = isFinite(audio.duration) ? audio.duration : 0;
  if(document.activeElement !== seek) seek.value = dur ? Math.round(audio.currentTime / dur * 1000) : 0;
  seek.style.setProperty('--p', (seek.value/10) + '%');
  document.getElementById('chCur').textContent = fmtClock(audio.currentTime);
  document.getElementById('chDur').textContent = fmtClock(dur);
}

function refreshPlayState(){
  const b = document.getElementById('chPlay');
  if(b) b.textContent = audio.paused ? '▶' : '⏸';
  const art = document.querySelector('.ch-art');
  if(art) art.classList.toggle('spinning', !audio.paused);
  renderList();
}

/* ---------- speed ---------- */
function clampSpeed(v){ return isFinite(v) ? Math.min(2, Math.max(0.5, Math.round(v*20)/20)) : 1; }
function applySpeed(){
  audio.defaultPlaybackRate = speed;   // survives a change of source
  audio.playbackRate = speed;
}
function setSpeed(v){
  speed = clampSpeed(v);
  try{ localStorage.setItem('tt-chalisa-speed', String(speed)); }catch(e){ /* private mode */ }
  applySpeed();
  const val = document.getElementById('chSpeedVal'); if(val) val.textContent = speed.toFixed(2) + '×';
  const sl = document.getElementById('chSpeed'); if(sl){ sl.value = speed; sl.style.setProperty('--p', ((speed-0.5)/1.5*100) + '%'); }
  document.querySelectorAll('#chPlayer [data-speed]').forEach(b=> b.classList.toggle('on', parseFloat(b.dataset.speed) === speed));
}

/* ---------- playback ---------- */
// Point the player at the bundled track without starting it.
function selectTrack(t){
  currentId = t.id;
  audio.src = t.url;
  audio.loop = mode === 'one';
  applySpeed();
  setMediaSession(t.name);
}

async function playTrack(id, autoplay){
  if(id === BUILTIN.id){
    if(objectUrl){ URL.revokeObjectURL(objectUrl); objectUrl = null; }
    selectTrack(BUILTIN);
  }else{
    let rec;
    try{ rec = await dbGet(id); }catch(e){ console.error(e); }
    if(!rec){ toast('That file could not be found.'); return; }
    if(objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(rec.blob);
    currentId = id;
    audio.src = objectUrl;
    audio.loop = mode === 'one';
    applySpeed();
    setMediaSession(rec.name);
  }
  renderPlayer();
  renderList();
  if(autoplay){
    try{ await audio.play(); }catch(e){ console.error(e); toast('Tap play to start.'); }
  }
}

function togglePlay(){
  if(!audio.src) return;
  if(audio.paused) audio.play().catch(()=>{}); else audio.pause();
}

function step(dir){
  if(!tracks.length) return;
  const i = tracks.findIndex(t=>t.id===currentId);
  const next = tracks[(i + dir + tracks.length) % tracks.length];
  playTrack(next.id, true);
}

function onEnded(){
  // Only reached when audio.loop is off (modes "all" and "off").
  plays++;
  if(mode === 'off'){ renderPlayer(); return; }
  if(tracks.length > 1) step(1);
  else { audio.currentTime = 0; audio.play().catch(()=>{}); renderPlayer(); }
}

// 'one' mode loops natively (gapless); count loops via the seek wrapping back.
let lastT = 0;
audio.addEventListener('timeupdate', ()=>{
  if(audio.loop && audio.currentTime + 0.5 < lastT){
    plays++;
    const el = document.getElementById('chPlays');
    if(el) el.textContent = `🔁 Played ${plays} time${plays===1?'':'s'} this session`;
  }
  lastT = audio.currentTime;
});

function setMediaSession(title){
  if(!('mediaSession' in navigator)) return;
  try{
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist:'Hanuman Chalisa', album:'Tapas Turiya' });
    navigator.mediaSession.setActionHandler('play', ()=> audio.play());
    navigator.mediaSession.setActionHandler('pause', ()=> audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', ()=> step(-1));
    navigator.mediaSession.setActionHandler('nexttrack', ()=> step(1));
  }catch(e){ /* unsupported */ }
}

async function removeTrack(id){
  const t = tracks.find(x=>x.id===id);
  if(!t || t.builtin || !confirm(`Remove “${t.name}” from this device?`)) return;
  if(id === currentId){
    audio.pause(); audio.removeAttribute('src'); audio.load();
    if(objectUrl){ URL.revokeObjectURL(objectUrl); objectUrl = null; }
    currentId = null;
  }
  try{ await dbDel(id); }catch(e){ console.error(e); }
  tracks = tracks.filter(x=>x.id!==id);
  renderList();
  renderPlayer();
}

// Called on profile switch / sign-out.
export function stopChalisa(){
  audio.pause();
  audio.currentTime = 0;
  plays = 0;
}
