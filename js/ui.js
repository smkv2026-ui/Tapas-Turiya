// Tiny shared UI helpers for the Tapas Turiya tab modules.

let toastEl = null, toastTimer = null;

export function toast(msg){
  if(!toastEl){
    toastEl = document.createElement('div');
    toastEl.className = 'tt-toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=> toastEl.classList.remove('show'), 2600);
}

export function fmtClock(sec){
  sec = Math.max(0, Math.floor(sec || 0));
  return Math.floor(sec/60) + ':' + String(sec%60).padStart(2,'0');
}

export function prettyDate(dateStr){
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric', year:'numeric' });
}
