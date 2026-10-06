// Journal — deliberately simple: write what is on your mind, or record a
// voice note, and it is saved under the day. Past entries are searchable.
//
//   data.journal[dateStr] = { entries: [{ id, ts, text, audio: {dur, mime}|null }] }
//   kv  journal-audio-<id> = { mime, dataUrl, dur }   (one doc per voice note;
//                                                      Firestore docs cap at 1 MiB)
import { cloudDelete } from "./cloud-store.js";
import { toast, fmtClock, prettyDate } from "./ui.js";

const MAX_AUDIO_DATAURL_CHARS = 950000;
const audioKey = id => 'journal-audio-' + id;

let ctx = null;
let built = false;
let viewDate = null;
let draft = '';
let rec = null;          // live MediaRecorder session
let pending = null;      // finished recording not yet saved: {blob, mime, dur, url}
const audioCache = {};

const esc = s => ctx.escapeHtml(s == null ? '' : String(s));
const data = () => ctx.getData();
const root = () => document.getElementById('tab-journal');
const curDate = () => viewDate || ctx.todayStr();

export function initJournal(c){ ctx = c; }

function shiftDate(days){
  const d = new Date(curDate() + 'T00:00:00');
  d.setDate(d.getDate() + days);
  viewDate = ctx.todayStr(d);
}

function buildDom(){
  if(built) return;
  root().innerHTML = `
    <div class="sec-head">
      <div>
        <h2>Journal</h2>
        <div class="desc">Write it, or just say it — a voice note is saved with the day</div>
      </div>
    </div>
    <div class="jr-daynav">
      <button class="icon-btn" id="jrPrev" aria-label="Previous day">‹</button>
      <h3 id="jrDayLabel" class="serif"></h3>
      <button class="icon-btn" id="jrNext" aria-label="Next day">›</button>
    </div>
    <div class="jr-composer">
      <textarea id="jrText" class="journal-textarea" rows="4" placeholder="What is on your mind today?"></textarea>
      <div id="jrRecStatus" class="jr-rec-status" style="display:none;"></div>
      <div id="jrPending" class="jr-pending" style="display:none;"></div>
      <div class="jr-actions">
        <button class="jr-mic" id="jrMic" type="button" aria-label="Record a voice note">
          <span class="jr-mic-ico">🎙️</span><span id="jrMicLabel">Voice note</span>
        </button>
        <button class="pill" id="jrSave" type="button">Save entry</button>
      </div>
    </div>
    <div id="jrToday"></div>
    <div class="sec-head" style="margin-top:26px;">
      <div><h2 style="font-size:16px;">Past entries</h2></div>
    </div>
    <input class="cal-search" id="jrSearch" placeholder="Search your journal…">
    <div id="jrPast" style="margin-top:12px;"></div>`;

  document.getElementById('jrPrev').addEventListener('click', ()=>{ shiftDate(-1); renderJournalTab(); });
  document.getElementById('jrNext').addEventListener('click', ()=>{ shiftDate(1); renderJournalTab(); });
  document.getElementById('jrText').addEventListener('input', e=>{ draft = e.target.value; });
  document.getElementById('jrSave').addEventListener('click', saveEntry);
  document.getElementById('jrMic').addEventListener('click', ()=>{ rec ? stopRecording() : startRecording(); });
  document.getElementById('jrSearch').addEventListener('input', renderPast);
  built = true;
}

export function renderJournalTab(){
  buildDom();
  const d = curDate();
  document.getElementById('jrDayLabel').textContent = d === ctx.todayStr() ? 'Today' : prettyDate(d);
  document.getElementById('jrNext').disabled = d >= ctx.todayStr();
  const ta = document.getElementById('jrText');
  if(ta.value !== draft) ta.value = draft;
  renderPendingAudio();
  setMicUi(!!rec);
  renderDay();
  renderPast();
}

