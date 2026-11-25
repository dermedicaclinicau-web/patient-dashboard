// The printer's status: a small pill. One check is shared by every pill on the page.
const PS_POLL_MS = 120000;
const PS_LOOK = {
  ready:   { dot: '#16a34a', text: 'Printer ready' },
  offline: { dot: '#dc2626', text: 'Printer offline' },
  warn:    { dot: '#d97706', text: 'Printer needs attention' },
  email:   { dot: '#64748b', text: 'Printing by email' },
  none:    { dot: '#94a3b8', text: 'No printer set up' },
  unknown: { dot: '#94a3b8', text: 'Checking printer…' },
};
let psApi = null;
let psState = null;
let psBusy = false;
let psTimer = 0;
const psSubs = new Set();

// el: where it goes. api(body) → Promise of the Apps Script answer for action "printStatus".
export function mountPrinterStatus(el, api) {
  if (!el) return () => {};
  if (api) psApi = api;
  psStyles();
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'ps-pill';
  pill.setAttribute('aria-live', 'polite');
  pill.addEventListener('click', () => refreshPrinterStatus(true));
  el.replaceChildren(pill);
  const draw = () => psDraw(pill);
  psSubs.add(draw);
  draw();
  psStart();
  return () => { psSubs.delete(draw); pill.remove(); if (!psSubs.size) psStop(); };
}

// Call after printing, or with true to skip the server's one-minute memory
export async function refreshPrinterStatus(fresh) {
  if (!psApi || psBusy) return;
  psBusy = true;
  psSubs.forEach((f) => f());
  try {
    const r = await psApi({ fresh: fresh === true });
    psState = r && r.ok ? r : { status: 'warn', message: "The printer's status couldn't be checked." };
  } catch (e) {
    psState = { status: 'warn', message: "The printer's status couldn't be checked." };
  }
  psBusy = false;
  psSubs.forEach((f) => f());
}

function psStart() {
  if (psTimer) return;
  refreshPrinterStatus(false);
  psTimer = setInterval(() => { if (!document.hidden) refreshPrinterStatus(false); }, PS_POLL_MS);
  document.addEventListener('visibilitychange', psOnShow);
}
function psStop() {
  clearInterval(psTimer);
  psTimer = 0;
  document.removeEventListener('visibilitychange', psOnShow);
}
function psOnShow() { if (!document.hidden) refreshPrinterStatus(false); }

function psDraw(pill) {
  const s = psState || { status: 'unknown' };
  const look = PS_LOOK[s.status] || PS_LOOK.unknown;
  const dot = document.createElement('span');
  dot.className = 'ps-dot';
  dot.style.background = look.dot;
  const text = document.createElement('span');
  text.textContent = look.text;
  pill.replaceChildren(dot, text);
  pill.classList.toggle('ps-busy', psBusy);
  const when = s.at ? new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  pill.title = [s.message || '', when ? 'Checked ' + when + '.' : '', 'Click to check again.'].filter(Boolean).join('\n');
}

function psStyles() {
  if (document.getElementById('ps-styles-1')) return;
  const st = document.createElement('style');
  st.id = 'ps-styles-1';
  st.textContent = `
    .ps-pill { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border:1px solid #e2e8f0;
      border-radius:999px; background:#fff; font:500 12px/1.4 inherit; color:#334155; cursor:pointer; white-space:nowrap; }
    .ps-pill:hover { background:#f8fafc; }
    .ps-dot { width:8px; height:8px; border-radius:50%; flex:none; }
    .ps-busy .ps-dot { animation: ps-pulse 1s ease-in-out infinite; }
    @keyframes ps-pulse { 50% { opacity:.3; } }
  `;
  document.head.appendChild(st);
}