// Dhyana Insights — a titled voice recording plus notes, kept in the Today tab.
//
//   data.dhyana = [{ id, ts, date, title, notes, audio: {dur, mime, size, cloud}|null }]
//
// The recording itself is always stored on THIS device (IndexedDB, no size
// limit). Short recordings are also synced to Firestore (kv dhyana-audio-<id>,
// Firestore docs cap at 1 MiB) so they appear on other devices; longer ones
// stay device-only. Any recording can also be downloaded as a file.
import { cloudDelete } from "./cloud-store.js";
import { toast, fmtClock, prettyDate } from "./ui.js";

const DB_NAME = 'tapas-turiya-dhyana';
const STORE = 'audio';
const MAX_DATAURL_CHARS = 950000;
const MAX_SECONDS = 30 * 60;
const cloudKey = id => 'dhyana-audio-' + id;

let ctx = null;
let built = false;
let editId = null;
let rec = null;        // live MediaRecorder session
let pending = null;    // finished recording not yet saved: {blob, mime, dur, url}
let draft = { title:'', notes:'' };

const data = () => ctx.getData();
const esc = s => ctx.escapeHtml(s == null ? '' : String(s));
const root = () => document.getElementById('dhyanaRoot');

export function initDhyana(c){ ctx = c; }

/* ---------- local storage (IndexedDB) ---------- */
function openDb(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = ()=> req.result.createObjectStore(STORE);
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}
async function idb(mode, fn){
  const db = await openDb();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = ()=>{ db.close(); resolve(req && req.result); };
    tx.onerror = tx.onabort = ()=>{ db.close(); reject(tx.error); };
  });
}
const localPut = (id, blob) => idb('readwrite', s=> s.put(blob, id));
const localGet = id => idb('readonly', s=> s.get(id));
const localDel = id => idb('readwrite', s=> s.delete(id));

function blobToDataUrl(blob){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = ()=> reject(r.error);
    r.readAsDataURL(blob);
  });
}
async function dataUrlToBlob(url){ return (await fetch(url)).blob(); }

/* ---------- view ---------- */
function buildDom(){
  if(built || !root()) return;
  root().innerHTML = `
    <div class="sec-head">
      <div>
        <h2>Dhyana Insights</h2>
        <div class="desc">Speak your meditation insights, add notes, and give them a title</div>
      </div>
    </div>
    <div class="dh-composer">
      <input type="text" id="dhTitle" placeholder="Title, e.g. Morning dhyana — stillness" maxlength="80">
      <textarea id="dhNotes" class="journal-textarea" rows="3" placeholder="Notes (optional)"></textarea>
      <div id="dhRecStatus" class="jr-rec-status" style="display:none;"></div>
      <div id="dhPending" class="jr-pending" style="display:none;"></div>
      <div class="jr-actions">
        <button class="jr-mic" id="dhMic" type="button" aria-label="Record a voice insight">
          <span class="jr-mic-ico">🎙️</span><span id="dhMicLabel">Record</span>
        </button>
        <div class="nk-btns">
          <button class="pill ghost" id="dhCancel" type="button" style="display:none;">Cancel</button>
          <button class="pill" id="dhSave" type="button">Save insight</button>
        </div>
      </div>
    </div>
    <div id="dhList"></div>`;
  document.getElementById('dhTitle').addEventListener('input', e=>{ draft.title = e.target.value; });
  document.getElementById('dhNotes').addEventListener('input', e=>{ draft.notes = e.target.value; });
  document.getElementById('dhMic').addEventListener('click', ()=>{ rec ? stopRecording() : startRecording(); });
  document.getElementById('dhSave').addEventListener('click', saveInsight);
  document.getElementById('dhCancel').addEventListener('click', ()=>{ resetComposer(); renderDhyana(); });
  built = true;
}

export function renderDhyana(){
  if(!root()) return;
  buildDom();
  document.getElementById('dhTitle').value = draft.title;
  document.getElementById('dhNotes').value = draft.notes;
  document.getElementById('dhSave').textContent = editId ? 'Save changes' : 'Save insight';
  document.getElementById('dhCancel').style.display = editId ? '' : 'none';
  renderPending();
  setMicUi(!!rec);
  renderList();
}

