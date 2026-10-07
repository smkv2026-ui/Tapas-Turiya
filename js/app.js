import {
  cloudGet, cloudSet, subscribeKey,
  globalGet, globalSet, subscribeGlobalKey,
  adminListAllUsers, adminGetWorkspaceKv
} from "./cloud-store.js";
import { auth } from "./firebase-init.js";
import { initJournal, renderJournalTab, openJournalNoteFor, stopJournalRecording } from "./journal.js";
import { initDhyana, renderDhyana, stopDhyana } from "./dhyana.js";
import { initChalisa, renderChalisaTab, stopChalisa } from "./chalisa.js";
import { initKumbhak, renderKumbhakTab, resetKumbhak } from "./kumbhak.js";
import { initNishkaam, renderNishkaamTab } from "./nishkaam.js";

  const SANDHYAS = ['morning','afternoon','evening'];
  const SANDHYA_LABEL = { morning:'Morning sandhyā', afternoon:'Afternoon sandhyā', evening:'Evening sandhyā', any:'Daily (no sandhyā)' };
  const USERS_KEY = 'sadhana-users';
  function userStorageKey(id){ return 'sadhana-data-'+id; }

  function defaultData(){
    return {
      settings:{ theme:'light' },
      japa:[], practice:[], books:[], learning:[], logs:{},
      // Routine Scheduler: a single reusable activity model. A "flexible"
      // (unscheduled-for-today) activity is just one whose
      // schedule.startTime is null — there is no separate data source.
      activities:[],
      templates:[],
      activeTemplateId:null,
      // Optional display-time overrides for the four mandatory practices,
      // used only to position/drag them on the Routine timeline; the
      // practices themselves and their real timers/logs are untouched.
      mandatorySchedule:{ japa:{}, practice:{}, reading:{}, learning:{} },
      // Journal: { [dateStr]: { entries:[{id, ts, text, audio:{dur}|null}] } }
      // (js/journal.js). Voice notes themselves live in their own kv keys.
      journal:{},
      // Nishkaam Karma: [{id, text, date, status:'done'|'planned', note}] (js/nishkaam.js)
      nishkaam:[],
      // Kumbhak Pranayama sessions: [{id, date, ts, unit, rounds, seconds}] (js/kumbhak.js)
      kumbhak:[],
      // Dhyana Insights: [{id, ts, date, title, notes, audio}] (js/dhyana.js)
      dhyana:[],
      kumbhakUnit:5
    };
  }
  // Back-fills fields added after a profile's data was first created, so
  // profiles saved before the Routine Scheduler existed still work.
  function normalizeData(d){
    if(!d || typeof d !== 'object') return defaultData();
    if(!d.settings) d.settings = { theme:'light' };
    if(!Array.isArray(d.japa)) d.japa = [];
    if(!Array.isArray(d.practice)) d.practice = [];
    if(!Array.isArray(d.books)) d.books = [];
    if(!Array.isArray(d.learning)) d.learning = [];
    if(!d.logs || typeof d.logs !== 'object') d.logs = {};
    if(!Array.isArray(d.activities)) d.activities = [];
    if(!Array.isArray(d.templates)) d.templates = [];
    if(d.activeTemplateId === undefined) d.activeTemplateId = null;
    if(!d.mandatorySchedule || typeof d.mandatorySchedule !== 'object'){
      d.mandatorySchedule = { japa:{}, practice:{}, reading:{}, learning:{} };
    }
    ['japa','practice','reading','learning'].forEach(k=>{
      if(!d.mandatorySchedule[k] || typeof d.mandatorySchedule[k] !== 'object') d.mandatorySchedule[k] = {};
    });
    if(!d.journal || typeof d.journal !== 'object') d.journal = {};
    if(!Array.isArray(d.nishkaam)) d.nishkaam = [];
    if(!Array.isArray(d.kumbhak)) d.kumbhak = [];
    if(!Array.isArray(d.dhyana)) d.dhyana = [];
    if(!d.kumbhakUnit) d.kumbhakUnit = 5;
    return d;
  }
  let data = defaultData();
  let users = [];
  let currentUser = null;

  function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,8); }
  function todayStr(d){ d = d||new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function fmtTime(sec){ sec = Math.floor(sec); const m=Math.floor(sec/60), s=sec%60; return m+':'+String(s).padStart(2,'0'); }
  function fmtShort(sec){
    sec = Math.round(sec);
    const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
    if(h>0) return h+'h'+String(m).padStart(2,'0')+'m';
    if(m>0) return m+'m';
    return sec+'s';
  }

  function ensureDay(dateStr){
    if(!data.logs[dateStr]) data.logs[dateStr] = { japa:{}, practice:{}, reading:{}, activities:{} };
    if(!data.logs[dateStr].activities) data.logs[dateStr].activities = {};
    return data.logs[dateStr];
  }
  function ensureActivityEntry(dateStr, activityId){
    const day = ensureDay(dateStr);
    if(!day.activities[activityId]){
      day.activities[activityId] = { status:'pending', seconds:0, log:[], startedAt:null, completedAt:null };
    }
    return day.activities[activityId];
  }
  function ensureJapaEntry(dateStr, counterId, sandhya){
    const day = ensureDay(dateStr);
    if(!day.japa[counterId]) day.japa[counterId] = {};
    if(!day.japa[counterId][sandhya]) day.japa[counterId][sandhya] = {count:0, seconds:0};
    return day.japa[counterId][sandhya];
  }
  function ensurePracticeEntry(dateStr, practiceId, sandhya){
    const day = ensureDay(dateStr);
    if(!day.practice[practiceId]) day.practice[practiceId] = {};
    if(!day.practice[practiceId][sandhya]) day.practice[practiceId][sandhya] = {seconds:0, log:[]};
    if(!day.practice[practiceId][sandhya].log) day.practice[practiceId][sandhya].log = [];
    return day.practice[practiceId][sandhya];
  }

  let saveTimer = null;
  function save(){
    if(!currentUser) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async ()=>{
      try{
        await cloudSet(userStorageKey(currentUser.id), JSON.stringify(data));
        rebuildReminderSchedule();
      }
      catch(e){ console.error('save failed', e); }
    }, 250);
  }

  /* ---------- Users ---------- */
  async function saveUsersNow(list){
    try{ await cloudSet(USERS_KEY, JSON.stringify(list)); }
    catch(e){ console.error('save users failed', e); }
  }
  async function loadUsers(){
    try{
      const res = await cloudGet(USERS_KEY);
      if(res && res.value){
        const arr = JSON.parse(res.value);
        if(Array.isArray(arr) && arr.length) return arr;
      }
    }catch(e){ /* none yet */ }
    // A brand-new shared space starts with no profiles — the "Add user"
    // card is how the first household member creates one.
    return [];
  }

  /* ---------- Guru's Teachings (shared across all users) ---------- */
  const GURUS_KEY = 'sadhana-gurus';
  let gurus = [];              // [{id, name, image, teachings:[{id,text,date}]}]
  let activeGuruId = null;     // currently selected sub-tab
  let gurusQuery = '';

  async function loadGurus(){
    try{
      const res = await globalGet(GURUS_KEY);
      if(res && res.value){
        const arr = JSON.parse(res.value);
        if(Array.isArray(arr)) return arr;
      }
    }catch(e){ /* none yet */ }
    return [];
  }
  async function saveGurus(){
    try{ await globalSet(GURUS_KEY, JSON.stringify(gurus)); }
    catch(e){
      console.error('save gurus failed', e);
      // Surfaced (not just logged) because a silent failure here looks
      // identical to "it saved but didn't sync" — the most likely cause is
      // firestore.rules not yet deployed with the globalKv collection rule
      // this feature needs (see CLAUDE.md "Guru's Teachings is global").
      alert('Could not save this to Guru\'s Teachings: '+e.message+'\n\nIf this keeps happening, the app\'s Firestore security rules may need to be redeployed.');
    }
  }
  function findOrCreateGuru(name){
    const key = name.trim().toLowerCase();
    let g = gurus.find(g=>g.name.trim().toLowerCase()===key);
    if(!g){ g = {id:uid(), name:name.trim(), image:null, teachings:[]}; gurus.push(g); }
    return g;
  }

  function renderGuruTabbar(){
    const bar = document.getElementById('guruTabbar');
    if(gurus.length===0){ bar.innerHTML = '<span class="empty-note">No gurus added yet — add a teaching below to begin.</span>'; return; }
    if(!activeGuruId || !gurus.find(g=>g.id===activeGuruId)) activeGuruId = gurus[0].id;
    bar.innerHTML = gurus.map(g=>`<button class="guru-tab ${g.id===activeGuruId?'active':''}" data-guru="${g.id}">${escapeHtml(g.name)}</button>`).join('');
    bar.querySelectorAll('.guru-tab').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        activeGuruId = btn.dataset.guru;
        renderGuruTabbar();
        renderGuruTeachingsList();
      });
    });
  }

  function renderGuruTeachingsList(){
    const el = document.getElementById('guruTeachingsList');
    const guru = gurus.find(g=>g.id===activeGuruId);
    if(!guru){ el.innerHTML = ''; return; }
    const q = gurusQuery.trim().toLowerCase();
    const items = guru.teachings.filter(t=>!q || t.text.toLowerCase().includes(q));
    if(items.length===0){
      el.innerHTML = '<div class="empty-note">'+(q ? 'No teachings match that search.' : 'No teachings from '+escapeHtml(guru.name)+' yet.')+'</div>';
      return;
    }
    const photoHtml = guru.image
      ? `<img class="quote-photo" src="${guru.image}" alt="${escapeHtml(guru.name)}">`
      : `<span class="quote-photo placeholder">${escapeHtml((guru.name||'?').trim().charAt(0).toUpperCase()||'?')}</span>`;
    el.innerHTML = items.map(t=>`
      <div class="quote-entry">
        ${photoHtml}
        <div class="quote-body">
          <div class="qtext">${escapeHtml(t.text)}</div>
          <div class="qmeta">— ${escapeHtml(guru.name)}${t.date ? ' · '+t.date : ''}</div>
        </div>
      </div>`).join('');
  }

  function renderGurusTab(){
    renderGuruTabbar();
    renderGuruTeachingsList();
  }

  document.getElementById('gurusSearch').addEventListener('input', (e)=>{
    gurusQuery = e.target.value;
    renderGuruTeachingsList();
  });

  document.getElementById('guruAddSave').addEventListener('click', async ()=>{
    const name = document.getElementById('guruNameInput').value.trim();
    const text = document.getElementById('guruTeachingInput').value.trim();
    if(!name || !text) return;
    const guru = findOrCreateGuru(name);
    guru.teachings.push({id:uid(), text, date:todayStr()});
    activeGuruId = guru.id;
    document.getElementById('guruTeachingInput').value = '';
    await saveGurus();
    renderGurusTab();
  });

  document.getElementById('guruImageBtn').addEventListener('click', ()=>{
    const name = document.getElementById('guruNameInput').value.trim() || (gurus.find(g=>g.id===activeGuruId)||{}).name;
    if(!name){ alert("Type the Guru's name first (or select a sub-tab)."); return; }
    document.getElementById('guruImageInput').dataset.forName = name;
    document.getElementById('guruImageInput').click();
  });
  document.getElementById('guruImageInput').addEventListener('change', async (ev)=>{
    const file = ev.target.files[0];
    const forName = ev.target.dataset.forName;
    ev.target.value = '';
    if(!file || !forName) return;
    try{
      const dataUrl = await resizeImageFile(file, 1600, 0.82);
      const guru = findOrCreateGuru(forName);
      guru.image = dataUrl;
      activeGuruId = guru.id;
      await saveGurus();
      renderGurusTab();
    }catch(e){ console.error('guru image attach failed', e); }
  });

  function splitCsvRow(line){
    // Splits a CSV line into fields, respecting double-quoted fields that may contain commas.
    const fields = [];
    let cur = '', inQuotes = false;
    for(let i=0;i<line.length;i++){
      const ch = line[i];
      if(inQuotes){
        if(ch === '"'){
          if(line[i+1] === '"'){ cur += '"'; i++; }
          else inQuotes = false;
        } else cur += ch;
      } else {
        if(ch === '"') inQuotes = true;
        else if(ch === ','){ fields.push(cur); cur = ''; }
        else cur += ch;
      }
    }
    fields.push(cur);
    return fields.map(f=>f.trim());
  }
  function parseGuruCsv(text){
    const lines = text.split(/\r?\n/).filter(l=>l.trim().length>0);
    if(lines.length===0) return [];
    let start = 0;
    if(/guru/i.test(lines[0]) && /teach/i.test(lines[0])) start = 1; // skip header row
    const rows = [];
    for(let i=start;i<lines.length;i++){
      const fields = splitCsvRow(lines[i]);
      const name = (fields[0]||'').trim();
      const teaching = fields.slice(1).join(',').trim();
      if(name && teaching) rows.push({name, teaching});
    }
    return rows;
  }

  document.getElementById('gurusTemplateBtn').addEventListener('click', ()=>{
    const csv = "Guru's Name,Teaching\nSri Guru Ji,\"Example teaching text goes here.\"\n";
    const blob = new Blob([csv], {type:'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'gurus-teachings-template.csv';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });
  document.getElementById('gurusCsvBtn').addEventListener('click', ()=>{
    document.getElementById('gurusCsvInput').click();
  });
  document.getElementById('gurusCsvInput').addEventListener('change', async (ev)=>{
    const file = ev.target.files[0];
    ev.target.value = '';
    if(!file) return;
    try{
      const text = await file.text();
      const rows = parseGuruCsv(text);
      if(rows.length===0){ alert("No rows found — make sure the file has Guru's Name, Teaching columns."); return; }
      rows.forEach(r=>{
        const guru = findOrCreateGuru(r.name);
        guru.teachings.push({id:uid(), text:r.teaching, date:todayStr()});
        activeGuruId = guru.id;
      });
      await saveGurus();
      renderGurusTab();
    }catch(e){ console.error('csv upload failed', e); alert('Could not read that file.'); }
  });

  /* ---------- Daily random teaching on the user-select screen ---------- */
  function dailySeed(str){
    let h = 0;
    for(let i=0;i<str.length;i++){ h = (h*31 + str.charCodeAt(i)) >>> 0; }
    return h;
  }
  function renderDailyQuote(){
    const flat = [];
    gurus.forEach(g=>{ g.teachings.forEach(t=> flat.push({guru:g, teaching:t})); });
    const card = document.getElementById('dailyQuoteCard');
    if(flat.length===0){ card.style.display='none'; return; }
    const idx = dailySeed(todayStr()) % flat.length;
    const pick = flat[idx];
    card.style.display = 'flex';
    document.getElementById('dailyQuoteText').textContent = pick.teaching.text;
    document.getElementById('dailyQuoteAttrib').textContent = '— ' + pick.guru.name;
    const photo = document.getElementById('dailyQuotePhoto');
    if(pick.guru.image){
      photo.src = pick.guru.image;
      photo.alt = pick.guru.name;
      photo.style.display = '';
    } else {
      photo.style.display = 'none';
    }
  }

  function renderUserGrid(){
    const grid = document.getElementById('userGrid');
    grid.innerHTML = users.map(u=>`
      <button class="user-card" data-user="${u.id}">
        <span class="user-avatar">${escapeHtml((u.name||'?').trim().charAt(0).toUpperCase()||'?')}</span>
        <span class="user-name">${escapeHtml(u.name)}</span>
      </button>
    `).join('') + `
      <button class="user-card add-user-card" id="addUserCard">
        <span class="user-avatar add">+</span>
        <span class="user-name">Add user</span>
      </button>
    `;
    grid.querySelectorAll('.user-card[data-user]').forEach(btn=>{
      btn.addEventListener('click', ()=> selectUser(btn.dataset.user));
    });
    document.getElementById('addUserCard').addEventListener('click', ()=>{
      document.getElementById('addUserForm').classList.add('open');
      document.getElementById('newUserName').focus();
    });
  }

  document.getElementById('addUserSave').addEventListener('click', async ()=>{
    const name = document.getElementById('newUserName').value.trim();
    if(!name) return;
    const newUser = {id:uid(), name};
    users.push(newUser);
    await saveUsersNow(users);
    document.getElementById('newUserName').value='';
    document.getElementById('addUserForm').classList.remove('open');
    renderUserGrid();
    selectUser(newUser.id);
  });
  document.getElementById('addUserCancel').addEventListener('click', ()=>{
    document.getElementById('addUserForm').classList.remove('open');
    document.getElementById('newUserName').value='';
  });

  function finalizeAllRunning(){
    Object.keys(runningTimers).forEach(key=>{
      if(key.startsWith('activity|')){
        completeActivityTimer(key.slice('activity|'.length));
        return;
      }
      const idx = key.indexOf('|');
      stopPractice(key.slice(0,idx), key.slice(idx+1));
    });
    if(fsState) closeJapaFullscreen();
  }

  async function selectUser(id){
    const user = users.find(u=>u.id===id);
    if(!user) return;
    currentUser = user;
    data = defaultData();
    try{
      const res = await cloudGet(userStorageKey(id));
      if(res && res.value) data = normalizeData(JSON.parse(res.value));
    }catch(e){ /* first time for this user */ }
    applyTheme();
    document.getElementById('userSelectScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = '';
    document.getElementById('addActivityFab').style.display = '';
    document.getElementById('userSubtitle').textContent = 'daily practice tracker · '+user.name;
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelector('.tab-btn[data-tab="today"]').classList.add('active');
    document.querySelectorAll('#appScreen > [id^="tab-"]').forEach(el=>{ el.style.display = el.id === 'tab-today' ? '' : 'none'; });
    selectedDate = null;
    renderAll();
    rebuildReminderSchedule();
  }

  document.getElementById('switchUserBtn').addEventListener('click', ()=>{
    finalizeAllRunning();
    clearAllReminderTimers();
    stopJournalRecording();
    stopDhyana();
    stopChalisa();
    resetKumbhak();
    document.getElementById('appScreen').style.display='none';
    document.getElementById('addActivityFab').style.display='none';
    document.getElementById('userSelectScreen').style.display='';
    renderUserGrid();
  });

  let unsubUsers = null, unsubGurus = null;

  async function initApp(){
    users = await loadUsers();
    renderUserGrid();
    gurus = await loadGurus();
    renderDailyQuote();

    // Live cross-device sync: if another signed-in device on this shared
    // space adds/renames a profile, or adds a Guru's teaching, reflect it
    // here without needing a manual refresh.
    if(unsubUsers) unsubUsers();
    unsubUsers = subscribeKey(USERS_KEY, raw=>{
      if(!raw) return;
      try{
        const arr = JSON.parse(raw);
        if(Array.isArray(arr)){
          users = arr;
          if(document.getElementById('userSelectScreen').style.display !== 'none') renderUserGrid();
        }
      }catch(e){ /* ignore malformed remote value */ }
    });
    if(unsubGurus) unsubGurus();
    unsubGurus = subscribeGlobalKey(GURUS_KEY, raw=>{
      try{
        const arr = raw ? JSON.parse(raw) : [];
        if(Array.isArray(arr)){
          gurus = arr;
          if(document.getElementById('tab-gurus').style.display !== 'none') renderGurusTab();
        }
      }catch(e){ /* ignore malformed remote value */ }
    });
  }

  function resetAppState(){
    if(unsubUsers){ unsubUsers(); unsubUsers = null; }
    if(unsubGurus){ unsubGurus(); unsubGurus = null; }
    finalizeAllRunning();
    clearAllReminderTimers();
    stopJournalRecording();
    stopDhyana();
    stopChalisa();
    resetKumbhak();
    users = [];
    gurus = [];
    currentUser = null;
    data = defaultData();
  }

  document.addEventListener('sadhana-auth-ready', ()=>{ initApp(); });
  document.addEventListener('sadhana-workspace-changed', ()=>{
    document.getElementById('appScreen').style.display = 'none';
    document.getElementById('addActivityFab').style.display = 'none';
    document.getElementById('userSelectScreen').style.display = '';
    resetAppState();
    initApp();
  });
  document.addEventListener('sadhana-before-signout', resetAppState);
  document.addEventListener('sadhana-signed-out', ()=>{
    document.getElementById('addActivityFab').style.display = 'none';
    document.getElementById('userGrid').innerHTML = '';
  });

  function applyTheme(){
    const theme = data.settings.theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', theme);
    // Remembered per device so the sign-in/profile screens (shown before any
    // profile's own saved theme is loaded) open in the same theme next time.
    try{ localStorage.setItem('sadhana-theme', theme); }catch(e){ /* private mode */ }
  }

  /* ---------- Tabs ---------- */
  document.querySelectorAll('.tab-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const tab = btn.dataset.tab;
      document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('#appScreen > [id^="tab-"]').forEach(el=>{ el.style.display = el.id === 'tab-'+tab ? '' : 'none'; });
      if(tab==='routine') renderRoutineTab();
      if(tab==='journal') renderJournalTab();
      if(tab==='calendar') renderCalendar();
      if(tab==='gurus') renderGurusTab();
      if(tab==='chalisa') renderChalisaTab();
      if(tab==='kumbhak') renderKumbhakTab();
      if(tab==='nishkaam') renderNishkaamTab();
      btn.scrollIntoView({inline:'center', block:'nearest', behavior:'smooth'});
    });
  });

  const appCtx = {
    getData: ()=>data, save, uid, todayStr, escapeHtml, fmtShort, fmtTime,
    cloudGet, cloudSet, getCurrentUser: ()=>currentUser
  };
  initJournal(appCtx);
  initDhyana(appCtx);
  initChalisa(appCtx);
  initKumbhak(appCtx);
  initNishkaam(appCtx);


  document.getElementById('themeToggle').addEventListener('click', ()=>{
    data.settings.theme = data.settings.theme==='dark' ? 'light' : 'dark';
    applyTheme(); save();
  });

  /* ---------- Export / Import (all data: every user + Guru's Teachings) ---------- */
  async function gatherFullExport(){
    if(currentUser){
      try{ await cloudSet(userStorageKey(currentUser.id), JSON.stringify(data)); }
      catch(e){ /* ignore */ }
    }
    const usersData = {};
    for(const u of users){
      try{
        const res = await cloudGet(userStorageKey(u.id));
        usersData[u.id] = (res && res.value) ? JSON.parse(res.value) : defaultData();
      }catch(e){ usersData[u.id] = defaultData(); }
    }
    return {
      format: 'sadhana-full-export',
      version: 1,
      exportedAt: new Date().toISOString(),
      users,
      usersData,
      gurus
    };
  }

  document.getElementById('exportBtn').addEventListener('click', async ()=>{
    const full = await gatherFullExport();
    const blob = new Blob([JSON.stringify(full,null,2)], {type:'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'sadhana-full-export-'+todayStr()+'.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  });

  document.getElementById('importBtn').addEventListener('click', ()=>{
    document.getElementById('importFileInput').click();
  });
  document.getElementById('importFileInput').addEventListener('change', async (ev)=>{
    const file = ev.target.files[0];
    ev.target.value = '';
    if(!file) return;
    let parsed;
    try{ parsed = JSON.parse(await file.text()); }
    catch(e){ alert('That file is not valid JSON.'); return; }
    if(!parsed || !Array.isArray(parsed.users) || typeof parsed.usersData !== 'object'){
      alert('That file does not look like a Sadhana export.');
      return;
    }
    if(!confirm('Importing will replace all users, their tracker data, and Guru\'s Teachings on this device with the contents of this file. Continue?')) return;

    finalizeAllRunning();

    try{
      users = parsed.users;
      await saveUsersNow(users);

      for(const u of users){
        const uData = normalizeData(parsed.usersData[u.id] || defaultData());
        await cloudSet(userStorageKey(u.id), JSON.stringify(uData));
      }

      gurus = Array.isArray(parsed.gurus) ? parsed.gurus : [];
      await saveGurus();
    }catch(e){
      console.error('import failed', e);
      alert('Import failed partway through — some data may be inconsistent.');
    }

    currentUser = null;
    data = defaultData();
    document.getElementById('appScreen').style.display = 'none';
    document.getElementById('userSelectScreen').style.display = '';
    renderUserGrid();
    renderDailyQuote();
    alert('Import complete.');
  });

  /* ---------- Add-form toggles ---------- */
  document.querySelectorAll('[data-open]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const formEl = document.getElementById(btn.dataset.open);
      const willOpen = !formEl.classList.contains('open');
      if(willOpen && btn.dataset.open==='japaForm') resetJapaForm();
      if(willOpen && btn.dataset.open==='practiceForm') resetPracticeForm();
      formEl.classList.toggle('open');
    });
  });
  document.querySelectorAll('[data-close]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.getElementById(btn.dataset.close).classList.remove('open');
    });
  });
  document.getElementById('todayAddActivityLink').addEventListener('click', ()=> openAddActivityPanel());

  /* ---------- Japa: create / edit ---------- */
  document.getElementById('japaSandhyaApplicable').addEventListener('change', (e)=>{
    document.getElementById('japaSandhyaRow').style.display = e.target.checked ? '' : 'none';
  });
  function resetJapaForm(){
    document.getElementById('japaEditId').value = '';
    document.getElementById('japaName').value = '';
    document.getElementById('japaSandhyaApplicable').checked = true;
    document.getElementById('japaSandhyaRow').style.display = '';
    document.querySelectorAll('#japaForm .check-row input').forEach(b=>b.checked=false);
    document.getElementById('japaSave').textContent = 'Save';
  }
  function openJapaEditForm(counterId){
    const counter = data.japa.find(c=>c.id===counterId);
    if(!counter) return;
    document.getElementById('japaEditId').value = counterId;
    document.getElementById('japaName').value = counter.name;
    const isAny = counter.sandhyas.length===1 && counter.sandhyas[0]==='any';
    document.getElementById('japaSandhyaApplicable').checked = !isAny;
    document.getElementById('japaSandhyaRow').style.display = isAny ? 'none' : '';
    document.querySelectorAll('#japaForm .check-row input').forEach(b=>{ b.checked = counter.sandhyas.includes(b.value); });
    document.getElementById('japaSave').textContent = 'Update';
    document.getElementById('japaForm').classList.add('open');
  }
  document.getElementById('japaSave').addEventListener('click', ()=>{
    const name = document.getElementById('japaName').value.trim();
    const applicable = document.getElementById('japaSandhyaApplicable').checked;
    const boxes = document.querySelectorAll('#japaForm .check-row input:checked');
    let sandhyas = Array.from(boxes).map(b=>b.value);
    if(!applicable) sandhyas = ['any'];
    if(!name || sandhyas.length===0) return;
    const editId = document.getElementById('japaEditId').value;
    if(editId){
      const counter = data.japa.find(c=>c.id===editId);
      if(counter){ counter.name = name; counter.sandhyas = sandhyas; }
    } else {
      data.japa.push({id:uid(), name, sandhyas, image:null, createdAt:Date.now()});
    }
    resetJapaForm();
    document.getElementById('japaForm').classList.remove('open');
    save(); renderJapa();
  });

  function renderJapa(){
    const el = document.getElementById('japaList');
    const t = todayStr();
    if(data.japa.length===0){ el.innerHTML = '<div class="card-list"><div class="item-row"><span class="empty-note">No japa counters yet.</span></div></div>'; return; }
    el.innerHTML = '<div class="card-list">' + data.japa.map(counter=>{
      const tasks = counter.sandhyas.map(s=>{
        const entry = (data.logs[t] && data.logs[t].japa[counter.id] && data.logs[t].japa[counter.id][s]) || {count:0,seconds:0};
        const done = entry.count > 0;
        return `<div class="task-item ${done?'done':''}" data-counter="${counter.id}" data-sandhya="${s}">
          <div class="t-left"><span class="dot"></span><span class="t-label">${SANDHYA_LABEL[s]}</span></div>
          <span class="t-meta">${done ? entry.count+' japas · '+fmtTime(entry.seconds) : 'tap to count'}</span>
        </div>`;
      }).join('');
      return `<div class="item-row">
        <div class="row-flex">
          <span class="item-title">${escapeHtml(counter.name)}</span>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="edit-icon-btn japa-journal-btn" data-name="${escapeHtml(counter.name)}" title="Add journal note">📝</button>
            <button class="edit-icon-btn japa-edit-btn" data-counter="${counter.id}" title="Edit counter">✎</button>
            <button class="icon-btn japa-img-btn" data-counter="${counter.id}" title="${counter.image ? 'Change background image' : 'Attach background image'}" style="width:28px;height:28px;font-size:13px;flex-shrink:0;">${counter.image ? '🖼️' : '📷'}</button>
          </div>
        </div>
        <div class="task-list">${tasks}</div>
      </div>`;
    }).join('') + '</div>';

    el.querySelectorAll('.task-item').forEach(item=>{
      item.addEventListener('click', ()=>{
        openJapaFullscreen(item.dataset.counter, item.dataset.sandhya);
      });
    });
    el.querySelectorAll('.japa-img-btn').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        pendingImageCounterId = btn.dataset.counter;
        document.getElementById('japaImageInput').click();
      });
    });
    el.querySelectorAll('.japa-edit-btn').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        openJapaEditForm(btn.dataset.counter);
      });
    });
    el.querySelectorAll('.japa-journal-btn').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{ ev.stopPropagation(); openJournalNoteFor(btn.dataset.name); });
    });
  }

  /* ---------- Japa fullscreen ---------- */
  let fsState = null; // {counterId, sandhya, startTime, baseCount, baseSeconds, tickHandle}
  let pendingImageCounterId = null;

  function applyFsBackground(counter){
    const bg = document.getElementById('fsBg');
    const fsEl = document.getElementById('japaFullscreen');
    const removeBtn = document.getElementById('fsImageRemove');
    if(counter && counter.image){
      bg.style.backgroundImage = 'url("'+counter.image+'")';
      fsEl.classList.add('has-image');
      removeBtn.style.display = '';
    } else {
      bg.style.backgroundImage = 'none';
      fsEl.classList.remove('has-image');
      removeBtn.style.display = 'none';
    }
  }

  function resizeImageFile(file, maxDim, quality){
    return new Promise((resolve, reject)=>{
      const reader = new FileReader();
      reader.onload = ()=>{
        const img = new Image();
        img.onload = ()=>{
          let w = img.width, h = img.height;
          if(w > maxDim || h > maxDim){
            if(w >= h){ h = Math.round(h * maxDim / w); w = maxDim; }
            else { w = Math.round(w * maxDim / h); h = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = reader.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  document.getElementById('japaImageInput').addEventListener('change', async (ev)=>{
    const file = ev.target.files[0];
    ev.target.value = '';
    if(!file || !pendingImageCounterId) return;
    const counterId = pendingImageCounterId;
    pendingImageCounterId = null;
    try{
      const dataUrl = await resizeImageFile(file, 1600, 0.82);
      const counter = data.japa.find(c=>c.id===counterId);
      if(!counter) return;
      counter.image = dataUrl;
      save();
      renderJapa();
      if(fsState && fsState.counterId===counterId) applyFsBackground(counter);
    }catch(e){ console.error('image attach failed', e); }
  });

  document.getElementById('fsImageBtn').addEventListener('click', (ev)=>{
    ev.stopPropagation();
    if(!fsState) return;
    pendingImageCounterId = fsState.counterId;
    document.getElementById('japaImageInput').click();
  });
  document.getElementById('fsImageRemove').addEventListener('click', (ev)=>{
    ev.stopPropagation();
    if(!fsState) return;
    const counter = data.japa.find(c=>c.id===fsState.counterId);
    if(!counter) return;
    counter.image = null;
    save();
    applyFsBackground(counter);
  });

  function openJapaFullscreen(counterId, sandhya){
    const counter = data.japa.find(c=>c.id===counterId);
    if(!counter) return;
    const t = todayStr();
    const entry = ensureJapaEntry(t, counterId, sandhya);
    fsState = { counterId, sandhya, startTime: Date.now(), baseCount: entry.count, baseSeconds: entry.seconds, liveCount: entry.count };
    document.getElementById('fsName').textContent = counter.name + ' · ' + SANDHYA_LABEL[sandhya];
    document.getElementById('fsCount').textContent = fsState.liveCount;
    document.getElementById('fsTimer').textContent = fmtTime(entry.seconds);
    applyFsBackground(counter);
    document.getElementById('japaFullscreen').classList.add('open');
    fsState.tickHandle = setInterval(()=>{
      const elapsed = (Date.now()-fsState.startTime)/1000;
      document.getElementById('fsTimer').textContent = fmtTime(fsState.baseSeconds + elapsed);
      tickLiveCalendarCell();
      tickRoutineNowLine();
      renderStatsStrip();
    }, 1000);
  }
  function closeJapaFullscreen(){
    if(!fsState) return;
    clearInterval(fsState.tickHandle);
    const elapsed = (Date.now()-fsState.startTime)/1000;
    const t = todayStr();
    const entry = ensureJapaEntry(t, fsState.counterId, fsState.sandhya);
    entry.count = fsState.liveCount;
    entry.seconds = fsState.baseSeconds + elapsed;
    document.getElementById('japaFullscreen').classList.remove('open');
    fsState = null;
    save(); renderJapa(); renderStatsStrip();
  }
  // Vibration API support is device/browser-dependent (most Android
  // browsers; not supported on iOS Safari at all — Apple gives web pages no
  // access to the Taptic Engine) and navigator.vibrate itself is a no-op
  // over unsupported browsers/desktops, so this is best-effort with no
  // fallback needed. A short-short-long pattern (rather than a single
  // buzz) so it reads as "milestone reached" distinct from an accidental
  // double-tap.
  function japaMilestoneHaptic(){
    if(navigator.vibrate){
      try{ navigator.vibrate([30, 40, 30, 40, 120]); }catch(e){ /* unsupported */ }
    }
  }
  document.getElementById('fsTapArea').addEventListener('click', ()=>{
    if(!fsState) return;
    fsState.liveCount++;
    document.getElementById('fsCount').textContent = fsState.liveCount;
    if(fsState.liveCount > 0 && fsState.liveCount % 108 === 0) japaMilestoneHaptic();
  });
  document.getElementById('fsMinus').addEventListener('click', (e)=>{
    e.stopPropagation();
    if(!fsState) return;
    fsState.liveCount = Math.max(0, fsState.liveCount-1);
    document.getElementById('fsCount').textContent = fsState.liveCount;
  });
  document.getElementById('fsReset').addEventListener('click', (e)=>{
    e.stopPropagation();
    if(!fsState) return;
    fsState.liveCount = 0;
    document.getElementById('fsCount').textContent = 0;
  });
  document.getElementById('fsClose').addEventListener('click', closeJapaFullscreen);

  /* ---------- Practice ---------- */
  document.getElementById('practiceSandhyaApplicable').addEventListener('change', (e)=>{
    document.getElementById('practiceSandhyaRow').style.display = e.target.checked ? '' : 'none';
  });
  function resetPracticeForm(){
    document.getElementById('practiceEditId').value = '';
    document.getElementById('practiceName').value = '';
    document.getElementById('practiceSandhyaApplicable').checked = true;
    document.getElementById('practiceSandhyaRow').style.display = '';
    document.querySelectorAll('#practiceForm .check-row input').forEach(b=>b.checked=false);
    document.getElementById('practiceSave').textContent = 'Save';
  }
  function openPracticeEditForm(practiceId){
    const pr = data.practice.find(p=>p.id===practiceId);
    if(!pr) return;
    document.getElementById('practiceEditId').value = practiceId;
    document.getElementById('practiceName').value = pr.name;
    const isAny = pr.sandhyas.length===1 && pr.sandhyas[0]==='any';
    document.getElementById('practiceSandhyaApplicable').checked = !isAny;
    document.getElementById('practiceSandhyaRow').style.display = isAny ? 'none' : '';
    document.querySelectorAll('#practiceForm .check-row input').forEach(b=>{ b.checked = pr.sandhyas.includes(b.value); });
    document.getElementById('practiceSave').textContent = 'Update';
    document.getElementById('practiceForm').classList.add('open');
  }
  document.getElementById('practiceSave').addEventListener('click', ()=>{
    const name = document.getElementById('practiceName').value.trim();
    const applicable = document.getElementById('practiceSandhyaApplicable').checked;
    const boxes = document.querySelectorAll('#practiceForm .check-row input:checked');
    let sandhyas = Array.from(boxes).map(b=>b.value);
    if(!applicable) sandhyas = ['any'];
    if(!name || sandhyas.length===0) return;
    const editId = document.getElementById('practiceEditId').value;
    if(editId){
      const pr = data.practice.find(p=>p.id===editId);
      if(pr){ pr.name = name; pr.sandhyas = sandhyas; }
    } else {
      data.practice.push({id:uid(), name, sandhyas, createdAt:Date.now()});
    }
    resetPracticeForm();
    document.getElementById('practiceForm').classList.remove('open');
    save(); renderPractice();
  });

  let runningTimers = {}; // key `${practiceId}|${sandhya}` -> {startTime, interval}

  function renderPractice(){
    const el = document.getElementById('practiceList');
    const t = todayStr();
    if(data.practice.length===0){ el.innerHTML = '<div class="card-list"><div class="item-row"><span class="empty-note">No practices yet.</span></div></div>'; return; }
    el.innerHTML = '<div class="card-list">' + data.practice.map(pr=>{
      const tasks = pr.sandhyas.map(s=>{
        const key = pr.id+'|'+s;
        const entry = (data.logs[t] && data.logs[t].practice[pr.id] && data.logs[t].practice[pr.id][s]) || {seconds:0,log:[]};
        const running = !!runningTimers[key];
        const done = entry.seconds > 0 && !running;
        let metaHtml, btnHtml;
        if(running){
          const subLabel = entry.seconds>0 ? `<div class="t-submeta">${fmtTime(entry.seconds)} logged earlier</div>` : '';
          metaHtml = `<div class="t-meta-stack"><span class="t-meta live" id="run-${key}">${fmtTime(0)}</span>${subLabel}</div>`;
          btnHtml = `<button class="pill done-btn" data-action="done" data-practice="${pr.id}" data-sandhya="${s}">Done</button>`;
        } else {
          const sessionCount = (entry.log||[]).length;
          metaHtml = `<span class="t-meta">${entry.seconds>0 ? fmtTime(entry.seconds)+(sessionCount>1?' · '+sessionCount+' sessions':' logged') : 'not started'}</span>`;
          btnHtml = `<button class="pill" data-action="start" data-practice="${pr.id}" data-sandhya="${s}">Start</button>`;
        }
        return `<div class="task-item ${done?'done':''}" data-static="1">
          <div class="t-left"><span class="dot"></span><span class="t-label">${SANDHYA_LABEL[s]}</span></div>
          <div style="display:flex;align-items:center;gap:10px;">${metaHtml}${btnHtml}</div>
        </div>`;
      }).join('');
      return `<div class="item-row">
        <div class="row-flex">
          <span class="item-title">${escapeHtml(pr.name)}</span>
          <div style="display:flex;gap:6px;flex-shrink:0;">
            <button class="edit-icon-btn practice-journal-btn" data-name="${escapeHtml(pr.name)}" title="Add journal note">📝</button>
            <button class="edit-icon-btn practice-edit-btn" data-practice="${pr.id}" title="Edit practice">✎</button>
          </div>
        </div>
        <div class="task-list">${tasks}</div>
      </div>`;
    }).join('') + '</div>';

    el.querySelectorAll('[data-action="start"]').forEach(btn=>{
      btn.addEventListener('click', ()=>startPractice(btn.dataset.practice, btn.dataset.sandhya));
    });
    el.querySelectorAll('[data-action="done"]').forEach(btn=>{
      btn.addEventListener('click', ()=>stopPractice(btn.dataset.practice, btn.dataset.sandhya));
    });
    el.querySelectorAll('.practice-edit-btn').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        openPracticeEditForm(btn.dataset.practice);
      });
    });
    el.querySelectorAll('.practice-journal-btn').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{ ev.stopPropagation(); openJournalNoteFor(btn.dataset.name); });
    });
  }

  function startPractice(practiceId, sandhya){
    const key = practiceId+'|'+sandhya;
    if(runningTimers[key]) return;
    ensurePracticeEntry(todayStr(), practiceId, sandhya);
    runningTimers[key] = { startTime: Date.now() };
    renderPractice();
    runningTimers[key].interval = setInterval(()=>{
      const el = document.getElementById('run-'+key);
      if(el){
        const elapsed = (Date.now()-runningTimers[key].startTime)/1000;
        el.textContent = fmtTime(elapsed);
      }
      tickLiveCalendarCell();
      tickRoutineNowLine();
      renderStatsStrip();
    }, 1000);
  }
  function stopPractice(practiceId, sandhya){
    const key = practiceId+'|'+sandhya;
    const rt = runningTimers[key];
    if(!rt) return;
    clearInterval(rt.interval);
    const elapsed = (Date.now()-rt.startTime)/1000;
    const t = todayStr();
    const entry = ensurePracticeEntry(t, practiceId, sandhya);
    entry.log = entry.log || [];
    entry.log.push({ seconds: elapsed, endedAt: Date.now() });
    entry.seconds += elapsed;
    delete runningTimers[key];
    save(); renderPractice(); renderCalendarDashboard(); renderStatsStrip();
    if(document.getElementById('tab-calendar').style.display !== 'none') renderCalendar();
  }

  /* ---------- Routine Scheduler activity timers ----------
     Reuses the exact same runningTimers map and tick pattern as the
     mandatory Practice timer above (startPractice/stopPractice), just
     keyed as 'activity|<id>' and writing into logs[date].activities
     instead of logs[date].practice[..][sandhya]. There is no separate
     timer system for custom activities. */
  function refreshActivityViews(){
    renderTodaySchedule();
    if(document.getElementById('tab-routine') && document.getElementById('tab-routine').style.display !== 'none') renderRoutineTab();
    renderCalendarDashboard();
  }

  function startActivityTimer(activityId){
    const key = 'activity|'+activityId;
    if(runningTimers[key]) return;
    const t = todayStr();
    const entry = ensureActivityEntry(t, activityId);
    if(!entry.startedAt) entry.startedAt = Date.now();
    entry.status = 'in-progress';
    runningTimers[key] = { startTime: Date.now() };
    save();
    refreshActivityViews();
    runningTimers[key].interval = setInterval(()=>{
      const el = document.getElementById('run-'+key);
      if(el){
        const elapsed = (Date.now()-runningTimers[key].startTime)/1000;
        el.textContent = fmtTime(elapsed);
      }
      tickLiveCalendarCell();
      tickRoutineNowLine();
      renderStatsStrip();
    }, 1000);
  }

  function pauseActivityTimer(activityId){
    const key = 'activity|'+activityId;
    const rt = runningTimers[key];
    if(!rt) return;
    clearInterval(rt.interval);
    const elapsed = (Date.now()-rt.startTime)/1000;
    const entry = ensureActivityEntry(todayStr(), activityId);
    entry.log = entry.log || [];
    entry.log.push({ seconds: elapsed, endedAt: Date.now() });
    entry.seconds += elapsed;
    entry.status = 'paused';
    delete runningTimers[key];
    save();
    refreshActivityViews();
  }

  function completeActivityTimer(activityId){
    const key = 'activity|'+activityId;
    const entry = ensureActivityEntry(todayStr(), activityId);
    const rt = runningTimers[key];
    if(rt){
      clearInterval(rt.interval);
      const elapsed = (Date.now()-rt.startTime)/1000;
      entry.log = entry.log || [];
      entry.log.push({ seconds: elapsed, endedAt: Date.now() });
      entry.seconds += elapsed;
      delete runningTimers[key];
    }
    entry.status = 'done';
    entry.completedAt = Date.now();
    save();
    refreshActivityViews();
  }

  /* ---------- Reading ---------- */
  document.getElementById('bookSave').addEventListener('click', ()=>{
    const title = document.getElementById('bookTitle').value.trim();
    const pages = parseInt(document.getElementById('bookPages').value, 10);
    if(!title || !pages || pages<=0) return;
    data.books.push({id:uid(), title, pages});
    document.getElementById('bookTitle').value='';
    document.getElementById('bookPages').value='';
    document.getElementById('bookForm').classList.remove('open');
    save(); renderReading();
  });

  function totalPagesRead(bookId){
    let total = 0;
    for(const d in data.logs){
      const v = data.logs[d].reading && data.logs[d].reading[bookId];
      if(v) total += v;
    }
    return total;
  }

  function renderReading(){
    const el = document.getElementById('readingList');
    const t = todayStr();
    if(data.books.length===0){ el.innerHTML = '<div class="card-list"><div class="item-row"><span class="empty-note">No books yet.</span></div></div>'; return; }
    el.innerHTML = '<div class="card-list">' + data.books.map(book=>{
      const read = totalPagesRead(book.id);
      const pct = Math.min(100, Math.round((read/book.pages)*100));
      const todayVal = (data.logs[t] && data.logs[t].reading && data.logs[t].reading[book.id]) || '';
      return `<div class="item-row">
        <div class="row-flex">
          <span class="item-title">${escapeHtml(book.title)}</span>
          <span class="item-sub">${read} / ${book.pages} pages · ${pct}%</span>
        </div>
        <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        <div class="reading-log">
          <input type="number" min="0" placeholder="pages today" data-book="${book.id}" value="${todayVal||''}">
          <button class="pill" data-log-book="${book.id}">Log</button>
          <button class="edit-icon-btn" data-journal-book="${escapeHtml(book.title)}" title="Add journal note">📝</button>
        </div>
        <div class="reminder-control" style="margin-top:8px;">
          <span class="reminder-icon">🔔</span>
          <input type="time" data-reminder-reading="${book.id}" value="${getItemReminderTime('reading', book.id)}" title="Daily reading reminder">
        </div>
      </div>`;
    }).join('') + '</div>';

    el.querySelectorAll('[data-reminder-reading]').forEach(inp=>{
      inp.addEventListener('change', ()=>{
        setItemReminderTime('reading', inp.dataset.reminderReading, inp.value);
        if(inp.value) ensureNotificationPermission();
      });
    });
    el.querySelectorAll('[data-journal-book]').forEach(btn=>{
      btn.addEventListener('click', ()=> openJournalNoteFor(btn.dataset.journalBook));
    });
    el.querySelectorAll('[data-log-book]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const bookId = btn.dataset.logBook;
        const input = el.querySelector(`input[data-book="${bookId}"]`);
        const val = parseInt(input.value,10);
        if(isNaN(val) || val<0) return;
        const t = todayStr();
        const day = ensureDay(t);
        day.reading[bookId] = val;
        save(); renderReading();
      });
    });
  }

  /* ---------- Learning ---------- */
  document.getElementById('learnSave').addEventListener('click', ()=>{
    const title = document.getElementById('learnTitle').value.trim();
    if(!title) return;
    data.learning.push({id:uid(), title, milestones:[], notes:[], expanded:true});
    document.getElementById('learnTitle').value='';
    document.getElementById('learnForm').classList.remove('open');
    save(); renderLearning();
  });

  function renderLearning(){
    const el = document.getElementById('learningList');
    if(data.learning.length===0){ el.innerHTML = '<div class="card-list"><div class="item-row"><span class="empty-note">No learning tracks yet.</span></div></div>'; return; }
    el.innerHTML = '<div class="card-list">' + data.learning.map(track=>{
      const doneCount = track.milestones.filter(m=>m.done).length;
      const milestonesHtml = track.milestones.map((m,i)=>`
        <div class="milestone ${m.done?'done':''}">
          <input type="checkbox" ${m.done?'checked':''} data-toggle-milestone="${track.id}|${m.id}">
          <span class="m-text">${i+1}. ${escapeHtml(m.text)}</span>
        </div>`).join('');
      const notesHtml = track.notes.slice().reverse().map(n=>`
        <div class="note-entry"><span class="note-date">${n.date}</span>${escapeHtml(n.text)}</div>`).join('');
      const body = track.expanded ? `
        <div class="milestone-list">${milestonesHtml || '<span class="empty-note">No milestones yet.</span>'}</div>
        <div class="mini-input-row">
          <input type="text" placeholder="add milestone" data-milestone-input="${track.id}">
          <button class="pill ghost" data-add-milestone="${track.id}">Add</button>
        </div>
        <div class="notes-list">${notesHtml || '<span class="empty-note">No notes yet.</span>'}</div>
        <div class="mini-input-row">
          <input type="text" placeholder="add a note or to-do" data-note-input="${track.id}">
          <button class="pill ghost" data-add-note="${track.id}">Add</button>
        </div>
      ` : '';
      return `<div class="item-row">
        <div class="row-flex">
          <span class="item-title">${escapeHtml(track.title)}</span>
          <span class="item-sub">${doneCount}/${track.milestones.length} milestones</span>
        </div>
        <button class="expand-toggle" data-toggle-expand="${track.id}">${track.expanded?'hide details':'show details'}</button>
        <button class="edit-icon-btn" data-journal-track="${escapeHtml(track.title)}" title="Add journal note" style="margin-left:8px;">📝</button>
        <div class="reminder-control" style="margin-top:8px;">
          <span class="reminder-icon">🔔</span>
          <input type="time" data-reminder-learning="${track.id}" value="${getItemReminderTime('learning', track.id)}" title="Daily learning reminder">
        </div>
        ${body}
      </div>`;
    }).join('') + '</div>';

    el.querySelectorAll('[data-reminder-learning]').forEach(inp=>{
      inp.addEventListener('change', ()=>{
        setItemReminderTime('learning', inp.dataset.reminderLearning, inp.value);
        if(inp.value) ensureNotificationPermission();
      });
    });
    el.querySelectorAll('[data-journal-track]').forEach(btn=>{
      btn.addEventListener('click', ()=> openJournalNoteFor(btn.dataset.journalTrack));
    });
    el.querySelectorAll('[data-toggle-expand]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const track = data.learning.find(t=>t.id===btn.dataset.toggleExpand);
        track.expanded = !track.expanded;
        renderLearning();
      });
    });
    el.querySelectorAll('[data-toggle-milestone]').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        const [trackId, mId] = cb.dataset.toggleMilestone.split('|');
        const track = data.learning.find(t=>t.id===trackId);
        const m = track.milestones.find(m=>m.id===mId);
        m.done = cb.checked;
        save(); renderLearning();
      });
    });
    el.querySelectorAll('[data-add-milestone]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const trackId = btn.dataset.addMilestone;
        const input = el.querySelector(`[data-milestone-input="${trackId}"]`);
        const text = input.value.trim();
        if(!text) return;
        const track = data.learning.find(t=>t.id===trackId);
        track.milestones.push({id:uid(), text, done:false});
        save(); renderLearning();
      });
    });
    el.querySelectorAll('[data-add-note]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const trackId = btn.dataset.addNote;
        const input = el.querySelector(`[data-note-input="${trackId}"]`);
        const text = input.value.trim();
        if(!text) return;
        const track = data.learning.find(t=>t.id===trackId);
        track.notes.push({id:uid(), text, date:todayStr()});
        save(); renderLearning();
      });
    });
  }

  /* ======================================================================
     Routine Scheduler
     A single reusable activity model shared by Today's Schedule and the
     Routine tab's timeline. A "flexible" (unscheduled) activity is simply
     one whose schedule.startTime is null — there is no separate data
     source for flexible vs. scheduled vs. mandatory-linked activities.
     Timers reuse startActivityTimer/pauseActivityTimer/completeActivityTimer
     (defined above, next to stopPractice) which share the runningTimers map
     with the mandatory Practice timer.
     ====================================================================== */

  const ACTIVITY_CATEGORIES = [
    {key:'spiritual', label:'Spiritual', color:'#B8863B'},
    {key:'health',    label:'Health',    color:'#66805A'},
    {key:'work',      label:'Work',      color:'#6B4A33'},
    {key:'learning',  label:'Learning',  color:'#A2543A'},
    {key:'personal',  label:'Personal',  color:'#A07C58'},
    {key:'other',     label:'Other',     color:'#8A8370'}
  ];
  const ACTIVITY_PRIORITY_ORDER = { high:0, medium:1, low:2 };
  const ACTIVITY_PRIORITY_LABEL = { high:'High priority', medium:'Medium priority', low:'Low priority' };
  const ACTIVITY_SUGGESTIONS = [
    {name:'Exercise', icon:'🏃', category:'health', durationMin:45},
    {name:'Meditation', icon:'🧘', category:'spiritual', durationMin:20},
    {name:'Yoga', icon:'🤸', category:'health', durationMin:30},
    {name:'Walking', icon:'🚶', category:'health', durationMin:30},
    {name:'Study', icon:'📖', category:'learning', durationMin:60},
    {name:'Office Work', icon:'💼', category:'work', durationMin:480},
    {name:'Journaling', icon:'📝', category:'personal', durationMin:15},
    {name:'Family Time', icon:'👨‍👩‍👧', category:'personal', durationMin:60},
    {name:'Sleep', icon:'😴', category:'health', durationMin:480},
    {name:'Sanskrit Practice', icon:'🕉', category:'spiritual', durationMin:20},
    {name:'Pranayama', icon:'🌬️', category:'spiritual', durationMin:15},
    {name:'Seva', icon:'🤝', category:'spiritual', durationMin:60}
  ];
  const ROUTINE_PRESETS = [
    { name:'Spiritual Routine', activities:[
      {name:'Early Wake Up', icon:'🌅', category:'spiritual', priority:'high', durationMin:15, schedule:{startTime:'05:00', frequency:'daily'}},
      {name:'Meditation', icon:'🧘', category:'spiritual', priority:'high', durationMin:20, schedule:{startTime:'05:30', frequency:'daily'}},
      {name:'Reflection', icon:'📓', category:'spiritual', priority:'medium', durationMin:15, schedule:{startTime:'21:30', frequency:'daily'}}
    ]},
    { name:'Productive Work Day', activities:[
      {name:'Morning Routine', icon:'☀️', category:'personal', priority:'medium', durationMin:30, schedule:{startTime:'06:30', frequency:'weekdays'}},
      {name:'Deep Work', icon:'💻', category:'work', priority:'high', durationMin:180, schedule:{startTime:'09:00', frequency:'weekdays'}},
      {name:'Meetings', icon:'🗣️', category:'work', priority:'medium', durationMin:60, schedule:{startTime:'14:00', frequency:'weekdays'}},
      {name:'Exercise', icon:'🏃', category:'health', priority:'medium', durationMin:45, schedule:{startTime:'18:00', frequency:'weekdays'}}
    ]},
    { name:'Balanced Routine', activities:[
      {name:'Exercise', icon:'🏃', category:'health', priority:'medium', durationMin:45, schedule:{startTime:'06:30', frequency:'daily'}},
      {name:'Work', icon:'💼', category:'work', priority:'high', durationMin:300, schedule:{startTime:'09:30', frequency:'weekdays'}},
      {name:'Family Time', icon:'👨‍👩‍👧', category:'personal', priority:'medium', durationMin:60, schedule:{startTime:'19:00', frequency:'daily'}},
      {name:'Rest', icon:'😴', category:'health', priority:'low', durationMin:30, schedule:{startTime:'21:30', frequency:'daily'}}
    ]}
  ];

  /* ======================================================================
     Reminders — best-effort browser notifications, not a real OS alarm.
     A reminder is a daily HH:MM stored on the item itself (activities) or
     in mandatorySchedule (Japa/Practice per sandhya, Reading per book,
     Learning per track). This schedules a plain setTimeout to the next
     occurrence and calls the service worker's showNotification() when it
     fires, then re-arms itself for the following day. This only fires
     while the browser/PWA process for this device is running (or has run
     recently, depending on the OS/browser) — it cannot wake a fully closed
     browser at an exact time. On iOS this only works at all once the app
     has been added to the Home Screen (Apple restricts background web
     notifications otherwise). See CLAUDE.md/BRD.md for why a true
     guaranteed-timing alarm was not built (it needs a paid scheduled-push
     backend: Firebase Cloud Functions + Cloud Scheduler + FCM).
     ====================================================================== */
  let reminderTimers = {};

  async function ensureNotificationPermission(){
    if(!('Notification' in window)) return false;
    if(Notification.permission === 'granted') return true;
    if(Notification.permission === 'denied') return false;
    try{ return (await Notification.requestPermission()) === 'granted'; }
    catch(e){ return false; }
  }

  function clearAllReminderTimers(){
    Object.values(reminderTimers).forEach(h=>clearTimeout(h));
    reminderTimers = {};
  }

  function collectReminders(){
    const list = [];
    data.japa.forEach(item=>{
      (item.sandhyas||[]).forEach(sandhya=>{
        if(sandhya==='any') return;
        const rec = data.mandatorySchedule.japa[sandhya];
        if(rec && rec.reminderTime) list.push({ id:'japa:'+item.id+':'+sandhya, time:rec.reminderTime, title:'Japa reminder', body:item.name+' · '+SANDHYA_LABEL[sandhya] });
      });
    });
    data.practice.forEach(item=>{
      (item.sandhyas||[]).forEach(sandhya=>{
        if(sandhya==='any') return;
        const rec = data.mandatorySchedule.practice[sandhya];
        if(rec && rec.reminderTime) list.push({ id:'practice:'+item.id+':'+sandhya, time:rec.reminderTime, title:'Practice reminder', body:item.name+' · '+SANDHYA_LABEL[sandhya] });
      });
    });
    data.books.forEach(book=>{
      const rec = data.mandatorySchedule.reading[book.id];
      if(rec && rec.reminderTime) list.push({ id:'reading:'+book.id, time:rec.reminderTime, title:'Reading reminder', body:book.title });
    });
    data.learning.forEach(track=>{
      const rec = data.mandatorySchedule.learning[track.id];
      if(rec && rec.reminderTime) list.push({ id:'learning:'+track.id, time:rec.reminderTime, title:'Learning reminder', body:track.title });
    });
    data.activities.forEach(a=>{
      if(a.reminderTime) list.push({ id:'activity:'+a.id, time:a.reminderTime, title:'Sadhana reminder', body:a.name });
    });
    return list;
  }

  function msUntilNextOccurrence(timeStr){
    const parts = timeStr.split(':');
    const h = +parts[0], m = +parts[1];
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0);
    if(next <= now) next.setDate(next.getDate()+1);
    return next.getTime() - now.getTime();
  }

  async function fireReminder(rem){
    try{
      if('serviceWorker' in navigator){
        const reg = await navigator.serviceWorker.ready;
        if(reg && reg.showNotification){
          await reg.showNotification(rem.title, { body: rem.body, icon:'icons/icon-192.png', badge:'icons/icon-192.png', tag: rem.id });
          return;
        }
      }
      if('Notification' in window && Notification.permission==='granted') new Notification(rem.title, { body: rem.body, icon:'icons/icon-192.png' });
    }catch(e){ console.error('reminder notification failed', e); }
  }

  function scheduleReminder(rem){
    // setTimeout delays beyond ~24.8 days overflow to fire immediately in
    // some engines; a daily reminder's delay is always <24h so this is
    // safe, but re-arming recomputes fresh each time regardless.
    reminderTimers[rem.id] = setTimeout(()=>{
      fireReminder(rem);
      scheduleReminder(rem);
    }, msUntilNextOccurrence(rem.time));
  }

  function rebuildReminderSchedule(){
    clearAllReminderTimers();
    if(!('Notification' in window) || Notification.permission !== 'granted') return;
    collectReminders().forEach(scheduleReminder);
  }

  // Reading/Learning have no sandhya concept, so their reminders live
  // directly under mandatorySchedule.reading[bookId] /
  // mandatorySchedule.learning[trackId] rather than through
  // getMandatoryTimeInfo (which is sandhya-shaped, for Japa/Practice).
  function getItemReminderTime(scheduleKey, itemId){
    const bucket = data.mandatorySchedule[scheduleKey];
    return (bucket && bucket[itemId] && bucket[itemId].reminderTime) || '';
  }
  function setItemReminderTime(scheduleKey, itemId, time){
    if(!data.mandatorySchedule[scheduleKey]) data.mandatorySchedule[scheduleKey] = {};
    const bucket = data.mandatorySchedule[scheduleKey];
    if(!bucket[itemId]) bucket[itemId] = {};
    bucket[itemId].reminderTime = time || '';
    save();
  }

  // Shared markup for a reminder control, reused wherever a reminder can be
  // set: the activity panel, the mandatory block expand panel, Reading book
  // rows, and Learning track headers.
  function reminderControlHtml(idAttr, currentTime){
    return `<span class="reminder-control">
      <span class="reminder-icon">🔔</span>
      <input type="time" class="reminder-time-input" id="${idAttr}" value="${currentTime||''}" title="Daily reminder time">
    </span>`;
  }

  function categoryMeta(key){ return ACTIVITY_CATEGORIES.find(c=>c.key===key) || ACTIVITY_CATEGORIES[ACTIVITY_CATEGORIES.length-1]; }
  function categoryColor(key){ return categoryMeta(key).color; }
  function categoryLabel(key){ return categoryMeta(key).label; }
  function priorityLabel(p){ return ACTIVITY_PRIORITY_LABEL[p] || ACTIVITY_PRIORITY_LABEL.medium; }

  function timeToMin(t){ if(!t) return null; const parts = t.split(':'); return (+parts[0])*60 + (+parts[1]); }
  function minToTime(min){ min = ((Math.round(min)%1440)+1440)%1440; const h=Math.floor(min/60), m=min%60; return String(h).padStart(2,'0')+':'+String(m).padStart(2,'0'); }
  function fmtTimeLabel(t){
    const min = timeToMin(t);
    if(min==null) return '';
    let h = Math.floor(min/60), m = min%60;
    const ampm = h>=12 ? 'PM' : 'AM';
    h = h%12; if(h===0) h=12;
    return h+':'+String(m).padStart(2,'0')+' '+ampm;
  }
  function activityEndTime(activity){
    const sch = activity.schedule || {};
    if(sch.endTime) return sch.endTime;
    if(sch.startTime!=null && activity.durationMin) return minToTime(timeToMin(sch.startTime) + activity.durationMin);
    return null;
  }

  function isActivityDueOn(activity, dateStr){
    // An activity can't have been "due" (and therefore can't be "missed")
    // on a date before it was created — without this, creating a new daily
    // activity today would retroactively mark it overdue for every past
    // matching day, inflating missed counts in the Calendar Dashboard.
    if(activity.createdAt && dateStr < todayStr(new Date(activity.createdAt))) return false;
    const sch = activity.schedule || {};
    const freq = sch.frequency || 'daily';
    const dow = new Date(dateStr+'T00:00:00').getDay();
    if(freq==='weekdays') return dow>=1 && dow<=5;
    if(freq==='weekends') return dow===0 || dow===6;
    if(freq==='custom') return Array.isArray(sch.days) && sch.days.includes(dow);
    return true; // 'daily' or unrecognized -> treat as daily
  }
  function getActivitiesDueOn(dateStr){ return data.activities.filter(a=>isActivityDueOn(a, dateStr)); }
  function getActivitiesDueToday(){ return getActivitiesDueOn(todayStr()); }

  function sortActivitiesForDisplay(list){
    return list.slice().sort((a,b)=>{
      const aTimed = !!(a.schedule && a.schedule.startTime);
      const bTimed = !!(b.schedule && b.schedule.startTime);
      if(aTimed !== bTimed) return aTimed ? -1 : 1;
      if(aTimed && bTimed){
        const ta = timeToMin(a.schedule.startTime), tb = timeToMin(b.schedule.startTime);
        if(ta !== tb) return ta - tb;
      }
      const pa = ACTIVITY_PRIORITY_ORDER[a.priority] ?? 1;
      const pb = ACTIVITY_PRIORITY_ORDER[b.priority] ?? 1;
      if(pa !== pb) return pa - pb;
      return (a.order||0) - (b.order||0);
    });
  }

  function createActivity(fields){
    const activity = Object.assign({
      id: uid(),
      name: '', description:'', icon:'✦', category:'personal', priority:'medium',
      color: null, durationMin: 30,
      schedule: { startTime:null, endTime:null, frequency:'daily', days:[] },
      order: data.activities.length,
      locked:false,
      createdAt: Date.now(), updatedAt: Date.now()
    }, fields);
    if(fields && fields.schedule) activity.schedule = Object.assign({startTime:null, endTime:null, frequency:'daily', days:[]}, fields.schedule);
    data.activities.push(activity);
    save();
    return activity;
  }
  function updateActivity(id, fields){
    const a = data.activities.find(x=>x.id===id);
    if(!a) return null;
    if(fields.schedule) fields = Object.assign({}, fields, { schedule: Object.assign({}, a.schedule, fields.schedule) });
    Object.assign(a, fields, {updatedAt:Date.now()});
    save();
    return a;
  }
  function deleteActivity(id){
    const a = data.activities.find(x=>x.id===id);
    if(a && a.locked) return; // mandatory-linked activities are never deletable
    data.activities = data.activities.filter(x=>x.id!==id);
    save();
  }
  function duplicateActivity(id, overrides){
    const a = data.activities.find(x=>x.id===id);
    if(!a) return null;
    const copy = Object.assign({}, a, overrides||{}, {id:uid(), locked:false, order:data.activities.length, createdAt:Date.now(), updatedAt:Date.now()});
    if(!overrides || !overrides.name) copy.name = a.name;
    data.activities.push(copy);
    save();
    return copy;
  }

  /* ---------- Today's Schedule (in the Today tab, after the mandatory sections) ---------- */
  function renderActivityRow(activity, dateStr, opts){
    opts = opts || {};
    const day = data.logs[dateStr];
    const entry = (day && day.activities && day.activities[activity.id]) || {status:'pending', seconds:0};
    const key = 'activity|'+activity.id;
    const running = !!runningTimers[key];
    const color = activity.color || categoryColor(activity.category);
    const end = activityEndTime(activity);
    const timeLabel = opts.flexible ? 'Flexible — no fixed time' : (fmtTimeLabel(activity.schedule.startTime) + (end ? ' – '+fmtTimeLabel(end) : ''));

    let metaHtml, actionsHtml;
    if(running){
      metaHtml = `<span class="t-meta live" id="run-${key}">${fmtTime(0)}</span>`;
      actionsHtml = `<button class="pill ghost" data-act="pause" data-id="${activity.id}">Pause</button>
        <button class="pill done-btn" data-act="complete" data-id="${activity.id}">Complete</button>`;
    } else if(entry.status==='done'){
      metaHtml = `<span class="t-meta">✓ ${fmtTime(entry.seconds)}</span>`;
      actionsHtml = '';
    } else if(entry.status==='skipped'){
      metaHtml = `<span class="t-meta">Skipped today</span>`;
      actionsHtml = `<button class="pill ghost" data-act="start" data-id="${activity.id}">Start</button>`;
    } else if(entry.seconds>0){
      metaHtml = `<span class="t-meta">${fmtTime(entry.seconds)} so far</span>`;
      actionsHtml = `<button class="pill" data-act="resume" data-id="${activity.id}">Resume</button>
        <button class="pill done-btn" data-act="complete" data-id="${activity.id}">Complete</button>`;
    } else {
      metaHtml = `<span class="t-meta">not started</span>`;
      actionsHtml = `<button class="pill" data-act="start" data-id="${activity.id}">Start</button>`;
    }
    if(opts.flexible){
      actionsHtml += `<input type="time" class="flex-time-input" data-flex-schedule="${activity.id}" title="Schedule this for a specific time today">`;
    }
    const editBtn = activity.locked
      ? `<span class="lock-badge" title="Core Practice — always available, cannot be deleted">🔒 Core</span>`
      : `<button class="edit-icon-btn activity-edit-btn" data-id="${activity.id}" title="Edit activity">✎</button>`;
    return `<div class="item-row activity-row" data-activity="${activity.id}">
      <div class="row-flex">
        <span class="item-title"><span class="activity-dot" style="background:${color}"></span>${activity.icon?escapeHtml(activity.icon)+' ':''}${escapeHtml(activity.name)}</span>
        <button class="edit-icon-btn" data-journal-note="${escapeHtml(activity.name)}" title="Add journal note">📝</button>
        ${editBtn}
      </div>
      <div class="item-sub">${timeLabel} · ${categoryLabel(activity.category)} · ${priorityLabel(activity.priority)}</div>
      <div class="task-list">
        <div class="task-item ${entry.status==='done'?'done':''}">
          <div class="t-left"><span class="dot"></span><span class="t-label">${escapeHtml(activity.description||'')||'&nbsp;'}</span></div>
          <div style="display:flex;align-items:center;gap:8px;">${metaHtml}${actionsHtml}</div>
        </div>
      </div>
    </div>`;
  }

  function wireActivityRowActions(container){
    container.querySelectorAll('[data-act="start"], [data-act="resume"]').forEach(b=>{
      b.addEventListener('click', ()=>startActivityTimer(b.dataset.id));
    });
    container.querySelectorAll('[data-act="pause"]').forEach(b=>{
      b.addEventListener('click', ()=>pauseActivityTimer(b.dataset.id));
    });
    container.querySelectorAll('[data-act="complete"]').forEach(b=>{
      b.addEventListener('click', ()=>completeActivityTimer(b.dataset.id));
    });
    container.querySelectorAll('.activity-edit-btn').forEach(b=>{
      b.addEventListener('click', (ev)=>{ ev.stopPropagation(); openActivityEditor(b.dataset.id); });
    });
    container.querySelectorAll('[data-journal-note]').forEach(b=>{
      b.addEventListener('click', (ev)=>{ ev.stopPropagation(); openJournalNoteFor(b.dataset.journalNote); });
    });
    container.querySelectorAll('[data-flex-schedule]').forEach(inp=>{
      inp.addEventListener('change', ()=>{
        if(!inp.value) return;
        updateActivity(inp.dataset.flexSchedule, { schedule: { startTime: inp.value } });
        refreshActivityViews();
      });
    });
  }

  function renderTodaySchedule(){
    const listEl = document.getElementById('todayScheduleList');
    if(!listEl) return;
    const flexEl = document.getElementById('todayFlexibleList');
    const flexWrap = document.getElementById('todayFlexibleWrap');
    const t = todayStr();
    const due = getActivitiesDueOn(t);
    const timed = sortActivitiesForDisplay(due.filter(a=>a.schedule && a.schedule.startTime));
    const flexible = due.filter(a=>!a.schedule || !a.schedule.startTime);

    if(timed.length===0){
      listEl.innerHTML = '<div class="card-list"><div class="item-row"><span class="empty-note">No scheduled activities for today yet — tap "+ add activity" or open the Routine tab.</span></div></div>';
    } else {
      listEl.innerHTML = '<div class="card-list">' + timed.map(a=>renderActivityRow(a, t)).join('') + '</div>';
    }
    wireActivityRowActions(listEl);

    if(flexible.length===0){
      flexWrap.style.display = 'none';
    } else {
      flexWrap.style.display = '';
      flexEl.innerHTML = '<div class="card-list">' + flexible.map(a=>renderActivityRow(a, t, {flexible:true})).join('') + '</div>';
      wireActivityRowActions(flexEl);
    }

    renderTodayCompletionBanner(due, t);
  }

  function renderTodayCompletionBanner(dueActivities, dateStr){
    const el = document.getElementById('todayCompletionBanner');
    if(!el) return;
    const day = data.logs[dateStr];
    const timed = dueActivities.filter(a=>a.schedule && a.schedule.startTime);
    if(timed.length===0){ el.innerHTML=''; el.style.display='none'; return; }
    const doneCount = timed.filter(a=> day && day.activities && day.activities[a.id] && day.activities[a.id].status==='done').length;
    if(doneCount < timed.length){ el.innerHTML=''; el.style.display='none'; return; }
    let totalSeconds = 0, longest = null;
    timed.forEach(a=>{
      const e = day.activities[a.id];
      totalSeconds += e.seconds||0;
      if(!longest || (e.seconds||0) > longest.seconds) longest = {name:a.name, seconds:e.seconds||0};
    });
    el.style.display = '';
    el.innerHTML = `<div class="completion-banner">
      <div class="completion-title">✨ Today's Routine Complete</div>
      <div class="completion-sub">You completed ${doneCount} of ${timed.length} planned activities.</div>
      <div class="completion-stats">
        <span>${fmtShort(totalSeconds)} focused time</span>
        ${longest ? `<span>Longest: ${escapeHtml(longest.name)} (${fmtShort(longest.seconds)})</span>` : ''}
      </div>
    </div>`;
  }

  /* ---------- Add / Edit Activity panel (Quick Add + Detailed) ---------- */
  function initActivityPanelStatic(){
    const catSel = document.getElementById('actCategory');
    catSel.innerHTML = ACTIVITY_CATEGORIES.map(c=>`<option value="${c.key}">${escapeHtml(c.label)}</option>`).join('');

    const swatchWrap = document.getElementById('actColorSwatches');
    const swatchColors = [null, ...ACTIVITY_CATEGORIES.map(c=>c.color)];
    swatchWrap.innerHTML = swatchColors.map(c=>
      `<button type="button" class="color-swatch${c?'':' auto'}" data-color="${c||''}" style="${c?'background:'+c+';':''}" title="${c?c:'Match category color'}">${c?'':'auto'}</button>`
    ).join('');
    swatchWrap.querySelectorAll('.color-swatch').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        swatchWrap.querySelectorAll('.color-swatch').forEach(b=>b.classList.remove('selected'));
        btn.classList.add('selected');
        swatchWrap.dataset.selected = btn.dataset.color;
      });
    });

    const dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    document.getElementById('actDayPicker').innerHTML = dayLabels.map((d,i)=>
      `<label class="day-chip"><input type="checkbox" value="${i}">${d}</label>`
    ).join('');

    const sugWrap = document.getElementById('activitySuggestions');
    sugWrap.innerHTML = ACTIVITY_SUGGESTIONS.map(s=>
      `<button type="button" class="suggestion-chip" data-name="${escapeHtml(s.name)}" data-icon="${s.icon}" data-category="${s.category}" data-duration="${s.durationMin}">${s.icon} ${escapeHtml(s.name)}</button>`
    ).join('');
    sugWrap.querySelectorAll('.suggestion-chip').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        document.getElementById('actName').value = btn.dataset.name;
        document.getElementById('actIcon').value = btn.dataset.icon;
        document.getElementById('actCategory').value = btn.dataset.category;
        document.getElementById('actDuration').value = btn.dataset.duration;
      });
    });

    document.getElementById('actFrequencyFields').addEventListener('change', ()=>{
      const checked = document.querySelector('input[name="actFreq"]:checked');
      document.getElementById('actDayPicker').style.display = (checked && checked.value==='custom') ? '' : 'none';
    });

    document.querySelectorAll('#activityModeTabs .auth-tab').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        document.querySelectorAll('#activityModeTabs .auth-tab').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        const detailed = btn.dataset.mode==='detailed';
        document.getElementById('actDetailedFields').style.display = detailed ? '' : 'none';
        document.getElementById('actFrequencyFields').style.display = detailed ? '' : 'none';
        document.getElementById('activitySuggestions').style.display = detailed ? 'none' : '';
      });
    });
  }
  initActivityPanelStatic();

  function setActivityMode(mode){
    const btn = document.querySelector(`#activityModeTabs .auth-tab[data-mode="${mode}"]`);
    if(btn) btn.click();
  }

  function resetActivityForm(){
    document.getElementById('actEditId').value = '';
    document.getElementById('actName').value = '';
    document.getElementById('actName').disabled = false;
    document.getElementById('actDescription').value = '';
    document.getElementById('actIcon').value = '';
    document.getElementById('actCategory').value = 'personal';
    document.getElementById('actPriority').value = 'medium';
    document.getElementById('actStartTime').value = '';
    document.getElementById('actDuration').value = '30';
    document.getElementById('actReminder').value = '';
    document.querySelectorAll('input[name="actFreq"]').forEach(r=> r.checked = (r.value==='daily'));
    document.querySelectorAll('#actDayPicker input').forEach(cb=>cb.checked=false);
    document.getElementById('actDayPicker').style.display = 'none';
    document.getElementById('actColorSwatches').querySelectorAll('.color-swatch').forEach(b=>b.classList.remove('selected'));
    document.getElementById('actColorSwatches').dataset.selected = '';
    document.getElementById('actDetailedFields').querySelectorAll('input,select,textarea').forEach(el=> el.disabled = false);
    document.getElementById('actDuplicate').style.display = 'none';
    document.getElementById('actDelete').style.display = 'none';
    document.getElementById('actSave').textContent = 'Add to Routine';
    document.getElementById('activityPanelTitle').textContent = 'Add Activity';
  }

  function openAddActivityPanel(prefill){
    resetActivityForm();
    setActivityMode('quick');
    if(prefill && prefill.startTime) document.getElementById('actStartTime').value = prefill.startTime;
    document.getElementById('activityPanel').classList.add('open');
    setTimeout(()=>document.getElementById('actName').focus(), 50);
  }

  function openActivityEditor(id){
    const a = data.activities.find(x=>x.id===id);
    if(!a) return;
    resetActivityForm();
    setActivityMode('detailed');
    document.getElementById('actEditId').value = a.id;
    document.getElementById('actName').value = a.name;
    document.getElementById('actDescription').value = a.description||'';
    document.getElementById('actIcon').value = a.icon||'';
    document.getElementById('actCategory').value = a.category||'personal';
    document.getElementById('actPriority').value = a.priority||'medium';
    document.getElementById('actStartTime').value = (a.schedule&&a.schedule.startTime)||'';
    document.getElementById('actDuration').value = a.durationMin||30;
    document.getElementById('actReminder').value = a.reminderTime||'';
    const freq = (a.schedule&&a.schedule.frequency)||'daily';
    document.querySelectorAll('input[name="actFreq"]').forEach(r=> r.checked = (r.value===freq));
    document.getElementById('actDayPicker').style.display = (freq==='custom') ? '' : 'none';
    const days = (a.schedule&&a.schedule.days)||[];
    document.querySelectorAll('#actDayPicker input').forEach(cb=> cb.checked = days.includes(+cb.value));
    if(a.color){
      const swatch = document.querySelector(`#actColorSwatches .color-swatch[data-color="${a.color}"]`);
      if(swatch) swatch.classList.add('selected');
      document.getElementById('actColorSwatches').dataset.selected = a.color;
    }
    document.getElementById('actSave').textContent = 'Save Changes';
    document.getElementById('activityPanelTitle').textContent = a.locked ? 'Edit Core Practice time' : 'Edit Activity';
    if(!a.locked){
      document.getElementById('actDuplicate').style.display = '';
      document.getElementById('actDelete').style.display = '';
    } else {
      // Core practices keep their name/category/etc. — only time, duration
      // and frequency are editable from here, per the "Core Practice" rule.
      document.getElementById('actName').disabled = true;
      document.getElementById('actDetailedFields').querySelectorAll('input,select,textarea').forEach(el=> el.disabled = true);
    }
    document.getElementById('activityPanel').classList.add('open');
  }

  function closeActivityPanel(){
    document.getElementById('activityPanel').classList.remove('open');
  }
  document.getElementById('activityPanelClose').addEventListener('click', closeActivityPanel);
  document.getElementById('actCancel').addEventListener('click', closeActivityPanel);
  document.getElementById('addActivityFab').addEventListener('click', ()=> openAddActivityPanel());
  document.getElementById('actReminderClear').addEventListener('click', ()=>{ document.getElementById('actReminder').value = ''; });

  document.getElementById('actDelete').addEventListener('click', ()=>{
    const id = document.getElementById('actEditId').value;
    if(!id) return;
    if(!confirm('Delete this activity? This cannot be undone.')) return;
    deleteActivity(id);
    closeActivityPanel();
    refreshActivityViews();
  });
  document.getElementById('actDuplicate').addEventListener('click', ()=>{
    const id = document.getElementById('actEditId').value;
    if(!id) return;
    duplicateActivity(id, {name: (data.activities.find(a=>a.id===id)||{}).name + ' (copy)'});
    closeActivityPanel();
    refreshActivityViews();
  });

  document.getElementById('activityForm').addEventListener('submit', (e)=>{
    e.preventDefault();
    const editId = document.getElementById('actEditId').value;
    const existing = editId ? data.activities.find(a=>a.id===editId) : null;

    const reminderTime = document.getElementById('actReminder').value || null;

    if(existing && existing.locked){
      const startTimeRaw = document.getElementById('actStartTime').value;
      const duration = Math.max(5, parseInt(document.getElementById('actDuration').value,10) || existing.durationMin || 30);
      updateActivity(editId, { durationMin: duration, reminderTime, schedule: { startTime: startTimeRaw || null } });
      if(reminderTime) ensureNotificationPermission();
      closeActivityPanel();
      refreshActivityViews();
      return;
    }

    const name = document.getElementById('actName').value.trim();
    if(!name) return;
    const startTimeRaw = document.getElementById('actStartTime').value;
    const duration = Math.max(5, parseInt(document.getElementById('actDuration').value,10) || 30);
    const freqEl = document.querySelector('input[name="actFreq"]:checked');
    const freq = freqEl ? freqEl.value : 'daily';
    const days = freq==='custom' ? Array.from(document.querySelectorAll('#actDayPicker input:checked')).map(cb=>+cb.value) : [];
    const selectedColor = document.getElementById('actColorSwatches').dataset.selected || null;
    const fields = {
      name,
      description: document.getElementById('actDescription').value.trim(),
      icon: document.getElementById('actIcon').value.trim() || '✦',
      category: document.getElementById('actCategory').value || 'personal',
      priority: document.getElementById('actPriority').value || 'medium',
      color: selectedColor,
      durationMin: duration,
      reminderTime,
      schedule: { startTime: startTimeRaw || null, endTime:null, frequency: freq, days }
    };
    if(editId){
      updateActivity(editId, fields);
    } else {
      createActivity(fields);
    }
    if(reminderTime) ensureNotificationPermission();
    closeActivityPanel();
    refreshActivityViews();
  });

  /* ======================================================================
     Routine tab: visual daily/weekly/overview timeline, drag-and-drop
     scheduling, conflict detection, missed-activity handling, templates
     and analytics — all built on the same activity model and block data
     above. Mandatory Japa/Practice sessions are represented as blocks
     computed live from data.japa/data.practice (never duplicated into
     data.activities); Reading/Learning have no time-of-day concept in the
     existing app, so they stay in a pinned summary strip instead of being
     forced onto the timeline.
     Simplifications vs. the full brief (documented in BRD.md): the Weekly
     view is click-to-jump-and-edit rather than true drag-across-days, and
     there is no dedicated multi-year Insights tab — analytics here cover
     the current day only.
     ====================================================================== */
  const TIMELINE_START_HOUR = 4;
  const TIMELINE_END_HOUR = 24;
  const PX_PER_MIN = 1;
  const DEFAULT_SANDHYA_TIME = { morning:'06:00', afternoon:'13:00', evening:'18:00' };
  let routineSnapMin = 15;
  let routineView = 'daily';
  let routineDayOffset = 0;
  let routineHeaderBuilt = false;
  let routineNowInterval = null;

  function routineDateForOffset(offset){
    const d = new Date();
    d.setDate(d.getDate()+offset);
    return todayStr(d);
  }

  function getMandatoryTimeInfo(kind, sandhya){
    const rec = data.mandatorySchedule[kind] && data.mandatorySchedule[kind][sandhya];
    return { time: (rec && rec.time) || DEFAULT_SANDHYA_TIME[sandhya], durationMin: (rec && rec.durationMin) || 30, reminderTime: (rec && rec.reminderTime) || '' };
  }
  function setMandatoryTimeInfo(kind, sandhya, patch){
    if(!data.mandatorySchedule[kind]) data.mandatorySchedule[kind] = {};
    data.mandatorySchedule[kind][sandhya] = Object.assign({}, getMandatoryTimeInfo(kind, sandhya), patch);
    save();
  }

  function getMandatoryBlocksForDate(dateStr){
    const blocks = [];
    const day = data.logs[dateStr];
    [['japa', data.japa], ['practice', data.practice]].forEach(([kind, list])=>{
      list.forEach(item=>{
        // Same reasoning as isActivityDueOn(): a counter can't have been
        // due before it existed, or the dashboard would show it as missed
        // for every past day retroactively. Counters from before this
        // field existed have no createdAt and are treated as always due.
        if(item.createdAt && dateStr < todayStr(new Date(item.createdAt))) return;
        (item.sandhyas||[]).forEach(sandhya=>{
          if(sandhya==='any') return; // no time-of-day concept for sandhya-not-applicable items
          const info = getMandatoryTimeInfo(kind, sandhya);
          const bucket = day && day[kind] && day[kind][item.id] && day[kind][item.id][sandhya];
          const seconds = bucket ? (bucket.seconds||0) : 0;
          const runningKey = item.id+'|'+sandhya;
          blocks.push({
            key: kind+':'+item.id+':'+sandhya,
            kind:'mandatory', subtype:kind, refId:item.id, sandhya,
            name:item.name, icon: kind==='japa' ? '📿' : '🧘',
            color: kind==='japa' ? '#B8863B' : '#66805A',
            startTime: info.time,
            durationMin: Math.max(15, seconds>0 ? Math.round(seconds/60) : info.durationMin),
            locked:true, running: !!runningTimers[runningKey], seconds,
            done: seconds>0 && !runningTimers[runningKey],
            reminderTime: info.reminderTime
          });
        });
      });
    });
    return blocks;
  }

  function getCustomBlocksForDate(dateStr){
    const day = data.logs[dateStr];
    return getActivitiesDueOn(dateStr).filter(a=>a.schedule && a.schedule.startTime).map(a=>{
      const entry = day && day.activities && day.activities[a.id];
      const key = 'activity|'+a.id;
      return {
        key:'activity:'+a.id,
        kind:'custom', subtype:'activity', refId:a.id,
        name:a.name, icon:a.icon||'✦', color:a.color||categoryColor(a.category),
        startTime:a.schedule.startTime, durationMin:a.durationMin||30,
        locked:false, priority:a.priority,
        running: !!runningTimers[key], seconds: entry ? (entry.seconds||0) : 0,
        status: entry ? entry.status : 'pending',
        done: !!(entry && entry.status==='done')
      };
    });
  }

  function markConflicts(blocks){
    const timed = blocks.filter(b=>b.startTime!=null).sort((a,b)=>timeToMin(a.startTime)-timeToMin(b.startTime));
    timed.forEach(b=>{ b.conflict=false; b.conflictNames=[]; });
    for(let i=0;i<timed.length;i++){
      for(let j=i+1;j<timed.length;j++){
        const aStart=timeToMin(timed[i].startTime), aEnd=aStart+timed[i].durationMin;
        const bStart=timeToMin(timed[j].startTime), bEnd=bStart+timed[j].durationMin;
        if(aStart<bEnd && bStart<aEnd){
          timed[i].conflict=true; timed[i].conflictNames.push(timed[j].name);
          timed[j].conflict=true; timed[j].conflictNames.push(timed[i].name);
        }
      }
    }
    return blocks;
  }

  // Assigns each timed block a column (b._col) and how many columns its
  // overlap cluster needs (b._cols), so overlapping blocks render
  // side-by-side (like a calendar app) instead of fully covering each
  // other and swallowing clicks.
  function layoutBlocksForOverlap(blocks){
    const timed = blocks.filter(b=>b.startTime!=null).sort((a,b)=>timeToMin(a.startTime)-timeToMin(b.startTime) || (a.durationMin-b.durationMin));
    let active = [];
    let cluster = [];
    timed.forEach(b=>{
      const startMin = timeToMin(b.startTime), endMin = startMin+b.durationMin;
      active = active.filter(a=>a.endMin>startMin);
      if(active.length===0 && cluster.length){
        finishCluster(cluster);
        cluster = [];
      }
      const usedCols = new Set(active.map(a=>a.col));
      let col = 0; while(usedCols.has(col)) col++;
      active.push({col, endMin});
      b._col = col;
      cluster.push(b);
    });
    if(cluster.length) finishCluster(cluster);
    function finishCluster(list){
      const maxCols = Math.max(...list.map(b=>b._col)) + 1;
      list.forEach(b=>{ b._cols = maxCols; });
    }
    return blocks;
  }

  function getAllBlocksForDate(dateStr){
    const blocks = markConflicts([...getMandatoryBlocksForDate(dateStr), ...getCustomBlocksForDate(dateStr)]);
    layoutBlocksForOverlap(blocks);
    return blocks;
  }

  function isActivityMissed(block, dateStr){
    if(dateStr !== todayStr() || block.kind!=='custom' || block.done || block.running || block.status==='skipped') return false;
    const nowMin = new Date().getHours()*60 + new Date().getMinutes();
    return nowMin > (timeToMin(block.startTime) + block.durationMin);
  }

  function markActivitySkipped(id, dateStr){
    const entry = ensureActivityEntry(dateStr||todayStr(), id);
    entry.status = 'skipped';
    save();
  }
  function moveActivityToTomorrow(id){
    const a = data.activities.find(x=>x.id===id);
    if(!a) return;
    markActivitySkipped(id, todayStr());
    const tomorrow = routineDateForOffset(1);
    if(!isActivityDueOn(a, tomorrow)){
      const dow = new Date(tomorrow+'T00:00:00').getDay();
      const days = Array.from(new Set([...(a.schedule.days||[]), dow]));
      updateActivity(id, { schedule:{ frequency:'custom', days } });
    } else {
      save();
    }
  }
  function convertActivityToFlexible(id){
    updateActivity(id, { schedule:{ startTime:null } });
  }

  function frequencyLabel(schedule){
    if(!schedule || !schedule.frequency || schedule.frequency==='daily') return 'Every day';
    if(schedule.frequency==='weekdays') return 'Weekdays only';
    if(schedule.frequency==='weekends') return 'Weekends only';
    if(schedule.frequency==='custom'){
      const names=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      return (schedule.days||[]).slice().sort().map(d=>names[d]).join(', ') || 'Custom (no days selected)';
    }
    return 'Every day';
  }

  // Shared Morning/Afternoon/Evening/Night bucketing, used by the Routine
  // Overview and the Calendar Dashboard so both group activities the same
  // way. A block with no fixed time falls into 'Flexible' rather than
  // being guessed into a time bucket.
  function bucketForStartTime(startTime){
    if(startTime==null) return 'Flexible';
    const m = timeToMin(startTime);
    if(m < 12*60) return 'Morning';
    if(m < 17*60) return 'Afternoon';
    if(m < 21*60) return 'Evening';
    return 'Night';
  }
  const BUCKET_ICON = { Morning:'🌅', Afternoon:'☀️', Evening:'🌆', Night:'🌙', Flexible:'✦' };

  // Classifies a block's status on a given date — used for read-only
  // reporting (Calendar Dashboard). This is deliberately separate from
  // isActivityMissed(), which drives *actionable* missed-activity UI and
  // only ever applies to today; a dashboard looking at a past date needs
  // "overdue" (never completed, day is over) without offering Start/Skip
  // buttons for a day that's already gone.
  function computeBlockStatus(block, dateStr){
    if(block.done) return 'done';
    if(block.running) return 'in-progress';
    const today = todayStr();
    if(dateStr > today) return 'pending';
    if(dateStr < today) return block.startTime!=null || block.kind==='mandatory' ? 'overdue' : 'pending';
    if(block.startTime==null) return 'pending';
    const nowMin = new Date().getHours()*60 + new Date().getMinutes();
    return nowMin > (timeToMin(block.startTime)+block.durationMin) ? 'overdue' : 'pending';
  }

  function ensureRoutineTabDom(){
    if(routineHeaderBuilt) return;
    const root = document.getElementById('tab-routine');
    root.innerHTML = `
      <div class="routine-toolbar">
        <div class="routine-template-bar">
          <select id="routineTemplateSelect"></select>
          <button class="icon-btn" id="routineTemplateRenameBtn" title="Rename template" style="display:none;">✎</button>
          <button class="icon-btn" id="routineTemplateDuplicateBtn" title="Duplicate template" style="display:none;">⧉</button>
          <button class="icon-btn" id="routineTemplateDeleteBtn" title="Delete template" style="display:none;">🗑</button>
          <button class="pill ghost" id="routineTemplateNewBtn">+ Save as template</button>
        </div>
        <div class="cal-tabbar" id="routineViewTabs">
          <button class="cal-tab on" data-view="daily">Daily</button>
          <button class="cal-tab" data-view="weekly">Weekly</button>
          <button class="cal-tab" data-view="overview">Overview</button>
        </div>
      </div>

      <div class="routine-analytics" id="routineAnalytics"></div>
      <div class="mandatory-pinned-strip" id="mandatoryPinnedStrip"></div>

      <div id="routineDailyView">
        <div class="cal-nav">
          <button id="routineDayPrev">‹</button>
          <h3 id="routineDayLabel"></h3>
          <button id="routineDayNext">›</button>
        </div>
        <div class="snap-control">
          <span>Snap</span>
          <button class="snap-btn on" data-snap="15">15m</button>
          <button class="snap-btn" data-snap="30">30m</button>
          <button class="snap-btn" data-snap="60">1h</button>
        </div>
        <div class="timeline-wrap" id="timelineWrap">
          <div class="timeline-inner" id="timelineInner">
            <div class="timeline-hours" id="timelineHours"></div>
            <div class="timeline-track" id="timelineTrack"></div>
          </div>
        </div>
        <div class="routine-flexible-panel" id="routineFlexiblePanel">
          <div class="item-sub" style="margin-bottom:8px;">Flexible Activities <span class="empty-note">— drag onto the timeline, or pick a time</span></div>
          <div id="routineFlexibleList" class="flexible-dropzone"></div>
        </div>
      </div>

      <div id="routineWeeklyView" style="display:none;">
        <div class="weekly-grid" id="weeklyGrid"></div>
      </div>

      <div id="routineOverviewView" style="display:none;">
        <div class="overview-groups" id="overviewGroups"></div>
      </div>

      <div class="routine-expand-panel" id="routineExpandPanel" style="display:none;"></div>
    `;

    const hoursEl = document.getElementById('timelineHours');
    const trackEl = document.getElementById('timelineTrack');
    const totalMin = (TIMELINE_END_HOUR-TIMELINE_START_HOUR)*60;
    trackEl.style.height = (totalMin*PX_PER_MIN)+'px';
    hoursEl.style.height = (totalMin*PX_PER_MIN)+'px';
    let hoursHtml = '', gridHtml = '';
    for(let h=TIMELINE_START_HOUR; h<TIMELINE_END_HOUR; h++){
      const top = (h-TIMELINE_START_HOUR)*60*PX_PER_MIN;
      const label = h===0?'12 AM': h<12?h+' AM': h===12?'12 PM':(h-12)+' PM';
      hoursHtml += `<div class="hour-label" style="top:${top}px">${label}</div>`;
      gridHtml += `<div class="hour-line" style="top:${top}px"></div>`;
    }
    hoursEl.innerHTML = hoursHtml;
    trackEl.insertAdjacentHTML('beforeend', gridHtml + '<div class="timeline-now-line" id="timelineNowLine"><span class="now-badge"></span></div>');

    trackEl.addEventListener('dragover', ev=> ev.preventDefault());
    trackEl.addEventListener('drop', ev=>{
      ev.preventDefault();
      const id = ev.dataTransfer.getData('text/plain');
      if(!id) return;
      const rect = trackEl.getBoundingClientRect();
      const y = ev.clientY - rect.top;
      const minutes = TIMELINE_START_HOUR*60 + Math.round((y/PX_PER_MIN)/routineSnapMin)*routineSnapMin;
      updateActivity(id, { schedule:{ startTime: minToTime(minutes) } });
      renderRoutineTab();
    });

    document.querySelectorAll('#routineViewTabs .cal-tab').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        document.querySelectorAll('#routineViewTabs .cal-tab').forEach(b=>b.classList.remove('on'));
        btn.classList.add('on');
        routineView = btn.dataset.view;
        renderRoutineTab();
      });
    });
    document.getElementById('routineDayPrev').addEventListener('click', ()=>{ routineDayOffset--; renderRoutineTab(); });
    document.getElementById('routineDayNext').addEventListener('click', ()=>{ routineDayOffset++; renderRoutineTab(); });
    document.querySelectorAll('.snap-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        routineSnapMin = +btn.dataset.snap;
        document.querySelectorAll('.snap-btn').forEach(b=>b.classList.remove('on'));
        btn.classList.add('on');
      });
    });

    document.getElementById('routineTemplateNewBtn').addEventListener('click', createTemplateFlow);
    document.getElementById('routineTemplateSelect').addEventListener('change', e=> onTemplateSelected(e.target.value));
    document.getElementById('routineTemplateRenameBtn').addEventListener('click', renameActiveTemplate);
    document.getElementById('routineTemplateDuplicateBtn').addEventListener('click', duplicateActiveTemplate);
    document.getElementById('routineTemplateDeleteBtn').addEventListener('click', deleteActiveTemplate);

    if(!routineNowInterval) routineNowInterval = setInterval(tickRoutineNowLine, 30000);
    routineHeaderBuilt = true;
  }

  function tickRoutineNowLine(){
    const line = document.getElementById('timelineNowLine');
    if(!line) return;
    const now = new Date();
    const nowMin = now.getHours()*60 + now.getMinutes();
    if(routineDayOffset!==0 || nowMin < TIMELINE_START_HOUR*60 || nowMin >= TIMELINE_END_HOUR*60){
      line.style.display = 'none';
    } else {
      line.style.display = '';
      line.style.top = ((nowMin-TIMELINE_START_HOUR*60)*PX_PER_MIN)+'px';
      line.querySelector('.now-badge').textContent = 'NOW · '+now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    }
    document.querySelectorAll('.timeline-block.live .block-live span').forEach(span=>{
      const blockEl = span.closest('.timeline-block');
      if(!blockEl) return;
      const key = blockEl.dataset.key;
      const rtKey = key.startsWith('activity:') ? 'activity|'+key.slice(9) : (()=>{ const p=key.split(':'); return p[1]+'|'+p[2]; })();
      const rt = runningTimers[rtKey];
      if(rt) span.textContent = fmtTime((Date.now()-rt.startTime)/1000);
    });
  }

  function renderRoutineTab(){
    ensureRoutineTabDom();
    renderTemplateSelect();
    renderMandatoryPinnedStrip();
    document.getElementById('routineDailyView').style.display = routineView==='daily' ? '' : 'none';
    document.getElementById('routineWeeklyView').style.display = routineView==='weekly' ? '' : 'none';
    document.getElementById('routineOverviewView').style.display = routineView==='overview' ? '' : 'none';
    document.getElementById('routineExpandPanel').style.display = 'none';
    if(routineView==='daily') renderRoutineDaily();
    if(routineView==='weekly') renderRoutineWeekly();
    if(routineView==='overview') renderRoutineOverview();
  }

  function renderMandatoryPinnedStrip(){
    const el = document.getElementById('mandatoryPinnedStrip');
    const t = todayStr();
    const day = data.logs[t];
    const readingLoggedToday = data.books.length>0 && data.books.some(b=>((day && day.reading && day.reading[b.id])||0) > 0);
    const totalMilestones = data.learning.reduce((n,tr)=>n+tr.milestones.length,0);
    const doneMilestones = data.learning.reduce((n,tr)=>n+tr.milestones.filter(m=>m.done).length,0);
    el.innerHTML = `
      <div class="pinned-label">Mandatory Practices <span class="lock-badge">🔒 Core</span></div>
      <div class="pinned-grid">
        <div class="pinned-chip">📿 Japa <span class="pinned-note">on timeline below</span></div>
        <div class="pinned-chip">🧘 Practice <span class="pinned-note">on timeline below</span></div>
        <div class="pinned-chip">📖 Reading <span class="pinned-note">${data.books.length===0?'no books yet':(readingLoggedToday?'logged today':'not logged today')}</span></div>
        <div class="pinned-chip">🎓 Learning <span class="pinned-note">${totalMilestones? doneMilestones+'/'+totalMilestones+' milestones':'no milestones yet'}</span></div>
      </div>`;
  }

  function renderRoutineDaily(){
    const dateStr = routineDateForOffset(routineDayOffset);
    const label = routineDayOffset===0 ? 'Today' : new Date(dateStr+'T00:00:00').toLocaleDateString('en-US',{weekday:'long', month:'short', day:'numeric'});
    document.getElementById('routineDayLabel').textContent = label;

    const blocks = getAllBlocksForDate(dateStr);
    const track = document.getElementById('timelineTrack');
    track.querySelectorAll('.timeline-block').forEach(n=>n.remove());

    blocks.forEach(b=>{
      const top = (timeToMin(b.startTime) - TIMELINE_START_HOUR*60) * PX_PER_MIN;
      if(top < 0 || top > (TIMELINE_END_HOUR-TIMELINE_START_HOUR)*60*PX_PER_MIN) return;
      const height = Math.max(18, b.durationMin*PX_PER_MIN);
      const div = document.createElement('div');
      div.className = 'timeline-block'+(b.locked?' locked':'')+(b.conflict?' conflict':'')+(b.running?' live':'')+(b.done?' done':'');
      const cols = b._cols || 1, col = b._col || 0;
      div.style.top = top+'px';
      div.style.height = height+'px';
      div.style.left = `calc(${(col/cols)*100}% + 4px)`;
      div.style.width = `calc(${(1/cols)*100}% - ${cols>1?6:12}px)`;
      div.style.borderLeftColor = b.color;
      div.dataset.key = b.key;
      const end = minToTime(timeToMin(b.startTime)+b.durationMin);
      div.innerHTML = `
        <div class="block-body">
          <div class="block-title">${b.icon} ${escapeHtml(b.name)}${b.locked?' <span class="mini-lock">🔒</span>':''}</div>
          <div class="block-time">${fmtTimeLabel(b.startTime)}${height>=32?' – '+fmtTimeLabel(end):''}</div>
          ${b.running ? `<div class="block-live">● RUNNING — <span>${fmtTime(b.seconds||0)}</span></div>` : ''}
          ${b.conflict ? `<div class="block-conflict">⚠ overlaps</div>` : ''}
        </div>
        <div class="resize-handle"></div>
      `;
      track.appendChild(div);
      div.querySelector('.block-body').addEventListener('click', ev=>{ ev.stopPropagation(); openBlockExpand(b, dateStr); });
      wireBlockDrag(div, b, dateStr);
      wireBlockResize(div, b, dateStr);
    });

    renderRoutineFlexible(dateStr);
    renderRoutineAnalytics(dateStr, blocks);
    tickRoutineNowLine();

    if(routineDayOffset===0){
      const wrap = document.getElementById('timelineWrap');
      const nowMin = new Date().getHours()*60+new Date().getMinutes();
      if(nowMin>=TIMELINE_START_HOUR*60 && nowMin<TIMELINE_END_HOUR*60){
        wrap.scrollTop = Math.max(0, (nowMin-TIMELINE_START_HOUR*60)*PX_PER_MIN - 120);
      }
    }
  }

  function wireBlockDrag(el, block, dateStr){
    const body = el.querySelector('.block-body');
    const DRAG_THRESHOLD_PX = 4; // below this, treat as a plain click (open the expand panel) rather than a drag
    let dragging=false, moved=false, startY=0, startTop=0;
    body.addEventListener('pointerdown', ev=>{
      if(ev.target.closest('.resize-handle')) return;
      dragging = true; moved = false; startY = ev.clientY; startTop = el.offsetTop;
      body.setPointerCapture(ev.pointerId);
    });
    body.addEventListener('pointermove', ev=>{
      if(!dragging) return;
      if(!moved && Math.abs(ev.clientY-startY) > DRAG_THRESHOLD_PX){
        moved = true;
        el.classList.add('dragging');
      }
      if(!moved) return;
      const track = document.getElementById('timelineTrack');
      let newTop = startTop + (ev.clientY - startY);
      newTop = Math.max(0, Math.min(newTop, track.clientHeight - el.offsetHeight));
      const snappedMin = Math.round((newTop/PX_PER_MIN)/routineSnapMin)*routineSnapMin;
      el.style.top = Math.max(0, snappedMin*PX_PER_MIN)+'px';
    });
    body.addEventListener('pointerup', ev=>{
      if(!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      if(!moved) return; // a plain click — let the click listener open the expand panel undisturbed
      const newStartMin = TIMELINE_START_HOUR*60 + Math.round(parseFloat(el.style.top)/PX_PER_MIN);
      applyBlockTimeChange(block, minToTime(newStartMin));
    });
  }

  function wireBlockResize(el, block, dateStr){
    const handle = el.querySelector('.resize-handle');
    let resizing=false, moved=false, startY=0, startHeight=0;
    handle.addEventListener('pointerdown', ev=>{
      ev.stopPropagation();
      resizing = true; moved = false; startY = ev.clientY; startHeight = el.offsetHeight;
      handle.setPointerCapture(ev.pointerId);
    });
    handle.addEventListener('pointermove', ev=>{
      if(!resizing) return;
      ev.stopPropagation();
      if(!moved && Math.abs(ev.clientY-startY) > 3){ moved = true; el.classList.add('resizing'); }
      if(!moved) return;
      let newHeight = Math.max(15*PX_PER_MIN, startHeight + (ev.clientY - startY));
      const snappedMin = Math.max(routineSnapMin, Math.round((newHeight/PX_PER_MIN)/routineSnapMin)*routineSnapMin);
      el.style.height = (snappedMin*PX_PER_MIN)+'px';
    });
    handle.addEventListener('pointerup', ev=>{
      if(!resizing) return;
      ev.stopPropagation();
      resizing = false;
      el.classList.remove('resizing');
      if(!moved) return;
      const newDurationMin = Math.max(5, Math.round(parseFloat(el.style.height)/PX_PER_MIN));
      applyBlockDurationChange(block, newDurationMin);
    });
  }

  function applyBlockTimeChange(block, newStartTime){
    if(block.kind==='mandatory') setMandatoryTimeInfo(block.subtype, block.sandhya, {time:newStartTime});
    else updateActivity(block.refId, { schedule:{ startTime:newStartTime } });
    renderRoutineTab();
  }
  function applyBlockDurationChange(block, newDurationMin){
    if(block.kind==='mandatory') setMandatoryTimeInfo(block.subtype, block.sandhya, {durationMin:newDurationMin});
    else updateActivity(block.refId, { durationMin:newDurationMin });
    renderRoutineTab();
  }

  function openBlockExpand(block, dateStr){
    const panel = document.getElementById('routineExpandPanel');
    const isToday = dateStr===todayStr();
    const missed = isToday && isActivityMissed(block, dateStr);
    const end = minToTime(timeToMin(block.startTime)+block.durationMin);

    let actionsHtml = '';
    if(!isToday){
      actionsHtml = '<span class="empty-note">Only today\'s activities can be started.</span>';
    } else if(block.kind==='mandatory'){
      if(block.subtype==='japa'){
        actionsHtml = `<button class="pill" data-block-act="start">Start</button>`;
      } else {
        actionsHtml = block.running
          ? `<button class="pill done-btn" data-block-act="complete">Done</button>`
          : `<button class="pill" data-block-act="start">Start</button>`;
      }
    } else if(missed){
      actionsHtml = `
        <button class="pill" data-block-act="complete">Mark Complete</button>
        <button class="pill ghost" data-block-act="skip">Skip Today</button>
        <button class="pill ghost" data-block-act="reschedule">Reschedule</button>
        <button class="pill ghost" data-block-act="tomorrow">Move to Tomorrow</button>
        <button class="pill ghost" data-block-act="flexible">Convert to Flexible</button>`;
    } else if(block.running){
      actionsHtml = `<button class="pill ghost" data-block-act="pause">Pause</button><button class="pill done-btn" data-block-act="complete">Complete</button>`;
    } else if(block.done){
      actionsHtml = `<span class="empty-note">Completed ✓ — ${fmtShort(block.seconds)}</span>`;
    } else if(block.seconds>0){
      actionsHtml = `<button class="pill" data-block-act="start">Resume</button><button class="pill done-btn" data-block-act="complete">Complete</button>`;
    } else {
      actionsHtml = `<button class="pill" data-block-act="start">Start</button>`;
    }

    let manageHtml = '';
    if(block.kind==='mandatory'){
      manageHtml = `
        <div class="mandatory-edit-row">
          <input type="time" class="mini-time-input" id="mtEditTime" value="${block.startTime}">
          <input type="number" class="mini-dur-input" id="mtEditDuration" min="5" step="5" value="${block.durationMin}">
          <span class="reminder-control"><span class="reminder-icon">🔔</span><input type="time" class="mini-time-input" id="mtEditReminder" value="${block.reminderTime||''}" title="Daily reminder"></span>
          <button class="pill ghost" data-block-act="save-mandatory-time">Save</button>
        </div>
        <span class="lock-badge">🔒 Core Practice — always available, cannot be deleted</span>`;
    } else {
      manageHtml = `
        <button class="pill ghost" data-block-act="edit">Edit</button>
        <button class="pill ghost" data-block-act="duplicate">Duplicate</button>
        <button class="pill ghost" data-block-act="delete">Delete</button>`;
    }

    const activityMeta = block.kind==='custom' ? data.activities.find(a=>a.id===block.refId) : null;

    panel.innerHTML = `
      <div class="expand-close-row"><button class="fs-close sheet-close" id="expandCloseBtn">✕</button></div>
      <div class="expand-title">${block.icon} ${escapeHtml(block.name)}</div>
      <div class="expand-meta">${fmtTimeLabel(block.startTime)} – ${fmtTimeLabel(end)} · planned ${fmtShort(block.durationMin*60)}</div>
      ${block.seconds>0 ? `<div class="expand-meta">Actual so far: ${fmtShort(block.seconds)}</div>` : ''}
      ${activityMeta && activityMeta.description ? `<div class="expand-desc">${escapeHtml(activityMeta.description)}</div>` : ''}
      ${activityMeta ? `<div class="expand-meta">${categoryLabel(activityMeta.category)} · ${priorityLabel(activityMeta.priority)} · ${frequencyLabel(activityMeta.schedule)}</div>` : ''}
      ${block.conflict ? `<div class="expand-conflict">⚠ Overlaps with ${escapeHtml(block.conflictNames.join(', '))}</div>` : ''}
      <div class="expand-actions">${actionsHtml}</div>
      <div class="expand-actions">${manageHtml}</div>
      <div class="expand-actions"><button class="pill ghost" id="expandJournalBtn">📝 Journal note</button></div>
    `;
    panel.style.display = '';
    panel.classList.remove('expand-in');
    void panel.offsetWidth;
    panel.classList.add('expand-in');

    document.getElementById('expandCloseBtn').addEventListener('click', ()=>{ panel.style.display='none'; });
    document.getElementById('expandJournalBtn').addEventListener('click', ()=>{
      panel.style.display = 'none';
      openJournalNoteFor(block.name);
    });
    panel.querySelectorAll('[data-block-act]').forEach(btn=>{
      btn.addEventListener('click', ()=> handleBlockAction(btn.dataset.blockAct, block, dateStr));
    });
  }

  function handleBlockAction(act, block, dateStr){
    const panel = document.getElementById('routineExpandPanel');
    const closeAndRefresh = ()=>{ panel.style.display='none'; renderRoutineTab(); };

    if(block.kind==='mandatory'){
      if(act==='start'){
        if(block.subtype==='japa'){ panel.style.display='none'; openJapaFullscreen(block.refId, block.sandhya); return; }
        startPractice(block.refId, block.sandhya); closeAndRefresh(); return;
      }
      if(act==='complete' && block.subtype==='practice'){ stopPractice(block.refId, block.sandhya); closeAndRefresh(); return; }
      if(act==='save-mandatory-time'){
        const time = document.getElementById('mtEditTime').value || block.startTime;
        const dur = Math.max(5, parseInt(document.getElementById('mtEditDuration').value,10) || block.durationMin);
        const reminderTime = document.getElementById('mtEditReminder').value || '';
        setMandatoryTimeInfo(block.subtype, block.sandhya, {time, durationMin:dur, reminderTime});
        if(reminderTime) ensureNotificationPermission();
        closeAndRefresh();
      }
      return;
    }

    const id = block.refId;
    if(act==='start'){ startActivityTimer(id); closeAndRefresh(); return; }
    if(act==='pause'){ pauseActivityTimer(id); closeAndRefresh(); return; }
    if(act==='complete'){ completeActivityTimer(id); closeAndRefresh(); return; }
    if(act==='skip'){ markActivitySkipped(id, dateStr); closeAndRefresh(); return; }
    if(act==='reschedule'){ panel.style.display='none'; openActivityEditor(id); return; }
    if(act==='tomorrow'){ moveActivityToTomorrow(id); closeAndRefresh(); return; }
    if(act==='flexible'){ convertActivityToFlexible(id); closeAndRefresh(); return; }
    if(act==='edit'){ panel.style.display='none'; openActivityEditor(id); return; }
    if(act==='duplicate'){ duplicateActivity(id); closeAndRefresh(); return; }
    if(act==='delete'){
      if(!confirm('Delete this activity? This cannot be undone.')) return;
      deleteActivity(id); closeAndRefresh(); return;
    }
  }

  function renderRoutineFlexible(dateStr){
    const listEl = document.getElementById('routineFlexibleList');
    const due = getActivitiesDueOn(dateStr).filter(a=>!a.schedule || !a.schedule.startTime);
    if(due.length===0){ listEl.innerHTML = '<span class="empty-note">No flexible activities for this day.</span>'; return; }
    listEl.innerHTML = due.map(a=>`
      <div class="flex-card" draggable="true" data-flex-id="${a.id}">
        <span>${a.icon||'✦'} ${escapeHtml(a.name)}</span>
        <input type="time" class="flex-time-input" data-flex-schedule="${a.id}" title="Schedule at this time">
      </div>`).join('');
    wireActivityRowActions(listEl);
    listEl.querySelectorAll('.flex-card').forEach(card=>{
      card.addEventListener('dragstart', ev=> ev.dataTransfer.setData('text/plain', card.dataset.flexId));
    });
  }

  function renderRoutineAnalytics(dateStr, blocks){
    const el = document.getElementById('routineAnalytics');
    const timed = blocks.filter(b=>b.startTime);
    const plannedSec = timed.reduce((n,b)=>n+b.durationMin*60,0);
    const completedSec = timed.reduce((n,b)=>n+(b.done ? Math.max(b.seconds,b.durationMin*60*0.001) : (b.seconds||0)),0);
    const remainingSec = Math.max(0, plannedSec-completedSec);

    const byCategory = {};
    timed.forEach(b=>{
      const cat = b.kind==='mandatory' ? 'Spiritual' : categoryLabel((data.activities.find(a=>a.id===b.refId)||{}).category);
      byCategory[cat] = (byCategory[cat]||0) + b.durationMin;
    });
    const maxCatMin = Math.max(1, ...Object.values(byCategory));

    el.innerHTML = `
      <div class="routine-stats-row">
        <div class="routine-stat"><div class="num">${fmtShort(plannedSec)}</div><div class="lbl">Scheduled</div></div>
        <div class="routine-stat"><div class="num">${fmtShort(completedSec)}</div><div class="lbl">Completed</div></div>
        <div class="routine-stat"><div class="num">${fmtShort(remainingSec)}</div><div class="lbl">Remaining</div></div>
      </div>
      ${Object.keys(byCategory).length ? `<div class="routine-balance">${Object.entries(byCategory).map(([cat,min])=>`
        <div class="balance-row">
          <span class="balance-label">${escapeHtml(cat)}</span>
          <div class="balance-bar"><i style="width:${Math.round(min/maxCatMin*100)}%"></i></div>
          <span class="balance-val">${fmtShort(min*60)}</span>
        </div>`).join('')}</div>` : ''}
    `;
  }

  function renderRoutineWeekly(){
    const grid = document.getElementById('weeklyGrid');
    const base = new Date();
    base.setDate(base.getDate() - base.getDay());
    const dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    let html = '';
    for(let i=0;i<7;i++){
      const d = new Date(base); d.setDate(base.getDate()+i);
      const dateStr = todayStr(d);
      const isToday = dateStr===todayStr();
      const dayBlocks = getAllBlocksForDate(dateStr).filter(b=>b.startTime).sort((a,b)=>timeToMin(a.startTime)-timeToMin(b.startTime));
      html += `<div class="weekly-col ${isToday?'today':''}" data-date="${dateStr}">
        <div class="weekly-col-head">${dayLabels[i]}<br><span class="weekly-date">${d.getDate()}</span></div>
        <div class="weekly-col-body">
          ${dayBlocks.length===0 ? '<div class="empty-note" style="font-size:11px;">Nothing scheduled</div>' : dayBlocks.map(b=>`
            <div class="weekly-chip" style="border-left-color:${b.color}" data-week-block="${b.key}" data-date="${dateStr}">
              <span class="weekly-chip-time">${fmtTimeLabel(b.startTime)}</span>
              <span class="weekly-chip-name">${b.icon} ${escapeHtml(b.name)}</span>
            </div>`).join('')}
        </div>
      </div>`;
    }
    grid.innerHTML = html;
    function jumpToDay(dateStr){
      routineDayOffset = Math.round((new Date(dateStr+'T00:00:00') - new Date(todayStr()+'T00:00:00'))/86400000);
      routineView = 'daily';
      document.querySelectorAll('#routineViewTabs .cal-tab').forEach(b=>b.classList.remove('on'));
      document.querySelector('#routineViewTabs .cal-tab[data-view="daily"]').classList.add('on');
      renderRoutineTab();
    }
    grid.querySelectorAll('.weekly-col-head').forEach(head=>{
      head.addEventListener('click', ()=> jumpToDay(head.closest('.weekly-col').dataset.date));
    });
    grid.querySelectorAll('.weekly-chip').forEach(chip=>{
      chip.addEventListener('click', ()=>{
        const dateStr = chip.dataset.date;
        jumpToDay(dateStr);
        setTimeout(()=>{
          const block = getAllBlocksForDate(dateStr).find(b=>b.key===chip.dataset.weekBlock);
          if(block) openBlockExpand(block, dateStr);
        }, 60);
      });
    });
  }

  function renderRoutineOverview(){
    const el = document.getElementById('overviewGroups');
    const dateStr = routineDateForOffset(routineDayOffset);
    const blocks = getAllBlocksForDate(dateStr).filter(b=>b.startTime).sort((a,b)=>timeToMin(a.startTime)-timeToMin(b.startTime));
    const buckets = { Morning:[], Afternoon:[], Evening:[], Night:[] };
    blocks.forEach(b=> buckets[bucketForStartTime(b.startTime)].push(b));
    const order = ['Morning','Afternoon','Evening','Night'];
    el.innerHTML = order.map((name,i)=>`
      <div class="overview-group">
        <div class="overview-group-title">${name}</div>
        <div class="overview-chain">
          ${buckets[name].length===0 ? '<span class="empty-note">Nothing planned</span>' :
            buckets[name].map(b=>`<span class="overview-chip" style="border-color:${b.color}">${b.icon} ${escapeHtml(b.name)}</span>`).join('<span class="overview-arrow">→</span>')}
        </div>
      </div>
      ${i<order.length-1 ? '<div class="overview-divider">↓</div>' : ''}
    `).join('');
  }

  /* ---------- Routine templates ---------- */
  function renderTemplateSelect(){
    const sel = document.getElementById('routineTemplateSelect');
    const opts = ['<option value="">No template (custom)</option>']
      .concat(data.templates.map(t=>`<option value="${t.id}">${escapeHtml(t.name)}</option>`))
      .concat(['<option value="" disabled>── Starter presets ──</option>'])
      .concat(ROUTINE_PRESETS.map((p,i)=>`<option value="preset:${i}">✨ ${escapeHtml(p.name)}</option>`));
    sel.innerHTML = opts.join('');
    sel.value = data.activeTemplateId || '';
    const isRealTemplate = data.templates.some(t=>t.id===data.activeTemplateId);
    ['routineTemplateRenameBtn','routineTemplateDuplicateBtn','routineTemplateDeleteBtn'].forEach(id=>{
      document.getElementById(id).style.display = isRealTemplate ? '' : 'none';
    });
  }

  function onTemplateSelected(value){
    if(!value){ data.activeTemplateId=null; save(); return; }
    if(value.startsWith('preset:')){
      const preset = ROUTINE_PRESETS[+value.slice(7)];
      if(!preset) return;
      if(confirm(`Add the "${preset.name}" preset activities to your routine? You can edit or remove any of them afterward.`)){
        preset.activities.forEach(a=> createActivity(Object.assign({}, a)));
        refreshActivityViews();
      }
      renderTemplateSelect();
      return;
    }
    if(!confirm('Switch to this template? This replaces your current custom activities with the template\'s saved set.')){
      renderTemplateSelect();
      return;
    }
    const tpl = data.templates.find(t=>t.id===value);
    if(!tpl) return;
    data.activities = tpl.activities.map(a=>Object.assign({}, a, {id:uid()}));
    data.activeTemplateId = value;
    save();
    refreshActivityViews();
  }

  function createTemplateFlow(){
    const name = prompt('Name this template (it saves your current custom activities):');
    if(!name || !name.trim()) return;
    const tpl = { id:uid(), name:name.trim(), activities: data.activities.map(a=>Object.assign({}, a)), createdAt:Date.now() };
    data.templates.push(tpl);
    data.activeTemplateId = tpl.id;
    save();
    renderTemplateSelect();
  }
  function renameActiveTemplate(){
    const tpl = data.templates.find(t=>t.id===data.activeTemplateId);
    if(!tpl) return;
    const name = prompt('Rename template:', tpl.name);
    if(!name || !name.trim()) return;
    tpl.name = name.trim();
    save();
    renderTemplateSelect();
  }
  function duplicateActiveTemplate(){
    const tpl = data.templates.find(t=>t.id===data.activeTemplateId);
    if(!tpl) return;
    const copy = { id:uid(), name: tpl.name+' (copy)', activities: tpl.activities.map(a=>Object.assign({}, a)), createdAt:Date.now() };
    data.templates.push(copy);
    data.activeTemplateId = copy.id;
    save();
    renderTemplateSelect();
  }
  function deleteActiveTemplate(){
    const tpl = data.templates.find(t=>t.id===data.activeTemplateId);
    if(!tpl) return;
    if(!confirm(`Delete template "${tpl.name}"? This does not remove activities already added to your routine.`)) return;
    data.templates = data.templates.filter(t=>t.id!==tpl.id);
    data.activeTemplateId = null;
    save();
    renderTemplateSelect();
  }

  /* ---------- Calendar (execution-calendar style: filterable blocks, ported from NSQF interactive calendar) ---------- */
  let calYear, calMonth; // 0-indexed month
  let calFilter = 'all';   // 'all' | 'japa' | 'practice' | 'reading' | 'learning'
  let calQuery = '';       // lowercase search text
  let calFocus = null;     // 'type|id' of a block currently traced across the month
  function initCalendarCursor(){
    const now = new Date();
    calYear = now.getFullYear(); calMonth = now.getMonth();
  }

  function dayHasActivity(dateStr, type){
    const day = data.logs[dateStr];
    if(!day) return false;
    if(type==='japa'){
      return Object.values(day.japa||{}).some(sMap=>Object.values(sMap).some(e=>e.count>0));
    }
    if(type==='practice'){
      return Object.values(day.practice||{}).some(sMap=>Object.values(sMap).some(e=>e.seconds>0));
    }
    if(type==='reading'){
      return Object.values(day.reading||{}).some(p=>p>0);
    }
    if(type==='learning'){
      return data.learning.some(t=>t.notes.some(n=>n.date===dateStr));
    }
    if(type==='any'){
      return dayHasActivity(dateStr,'japa') || dayHasActivity(dateStr,'practice') || dayHasActivity(dateStr,'reading') || dayHasActivity(dateStr,'learning');
    }
    return false;
  }

  /* Builds one "block" per logged item for a day — the calendar-cell / day-panel unit,
     mirroring the session chips in the NSQF execution calendar. */
  function getDayBlocks(dateStr){
    const day = data.logs[dateStr];
    const blocks = [];
    data.japa.forEach(c=>{
      c.sandhyas.forEach(s=>{
        const e = day && day.japa[c.id] && day.japa[c.id][s];
        if(e && e.count>0){
          blocks.push({type:'japa', id:c.id, key:'japa|'+c.id, name:c.name, meta:SANDHYA_LABEL[s]+' · '+e.count+' japas · '+fmtTime(e.seconds)});
        }
      });
    });
    data.practice.forEach(p=>{
      p.sandhyas.forEach(s=>{
        const e = day && day.practice[p.id] && day.practice[p.id][s];
        if(e && e.seconds>0){
          blocks.push({type:'practice', id:p.id, key:'practice|'+p.id, name:p.name, meta:SANDHYA_LABEL[s]+' · '+fmtTime(e.seconds)});
        }
      });
    });
    data.books.forEach(b=>{
      const v = day && day.reading[b.id];
      if(v>0){
        blocks.push({type:'reading', id:b.id, key:'reading|'+b.id, name:b.title, meta:v+' pages'});
      }
    });
    data.learning.forEach(t=>{
      t.notes.filter(n=>n.date===dateStr).forEach(n=>{
        blocks.push({type:'learning', id:t.id, key:'learning|'+t.id, name:t.title, meta:n.text});
      });
    });
    return blocks;
  }

  function blockMatchesFilters(b){
    const typeOk = calFilter==='all' || b.type===calFilter;
    const qOk = !calQuery || b.name.toLowerCase().indexOf(calQuery)>-1 || (b.meta||'').toLowerCase().indexOf(calQuery)>-1;
    return typeOk && qOk;
  }

  function dayStats(dateStr){
    const stats = {japa:false, practice:false, reading:false, learning:false, totalSeconds:0};
    const day = data.logs[dateStr];
    if(!day) return stats;
    stats.japa = dayHasActivity(dateStr,'japa');
    stats.practice = dayHasActivity(dateStr,'practice');
    stats.reading = dayHasActivity(dateStr,'reading');
    stats.learning = dayHasActivity(dateStr,'learning');
    Object.values(day.japa||{}).forEach(sMap=>Object.values(sMap).forEach(e=>stats.totalSeconds += (e.seconds||0)));
    Object.values(day.practice||{}).forEach(sMap=>Object.values(sMap).forEach(e=>stats.totalSeconds += (e.seconds||0)));
    return stats;
  }

  function tickLiveCalendarCell(){
    const el = document.getElementById('liveCellTime');
    if(!el) return;
    const stats = dayStats(todayStr());
    let total = stats.totalSeconds;
    Object.keys(runningTimers).forEach(key=>{ total += (Date.now()-runningTimers[key].startTime)/1000; });
    if(fsState) total += (Date.now()-fsState.startTime)/1000;
    el.textContent = fmtShort(total);
  }

  function computeConsistency(type){
    const now = new Date();
    const daysInMonth = new Date(calYear, calMonth+1, 0).getDate();
    const isCurrentMonth = (calYear===now.getFullYear() && calMonth===now.getMonth());
    const lastDay = isCurrentMonth ? now.getDate() : daysInMonth;
    let active = 0;
    for(let d=1; d<=lastDay; d++){
      const ds = calYear+'-'+String(calMonth+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      if(dayHasActivity(ds, type)) active++;
    }
    return {active, lastDay, pct: lastDay>0 ? Math.round((active/lastDay)*100) : 0};
  }

  /* ---------- Calendar Dashboard: Daily/Weekly/Monthly/Yearly ----------
     Read-only reporting view built on the same block model as the Routine
     tab (getMandatoryBlocksForDate/getCustomBlocksForDate) — no separate
     data source. Replaces the old plain consistency-% stat cards; the
     month heatmap grid, search/filter/trace controls and day panel below
     are unrelated existing functionality and are left exactly as they
     were. */
  let calDashPeriod = 'daily';
  let calDashDate = null; // explicit focus date; falls back to selectedDate, then today

  function currentCalDashDate(){ return calDashDate || selectedDate || todayStr(); }
  function shiftCalDashDate(days){
    const d = new Date(currentCalDashDate()+'T00:00:00');
    d.setDate(d.getDate()+days);
    calDashDate = todayStr(d);
  }

  function ensureCalDashboardDom(){
    const root = document.getElementById('calDashboard');
    if(!root || root.dataset.built) return;
    root.dataset.built = '1';
    root.innerHTML = `
      <div class="cal-dash">
        <div class="cal-tabbar" id="calDashPeriodTabs">
          <button class="cal-tab on" data-period="daily">Daily</button>
          <button class="cal-tab" data-period="weekly">Weekly</button>
          <button class="cal-tab" data-period="monthly">Monthly</button>
          <button class="cal-tab" data-period="yearly">Yearly</button>
        </div>

        <div id="calDashDaily">
          <div class="cal-nav">
            <button id="calDashDayPrev">‹</button>
            <h3 id="calDashDayLabel"></h3>
            <button id="calDashDayNext">›</button>
          </div>
          <div id="calDashDailyBody"></div>
        </div>

        <div id="calDashWeekly" style="display:none;">
          <div class="dash-week-row" id="calDashWeeklyBody"></div>
        </div>

        <div id="calDashMonthly" style="display:none;">
          <div class="routine-stats-row" id="calDashMonthlyStats"></div>
          <div class="dash-month-grid" id="calDashMonthlyGrid"></div>
        </div>

        <div id="calDashYearly" style="display:none;">
          <div class="routine-stats-row" id="calDashYearlyStats"></div>
          <div class="dash-year-grid" id="calDashYearlyGrid"></div>
        </div>
      </div>
    `;
    document.querySelectorAll('#calDashPeriodTabs .cal-tab').forEach(btn=>{
      btn.addEventListener('click', ()=>{ calDashPeriod = btn.dataset.period; renderCalendarDashboard(); });
    });
    document.getElementById('calDashDayPrev').addEventListener('click', ()=>{ shiftCalDashDate(-1); renderCalendarDashboard(); });
    document.getElementById('calDashDayNext').addEventListener('click', ()=>{ shiftCalDashDate(1); renderCalendarDashboard(); });
  }

  function renderCalendarDashboard(){
    ensureCalDashboardDom();
    if(!document.getElementById('calDashboard')) return;
    document.querySelectorAll('#calDashPeriodTabs .cal-tab').forEach(b=> b.classList.toggle('on', b.dataset.period===calDashPeriod));
    document.getElementById('calDashDaily').style.display = calDashPeriod==='daily' ? '' : 'none';
    document.getElementById('calDashWeekly').style.display = calDashPeriod==='weekly' ? '' : 'none';
    document.getElementById('calDashMonthly').style.display = calDashPeriod==='monthly' ? '' : 'none';
    document.getElementById('calDashYearly').style.display = calDashPeriod==='yearly' ? '' : 'none';
    if(calDashPeriod==='daily') renderCalDashDaily();
    if(calDashPeriod==='weekly') renderCalDashWeekly();
    if(calDashPeriod==='monthly') renderCalDashMonthly();
    if(calDashPeriod==='yearly') renderCalDashYearly();
  }

  function renderDashActivityRow(b){
    const statusMeta = {
      done:{label:'Done', cls:'status-done'},
      'in-progress':{label:'Running', cls:'status-running'},
      overdue:{label:'Overdue', cls:'status-overdue'},
      pending:{label:'Pending', cls:'status-pending'}
    }[b._status];
    const end = b.startTime!=null ? minToTime(timeToMin(b.startTime)+b.durationMin) : null;
    const timeLabel = b.startTime!=null ? fmtTimeLabel(b.startTime)+(end?' – '+fmtTimeLabel(end):'') : 'No fixed time';
    const durationBits = [];
    if(b.seconds>0) durationBits.push(fmtShort(b.seconds)+' actual');
    if(b.durationMin) durationBits.push(fmtShort(b.durationMin*60)+' planned');
    return `<div class="dash-row">
      <span class="dash-row-icon">${b.icon}</span>
      <span class="dash-row-name">${escapeHtml(b.name)}${b.locked?' <span class="mini-lock">🔒</span>':''}</span>
      <span class="dash-row-time">${timeLabel}</span>
      <span class="dash-row-duration">${durationBits.join(' / ')||'—'}</span>
      <span class="dash-status-pill ${statusMeta.cls}">${statusMeta.label}</span>
    </div>`;
  }

  function renderCalDashDaily(){
    const dateStr = currentCalDashDate();
    const label = dateStr===todayStr() ? 'Today' : new Date(dateStr+'T00:00:00').toLocaleDateString('en-US',{weekday:'long', month:'short', day:'numeric', year:'numeric'});
    document.getElementById('calDashDayLabel').textContent = label;
    const blocks = [...getMandatoryBlocksForDate(dateStr), ...getCustomBlocksForDate(dateStr)];
    const buckets = { Morning:[], Afternoon:[], Evening:[], Night:[], Flexible:[] };
    blocks.forEach(b=>{ b._status = computeBlockStatus(b, dateStr); buckets[bucketForStartTime(b.startTime)].push(b); });
    const order = ['Morning','Afternoon','Evening','Night','Flexible'];
    const nonEmpty = order.filter(k=>buckets[k].length);
    const el = document.getElementById('calDashDailyBody');
    if(nonEmpty.length===0){ el.innerHTML = '<div class="empty-note">Nothing scheduled for this day.</div>'; return; }
    el.innerHTML = nonEmpty.map(k=>`
      <div class="dash-bucket">
        <div class="dash-bucket-title">${BUCKET_ICON[k]} ${k}</div>
        <div class="dash-bucket-list">
          ${buckets[k].sort((a,b)=>(a.startTime!=null?timeToMin(a.startTime):9999)-(b.startTime!=null?timeToMin(b.startTime):9999)).map(renderDashActivityRow).join('')}
        </div>
      </div>`).join('');
  }

  function renderCalDashWeekly(){
    const anchor = new Date(currentCalDashDate()+'T00:00:00');
    const base = new Date(anchor); base.setDate(anchor.getDate()-anchor.getDay());
    const dayLabels=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    let html = '';
    for(let i=0;i<7;i++){
      const d = new Date(base); d.setDate(base.getDate()+i);
      const dateStr = todayStr(d);
      const blocks = [...getMandatoryBlocksForDate(dateStr), ...getCustomBlocksForDate(dateStr)];
      let done=0, overdue=0, pending=0;
      blocks.forEach(b=>{
        const s = computeBlockStatus(b, dateStr);
        if(s==='done') done++; else if(s==='overdue') overdue++; else pending++;
      });
      const total = blocks.length;
      html += `<div class="dash-week-col ${dateStr===todayStr()?'today':''}" data-date="${dateStr}">
        <div class="dash-week-head">${dayLabels[i]}<br><span class="dash-week-date">${d.getDate()}</span></div>
        <div class="dash-week-bar">${total ? `
          <i class="bar-seg bar-done" style="height:${done/total*100}%"></i>
          <i class="bar-seg bar-overdue" style="height:${overdue/total*100}%"></i>
          <i class="bar-seg bar-pending" style="height:${pending/total*100}%"></i>` : ''}</div>
        <div class="dash-week-counts">${total ? done+'/'+total : '—'}</div>
      </div>`;
    }
    const el = document.getElementById('calDashWeeklyBody');
    el.innerHTML = html;
    el.querySelectorAll('.dash-week-col').forEach(col=>{
      col.addEventListener('click', ()=>{ calDashDate = col.dataset.date; calDashPeriod = 'daily'; renderCalendarDashboard(); });
    });
  }

  function renderCalDashMonthly(){
    if(calYear===undefined) initCalendarCursor();
    const year = calYear, month = calMonth;
    const daysInMonth = new Date(year, month+1, 0).getDate();
    let totalScheduled=0, totalDone=0, totalOverdue=0;
    const cells = [];
    for(let d=1; d<=daysInMonth; d++){
      const dateStr = year+'-'+String(month+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      const blocks = [...getMandatoryBlocksForDate(dateStr), ...getCustomBlocksForDate(dateStr)];
      let done=0, overdue=0;
      blocks.forEach(b=>{ const s=computeBlockStatus(b,dateStr); if(s==='done') done++; else if(s==='overdue') overdue++; });
      totalScheduled += blocks.length; totalDone += done; totalOverdue += overdue;
      // Only a past or current day can be colored by completion — a future
      // day showing 0% would look identical to a genuinely missed day.
      const isFuture = dateStr > todayStr();
      cells.push({ d, dateStr, total: blocks.length, done, pct: (!isFuture && blocks.length) ? Math.round(done/blocks.length*100) : null });
    }
    const completionRate = totalScheduled ? Math.round(totalDone/totalScheduled*100) : 0;
    document.getElementById('calDashMonthlyStats').innerHTML = `
      <div class="routine-stat"><div class="num">${totalScheduled}</div><div class="lbl">Scheduled</div></div>
      <div class="routine-stat"><div class="num">${totalDone}</div><div class="lbl">Completed</div></div>
      <div class="routine-stat"><div class="num">${totalOverdue}</div><div class="lbl">Missed</div></div>
      <div class="routine-stat"><div class="num">${completionRate}%</div><div class="lbl">Completion</div></div>
    `;
    const firstDow = new Date(year, month, 1).getDay();
    let gridHtml = ['S','M','T','W','T','F','S'].map(d=>`<div class="dash-month-dow">${d}</div>`).join('');
    for(let i=0;i<firstDow;i++) gridHtml += '<div class="dash-month-cell empty"></div>';
    cells.forEach(c=>{
      const level = c.pct==null ? 'none' : c.pct>=80 ? 'high' : c.pct>=40 ? 'mid' : 'low';
      const title = !c.total ? 'Nothing scheduled' : (c.pct==null ? c.total+' planned' : c.done+'/'+c.total+' completed');
      gridHtml += `<div class="dash-month-cell level-${level}${c.dateStr===todayStr()?' today':''}" data-date="${c.dateStr}" title="${title}">${c.d}</div>`;
    });
    const gridEl = document.getElementById('calDashMonthlyGrid');
    gridEl.innerHTML = gridHtml;
    gridEl.querySelectorAll('.dash-month-cell[data-date]').forEach(cell=>{
      cell.addEventListener('click', ()=>{ calDashDate = cell.dataset.date; calDashPeriod = 'daily'; renderCalendarDashboard(); });
    });
  }

  function renderCalDashYearly(){
    if(calYear===undefined) initCalendarCursor();
    const year = calYear;
    const monthNames=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let totalScheduled=0, totalDone=0;
    const cells = [];
    for(let m=0;m<12;m++){
      const daysInMonth = new Date(year, m+1, 0).getDate();
      let scheduled=0, done=0;
      for(let d=1; d<=daysInMonth; d++){
        const dateStr = year+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
        const blocks = [...getMandatoryBlocksForDate(dateStr), ...getCustomBlocksForDate(dateStr)];
        scheduled += blocks.length;
        blocks.forEach(b=>{ if(computeBlockStatus(b,dateStr)==='done') done++; });
      }
      totalScheduled += scheduled; totalDone += done;
      // A month that hasn't started yet shouldn't be colored as "missed".
      const now = new Date();
      const isFutureMonth = year > now.getFullYear() || (year===now.getFullYear() && m > now.getMonth());
      cells.push({ m, pct: (!isFutureMonth && scheduled) ? Math.round(done/scheduled*100) : null });
    }
    const completionRate = totalScheduled ? Math.round(totalDone/totalScheduled*100) : 0;
    document.getElementById('calDashYearlyStats').innerHTML = `
      <div class="routine-stat"><div class="num">${totalScheduled}</div><div class="lbl">Scheduled</div></div>
      <div class="routine-stat"><div class="num">${totalDone}</div><div class="lbl">Completed</div></div>
      <div class="routine-stat"><div class="num">${completionRate}%</div><div class="lbl">Completion</div></div>
    `;
    document.getElementById('calDashYearlyGrid').innerHTML = cells.map(c=>{
      const level = c.pct==null ? 'none' : c.pct>=80 ? 'high' : c.pct>=40 ? 'mid' : 'low';
      return `<div class="dash-year-cell level-${level}" data-month="${c.m}">
        <div class="dash-year-month">${monthNames[c.m]}</div>
        <div class="dash-year-pct">${c.pct==null?'—':c.pct+'%'}</div>
      </div>`;
    }).join('');
    document.querySelectorAll('#calDashYearlyGrid .dash-year-cell').forEach(cell=>{
      cell.addEventListener('click', ()=>{
        calMonth = +cell.dataset.month;
        calDashPeriod = 'monthly';
        renderCalendarDashboard();
        renderCalendar();
      });
    });
  }

  function renderCalProgress(){
    const type = calFilter==='all' ? 'any' : calFilter;
    const {active, lastDay, pct} = computeConsistency(type);
    document.getElementById('calProgressCount').textContent = active+' / '+lastDay+' active days';
    document.getElementById('calProgressFill').style.width = pct+'%';
  }

  let selectedDate = null;
  function renderCalendar(){
    if(calYear===undefined) initCalendarCursor();
    renderCalendarDashboard();
    renderCalProgress();
    const label = new Date(calYear,calMonth,1).toLocaleString('en-US',{month:'long',year:'numeric'});
    document.getElementById('calMonthLabel').textContent = label;

    const grid = document.getElementById('calGrid');
    const dows = ['S','M','T','W','T','F','S'];
    let html = dows.map(d=>`<div class="cal-dow">${d}</div>`).join('');
    const firstDow = new Date(calYear,calMonth,1).getDay();
    const daysInMonth = new Date(calYear,calMonth+1,0).getDate();
    const todayS = todayStr();
    for(let i=0;i<firstDow;i++) html += '<div class="cal-cell empty"></div>';
    const MAX_VISIBLE_BLOCKS = 2;
    for(let d=1; d<=daysInMonth; d++){
      const ds = calYear+'-'+String(calMonth+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      const stats = dayStats(ds);
      const allBlocks = getDayBlocks(ds);
      const visibleBlocks = allBlocks.filter(blockMatchesFilters);
      const activeFilters = calFilter!=='all' || !!calQuery;
      const heatCount = activeFilters ? visibleBlocks.length : allBlocks.length;
      const heatOpacity = heatCount ? Math.min(0.15 + 0.16*heatCount, 0.62) : 0;
      const isToday = ds===todayS;
      const isSelected = ds===selectedDate;
      const isLive = isToday && (Object.keys(runningTimers).length>0 || !!fsState);
      const timeId = isLive ? ' id="liveCellTime"' : '';
      const timeLabel = stats.totalSeconds>0 ? fmtShort(stats.totalSeconds) : (isLive ? '0m' : '');
      const shown = visibleBlocks.slice(0, MAX_VISIBLE_BLOCKS);
      const overflow = visibleBlocks.length - shown.length;
      const blockHtml = shown.map((b,i)=>{
        const cls = ['cal-block', b.type];
        if(calFocus){ cls.push(b.key===calFocus ? 'foc' : 'dim'); }
        return `<div class="${cls.join(' ')}" data-key="${b.key}" style="animation-delay:${Math.min(i,4)*45}ms" title="${escapeHtml(b.name+' — '+b.meta)}">
          <span class="bn">${escapeHtml(b.name)}</span><span class="bm">${escapeHtml(b.meta)}</span>
        </div>`;
      }).join('') + (overflow>0 ? `<div class="cal-more" data-date="${ds}">+${overflow} more</div>` : '');
      html += `<div class="cal-cell ${isToday?'today':''} ${isSelected?'selected':''} ${isLive?'live':''}" data-date="${ds}" style="animation-delay:${Math.min(d,20)*8}ms" title="${visibleBlocks.length ? visibleBlocks.length+' item(s) logged' : 'No activity'}">
        ${heatCount ? `<div class="heat" style="background:var(--gold);opacity:${heatOpacity}"></div>` : ''}
        <div class="cal-cell-top">
          <span class="dnum">${d}</span>
          ${timeLabel ? `<span class="cal-time"${timeId}>${timeLabel}</span>` : ''}
        </div>
        <div class="cal-dots">
          ${stats.japa?'<span class="cdot japa" title="Japa"></span>':''}
          ${stats.practice?'<span class="cdot practice" title="Practice"></span>':''}
          ${stats.reading?'<span class="cdot reading" title="Reading"></span>':''}
          ${stats.learning?'<span class="cdot learning" title="Learning"></span>':''}
        </div>
        <div class="cal-blocks">${blockHtml}</div>
      </div>`;
    }
    grid.innerHTML = html;
    grid.querySelectorAll('.cal-cell[data-date]').forEach(cell=>{
      cell.addEventListener('click', (ev)=>{
        if(ev.target.closest('.cal-block') || ev.target.closest('.cal-more')) return;
        selectedDate = cell.dataset.date;
        renderCalendar();
        renderDayPanel(selectedDate);
      });
    });
    grid.querySelectorAll('.cal-more').forEach(btn=>{
      btn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        selectedDate = btn.dataset.date;
        renderCalendar();
        renderDayPanel(selectedDate);
      });
    });
    grid.querySelectorAll('.cal-block').forEach(el=>{
      el.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        const key = el.dataset.key;
        calFocus = (calFocus===key) ? null : key;
        renderCalendar();
        if(selectedDate) renderDayPanel(selectedDate);
      });
    });
    if(selectedDate) renderDayPanel(selectedDate);
  }

  function renderDayPanel(dateStr){
    const panel = document.getElementById('dayPanel');
    panel.style.display = '';
    const dateLabel = new Date(dateStr+'T00:00:00').toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric'});
    const blocks = getDayBlocks(dateStr);
    const groups = [
      ['japa','Japa', data.japa.length],
      ['practice','Practice', data.practice.length],
      ['reading','Reading', data.books.length],
      ['learning','Learning notes', data.learning.length],
    ];

    function blockRow(b){
      const cls = ['day-block', b.type];
      if(calFocus){ cls.push(b.key===calFocus ? 'foc' : 'dim'); }
      return `<div class="${cls.join(' ')}" data-key="${b.key}">
        <span class="db-name">${escapeHtml(b.name)}</span><span class="db-meta">${escapeHtml(b.meta)}</span>
      </div>`;
    }

    const groupsHtml = groups.map(([type,label,defined])=>{
      const rows = blocks.filter(b=>b.type===type);
      const body = rows.length ? rows.map(blockRow).join('') : `<span class="empty-note">${defined ? 'Nothing logged.' : 'None set up.'}</span>`;
      return `<div class="day-group"><div class="g-title">${label}</div>${body}</div>`;
    }).join('');

    panel.innerHTML = `<h4>${dateLabel} Summary</h4>${groupsHtml}`;
    panel.querySelectorAll('.day-block[data-key]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const key = el.dataset.key;
        calFocus = (calFocus===key) ? null : key;
        renderCalendar();
        renderDayPanel(dateStr);
      });
    });
  }

  document.getElementById('calTypeTabs').addEventListener('click', (ev)=>{
    const btn = ev.target.closest('.cal-tab'); if(!btn) return;
    document.querySelectorAll('#calTypeTabs .cal-tab').forEach(t=>t.classList.remove('on'));
    btn.classList.add('on');
    calFilter = btn.dataset.type;
    renderCalendar();
  });
  document.getElementById('calSearch').addEventListener('input', (ev)=>{
    calQuery = ev.target.value.trim().toLowerCase();
    renderCalendar();
  });
  document.getElementById('calReset').addEventListener('click', ()=>{
    calFilter = 'all'; calQuery = ''; calFocus = null;
    document.getElementById('calSearch').value = '';
    document.querySelectorAll('#calTypeTabs .cal-tab').forEach((t,i)=>t.classList.toggle('on', i===0));
    renderCalendar();
  });

  document.getElementById('calPrev').addEventListener('click', ()=>{
    calMonth--; if(calMonth<0){calMonth=11; calYear--;}
    selectedDate = null;
    document.getElementById('dayPanel').style.display='none';
    renderCalendar();
  });
  document.getElementById('calNext').addEventListener('click', ()=>{
    calMonth++; if(calMonth>11){calMonth=0; calYear++;}
    selectedDate = null;
    document.getElementById('dayPanel').style.display='none';
    renderCalendar();
  });

  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  }

  function computeTodayKindSeconds(kind){
    const day = data.logs[todayStr()];
    let total = 0;
    if(day && day[kind]) Object.values(day[kind]).forEach(sMap=>Object.values(sMap).forEach(e=>total+=(e.seconds||0)));
    if(kind==='practice'){
      // Practice timers are visible (not fullscreen), so add live elapsed
      // for any session currently running. Japa's timer is only ever
      // running inside the fullscreen counter, which covers the whole
      // screen (so this header strip isn't even visible then) — its
      // persisted seconds are enough, refreshed when that closes.
      Object.keys(runningTimers).forEach(key=>{
        if(key.startsWith('activity|')) return;
        total += (Date.now()-runningTimers[key].startTime)/1000;
      });
    }
    return total;
  }

  function renderStatsStrip(){
    const practiceEl = document.getElementById('statsPracticeTime');
    const japaEl = document.getElementById('statsJapaTime');
    if(!practiceEl || !japaEl) return;
    practiceEl.textContent = fmtShort(computeTodayKindSeconds('practice'));
    japaEl.textContent = fmtShort(computeTodayKindSeconds('japa'));
  }

  function renderAll(){
    renderJapa();
    renderPractice();
    renderReading();
    renderLearning();
    renderDhyana();
    renderTodaySchedule();
    renderStatsStrip();
  }

  /* ---------- Admin ----------
     A dashboard listing every account (users/{uid} doc) ever created, and
     — per account — every profile in its workspace with full tracker
     data, Journal included. There is no separate Admin UI at all: signing
     in with the admin email/password on the ordinary sign-in form
     (js/auth-ui.js) is what opens it — see the "sadhana-admin-ready" event
     below and "Admin module" in CLAUDE.md for why the credential check
     can't be a real Firestore-enforced gate, and why that's a deliberate,
     user-approved trade-off rather than an oversight. Write access stays
     restricted to each account's own data regardless. */
  let adminAccounts = [];
  let adminSelectedUid = null;
  let adminSelectedWorkspaceCode = null;
  let adminSelectedWorkspaceUsers = [];
  let adminSelectedProfileId = null;
  // Set once per session by the sadhana-admin-ready listener below, so
  // closeAdminScreen() knows this Firebase Auth session is the Admin
  // account (no workspace/profile of its own) rather than a normal one,
  // without needing to duplicate ADMIN_EMAIL from js/auth-ui.js here.
  let adminSessionActive = false;

  document.addEventListener('sadhana-admin-ready', ()=>{ adminSessionActive = true; openAdminScreen(); });
  document.getElementById('adminExitBtn').addEventListener('click', closeAdminScreen);

  async function openAdminScreen(){
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('userSelectScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'none';
    document.getElementById('addActivityFab').style.display = 'none';
    document.getElementById('adminScreen').style.display = '';
    adminSelectedUid = null;
    adminSelectedProfileId = null;
    document.getElementById('adminAccountDetail').innerHTML = '<div class="empty-note">Select an account on the left to view its profiles.</div>';
    const listEl = document.getElementById('adminAccountList');
    listEl.innerHTML = '<div class="empty-note" style="padding:14px;">Loading accounts…</div>';
    try{
      adminAccounts = await adminListAllUsers();
      adminAccounts.sort((a,b)=> (a.email||'').localeCompare(b.email||''));
    }catch(e){
      listEl.innerHTML = '<div class="empty-note" style="padding:14px;">Could not load accounts: '+escapeHtml(e.message)+'</div>';
      return;
    }
    renderAdminAccountList();
  }

  function closeAdminScreen(){
    document.getElementById('adminScreen').style.display = 'none';
    if(currentUser){
      document.getElementById('appScreen').style.display = '';
      document.getElementById('addActivityFab').style.display = '';
    } else if(auth.currentUser && !adminSessionActive){
      document.getElementById('userSelectScreen').style.display = '';
      renderUserGrid();
    } else {
      // Either nobody was signed in, or the only session is the Admin
      // account itself — neither has a real profile/workspace, so the
      // sign-in screen is the right place to land back on.
      document.getElementById('authScreen').style.display = '';
    }
  }

  function renderAdminAccountList(){
    const listEl = document.getElementById('adminAccountList');
    if(adminAccounts.length===0){ listEl.innerHTML = '<div class="empty-note" style="padding:14px;">No accounts yet.</div>'; return; }
    listEl.innerHTML = adminAccounts.map(a=>`
      <div class="admin-account-row ${a.uid===adminSelectedUid?'on':''}" data-admin-uid="${a.uid}">
        <div class="admin-account-email">${escapeHtml(a.email||'(no email)')}</div>
        <div class="admin-account-meta">Shared space: ${escapeHtml(a.workspaceId||'—')}</div>
      </div>`).join('');
    listEl.querySelectorAll('[data-admin-uid]').forEach(row=>{
      row.addEventListener('click', ()=> selectAdminAccount(row.dataset.adminUid));
    });
  }

  async function selectAdminAccount(uid){
    adminSelectedUid = uid;
    adminSelectedProfileId = null;
    renderAdminAccountList();
    const detailEl = document.getElementById('adminAccountDetail');
    const account = adminAccounts.find(a=>a.uid===uid);
    if(!account || !account.workspaceId){
      detailEl.innerHTML = '<div class="empty-note">This account has no shared space yet.</div>';
      return;
    }
    adminSelectedWorkspaceCode = account.workspaceId;
    detailEl.innerHTML = '<div class="empty-note">Loading profiles…</div>';
    try{
      const res = await adminGetWorkspaceKv(account.workspaceId, USERS_KEY);
      const arr = res && res.value ? JSON.parse(res.value) : [];
      adminSelectedWorkspaceUsers = Array.isArray(arr) ? arr : [];
    }catch(e){
      detailEl.innerHTML = '<div class="empty-note">Could not load this account\'s profiles: '+escapeHtml(e.message)+'</div>';
      return;
    }
    renderAdminAccountDetail();
  }

  function renderAdminAccountDetail(){
    const detailEl = document.getElementById('adminAccountDetail');
    const account = adminAccounts.find(a=>a.uid===adminSelectedUid);
    if(!account) return;
    if(adminSelectedWorkspaceUsers.length===0){
      detailEl.innerHTML = `
        <div class="item-sub" style="margin-bottom:4px;">Account</div>
        <div class="item-title" style="margin-bottom:14px;">${escapeHtml(account.email||'')}</div>
        <div class="empty-note">This shared space has no profiles yet.</div>`;
      return;
    }
    if(!adminSelectedProfileId || !adminSelectedWorkspaceUsers.some(u=>u.id===adminSelectedProfileId)){
      adminSelectedProfileId = adminSelectedWorkspaceUsers[0].id;
    }
    const tabsHtml = adminSelectedWorkspaceUsers.map(u=>
      `<button class="cal-tab ${u.id===adminSelectedProfileId?'on':''}" data-admin-profile="${u.id}">${escapeHtml(u.name)}</button>`
    ).join('');
    detailEl.innerHTML = `
      <div class="item-sub" style="margin-bottom:4px;">Account</div>
      <div class="item-title" style="margin-bottom:4px;">${escapeHtml(account.email||'')}</div>
      <div class="empty-note" style="margin-bottom:14px;">Shared space: ${escapeHtml(account.workspaceId||'—')} · ${adminSelectedWorkspaceUsers.length} profile${adminSelectedWorkspaceUsers.length===1?'':'s'}</div>
      <div class="cal-tabbar" style="flex-wrap:wrap; width:fit-content;">${tabsHtml}</div>
      <div id="adminProfileDetail" style="margin-top:16px;"><div class="empty-note">Loading profile data…</div></div>
    `;
    detailEl.querySelectorAll('[data-admin-profile]').forEach(btn=>{
      btn.addEventListener('click', ()=>{ adminSelectedProfileId = btn.dataset.adminProfile; renderAdminAccountDetail(); });
    });
    loadAdminProfileDetail();
  }

  async function loadAdminProfileDetail(){
    const el = document.getElementById('adminProfileDetail');
    if(!el) return;
    let profileData;
    try{
      const res = await adminGetWorkspaceKv(adminSelectedWorkspaceCode, userStorageKey(adminSelectedProfileId));
      profileData = res && res.value ? normalizeData(JSON.parse(res.value)) : defaultData();
    }catch(e){
      el.innerHTML = '<div class="empty-note">Could not load this profile\'s data: '+escapeHtml(e.message)+'</div>';
      return;
    }
    el.innerHTML = renderAdminProfileSummary(profileData) + renderAdminProfileJournal(profileData);
  }

  function adminTotalKindSeconds(d, kind){
    let total = 0;
    Object.values(d.logs||{}).forEach(day=>{
      if(day && day[kind]) Object.values(day[kind]).forEach(sMap=>Object.values(sMap).forEach(e=>total+=(e.seconds||0)));
    });
    return total;
  }
  function adminTotalPagesRead(d, bookId){
    let total = 0;
    Object.values(d.logs||{}).forEach(day=>{ if(day.reading && day.reading[bookId]) total += day.reading[bookId]; });
    return total;
  }

  function renderAdminProfileSummary(d){
    const totalPractice = adminTotalKindSeconds(d, 'practice');
    const totalJapa = adminTotalKindSeconds(d, 'japa');
    const booksHtml = (d.books||[]).map(b=>
      `<div class="admin-stat-row"><span>${escapeHtml(b.title)}</span><b>${adminTotalPagesRead(d,b.id)} / ${b.pages} pages</b></div>`
    ).join('') || '<div class="empty-note">No books.</div>';
    const learningHtml = (d.learning||[]).map(t=>
      `<div class="admin-stat-row"><span>${escapeHtml(t.title)}</span><b>${t.milestones.filter(m=>m.done).length} / ${t.milestones.length} milestones</b></div>`
    ).join('') || '<div class="empty-note">No learning tracks.</div>';
    const activitiesHtml = (d.activities||[]).map(a=>
      `<div class="admin-stat-row"><span>${a.icon?escapeHtml(a.icon)+' ':''}${escapeHtml(a.name)}</span><b>${categoryLabel(a.category)}</b></div>`
    ).join('') || '<div class="empty-note">No custom activities.</div>';
    return `
      <div class="journal-section">
        <div class="journal-section-title">📊 Summary (all time)</div>
        <div class="admin-stat-row"><span>🧘 Practice</span><b>${fmtShort(totalPractice)}</b></div>
        <div class="admin-stat-row"><span>📿 Japa</span><b>${fmtShort(totalJapa)}</b></div>
      </div>
      <div class="journal-section"><div class="journal-section-title">📖 Reading</div>${booksHtml}</div>
      <div class="journal-section"><div class="journal-section-title">🎓 Learning</div>${learningHtml}</div>
      <div class="journal-section"><div class="journal-section-title">🗓️ Custom Activities</div>${activitiesHtml}</div>
    `;
  }

  function renderAdminProfileJournal(d){
    const dates = Object.keys(d.journal||{}).sort().reverse();
    const jHtml = dates.length===0 ? '<div class="empty-note">No journal entries.</div>' : dates.map(dateStr=>{
      const label = new Date(dateStr+'T00:00:00').toLocaleDateString('en-US',{weekday:'long', month:'long', day:'numeric', year:'numeric'});
      const rows = (d.journal[dateStr].entries||[]).map(en=>`<div>${escapeHtml(en.text||'')}${en.audio?' 🎙️ (voice note)':''}</div>`).join('');
      return `<div class="journal-timeline-day" style="cursor:default;"><div class="journal-timeline-date">${label}</div><div class="journal-entry-body">${rows}</div></div>`;
    }).join('');
    const nk = (d.nishkaam||[]).map(n=>`<div>${n.status==='done'?'✅':'🗓️'} ${escapeHtml(n.text)} <span class="empty-note">· ${escapeHtml(n.date||'')}</span></div>`).join('') || '<div class="empty-note">None.</div>';
    const km = (d.kumbhak||[]).slice().reverse().map(s=>`<div>${escapeHtml(s.date)} — ${s.rounds} round${s.rounds===1?'':'s'} (1 : 4 : 2 : 2, unit ${s.unit}s)</div>`).join('') || '<div class="empty-note">None.</div>';
    const dh = (d.dhyana||[]).slice().reverse().map(x=>`<div><b>${escapeHtml(x.title||'Untitled')}</b>${x.audio?' 🎙️':''} <span class="empty-note">· ${escapeHtml(x.date||'')}</span>${x.notes?'<div>'+escapeHtml(x.notes)+'</div>':''}</div>`).join('') || '<div class="empty-note">None.</div>';
    return `<div class="journal-section"><div class="journal-section-title">📔 Journal (${dates.length} ${dates.length===1?'day':'days'})</div>${jHtml}</div>
      <div class="journal-section"><div class="journal-section-title">🧘 Dhyana Insights</div>${dh}</div>
      <div class="journal-section"><div class="journal-section-title">🪔 Nishkaam Karma</div>${nk}</div>
      <div class="journal-section"><div class="journal-section-title">🫁 Kumbhak Pranayama</div>${km}</div>`;
  }

  /* ---------- Startup handoff (must stay last) ---------- */
  // auth-ui.js can finish restoring a saved session before this (larger)
  // module has loaded and registered its listeners; it records the handoff
  // on <html data-sadhana-session>, so catch up here if the event already
  // fired. Registered listeners never see a missed event twice.
  if(document.documentElement.dataset.sadhanaSession === 'ready') initApp();
  else if(document.documentElement.dataset.sadhanaSession === 'admin'){ adminSessionActive = true; openAdminScreen(); }
