// Kumbhak Pranayama — paced breathing in the ratio 1 : 4 : 2 : 2
// (inhale : hold : exhale : hold). The user picks the length of "1" in
// seconds; a temple bell marks every change of phase. A round is counted
// each time a full cycle (all four phases) finishes.
//
//   data.kumbhak = [{ id, date, ts, unit, rounds, seconds }]
import { toast, fmtClock, prettyDate } from "./ui.js";

const RATIO = [1, 4, 2, 2];
const PHASES = [
  { key:'in',    label:'Breathe in',  sub:'Pūraka',        hz:660, scale:1,    cls:'in'   },
  { key:'hold',  label:'Hold',        sub:'Antara Kumbhaka', hz:523, scale:1,  cls:'hold' },
  { key:'out',   label:'Breathe out', sub:'Rechaka',       hz:440, scale:0.52, cls:'out'  },
  { key:'empty', label:'Hold',        sub:'Bāhya Kumbhaka', hz:392, scale:0.52, cls:'hold' }
];
const CYCLE_UNITS = RATIO.reduce((a,b)=>a+b, 0);   // 9
const LOOKAHEAD = 20;                               // seconds of bells scheduled in advance
const MIN_UNIT = 1, MAX_UNIT = 30;

let ctx = null;
let built = false;
let session = null;      // {t0, unit, scheduled:Set, timer, wake}
let audioCtx = null;
let soundOn = true;
let lastSummary = null;

const data = () => ctx.getData();
const root = () => document.getElementById('tab-kumbhak');
const esc = s => ctx.escapeHtml(s == null ? '' : String(s));

export function initKumbhak(c){
  ctx = c;
  try{ soundOn = localStorage.getItem('tt-kumbhak-sound') !== 'off'; }catch(e){ /* private mode */ }
  document.addEventListener('visibilitychange', ()=>{
    if(!document.hidden && session) acquireWakeLock();
  });
}