function renderList(){
  const el = document.getElementById('dhList');
  const list = data().dhyana.slice().sort((a,b)=> b.ts - a.ts);
  if(!list.length){
    el.innerHTML = '<div class="ch-empty"><div class="ch-empty-ico">🧘</div>No insights yet.<br>Record one, or write a few notes, after your dhyana.</div>';
    return;
  }
  el.innerHTML = list.map(it=>`
    <div class="dh-item" data-id="${esc(it.id)}">
      <div class="dh-head">
        <div class="dh-title">${esc(it.title || 'Untitled insight')}</div>
        <div class="dh-tools">
          ${it.audio ? `<button class="edit-icon-btn" data-dl="${esc(it.id)}" title="Download recording" aria-label="Download recording">⬇</button>` : ''}
          <button class="edit-icon-btn" data-edit="${esc(it.id)}" title="Edit" aria-label="Edit">✏️</button>
          <button class="edit-icon-btn" data-del="${esc(it.id)}" title="Delete" aria-label="Delete">🗑</button>
        </div>
      </div>
      <div class="dh-meta">${esc(prettyDate(it.date))} · ${new Date(it.ts).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}${it.audio ? ` · 🎙️ ${fmtClock(it.audio.dur)}` : ''}</div>
      ${it.notes ? `<div class="dh-notes">${esc(it.notes)}</div>` : ''}
      ${it.audio ? `<div class="jr-audio-slot" id="dhAudio-${esc(it.id)}"><button class="jr-play" type="button" data-play="${esc(it.id)}">▶ Play recording</button></div>` : ''}
    </div>`).join('');
  el.querySelectorAll('[data-play]').forEach(b=> b.addEventListener('click', ()=> playAudio(b.dataset.play)));
  el.querySelectorAll('[data-dl]').forEach(b=> b.addEventListener('click', ()=> downloadAudio(b.dataset.dl)));
  el.querySelectorAll('[data-del]').forEach(b=> b.addEventListener('click', ()=> deleteInsight(b.dataset.del)));
  el.querySelectorAll('[data-edit]').forEach(b=> b.addEventListener('click', ()=>{
    const it = data().dhyana.find(x=>x.id===b.dataset.edit);
    if(!it) return;
    editId = it.id;
    draft = { title: it.title || '', notes: it.notes || '' };
    discardPending();
    renderDhyana();
    document.getElementById('dhTitle').scrollIntoView({ behavior:'smooth', block:'center' });
    document.getElementById('dhTitle').focus();
  }));
}

/* ---------- save / delete ---------- */
function resetComposer(){
  editId = null;
  draft = { title:'', notes:'' };
  discardPending();
}

async function saveInsight(){
  if(rec) await stopRecording();
  const title = draft.title.trim(), notes = draft.notes.trim();
  const existing = editId ? data().dhyana.find(x=>x.id===editId) : null;
  if(!title && !notes && !pending && !(existing && existing.audio)) return toast('Add a title, notes or a recording first.');
  const item = existing || { id: ctx.uid(), ts: Date.now(), date: ctx.todayStr(), audio: null };
  item.title = title || (pending ? 'Untitled recording' : '');
  item.notes = notes;
  if(pending){
    try{
      await localPut(item.id, pending.blob);
    }catch(e){
      console.error('local save failed', e);
      return toast('Could not save the recording on this device.');
    }
    const audio = { mime: pending.mime, dur: pending.dur, size: pending.blob.size, cloud: false };
    try{
      const dataUrl = await blobToDataUrl(pending.blob);
      if(dataUrl.length <= MAX_DATAURL_CHARS){
        await ctx.cloudSet(cloudKey(item.id), JSON.stringify({ mime: pending.mime, dataUrl, dur: pending.dur }));
        audio.cloud = true;
      }
    }catch(e){ console.error('cloud sync of recording failed', e); }
    item.audio = audio;
  }
  if(!existing) data().dhyana.push(item);
  ctx.save();
  toast(!item.audio || item.audio.cloud ? 'Saved 🙏' : 'Saved on this device 🙏 (too long to sync)');
  resetComposer();
  renderDhyana();
}

async function deleteInsight(id){
  const it = data().dhyana.find(x=>x.id===id);
  if(!it || !confirm(`Delete “${it.title || 'this insight'}”?`)) return;
  data().dhyana = data().dhyana.filter(x=>x.id!==id);
  if(it.audio){
    try{ await localDel(id); }catch(e){ console.error(e); }
    if(it.audio.cloud){ try{ await cloudDelete(cloudKey(id)); }catch(e){ console.error(e); } }
  }
  if(editId === id) resetComposer();
  ctx.save();
  renderDhyana();
}

/* ---------- playback / download ---------- */
// Prefer the on-device copy; fall back to the synced one (other devices).
async function getAudioBlob(it){
  try{ const b = await localGet(it.id); if(b) return b; }catch(e){ console.error(e); }
  if(it.audio.cloud){
    try{
      const res = await ctx.cloudGet(cloudKey(it.id));
      const blob = await dataUrlToBlob(JSON.parse(res.value).dataUrl);
      try{ await localPut(it.id, blob); }catch(e){ /* cache is best-effort */ }
      return blob;
    }catch(e){ console.error(e); }
  }
  return null;
}

