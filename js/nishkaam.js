// Nishkaam Karma — selfless actions done, or planned for the future.
//
//   data.nishkaam = [{ id, text, note, date, status:'done'|'planned', createdAt, doneAt }]
import { toast, prettyDate } from "./ui.js";

let ctx = null;
let built = false;
let filter = 'all';
let editId = null;

const data = () => ctx.getData();
const root = () => document.getElementById('tab-nishkaam');
const esc = s => ctx.escapeHtml(s == null ? '' : String(s));

export function initNishkaam(c){ ctx = c; }

function buildDom(){
  if(built) return;
  root().innerHTML = `
    <div class="sec-head">
      <div>
        <h2>Nishkaam Karma</h2>
        <div class="desc">Action without attachment to the fruit — record what you have done, or plan to do</div>
      </div>
    </div>

    <div class="nk-stats" id="nkStats"></div>

    <form class="nk-form" id="nkForm" autocomplete="off">
      <div class="nk-status" role="radiogroup" aria-label="Status">
        <label class="nk-opt"><input type="radio" name="nkStatus" value="done" checked><span>✅ Done</span></label>
        <label class="nk-opt"><input type="radio" name="nkStatus" value="planned"><span>🗓️ Planning to do</span></label>
      </div>
      <input type="text" id="nkText" placeholder="What selfless act? e.g. Fed the street dogs, helped a neighbour…" maxlength="160" required>
      <textarea id="nkNote" class="journal-textarea journal-textarea-sm" placeholder="Notes (optional)" maxlength="500"></textarea>
      <div class="nk-row">
        <div class="field-col">
          <label class="field-label" for="nkDate" id="nkDateLabel">Date</label>
          <input type="date" id="nkDate">
        </div>
        <div class="nk-btns">
          <button class="pill" type="submit" id="nkSave">Add</button>
          <button class="pill ghost" type="button" id="nkCancel" style="display:none;">Cancel</button>
        </div>
      </div>
    </form>

    <div class="cal-tabbar nk-filter" id="nkFilter">
      <button class="cal-tab on" data-f="all">All</button>
      <button class="cal-tab" data-f="done">Done</button>
      <button class="cal-tab" data-f="planned">Planned</button>
    </div>
    <div id="nkList"></div>`;

  const form = document.getElementById('nkForm');
  form.addEventListener('submit', ev=>{ ev.preventDefault(); saveItem(); });
  document.getElementById('nkCancel').addEventListener('click', resetForm);
  form.querySelectorAll('[name=nkStatus]').forEach(r=> r.addEventListener('change', syncDateLabel));
  document.querySelectorAll('#nkFilter .cal-tab').forEach(b=> b.addEventListener('click', ()=>{
    filter = b.dataset.f;
    document.querySelectorAll('#nkFilter .cal-tab').forEach(x=> x.classList.toggle('on', x === b));
    renderList();
  }));
  built = true;
}

function status(){ return document.querySelector('[name=nkStatus]:checked').value; }
function syncDateLabel(){
  document.getElementById('nkDateLabel').textContent = status() === 'done' ? 'Date done' : 'Planned for';
}

function resetForm(){
  editId = null;
  document.getElementById('nkText').value = '';
  document.getElementById('nkNote').value = '';
  document.getElementById('nkDate').value = ctx.todayStr();
  document.querySelector('[name=nkStatus][value=done]').checked = true;
  document.getElementById('nkSave').textContent = 'Add';
  document.getElementById('nkCancel').style.display = 'none';
  syncDateLabel();
}

function saveItem(){
  const text = document.getElementById('nkText').value.trim();
  if(!text) return;
  const note = document.getElementById('nkNote').value.trim();
  const date = document.getElementById('nkDate').value || ctx.todayStr();
  const st = status();
  const list = data().nishkaam;
  if(editId){
    const it = list.find(x=>x.id===editId);
    if(it){
      Object.assign(it, { text, note, date, status: st });
      it.doneAt = st === 'done' ? (it.doneAt || Date.now()) : null;
    }
  }else{
    list.push({ id: ctx.uid(), text, note, date, status: st, createdAt: Date.now(), doneAt: st === 'done' ? Date.now() : null });
  }
  ctx.save();
  toast(editId ? 'Updated' : (st === 'done' ? 'Recorded 🪔' : 'Planned 🗓️'));
  resetForm();
  renderNishkaamTab();
}

