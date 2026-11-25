// The printer's status, shown beside Print buttons.
// Any element with data-printer-status gets a pill by itself ("compact": a dot and one word).
// One check is shared by every pill, and checking stops when no pill is on screen.
const PS_POLL_MS = 120000;
const PS_LOOK = {
  ready:   { dot: '#16a34a', text: 'Printer ready',           short: 'Ready' },
  offline: { dot: '#dc2626', text: 'Printer offline',         short: 'Offline' },
  warn:    { dot: '#d97706', text: 'Printer needs attention', short: 'Check printer' },
  email:   { dot: '#64748b', text: 'Printing by email',       short: 'By email' },
  none:    { dot: '#94a3b8', text: 'No printer set up',       short: 'No printer' },
  unknown: { dot: '#94a3b8', text: 'Checking printer…',       short: 'Checking…' },
};
let psApi = null;
let psState = null;
let psBusy = false;
let psTimer = 0;
let psLast = 0;
let psObserver = null;
const psSubs = new Set();

// Once, after login: how to ask Apps Script. api(body) → Promise of the answer for action "printStatus".
export function setPrinterStatusApi(api) {
  psApi = api;
  psStyles();
  psScan(document.body);
  if (psObserver) return;   // already watching (logged out and back in)
  psObserver = new MutationObserver((list) => {
    list.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) psScan(n); }));
  });
  psObserver.observe(document.body, { childList: true, subtree: true });
}

// Or mount one by hand: mountPrinterStatus(el, true) for the compact version
export function mountPrinterStatus(el, compact) {
  if (!el || el.__ps) return;
  el.__ps = true;
  psStyles();
  const pill = document.createElement('button');
  pill.type = 'button';
  pill.className = 'ps-pill' + (compact ? ' ps-compact' : '');
  pill.setAttribute('aria-live', 'polite');
  pill.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); refreshPrinterStatus(true); });
  el.replaceChildren(pill);
  const draw = () => {
    if (!pill.isConnected) { psSubs.delete(draw); if (!psSubs.size) psStop(); return; }   // the screen was closed
    psDraw(pill, compact);
  };
  psSubs.add(draw);
  draw();
  psStart();
}

// After printing, or with true to skip the server's one-minute memory
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
  psLast = Date.now();
  psBusy = false;
  psSubs.forEach((f) => f());
}

function psScan(root) {
  const list = root.matches && root.matches('[data-printer-status]') ? [root] : [];
  root.querySelectorAll && root.querySelectorAll('[data-printer-status]').forEach((el) => list.push(el));
  list.forEach((el) => mountPrinterStatus(el, el.getAttribute('data-printer-status') !== 'full'));
}

function psStart() {
  if (psTimer) return;
  if (Date.now() - psLast > 30000) refreshPrinterStatus(false);   // a print screen just opened
  psTimer = setInterval(() => {
    psSubs.forEach((f) => f());   // drops pills whose screen was closed
    if (psSubs.size && !document.hidden) refreshPrinterStatus(false);
  }, PS_POLL_MS);
}
function psStop() { clearInterval(psTimer); psTimer = 0; }

function psDraw(pill, compact) {
  const s = psState || { status: 'unknown' };
  const look = PS_LOOK[s.status] || PS_LOOK.unknown;
  const dot = document.createElement('span');
  dot.className = 'ps-dot';
  dot.style.background = look.dot;
  const text = document.createElement('span');
  text.textContent = compact ? look.short : look.text;
  pill.replaceChildren(dot, text);
  pill.classList.toggle('ps-busy', psBusy);
  const when = s.at ? new Date(s.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  pill.title = [s.message || look.text, when ? 'Checked ' + when + '.' : '', 'Click to check again.'].filter(Boolean).join('\n');
}

function psStyles() {
  if (document.getElementById('ps-styles-2')) return;
  const st = document.createElement('style');
  st.id = 'ps-styles-2';
  st.textContent = `
    .ps-pill { display:inline-flex; align-items:center; gap:6px; padding:3px 10px; border:1px solid #e2e8f0;
      border-radius:999px; background:#fff; font:500 12px/1.4 inherit; color:#334155; cursor:pointer;
      white-space:nowrap; vertical-align:middle; }
    .ps-pill:hover { background:#f8fafc; }
    .ps-compact { padding:2px 8px; font-size:11px; gap:5px; margin-left:6px; }
    .ps-dot { width:8px; height:8px; border-radius:50%; flex:none; }
    .ps-busy .ps-dot { animation: ps-pulse 1s ease-in-out infinite; }
    @keyframes ps-pulse { 50% { opacity:.3; } }
  `;
  document.head.appendChild(st);
}