async function playAudio(id){
  const it = data().dhyana.find(x=>x.id===id);
  const slot = document.getElementById('dhAudio-' + id);
  if(!it || !slot) return;
  slot.innerHTML = '<span class="empty-note">Loading…</span>';
  const blob = await getAudioBlob(it);
  if(!blob){ slot.innerHTML = '<span class="empty-note">This recording is not available on this device.</span>'; return; }
  slot.innerHTML = `<audio controls autoplay src="${URL.createObjectURL(blob)}"></audio>`;
}

async function downloadAudio(id){
  const it = data().dhyana.find(x=>x.id===id);
  if(!it) return;
  const blob = await getAudioBlob(it);
  if(!blob) return toast('This recording is not available on this device.');
  const ext = /mp4|aac/.test(it.audio.mime) ? 'm4a' : /ogg/.test(it.audio.mime) ? 'ogg' : 'webm';
  const safe = (it.title || 'dhyana-insight').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'dhyana-insight';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safe}-${it.date}.${ext}`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=> URL.revokeObjectURL(a.href), 4000);
}

/* ---------- recording ---------- */
function renderPending(){
  const el = document.getElementById('dhPending');
  if(!pending){ el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = `<audio controls src="${pending.url}"></audio>
    <button type="button" class="edit-icon-btn" id="dhDiscard" title="Discard recording" aria-label="Discard recording">🗑</button>`;
  document.getElementById('dhDiscard').addEventListener('click', ()=>{ discardPending(); renderPending(); setMicUi(!!rec); });
}

function discardPending(){
  if(pending){ URL.revokeObjectURL(pending.url); pending = null; }
}

function setMicUi(recording){
  const mic = document.getElementById('dhMic');
  if(!mic) return;
  mic.classList.toggle('recording', recording);
  document.getElementById('dhMicLabel').textContent = recording ? 'Stop' : (pending ? 'Re-record' : 'Record');
  document.getElementById('dhRecStatus').style.display = recording ? '' : 'none';
}

async function startRecording(){
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined'){
    return toast('Voice recording is not supported in this browser.');
  }
  let stream;
  try{ stream = await navigator.mediaDevices.getUserMedia({ audio:true }); }
  catch(e){ return toast('Microphone access was blocked. Allow it in your browser settings.'); }
  const types = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];
  const mime = types.find(t=> MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  let mr;
  try{ mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 24000 } : { audioBitsPerSecond: 24000 }); }
  catch(e){ stream.getTracks().forEach(t=>t.stop()); return toast('Could not start the recorder.'); }
  discardPending();
  renderPending();
  rec = { mr, stream, chunks: [], start: Date.now(), mime: mime || mr.mimeType || 'audio/webm', tick: null, discard: false };
  const r = rec;
  mr.ondataavailable = e=>{ if(e.data && e.data.size) r.chunks.push(e.data); };
  mr.onstop = ()=>{
    clearInterval(r.tick);
    r.stream.getTracks().forEach(t=>t.stop());
    if(!r.discard && r.chunks.length){
      const blob = new Blob(r.chunks, { type: r.mime });
      pending = { blob, mime: r.mime, dur: Math.max(1, Math.round((Date.now()-r.start)/1000)), url: URL.createObjectURL(blob) };
    }
    if(rec === r) rec = null;
    if(built){ renderPending(); setMicUi(false); }
    if(r.onDone) r.onDone();
  };
  mr.start(1000);
  setMicUi(true);
  const st = document.getElementById('dhRecStatus');
  const tick = ()=>{
    const s = Math.round((Date.now()-r.start)/1000);
    st.innerHTML = `<span class="jr-rec-dot"></span> Recording… ${fmtClock(s)}`;
    if(s >= MAX_SECONDS) stopRecording();
  };
  tick();
  r.tick = setInterval(tick, 500);
}

function stopRecording(){
  return new Promise(resolve=>{
    if(!rec) return resolve();
    rec.onDone = resolve;
    try{ rec.mr.stop(); }catch(e){ resolve(); }
  });
}

// Called on profile switch / sign-out: never keep the mic open.
export function stopDhyana(){
  if(rec){ rec.discard = true; try{ rec.mr.stop(); }catch(e){ /* already stopped */ } rec = null; }
  discardPending();
  editId = null;
  draft = { title:'', notes:'' };
  built = false;
}