/* ---------- temple bell (synthesised, no audio files) ---------- */
function getAudio(){
  if(!audioCtx){
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    audioCtx = new AC();
  }
  if(audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// A struck bell is a stack of inharmonic partials, each ringing down at its
// own rate (higher partials die faster), after a short bright "tink".
function bellAt(when, f0){
  const ac = audioCtx;
  const partials = [
    [1.0,  0.9, 3.8], [2.0, 0.45, 3.0], [2.76, 0.5, 2.2],
    [4.07, 0.25, 1.5], [5.4, 0.22, 1.1], [8.93, 0.1, 0.6]
  ];
  const master = ac.createGain();
  master.gain.value = 0.5;
  master.connect(ac.destination);
  partials.forEach(([mult, amp, decay])=>{
    const osc = ac.createOscillator(), g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = f0 * mult;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(amp * 0.5, when + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    osc.connect(g); g.connect(master);
    osc.start(when);
    osc.stop(when + decay + 0.05);
  });
}

/* ---------- timing ---------- */
function phaseAt(elapsed, unit){
  const cycle = CYCLE_UNITS * unit;
  const rounds = Math.floor(elapsed / cycle);
  let pos = elapsed - rounds * cycle, idx = 0;
  for(; idx < 4; idx++){
    const len = RATIO[idx] * unit;
    if(pos < len) break;
    pos -= len;
  }
  idx = Math.min(idx, 3);
  const len = RATIO[idx] * unit;
  return { rounds, idx, into: pos, len, left: len - pos };
}

// Start time (seconds from t0) of the n-th phase boundary, n = 0,1,2,...
function boundary(n, unit){
  const r = Math.floor(n / 4), i = n % 4;
  let t = r * CYCLE_UNITS;
  for(let k = 0; k < i; k++) t += RATIO[k];
  return t * unit;
}

function scheduleBells(){
  if(!session || !soundOn || !audioCtx) return;
  const { t0, unit, scheduled } = session;
  const elapsed = (Date.now() - t0) / 1000;
  for(let n = 0; ; n++){
    const t = boundary(n, unit);
    if(t > elapsed + LOOKAHEAD) break;
    if(scheduled.has(n)) continue;
    scheduled.add(n);
    const delay = t - elapsed;
    if(delay < -0.3) continue;                       // already long past
    bellAt(audioCtx.currentTime + Math.max(0, delay), PHASES[n % 4].hz);
  }
}

/* ---------- view ---------- */
function buildDom(){
  if(built) return;
  root().innerHTML = `
    <div class="sec-head">
      <div>
        <h2>Kumbhak Pranayama</h2>
        <div class="desc">Breathe in the ratio 1 : 4 : 2 : 2 — a temple bell guides every change</div>
      </div>
    </div>

    <div class="km-card">
      <div class="km-setup" id="kmSetup">
        <label class="field-label" for="kmUnit">Length of “1” (seconds)</label>
        <div class="km-stepper">
          <button class="icon-btn" id="kmMinus" type="button" aria-label="Decrease">−</button>
          <input type="number" id="kmUnit" min="${MIN_UNIT}" max="${MAX_UNIT}" inputmode="numeric">
          <button class="icon-btn" id="kmPlus" type="button" aria-label="Increase">+</button>
        </div>
        <div class="km-chips" id="kmChips">${[3,4,5,6,8,10].map(n=>`<button type="button" class="km-chip" data-u="${n}">${n}s</button>`).join('')}</div>
        <div class="km-plan" id="kmPlan"></div>
      </div>

      <div class="km-stage" id="kmStage">
        <div class="km-ring-wrap">
          <svg class="km-ring" viewBox="0 0 200 200" aria-hidden="true">
            <circle cx="100" cy="100" r="92" class="km-ring-bg"/>
            <circle cx="100" cy="100" r="92" class="km-ring-fg" id="kmRingFg" pathLength="100"/>
          </svg>
          <div class="km-orb" id="kmOrb"></div>
          <div class="km-center">
            <div class="km-phase" id="kmPhase">Ready</div>
            <div class="km-count" id="kmCount">—</div>
            <div class="km-sub" id="kmSub">Press start</div>
          </div>
        </div>
        <div class="km-rounds"><span id="kmRounds">0</span><small>rounds completed</small></div>
        <div class="km-steps" id="kmSteps"></div>
      </div>

      <div class="km-actions">
        <button class="pill km-start" id="kmStart" type="button">Start</button>
        <button class="pill done-btn" id="kmDone" type="button" style="display:none;">Done</button>
        <button class="km-sound" id="kmSound" type="button" aria-pressed="true" title="Toggle bell"></button>
      </div>
      <div class="km-summary" id="kmSummary" style="display:none;"></div>
    </div>

    <div class="sec-head" style="margin-top:26px;">
      <div><h2 style="font-size:16px;">Your sessions</h2><div class="desc" id="kmTotals"></div></div>
    </div>
    <div id="kmHistory"></div>`;

  const unitEl = document.getElementById('kmUnit');
  const setUnit = v=>{
    v = Math.min(MAX_UNIT, Math.max(MIN_UNIT, Math.round(+v || 5)));
    unitEl.value = v;
    data().kumbhakUnit = v;
    ctx.save();
    renderPlan();
  };
  unitEl.addEventListener('change', ()=> setUnit(unitEl.value));
  document.getElementById('kmMinus').addEventListener('click', ()=> setUnit((+unitEl.value||5) - 1));
  document.getElementById('kmPlus').addEventListener('click', ()=> setUnit((+unitEl.value||5) + 1));
  document.querySelectorAll('#kmChips .km-chip').forEach(b=> b.addEventListener('click', ()=> setUnit(b.dataset.u)));
  document.getElementById('kmStart').addEventListener('click', startSession);
  document.getElementById('kmDone').addEventListener('click', finishSession);
  document.getElementById('kmSound').addEventListener('click', ()=>{
    soundOn = !soundOn;
    try{ localStorage.setItem('tt-kumbhak-sound', soundOn ? 'on' : 'off'); }catch(e){ /* private mode */ }
    renderSound();
    if(soundOn && session){ getAudio(); session.scheduled.clear(); scheduleBells(); }
  });
  built = true;
}

function currentUnit(){
  const v = Math.round(+document.getElementById('kmUnit').value);
  return v >= MIN_UNIT && v <= MAX_UNIT ? v : 5;
}

function renderSound(){
  const b = document.getElementById('kmSound');
  b.textContent = soundOn ? '🔔 Bell on' : '🔕 Bell off';
  b.setAttribute('aria-pressed', String(soundOn));
}

function renderPlan(){
  const u = currentUnit();
  const names = ['Inhale', 'Hold', 'Exhale', 'Hold'];
  document.getElementById('kmSteps').innerHTML = RATIO.map((r,i)=>
    `<div class="km-step ${PHASES[i].cls}" data-i="${i}"><b>${r * u}s</b><span>${names[i]}</span><small>×${r}</small></div>`).join('');
  document.getElementById('kmPlan').textContent =
    `${RATIO.join(' : ')}  →  ${RATIO.map(r=>r*u).join(' · ')} seconds  (${CYCLE_UNITS * u}s per round)`;
}

export function renderKumbhakTab(){
  buildDom();
  const unitEl = document.getElementById('kmUnit');
  if(!session) unitEl.value = data().kumbhakUnit || 5;
  renderPlan();
  renderSound();
  renderHistory();
}

function renderHistory(){
  const list = data().kumbhak.slice().sort((a,b)=>b.ts-a.ts);
  const today = ctx.todayStr();
  const todayRounds = list.filter(s=>s.date===today).reduce((a,s)=>a+s.rounds, 0);
  const total = list.reduce((a,s)=>a+s.rounds, 0);
  document.getElementById('kmTotals').textContent = list.length
    ? `Today: ${todayRounds} round${todayRounds===1?'':'s'} · All time: ${total}`
    : '';
  const el = document.getElementById('kmHistory');
  if(!list.length){ el.innerHTML = '<div class="empty-note">Completed sessions will be listed here.</div>'; return; }
  el.innerHTML = list.slice(0, 30).map(s=>`
    <div class="km-hist">
      <div><b>${s.rounds}</b> round${s.rounds===1?'':'s'}<span class="km-hist-sub"> · ${s.unit}s unit · ${ctx.fmtShort(s.seconds)}</span></div>
      <div class="km-hist-date">${esc(prettyDate(s.date))}</div>
      <button class="edit-icon-btn" data-del="${esc(s.id)}" title="Delete" aria-label="Delete session">🗑</button>
    </div>`).join('');
  el.querySelectorAll('[data-del]').forEach(b=> b.addEventListener('click', ()=>{
    data().kumbhak = data().kumbhak.filter(s=>s.id!==b.dataset.del);
    ctx.save();
    renderHistory();
  }));
}

/* ---------- session ---------- */
async function acquireWakeLock(){
  try{
    if('wakeLock' in navigator && session){
      session.wake = await navigator.wakeLock.request('screen');
    }
  }catch(e){ /* not available / denied — not essential */ }
}

function startSession(){
  if(session) return;
  const unit = currentUnit();
  data().kumbhakUnit = unit;
  getAudio();     // must be created/resumed inside the click for iOS/Safari
  session = { t0: Date.now(), unit, scheduled: new Set(), timer: null, wake: null, lastIdx: -1, lastRounds: 0 };
  lastSummary = null;
  document.getElementById('kmSummary').style.display = 'none';
  document.getElementById('kmStart').style.display = 'none';
  document.getElementById('kmDone').style.display = '';
  document.getElementById('kmSetup').classList.add('locked');
  document.getElementById('kmStage').classList.add('running');
  document.querySelectorAll('#kmUnit,#kmMinus,#kmPlus,.km-chip').forEach(el=> el.disabled = true);
  acquireWakeLock();
  scheduleBells();
  tick();
  session.timer = setInterval(tick, 100);
}

function tick(){
  if(!session) return;
  const { unit } = session;
  const elapsed = (Date.now() - session.t0) / 1000;
  scheduleBells();
  const p = phaseAt(elapsed, unit);
  const ph = PHASES[p.idx];

  document.getElementById('kmPhase').textContent = ph.label;
  document.getElementById('kmSub').textContent = ph.sub;
  document.getElementById('kmCount').textContent = Math.ceil(p.left - 0.001);
  document.getElementById('kmRounds').textContent = p.rounds;
  document.getElementById('kmRingFg').style.strokeDashoffset = 100 - (p.into / p.len) * 100;
  document.querySelectorAll('#kmSteps .km-step').forEach(s=> s.classList.toggle('on', +s.dataset.i === p.idx));

  if(p.idx !== session.lastIdx){
    session.lastIdx = p.idx;
    const orb = document.getElementById('kmOrb');
    orb.className = 'km-orb ' + ph.cls;
    orb.style.transition = `transform ${p.len - p.into}s linear`;
    orb.style.transform = `scale(${ph.scale})`;
    if(navigator.vibrate) try{ navigator.vibrate(40); }catch(e){ /* unsupported */ }
  }
  if(p.rounds > session.lastRounds){
    session.lastRounds = p.rounds;
    document.getElementById('kmRounds').classList.remove('pop');
    void document.getElementById('kmRounds').offsetWidth;   // restart the animation
    document.getElementById('kmRounds').classList.add('pop');
  }
}

function endTimers(){
  if(!session) return;
  clearInterval(session.timer);
  try{ if(session.wake) session.wake.release(); }catch(e){ /* already released */ }
}

function resetStageUi(){
  if(!built) return;
  document.getElementById('kmStart').style.display = '';
  document.getElementById('kmDone').style.display = 'none';
  document.getElementById('kmSetup').classList.remove('locked');
  document.getElementById('kmStage').classList.remove('running');
  document.querySelectorAll('#kmUnit,#kmMinus,#kmPlus,.km-chip').forEach(el=> el.disabled = false);
  document.getElementById('kmPhase').textContent = 'Ready';
  document.getElementById('kmCount').textContent = '—';
  document.getElementById('kmSub').textContent = 'Press start';
  document.getElementById('kmRingFg').style.strokeDashoffset = 100;
  document.getElementById('kmRounds').textContent = '0';
  const orb = document.getElementById('kmOrb');
  orb.className = 'km-orb';
  orb.style.transition = 'transform 0.6s ease';
  orb.style.transform = '';
  document.querySelectorAll('#kmSteps .km-step').forEach(s=> s.classList.remove('on'));
}

function finishSession(){
  if(!session) return;
  const { t0, unit } = session;
  const seconds = Math.round((Date.now() - t0) / 1000);
  const rounds = Math.floor(seconds / (CYCLE_UNITS * unit));
  endTimers();
  session = null;
  // Silence any bells already queued for the future.
  if(audioCtx){ try{ audioCtx.close(); }catch(e){ /* ignore */ } audioCtx = null; }
  resetStageUi();
  const box = document.getElementById('kmSummary');
  if(rounds > 0){
    data().kumbhak.push({ id: ctx.uid(), date: ctx.todayStr(), ts: Date.now(), unit, rounds, seconds });
    ctx.save();
    box.innerHTML = `<div class="km-sum-ico">🪔</div>
      <div class="km-sum-big">${rounds} round${rounds===1?'':'s'}</div>
      <div>of Kumbhak Pranayama completed</div>
      <div class="km-sum-sub">1 : 4 : 2 : 2 · ${unit}s unit · ${ctx.fmtShort(seconds)} total</div>`;
  }else{
    box.innerHTML = `<div class="km-sum-ico">🌿</div>
      <div class="km-sum-big">0 rounds</div>
      <div class="km-sum-sub">A round takes ${CYCLE_UNITS * unit}s with a ${unit}s unit — nothing was saved.</div>`;
  }
  box.style.display = '';
  renderHistory();
}

// Called on profile switch / sign-out.
export function resetKumbhak(){
  if(session){
    endTimers();
    session = null;
    if(audioCtx){ try{ audioCtx.close(); }catch(e){ /* ignore */ } audioCtx = null; }
  }
  built = false;
}