// Used by the 📝 icons next to japa / practice / books / activities.
export function openJournalNoteFor(taskName){
  viewDate = ctx.todayStr();
  draft = (draft ? draft + '\n' : '') + '📝 ' + taskName + ': ';
  const btn = document.querySelector('.tab-btn[data-tab="journal"]');
  if(btn) btn.click();
  const ta = document.getElementById('jrText');
  if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

/* ---------- entries ---------- */
function entryHtml(en, showDate){
  const time = new Date(en.ts).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  return `<div class="jr-entry" data-id="${esc(en.id)}">
    <div class="jr-entry-head">
      <span>${showDate ? esc(showDate) + ' · ' : ''}${time}</span>
      <button class="edit-icon-btn" data-del="${esc(en.id)}" title="Delete entry" aria-label="Delete entry">🗑</button>
    </div>
    ${en.text ? `<div class="jr-entry-text">${esc(en.text)}</div>` : ''}
    ${en.audio ? `<div class="jr-audio-slot" id="jrAudio-${esc(en.id)}">
      <button class="jr-play" type="button" data-play="${esc(en.id)}">▶ Play voice note · ${fmtClock(en.audio.dur)}</button></div>` : ''}
  </div>`;
}

function wireEntries(container){
  container.querySelectorAll('[data-del]').forEach(b=> b.addEventListener('click', ()=> deleteEntry(b.dataset.del)));
  container.querySelectorAll('[data-play]').forEach(b=> b.addEventListener('click', ()=> playAudio(b.dataset.play)));
}

function renderDay(){
  const el = document.getElementById('jrToday');
  const day = data().journal[curDate()];
  const list = day ? day.entries.slice().reverse() : [];
  el.innerHTML = list.length
    ? list.map(en=>entryHtml(en)).join('')
    : '<div class="empty-note" style="padding:10px 2px;">Nothing written for this day yet.</div>';
  wireEntries(el);
}

function renderPast(){
  const el = document.getElementById('jrPast');
  const q = (document.getElementById('jrSearch').value || '').trim().toLowerCase();
  const dates = Object.keys(data().journal).sort().reverse().filter(d=> d !== curDate());
  const html = dates.map(d=>{
    const ents = data().journal[d].entries.filter(en=> !q || (en.text||'').toLowerCase().includes(q));
    return ents.length ? `<div class="jr-day-group"><div class="jr-day-title">${esc(prettyDate(d))}</div>${ents.slice().reverse().map(en=>entryHtml(en)).join('')}</div>` : '';
  }).join('');
  el.innerHTML = html || `<div class="empty-note">${q ? 'No entries match that search.' : 'Earlier days will appear here.'}</div>`;
  wireEntries(el);
}

/* ---------- saving ---------- */
function blobToDataUrl(blob){
  return new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onload = ()=> resolve(r.result);
    r.onerror = ()=> reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function saveEntry(){
  if(rec) await stopRecording();
  const text = (document.getElementById('jrText').value || '').trim();
  if(!text && !pending) return toast('Write something or record a voice note first.');
  const en = { id: ctx.uid(), ts: Date.now(), text, audio: null };
  if(pending){
    try{
      const dataUrl = await blobToDataUrl(pending.blob);
      if(dataUrl.length > MAX_AUDIO_DATAURL_CHARS) return toast('That recording is too long to store — please record a shorter one.');
      await ctx.cloudSet(audioKey(en.id), JSON.stringify({ mime: pending.mime, dataUrl, dur: pending.dur }));
      en.audio = { mime: pending.mime, dur: pending.dur };
      audioCache[en.id] = dataUrl;
    }catch(e){
      console.error('voice note save failed', e);
      return toast('Could not save the voice note. Check your connection and try again.');
    }
  }
  const d = data(), date = curDate();
  if(!d.journal[date]) d.journal[date] = { entries: [] };
  d.journal[date].entries.push(en);
  discardPending();
  draft = '';
  document.getElementById('jrText').value = '';
  ctx.save();
  toast('Saved 🙏');
  renderJournalTab();
}

async function deleteEntry(id){
  if(!confirm('Delete this journal entry?')) return;
  const d = data();
  for(const date of Object.keys(d.journal)){
    const day = d.journal[date];
    const en = day.entries.find(e=>e.id===id);
    if(!en) continue;
    day.entries = day.entries.filter(e=>e.id!==id);
    if(!day.entries.length) delete d.journal[date];
    if(en.audio){ try{ await cloudDelete(audioKey(id)); }catch(e){ console.error(e); } delete audioCache[id]; }
    break;
  }
  ctx.save();
  renderJournalTab();
}

/* ---------- voice notes ---------- */
async function playAudio(id){
  const slot = document.getElementById('jrAudio-' + id);
  if(!slot) return;
  let url = audioCache[id];
  if(!url){
    slot.innerHTML = '<span class="empty-note">Loading…</span>';
    try{
      const res = await ctx.cloudGet(audioKey(id));
      url = audioCache[id] = JSON.parse(res.value).dataUrl;
    }catch(e){
      slot.innerHTML = '<span class="empty-note">Could not load this voice note.</span>';
      return;
    }
  }
  slot.innerHTML = `<audio controls autoplay src="${url}"></audio>`;
}

function renderPendingAudio(){
  const el = document.getElementById('jrPending');
  if(!pending){ el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  el.innerHTML = `<audio controls src="${pending.url}"></audio>
    <button type="button" class="edit-icon-btn" id="jrDiscard" title="Discard recording" aria-label="Discard recording">🗑</button>`;
  document.getElementById('jrDiscard').addEventListener('click', ()=>{ discardPending(); renderPendingAudio(); setMicUi(!!rec); });
}

function discardPending(){
  if(pending){ URL.revokeObjectURL(pending.url); pending = null; }
}

function setMicUi(recording){
  const mic = document.getElementById('jrMic');
  if(!mic) return;
  mic.classList.toggle('recording', recording);
  document.getElementById('jrMicLabel').textContent = recording ? 'Stop' : (pending ? 'Re-record' : 'Voice note');
  const st = document.getElementById('jrRecStatus');
  st.style.display = recording ? '' : 'none';
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
  renderPendingAudio();
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
    if(built){ renderPendingAudio(); setMicUi(false); }
    if(r.onDone) r.onDone();
  };
  mr.start();
  setMicUi(true);
  const st = document.getElementById('jrRecStatus');
  const tick = ()=>{
    const s = Math.round((Date.now()-r.start)/1000);
    st.innerHTML = `<span class="jr-rec-dot"></span> Recording… ${fmtClock(s)}`;
    // ~24 kbps ≈ 3 KB/s, so the 1 MiB doc limit is reached a little over 4 minutes in.
    if(s >= 240) stopRecording();
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
export function stopJournalRecording(){
  if(rec){ rec.discard = true; try{ rec.mr.stop(); }catch(e){ /* already stopped */ } rec = null; }
  discardPending();
  draft = '';
  viewDate = null;
  built = false;
}