export function renderNishkaamTab(){
  buildDom();
  if(!document.getElementById('nkDate').value) resetForm();
  renderStats();
  renderList();
}

function renderStats(){
  const list = data().nishkaam;
  const done = list.filter(x=>x.status==='done').length;
  const month = ctx.todayStr().slice(0,7);
  const thisMonth = list.filter(x=>x.status==='done' && x.date.startsWith(month)).length;
  const planned = list.length - done;
  document.getElementById('nkStats').innerHTML = `
    <div class="nk-stat"><b>${done}</b><span>done</span></div>
    <div class="nk-stat"><b>${thisMonth}</b><span>this month</span></div>
    <div class="nk-stat"><b>${planned}</b><span>planned</span></div>`;
}

function renderList(){
  const el = document.getElementById('nkList');
  const today = ctx.todayStr();
  let list = data().nishkaam.filter(x=> filter === 'all' || x.status === filter);
  // Planned items first (soonest first), then done items (newest first).
  const planned = list.filter(x=>x.status==='planned').sort((a,b)=> a.date.localeCompare(b.date));
  const done = list.filter(x=>x.status==='done').sort((a,b)=> b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  list = planned.concat(done);
  if(!list.length){
    el.innerHTML = `<div class="ch-empty"><div class="ch-empty-ico">🪔</div>${
      filter === 'planned' ? 'Nothing planned yet.' : filter === 'done' ? 'Nothing recorded yet.' : 'No acts recorded yet.<br>Add your first Nishkaam Karma above.'}</div>`;
    return;
  }
  el.innerHTML = list.map(it=>{
    const overdue = it.status === 'planned' && it.date < today;
    return `<div class="nk-item ${it.status}${overdue?' overdue':''}" data-id="${esc(it.id)}">
      <button class="nk-check" type="button" data-toggle="${esc(it.id)}" aria-label="${it.status==='done'?'Mark as planned':'Mark as done'}">${it.status==='done'?'✓':''}</button>
      <div class="nk-body">
        <div class="nk-text">${esc(it.text)}</div>
        ${it.note ? `<div class="nk-note">${esc(it.note)}</div>` : ''}
        <div class="nk-meta">${it.status==='done' ? 'Done' : (overdue ? 'Was planned for' : 'Planned for')} ${esc(prettyDate(it.date))}${it.date===today?' · today':''}</div>
      </div>
      <div class="nk-tools">
        <button class="edit-icon-btn" data-edit="${esc(it.id)}" title="Edit" aria-label="Edit">✏️</button>
        <button class="edit-icon-btn" data-del="${esc(it.id)}" title="Delete" aria-label="Delete">🗑</button>
      </div>
    </div>`;
  }).join('');

  el.querySelectorAll('[data-toggle]').forEach(b=> b.addEventListener('click', ()=>{
    const it = data().nishkaam.find(x=>x.id===b.dataset.toggle);
    if(!it) return;
    if(it.status === 'planned'){ it.status = 'done'; it.doneAt = Date.now(); it.date = today; toast('Marked done 🪔'); }
    else{ it.status = 'planned'; it.doneAt = null; }
    ctx.save();
    renderStats();
    renderList();
  }));
  el.querySelectorAll('[data-edit]').forEach(b=> b.addEventListener('click', ()=>{
    const it = data().nishkaam.find(x=>x.id===b.dataset.edit);
    if(!it) return;
    editId = it.id;
    document.getElementById('nkText').value = it.text;
    document.getElementById('nkNote').value = it.note || '';
    document.getElementById('nkDate').value = it.date;
    document.querySelector(`[name=nkStatus][value=${it.status}]`).checked = true;
    document.getElementById('nkSave').textContent = 'Save';
    document.getElementById('nkCancel').style.display = '';
    syncDateLabel();
    document.getElementById('nkForm').scrollIntoView({ behavior:'smooth', block:'center' });
    document.getElementById('nkText').focus();
  }));
  el.querySelectorAll('[data-del]').forEach(b=> b.addEventListener('click', ()=>{
    if(!confirm('Delete this entry?')) return;
    data().nishkaam = data().nishkaam.filter(x=>x.id!==b.dataset.del);
    ctx.save();
    renderStats();
    renderList();
  }));
}
