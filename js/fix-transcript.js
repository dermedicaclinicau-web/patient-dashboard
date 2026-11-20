// Notes → Fix transcript: the whole transcript as a conversation. Staff choose sentences, then keep them,
// move them to another patient, or mark them as not needed.
// Apps Script does all the saving (action "transcriptFix", TranscriptFix.gs). This file only shows and chooses.
//
// openFixTranscript({ recordId, api, onDone, onOpenRecord })
//   api(action, body)        → Promise of Apps Script's reply (the portal's own call, which adds the session)
//   onDone(result)           → after a save, so the notes panel can reload
//   onOpenRecord(recordId)   → optional: opens another record's notes ("Open Mark Brown's notes")

const WHY = [['chitchat', 'Chit-chat'], ['staff', 'Talking to staff'], ['lefton', 'Recording left on'], ['other', 'Other']];
const WHY_NAME = Object.fromEntries(WHY);
const COL = { keep: '#0F766E', move: '#7C3AED', drop: '#CBD5E1' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const range = (a, b) => { const out = []; for (let k = Math.min(a, b); k <= Math.max(a, b); k++) out.push(k); return out; };
const dayText = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(k || '')
  ? new Date(`${k}T12:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '');

const svg = (p, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>', 15),
  spark: svg('<path d="M12 3l1.8 4.7 4.7 1.8-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>', 15),
  up: svg('<polyline points="18 15 12 9 6 15"/>', 14),
  down: svg('<polyline points="6 9 12 15 18 9"/>', 14),
  keep: svg('<polyline points="20 6 9 17 4 12"/>'),
  move: svg('<line x1="5" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>'),
  drop: svg('<circle cx="12" cy="12" r="9"/><line x1="8" y1="12" x2="16" y2="12"/>'),
  alert: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>', 15),
  done: svg('<circle cx="12" cy="12" r="10"/><polyline points="8 12 11 15 16 9"/>', 28),
};

const CSS = `
.fx-root{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,0);transition:background .22s ease;color:#0F172A;font-family:inherit}
.fx-root.in{background:rgba(15,23,42,.5)}
.fx-dlg{background:#fff;border-radius:18px;width:min(1240px,100%);height:min(900px,100%);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(15,23,42,.28);opacity:0;transform:translateY(12px) scale(.985);transition:opacity .24s ease,transform .24s ease}
.fx-root.in .fx-dlg{opacity:1;transform:none}
.fx-hd{display:flex;align-items:center;gap:20px;padding:16px 22px;border-bottom:1px solid #EEF2F6}
.fx-title{font-size:17px;font-weight:600;letter-spacing:-.01em}
.fx-meta{font-size:13px;color:#64748B;margin-top:2px}
.fx-mix{width:230px}
.fx-mixbar{display:flex;height:8px;border-radius:999px;overflow:hidden;background:#F1F5F9}
.fx-mixbar>i{display:block;height:100%;transition:width .35s ease}
.fx-mixleg{display:flex;gap:12px;font-size:12px;color:#475569;margin-top:7px;white-space:nowrap}
.fx-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px}
.fx-iconbtn{width:34px;height:34px;border-radius:10px;border:1px solid #E2E8F0;background:#fff;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;color:#475569;transition:background .15s,border-color .15s;flex:none}
.fx-iconbtn:hover{background:#F8FAFC;border-color:#CBD5E1}
.fx-tools{display:flex;align-items:center;gap:8px;padding:10px 22px;border-bottom:1px solid #EEF2F6;background:#FBFCFD;flex-wrap:wrap}
.fx-search{position:relative;flex:1;min-width:200px;max-width:400px}
.fx-search>svg{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#94A3B8}
.fx-search input{width:100%;box-sizing:border-box;height:36px;padding:0 96px 0 34px;border:1px solid #E2E8F0;border-radius:10px;font:inherit;font-size:14px;background:#fff;transition:border-color .15s,box-shadow .15s}
.fx-search input:focus,.fx-input:focus,.fx-ta:focus{outline:none;border-color:#0F766E;box-shadow:0 0 0 3px rgba(15,118,110,.15)}
.fx-hits{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:2px;font-size:12px;color:#64748B}
.fx-hits button{border:0;background:none;width:24px;height:24px;border-radius:6px;cursor:pointer;color:#475569;display:inline-flex;align-items:center;justify-content:center}
.fx-hits button:hover{background:#F1F5F9}
.fx-btn{display:inline-flex;align-items:center;gap:7px;height:36px;padding:0 14px;border:1px solid #E2E8F0;background:#fff;border-radius:10px;font:inherit;font-size:14px;color:#0F172A;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,box-shadow .15s,transform .06s}
.fx-btn:hover:not(:disabled){background:#F8FAFC;border-color:#CBD5E1}
.fx-btn:active:not(:disabled),.fx-tile:active:not(:disabled){transform:translateY(1px)}
.fx-btn:disabled{opacity:.45;cursor:not-allowed}
.fx-btn:focus-visible,.fx-tile:focus-visible,.fx-iconbtn:focus-visible,.fx-chip:focus-visible,.fx-res:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(15,118,110,.25)}
.fx-pri{background:#0F766E;border-color:#0F766E;color:#fff}
.fx-pri:hover:not(:disabled){background:#115E59;border-color:#115E59}
.fx-ai{color:#0F766E;border-color:#99F6E4;background:#F0FDFA}
.fx-ai:hover:not(:disabled){background:#CCFBF1;border-color:#5EEAD4}
.fx-body{display:flex;flex:1;min-height:0}
.fx-mapcol{width:20px;flex:none;padding:14px 0 14px 10px}
.fx-map{position:relative;height:100%;display:flex;flex-direction:column;gap:1px;cursor:pointer}
.fx-map>i{flex:1;min-height:1px;border-radius:2px;background:#99F6E4;transition:background .25s}
.fx-map>i.b{background:${COL.move}}.fx-map>i.x{background:${COL.drop}}.fx-map>i.sel{background:${COL.keep}}
.fx-view{position:absolute;left:-3px;right:-3px;border:1.5px solid rgba(15,23,42,.45);border-radius:4px;pointer-events:none;transition:top .08s linear,height .08s linear}
.fx-list{flex:1;min-width:0;overflow:auto;padding:18px 28px 48px;scroll-behavior:smooth}
.fx-turn{display:flex;gap:10px;margin:0 0 14px;max-width:800px}
.fx-turn.p{flex-direction:row-reverse;margin-left:auto}
.fx-av{flex:none;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;letter-spacing:.02em}
.fx-turn.c .fx-av{background:#CCFBF1;color:#115E59}.fx-turn.p .fx-av{background:#E2E8F0;color:#334155}.fx-turn.o .fx-av{background:#FEF3C7;color:#92400E}
.fx-tb{min-width:0;max-width:calc(100% - 42px)}
.fx-who{font-size:12px;color:#64748B;margin:0 0 4px;display:flex;align-items:center;gap:10px}
.fx-turn.p .fx-who{justify-content:flex-end}
.fx-who button{border:0;background:none;padding:0;font:inherit;font-size:12px;font-weight:600;color:#0F766E;cursor:pointer;opacity:0;transition:opacity .15s}
.fx-turn:hover .fx-who button,.fx-who button:focus-visible{opacity:1}
.fx-bub{border-radius:16px;padding:8px 13px;font-size:15px;line-height:1.8;border:1px solid transparent;user-select:none;transition:border-color .25s,opacity .25s}
.fx-turn.c .fx-bub{background:#F0FDFA;border-color:#CCFBF1;border-top-left-radius:5px}
.fx-turn.p .fx-bub{background:#F8FAFC;border-color:#E2E8F0;border-top-right-radius:5px}
.fx-turn.o .fx-bub{background:#FFFBEB;border-color:#FEF3C7;border-top-left-radius:5px}
.fx-turn.has-b .fx-bub{border-color:#C4B5FD}
.fx-turn.all-x .fx-bub{opacity:.55}
.fx-s{padding:2px 3px;margin:0 -1px;border-radius:6px;cursor:pointer;-webkit-box-decoration-break:clone;box-decoration-break:clone;transition:background .15s,color .15s,box-shadow .15s}
.fx-s:hover{background:rgba(15,23,42,.07)}
.fx-s.b{background:rgba(124,58,237,.14);color:#4C1D95}
.fx-s.x{color:#94A3B8;text-decoration:line-through}
.fx-s.sug{text-decoration:underline dashed #F59E0B;text-underline-offset:5px}
.fx-s.hit{background:rgba(250,204,21,.4)}
.fx-s.hit.cur{background:#FACC15;color:#0F172A}
.fx-s.sel{background:#CCFBF1;color:#134E4A;box-shadow:0 0 0 2px ${COL.keep}}
.fx-list.ro .fx-s{cursor:default}.fx-list.ro .fx-s:hover{background:none}.fx-list.ro .fx-who button{display:none}
.fx-tag{display:inline-block;margin:0 4px;padding:0 8px;border-radius:999px;font-size:11px;line-height:18px;background:#F1F5F9;color:#64748B;vertical-align:1px}
.fx-div,.fx-sep{display:flex;align-items:center;gap:12px;margin:20px 0;font-size:12px;font-weight:600;animation:fx-in .3s ease}
.fx-div{color:#6D28D9}.fx-sep{color:#B45309;font-weight:500}
.fx-div::before,.fx-div::after{content:"";flex:1;border-top:1.5px dashed #C4B5FD}
.fx-sep::before,.fx-sep::after{content:"";flex:1;border-top:1px solid #FDE68A}
.fx-side{width:340px;flex:none;border-left:1px solid #EEF2F6;padding:20px;overflow:auto;background:#FBFCFD}
.fx-h{font-size:15px;font-weight:600;margin:0 0 12px}
.fx-help{font-size:13px;color:#64748B;line-height:1.6;margin:0 0 14px;padding:10px 12px;border:1px dashed #E2E8F0;border-radius:12px;background:#fff}
.fx-tile{display:flex;align-items:center;gap:12px;width:100%;text-align:left;padding:11px 12px;margin:0 0 8px;border:1px solid #E2E8F0;border-radius:14px;background:#fff;font:inherit;font-size:14px;cursor:pointer;color:#0F172A;transition:border-color .15s,background .15s,transform .06s}
.fx-tile:hover:not(:disabled){border-color:#CBD5E1;background:#F8FAFC}
.fx-tile:disabled{opacity:.45;cursor:not-allowed}
.fx-tile .ic{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;flex:none}
.fx-tile .tx{flex:1;min-width:0}
.fx-tile .tx b{font-weight:600;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fx-tile small{display:block;font-size:12px;color:#64748B;margin-top:1px}
kbd.fx-k{font:inherit;font-size:11px;color:#64748B;border:1px solid #E2E8F0;border-bottom-width:2px;border-radius:5px;padding:0 6px;background:#fff}
.fx-chips{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 14px;animation:fx-in .2s ease}
.fx-chip{height:32px;padding:0 13px;border:1px solid #E2E8F0;border-radius:999px;background:#fff;font:inherit;font-size:13px;cursor:pointer;transition:background .15s,border-color .15s}
.fx-chip:hover{background:#F1F5F9;border-color:#CBD5E1}
.fx-card{border:1px solid #E2E8F0;border-radius:14px;background:#fff;padding:12px 14px;margin:0 0 12px;font-size:14px;line-height:1.55}
.fx-note{padding:10px 12px;border-radius:12px;font-size:14px;line-height:1.55}
.fx-banner{margin:12px 22px 0;display:flex;gap:10px;align-items:flex-start;animation:fx-in .25s ease}
.fx-link{background:none;border:0;padding:0;color:#0F766E;font:inherit;font-weight:600;cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.fx-res{display:block;width:100%;text-align:left;padding:10px 12px;margin:0 0 6px;border:1px solid #E2E8F0;border-radius:12px;background:#fff;font:inherit;cursor:pointer;transition:border-color .15s,background .15s}
.fx-res:hover{border-color:#5EEAD4;background:#F0FDFA}
.fx-input{width:100%;box-sizing:border-box;height:40px;padding:0 12px;border:1px solid #E2E8F0;border-radius:10px;font:inherit;font-size:14px;margin:0 0 10px}
.fx-ta{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #E2E8F0;border-radius:12px;font:inherit;font-size:14px;resize:vertical;min-height:84px;margin:0 0 10px}
.fx-sum{list-style:none;margin:0 0 16px;padding:0}
.fx-sum li{display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.55;margin:0 0 10px}
.fx-sum .fx-dot{margin-top:7px;flex:none}
.fx-ft{display:flex;align-items:center;gap:10px;padding:14px 22px;border-top:1px solid #EEF2F6}
.fx-ftx{flex:1;font-size:13px;color:#64748B}
.fx-spin{width:20px;height:20px;border-radius:50%;border:2px solid #CCFBF1;border-top-color:${COL.keep};animation:fx-rot .8s linear infinite;flex:none}
.fx-flash{animation:fx-flash 1.1s ease}
.fx-empty{padding:28px;color:#64748B;display:flex;align-items:center;gap:12px}
@keyframes fx-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
@keyframes fx-rot{to{transform:rotate(360deg)}}
@keyframes fx-flash{0%{box-shadow:0 0 0 0 rgba(15,118,110,.45)}100%{box-shadow:0 0 0 14px rgba(15,118,110,0)}}
@media (prefers-reduced-motion:reduce){.fx-root,.fx-root *{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
@media (max-width:860px){.fx-body{flex-direction:column}.fx-side{width:auto;border-left:0;border-top:1px solid #EEF2F6;max-height:46%}.fx-mapcol,.fx-mix{display:none}.fx-list{padding:14px}.fx-hd,.fx-tools,.fx-ft{padding-left:14px;padding-right:14px}}
`;

function initials(who, kind) {
  if (kind === 'p') return 'P';
  const sp = /^speaker\s*(\d+)$/i.exec(String(who || '').trim());
  if (sp) return `S${sp[1]}`;
  const w = String(who || '').replace(/^(dr|mr|mrs|ms|miss)\.?\s+/i, '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase();
}

export function openFixTranscript({ recordId, api, onDone, onOpenRecord }) {
  const S = {
    step: 'loading', lines: [], sig: '', info: {}, mark: [], why: {}, sel: new Set(), anchor: -1,
    els: [], segs: [], turns: [], turnOf: [], turnEls: [], drag: null,
    target: null, picking: false, moveAfterPick: false, askWhy: false, q: '', res: null,
    sugX: new Set(), suggestName: '', banner: null, reason: '', err: '', result: null,
    hits: new Set(), hitList: [], hitPos: -1, curHit: -1,
  };
  const prevFocus = document.activeElement;

  if (!document.getElementById('fx-css-v2')) {
    const st = document.createElement('style');
    st.id = 'fx-css-v2';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const root = document.createElement('div');
  root.className = 'fx-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Fix transcript');
  root.innerHTML = `<div class="fx-dlg" tabindex="-1">
    <div class="fx-hd" data-hd></div>
    <div class="fx-tools" data-tools hidden></div>
    <div data-banner></div>
    <div class="fx-body">
      <div class="fx-mapcol" data-mapcol hidden><div class="fx-map" data-map title="The whole recording. Click to jump there."></div></div>
      <div class="fx-list" data-list></div>
      <aside class="fx-side" data-side></aside>
    </div>
    <div class="fx-ft" data-ft></div>
  </div>`;
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add('in'));
  const $ = (s) => root.querySelector(s);
  const dlg = $('.fx-dlg'), head = $('[data-hd]'), tools = $('[data-tools]'), bannerEl = $('[data-banner]');
  const mapcol = $('[data-mapcol]'), map = $('[data-map]'), list = $('[data-list]'), side = $('[data-side]'), foot = $('[data-ft]');
  let view = null;
  dlg.focus();

  const nameA = () => S.info.patientName || 'this patient';
  const counts = () => {
    let a = 0, b = 0, x = 0;
    S.mark.forEach((m) => (m === 'b' ? b++ : m === 'x' ? x++ : a++));
    return { a, b, x };
  };

  /* ---------- The transcript as a conversation ---------- */

  function build() {
    const turns = [];
    let cur = null;
    S.lines.forEach((l, i) => {
      const k = `${l.part}|${l.para}`;
      if (!cur || cur.k !== k) { cur = { k, part: l.part, who: l.who, staff: l.staff, start: i, end: i }; turns.push(cur); }
      else cur.end = i;
      S.turnOf[i] = turns.length - 1;
    });
    S.turns = turns;
    let h = '', lastPart = -1;
    turns.forEach((t, ti) => {
      if (lastPart !== -1 && t.part !== lastPart) h += '<div class="fx-sep">Next recording</div>';
      lastPart = t.part;
      const kind = t.staff ? 'c' : /^patient$/i.test(String(t.who || '').trim()) ? 'p' : 'o';
      let s = '';
      for (let i = t.start; i <= t.end; i++) s += `<span class="fx-s" data-i="${i}"></span> `;
      h += `<div class="fx-turn ${kind}" data-t="${ti}">
        <div class="fx-av" aria-hidden="true">${esc(initials(t.who, kind))}</div>
        <div class="fx-tb"><div class="fx-who"><span>${esc(t.who || 'Speaker')}</span>
          <button type="button" data-turnsel="${ti}">Select turn</button></div>
          <div class="fx-bub">${s}</div></div></div>`;
    });
    list.innerHTML = h;
    S.els = [...list.querySelectorAll('.fx-s')];
    S.turnEls = [...list.querySelectorAll('.fx-turn')];
    map.innerHTML = S.lines.map(() => '<i></i>').join('') + '<div class="fx-view"></div>';
    S.segs = [...map.querySelectorAll('i')];
    view = map.querySelector('.fx-view');
    S.lines.forEach((_, i) => paint(i, true));
    S.turns.forEach((_, t) => paintTurn(t));
    placeDivider();
    requestAnimationFrame(syncView);
  }

  function paint(i, skipTurn) {
    const el = S.els[i];
    if (!el) return;
    const m = S.mark[i];
    el.className = `fx-s${m === 'b' ? ' b' : m === 'x' ? ' x' : ''}${S.sugX.has(i) ? ' sug' : ''}${S.hits.has(i) ? ' hit' : ''}${
      S.curHit === i ? ' cur' : ''}${S.sel.has(i) ? ' sel' : ''}`;
    const html = esc(S.lines[i].text) + (m === 'x' ? `<span class="fx-tag">${esc(WHY_NAME[S.why[i]] || 'Not needed')}</span>` : '');
    if (el.dataset.h !== html) { el.innerHTML = html; el.dataset.h = html; }
    S.segs[i].className = S.sel.has(i) ? 'sel' : m === 'b' ? 'b' : m === 'x' ? 'x' : '';
    if (!skipTurn) paintTurn(S.turnOf[i]);
  }

  function paintTurn(t) {
    const T = S.turns[t], el = S.turnEls[t];
    if (!T || !el) return;
    let b = false, allX = true;
    for (let i = T.start; i <= T.end; i++) { if (S.mark[i] === 'b') b = true; if (S.mark[i] !== 'x') allX = false; }
    el.classList.toggle('has-b', b);
    el.classList.toggle('all-x', allX);
  }

  function placeDivider() {
    const old = list.querySelector('.fx-div');
    if (old) old.remove();
    const first = S.mark.indexOf('b');
    if (first < 0) return;
    const t = S.turnEls[S.turnOf[first]];
    if (!t) return;
    const d = document.createElement('div');
    d.className = 'fx-div';
    d.textContent = `${S.target ? S.target.name : 'The moved part'} starts here`;
    t.before(d);
  }

  function syncView() {
    if (!view) return;
    const H = map.clientHeight, sh = list.scrollHeight, ch = list.clientHeight;
    if (!H || sh <= ch + 2) { view.style.display = 'none'; return; }
    view.style.display = '';
    view.style.top = `${(list.scrollTop / sh) * H}px`;
    view.style.height = `${Math.max(14, (ch / sh) * H)}px`;
  }

  function jumpTo(i) {
    const el = S.els[i];
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    const b = S.turnEls[S.turnOf[i]] && S.turnEls[S.turnOf[i]].querySelector('.fx-bub');
    if (b) { b.classList.remove('fx-flash'); void b.offsetWidth; b.classList.add('fx-flash'); }
  }

  function setSel(next) {
    const changed = [...S.sel].filter((k) => !next.has(k)).concat([...next].filter((k) => !S.sel.has(k)));
    S.sel = next;
    changed.forEach((i) => paint(i));
  }

  /* ---------- Header, tools, banner ---------- */

  function drawHead() {
    const i = S.info;
    const before = (i.fixes || []).slice(-1)[0];
    head.innerHTML = `<div style="flex:1;min-width:0">
        <div class="fx-title">Fix transcript</div>
        <div class="fx-meta">${esc([i.patientName, i.recordDate, i.staffName].filter(Boolean).join(' · '))}${
          before ? ` · fixed before by ${esc(before.by)}` : ''}</div>
      </div>
      ${S.lines.length ? `<div class="fx-mix" aria-hidden="true">
        <div class="fx-mixbar"><i data-mk style="background:${COL.keep}"></i><i data-mm style="background:${COL.move}"></i><i data-mx style="background:${COL.drop}"></i></div>
        <div class="fx-mixleg" data-leg></div></div>` : ''}
      <button type="button" class="fx-iconbtn" data-act="close" aria-label="Close">${IC.x}</button>`;
    drawMix();
  }

  function drawMix() {
    const c = counts(), n = S.lines.length || 1;
    const set = (sel, v) => { const el = head.querySelector(sel); if (el) el.style.width = `${(v / n) * 100}%`; };
    set('[data-mk]', c.a); set('[data-mm]', c.b); set('[data-mx]', c.x);
    const leg = head.querySelector('[data-leg]');
    if (leg) {
      leg.innerHTML = `<span><span class="fx-dot" style="background:${COL.keep}"></span>Keep ${c.a}</span>
        <span><span class="fx-dot" style="background:${COL.move}"></span>Move ${c.b}</span>
        <span><span class="fx-dot" style="background:${COL.drop}"></span>Left out ${c.x}</span>`;
    }
  }

  function drawTools() {
    tools.hidden = false;
    tools.innerHTML = `<label class="fx-search">${IC.search}
        <input type="text" data-find placeholder="Find words, like a name" aria-label="Find words in the transcript" autocomplete="off">
        <span class="fx-hits" data-hits hidden><span data-hitn></span>
          <button type="button" data-hit="-1" aria-label="Previous match">${IC.up}</button>
          <button type="button" data-hit="1" aria-label="Next match">${IC.down}</button></span></label>
      <span style="flex:1"></span>
      <button type="button" class="fx-btn fx-ai" data-tool="find">${IC.spark}<span>Find where it changed patient</span></button>
      <button type="button" class="fx-btn" data-tool="end" title="Select from the first selected sentence to the end">From here to the end</button>
      <button type="button" class="fx-btn" data-tool="clear">Clear</button>`;
  }

  function drawBanner() {
    const b = S.banner;
    bannerEl.innerHTML = b ? `<div class="fx-banner fx-note" style="background:${b.warn ? '#FEF2F2' : '#F0FDFA'};color:${b.warn ? '#991B1B' : '#134E4A'};border:1px solid ${b.warn ? '#FECACA' : '#CCFBF1'}">
      <span style="margin-top:2px;flex:none">${b.warn ? IC.alert : IC.spark}</span><div style="flex:1">${b.html}</div>
      <button type="button" class="fx-iconbtn" data-act="bannerx" aria-label="Dismiss" style="width:26px;height:26px;border:0;background:transparent">${IC.x}</button></div>` : '';
  }

  /* ---------- Search ---------- */

  function runSearch(q) {
    const old = [...S.hits].concat([S.curHit]);
    S.hits = new Set();
    q = String(q || '').trim().toLowerCase();
    if (q.length >= 2) S.lines.forEach((l, i) => { if (l.text.toLowerCase().includes(q)) S.hits.add(i); });
    S.hitList = [...S.hits];
    S.hitPos = S.hitList.length ? 0 : -1;
    S.curHit = S.hitPos >= 0 ? S.hitList[0] : -1;
    new Set(old.concat(S.hitList)).forEach((i) => { if (i >= 0) paint(i); });
    updHits(q);
    if (S.curHit >= 0) jumpTo(S.curHit);
  }
  function stepHit(d) {
    if (!S.hitList.length) return;
    const prev = S.curHit;
    S.hitPos = (S.hitPos + d + S.hitList.length) % S.hitList.length;
    S.curHit = S.hitList[S.hitPos];
    paint(prev); paint(S.curHit);
    updHits(tools.querySelector('[data-find]').value.trim());
    jumpTo(S.curHit);
  }
  function updHits(q) {
    const box = tools.querySelector('[data-hits]');
    if (!box) return;
    box.hidden = String(q || '').length < 2;
    tools.querySelector('[data-hitn]').textContent = S.hitList.length ? `${S.hitPos + 1} of ${S.hitList.length}` : 'None';
  }

  /* ---------- Side panel ---------- */

  function resultsHtml() {
    const R = S.res;
    if (!R || R.loading) return '<div class="fx-empty" style="padding:12px 2px"><span class="fx-spin"></span>Looking…</div>';
    if (R.problem) return `<p class="fx-note" style="background:#FEF2F2;color:#991B1B">${esc(R.problem)}</p>`;
    const rows = R.results || [];
    if (!rows.length) {
      return `<p style="color:#64748B;font-size:13px">${R.mode === 'day' ? 'No other bookings that day. Search for the patient.' : 'No patients found.'}</p>`;
    }
    const sub = (p) => (R.mode === 'day'
      ? [p.time, p.staff, (p.services || []).join(', ')]
      : [p.dob ? `Born ${dayText(p.dob) || p.dob}` : '', p.mobile]).filter(Boolean).join(' · ');
    return `<div style="font-size:12px;color:#64748B;margin:0 0 6px">${R.mode === 'day' ? `Booked on ${esc(dayText(R.day))}` : 'Patients'}</div>` +
      rows.map((p) => `<button type="button" class="fx-res" data-act="pick" data-id="${esc(p.id)}" data-name="${esc(p.name)}">
        <div style="font-weight:600">${esc(p.name)}</div><div style="font-size:12px;color:#64748B">${esc(sub(p))}</div></button>`).join('');
  }
  const paintRes = () => { const r = side.querySelector('[data-res]'); if (r) r.innerHTML = resultsHtml(); };

  function tile(act, color, bg, icon, title, sub, key, dis) {
    return `<button type="button" class="fx-tile" data-act="${act}"${dis ? ' disabled' : ''}>
      <span class="ic" style="background:${bg};color:${color}">${icon}</span>
      <span class="tx"><b>${esc(title)}</b><small>${esc(sub)}</small></span><kbd class="fx-k">${key}</kbd></button>`;
  }

  function drawSide() {
    const c = counts();
    const n = S.sel.size;
    let h = '';
    if (S.step === 'edit' && S.picking) {
      h += `<div class="fx-h">${S.moveAfterPick ? `Who do ${n === 1 ? 'this line' : `these ${n} lines`} belong to?` : 'Who do the moved lines belong to?'}</div>
        <input class="fx-input" data-q type="text" placeholder="Search patients" value="${esc(S.q)}" aria-label="Search patients" autocomplete="off">
        <div data-res>${resultsHtml()}</div>
        <button type="button" class="fx-btn" data-act="pickcancel" style="margin-top:6px">Cancel</button>`;
    } else if (S.step === 'edit') {
      h += `<div class="fx-h">${n ? `${plural(n, 'sentence')} selected` : 'Choose sentences'}</div>`;
      if (!n) {
        h += `<div class="fx-help">Click a sentence to select it. Drag across sentences, or Shift-click, to select a run of them.
          Point at a bubble and press <b>Select turn</b> to take the whole thing.</div>`;
      }
      h += tile('keep', COL.keep, '#CCFBF1', IC.keep, `Keep with ${nameA()}`, 'Stays in these notes', 'K', !n);
      h += tile('move', COL.move, '#EDE9FE', IC.move, S.target ? `Move to ${S.target.name}` : 'Move to another patient',
        S.target ? 'Goes to their notes' : "You'll choose the patient next", 'M', !n);
      h += tile('drop', '#475569', '#F1F5F9', IC.drop, 'Not needed', "Left out of everyone's notes", 'N', !n);
      if (S.askWhy && n) {
        h += `<div style="font-size:13px;color:#475569;margin:6px 0 6px">Why isn't it needed?</div><div class="fx-chips">${
          WHY.map(([k, l]) => `<button type="button" class="fx-chip" data-act="why" data-why="${k}">${l}</button>`).join('')}</div>`;
      }
      if (S.target) {
        h += `<div class="fx-card" style="display:flex;align-items:center;gap:10px;margin-top:6px">
          <span class="fx-dot" style="background:${COL.move}"></span>
          <span style="flex:1">Moving to <b>${esc(S.target.name)}</b></span>
          <button type="button" class="fx-link" data-act="change">Change</button></div>`;
      }
      h += `<p style="font-size:12px;color:#94A3B8;line-height:1.6;margin:14px 0 0">Shortcuts: K keep · M move · N not needed · / find · Esc clear.
        The original transcript is always kept for Admins.</p>`;
    } else if (S.step === 'review') {
      const whyCount = {};
      Object.keys(S.why).forEach((i) => { if (S.mark[i] === 'x') whyCount[S.why[i]] = (whyCount[S.why[i]] || 0) + 1; });
      const whyText = Object.keys(whyCount).map((k) => `${whyCount[k]} ${(WHY_NAME[k] || 'other').toLowerCase()}`).join(', ');
      h += `<div class="fx-h">Check the changes</div>
        <ul class="fx-sum">
          <li><span class="fx-dot" style="background:${COL.keep}"></span><span><b>${esc(nameA())}</b> keeps ${plural(c.a, 'sentence')}. Their notes are written again from these.</span></li>
          ${c.b ? `<li><span class="fx-dot" style="background:${COL.move}"></span><span><b>${esc(S.target.name)}</b> gets ${plural(c.b, 'sentence')}. If they have Draft notes by ${
            esc(S.info.staffName || 'the same clinician')} that day, these join them. Otherwise they get new notes.</span></li>` : ''}
          ${c.x ? `<li><span class="fx-dot" style="background:${COL.drop}"></span><span>${plural(c.x, 'sentence')} left out: ${esc(whyText)}.</span></li>` : ''}
        </ul>
        <label for="fx-reason" style="display:block;font-size:13px;font-weight:600;margin:0 0 6px">Reason (needed)</label>
        <textarea id="fx-reason" class="fx-ta" data-reason rows="3" placeholder="Recording wasn't stopped after ${esc(nameA())}">${esc(S.reason)}</textarea>
        ${S.err ? `<p class="fx-note" style="background:#FEF2F2;color:#991B1B;margin:0 0 10px">${esc(S.err)}</p>` : ''}
        <p style="font-size:12px;color:#64748B;line-height:1.6;margin:0">The audio stays with ${esc(nameA())}'s record. The original transcript and notes are kept for Admins.</p>`;
    } else if (S.step === 'working') {
      h += `<div class="fx-h" style="display:flex;align-items:center;gap:10px"><span class="fx-spin"></span>Writing the notes</div>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0">${esc(nameA())}'s notes${
          counts().b ? ` and ${esc(S.target.name)}'s notes` : ''} are being written again. This can take a minute or two. Keep this window open.</p>`;
    } else if (S.step === 'done') {
      const r = S.result;
      h += `<div style="color:${COL.keep};margin:0 0 10px">${IC.done}</div>
        <div class="fx-h">Transcript fixed</div>
        <p style="font-size:14px;line-height:1.6;margin:0 0 8px">${esc(nameA())}'s notes were written again from the sentences they kept.</p>
        ${r.moved ? `<p style="font-size:14px;line-height:1.6;margin:0 0 8px">${plural(r.moved, 'sentence')} went to ${esc(r.toPatientName)}${
          r.joined ? ', joining their notes from that day.' : ', as new notes.'}</p>` : ''}
        ${r.dropped ? `<p style="font-size:14px;line-height:1.6;margin:0 0 8px">${plural(r.dropped, 'sentence')} left out.</p>` : ''}
        <p style="font-size:13px;color:#64748B;margin:0">Check both sets of notes before marking them Reviewed.</p>`;
    }
    side.innerHTML = h;
    if (S.picking) { const q = side.querySelector('[data-q]'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
  }

  function drawFoot() {
    const c = counts();
    const changed = c.b + c.x > 0;
    if (S.step === 'edit') {
      const txt = !c.a ? `<span style="color:#B91C1C">Keep at least one sentence with ${esc(nameA())}.</span>`
        : changed ? `${plural(c.b, 'sentence')} moving · ${plural(c.x, 'sentence')} left out` : 'Nothing changed yet';
      foot.innerHTML = `<span class="fx-ftx">${txt}</span>
        <button type="button" class="fx-btn" data-act="close">Cancel</button>
        <button type="button" class="fx-btn fx-pri" data-act="review"${changed && c.a ? '' : ' disabled'}>Review changes</button>`;
    } else if (S.step === 'review') {
      foot.innerHTML = `<span class="fx-ftx"></span><button type="button" class="fx-btn" data-act="back">Back</button>
        <button type="button" class="fx-btn fx-pri" data-act="save"${S.reason.trim().length >= 3 ? '' : ' disabled'}>${c.b ? 'Split and rewrite notes' : 'Rewrite notes'}</button>`;
    } else if (S.step === 'working') {
      foot.innerHTML = '<span class="fx-ftx">Saving. Keep this window open.</span>';
    } else if (S.step === 'done') {
      const r = S.result;
      foot.innerHTML = `<span class="fx-ftx"></span>${r.moved && r.toRecordId && onOpenRecord
        ? `<button type="button" class="fx-btn" data-act="open">Open ${esc(r.toPatientName)}'s notes</button>` : ''}
        <button type="button" class="fx-btn fx-pri" data-act="close">Done</button>`;
    } else {
      foot.innerHTML = '<span class="fx-ftx"></span><button type="button" class="fx-btn" data-act="close">Close</button>';
    }
  }

  const drawAll = () => { drawBanner(); drawSide(); drawFoot(); drawMix(); };

  /* ---------- Choosing ---------- */

  function setMark(m, why) {
    const idx = [...S.sel];
    if (!idx.length) return;
    idx.forEach((i) => {
      S.mark[i] = m;
      if (m === 'x') S.why[i] = why || 'other'; else delete S.why[i];
      S.sugX.delete(i);
    });
    S.sel = new Set();
    S.askWhy = false;
    idx.forEach((i) => paint(i));
    placeDivider();
    drawSide();
    drawFoot();
    drawMix();
  }

  function doMove() {
    if (!S.sel.size) return;
    if (S.target) setMark('b'); else openPicker(false);
  }

  let qTimer = 0, qSeq = 0;
  async function loadPatients(q) {
    const seq = ++qSeq;
    S.res = { loading: true };
    paintRes();
    let r;
    try { r = await api('transcriptFix', { op: 'patients', recordId, q }); } catch { r = { problem: "Couldn't search just now. Try again." }; }
    if (seq !== qSeq) return;
    S.res = !r || r.problem || r.ok === false ? { problem: (r && r.problem) || "Couldn't search just now. Try again." } : r;
    paintRes();
  }

  function openPicker(change) {
    S.picking = true;
    S.moveAfterPick = !change;
    S.q = S.target ? '' : S.suggestName;
    drawSide();
    loadPatients(S.q.trim().length >= 2 ? S.q.trim() : '');
  }

  async function findChange() {
    const btn = tools.querySelector('[data-tool="find"]');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="fx-spin" style="width:15px;height:15px"></span><span>Looking…</span>'; }
    let r;
    try { r = await api('transcriptFix', { op: 'suggest', recordId }); } catch { r = null; }
    if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = `${IC.spark}<span>Find where it changed patient</span>`; }
    if (S.step !== 'edit') return;
    if (!r || r.problem || r.ok === false) {
      S.banner = { warn: true, html: esc((r && r.problem) || "Gemini couldn't look at it just now. You can still choose the sentences yourself.") };
      return drawBanner();
    }
    if (r.sig !== S.sig) {
      S.banner = { warn: true, html: 'The transcript changed since you opened it. Close this and open Fix transcript again.' };
      return drawBanner();
    }
    const n = S.lines.length;
    const oldSug = [...S.sugX];
    S.sugX = new Set((r.notNeeded || []).filter((i) => S.mark[i] !== 'x'));
    oldSug.concat([...S.sugX]).forEach((i) => paint(i));
    let html = '';
    if (r.start >= 0) {
      setSel(new Set(range(r.start, n - 1)));
      S.anchor = r.start;
      S.suggestName = r.name || '';
      html += `It looks like ${r.name ? `<b>${esc(r.name)}</b>` : 'another patient'} starts at “${esc(S.lines[r.start].text.slice(0, 80))}”. ${esc(r.reason)}
        Those sentences are selected. <button type="button" class="fx-link" data-act="movesug">Choose the patient</button>`;
      jumpTo(r.start);
    } else {
      html += "Gemini didn't find another patient in this recording.";
    }
    if (S.sugX.size) {
      html += ` ${plural(S.sugX.size, 'sentence')} might not be needed (dashed underline). <button type="button" class="fx-link" data-act="sugsel">Select them</button>`;
    }
    S.banner = { warn: false, html };
    drawBanner();
    drawSide();
  }

  /* ---------- Saving and closing ---------- */

  async function save() {
    const move = [], drop = [];
    S.mark.forEach((m, i) => { if (m === 'b') move.push(i); else if (m === 'x') drop.push({ i, why: S.why[i] || 'other' }); });
    S.step = 'working';
    S.err = '';
    drawAll();
    let r;
    try {
      r = await api('transcriptFix', {
        op: 'save', recordId, sig: S.sig, move, drop, toPatientId: move.length ? S.target.id : '', reason: S.reason.trim(),
      });
    } catch {
      r = { problem: "Couldn't reach the server. Check whether the notes changed before trying again." };
    }
    if (!r || r.problem || r.ok === false) {
      S.step = 'review';
      S.err = (r && r.problem) || 'Something went wrong. Nothing was changed.';
      return drawAll();
    }
    S.result = r;
    S.step = 'done';
    drawAll();
  }

  function close(force) {
    if (S.step === 'working') return;
    const c = counts();
    if (!force && (S.step === 'edit' || S.step === 'review') && c.b + c.x > 0 &&
      !window.confirm('Close without saving? Your changes will be lost.')) return;
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('resize', syncView);
    root.classList.remove('in');
    setTimeout(() => root.remove(), 240);
    try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch { /* not essential */ }
    if (S.result && onDone) onDone(S.result);
  }

  /* ---------- Events ---------- */

  function onKey(e) {
    if (!root.isConnected) return;
    const inField = e.target && e.target.closest && e.target.closest('input, textarea');
    if (e.key === 'Escape') {
      e.preventDefault();
      if (inField && inField.matches('[data-find]') && inField.value) { inField.value = ''; runSearch(''); return; }
      if (S.picking) { S.picking = false; drawSide(); return; }
      if (S.askWhy) { S.askWhy = false; drawSide(); return; }
      if (S.step === 'edit' && S.sel.size) { setSel(new Set()); drawSide(); return; }
      close();
      return;
    }
    if (S.step !== 'edit' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (inField) {
      if (e.key === 'Enter' && inField.matches('[data-find]')) { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === '/') { e.preventDefault(); const f = tools.querySelector('[data-find]'); if (f) f.focus(); return; }
    if (!S.sel.size) return;
    if (k === 'k') { e.preventDefault(); setMark('a'); }
    else if (k === 'm') { e.preventDefault(); doMove(); }
    else if (k === 'n') {
      e.preventDefault();
      S.askWhy = true;
      drawSide();
      const chip = side.querySelector('.fx-chip');
      if (chip) chip.focus();
    }
  }
  document.addEventListener('keydown', onKey);

  // Click a sentence to select it; drag across sentences, or Shift-click, to select a run
  list.addEventListener('pointerdown', (e) => {
    if (S.step !== 'edit' || e.button !== 0 || e.target.closest('[data-turnsel]')) return;
    const el = e.target.closest('.fx-s');
    if (!el) return;
    const i = Number(el.dataset.i);
    e.preventDefault();
    if (e.shiftKey && S.anchor >= 0) {
      const next = new Set(S.sel);
      range(S.anchor, i).forEach((k) => next.add(k));
      setSel(next);
      S.anchor = i;
      drawSide();
      return;
    }
    S.drag = { start: i, last: i, base: new Set(S.sel), moved: false, wasSel: S.sel.has(i) };
  });
  list.addEventListener('pointerover', (e) => {
    const d = S.drag;
    if (!d) return;
    const el = e.target.closest('.fx-s');
    if (!el) return;
    const i = Number(el.dataset.i);
    if (i === d.start && !d.moved) return;
    d.moved = true;
    d.last = i;
    const next = new Set(d.base);
    range(d.start, i).forEach((k) => next.add(k));
    setSel(next);
  });
  function onUp() {
    const d = S.drag;
    if (!d) return;
    S.drag = null;
    if (!d.moved) {
      const next = new Set(S.sel);
      if (d.wasSel) next.delete(d.start); else next.add(d.start);
      setSel(next);
      S.anchor = d.start;
    } else {
      S.anchor = d.last;
    }
    if (S.picking && !S.moveAfterPick) S.picking = false;
    drawSide();
  }
  window.addEventListener('pointerup', onUp);

  list.addEventListener('click', (e) => {
    const tb = e.target.closest('[data-turnsel]');
    if (!tb || S.step !== 'edit') return;
    const t = S.turns[Number(tb.dataset.turnsel)];
    if (!t) return;
    const next = new Set(S.sel);
    range(t.start, t.end).forEach((k) => next.add(k));
    setSel(next);
    S.anchor = t.end;
    drawSide();
  });

  list.addEventListener('scroll', syncView, { passive: true });
  window.addEventListener('resize', syncView);
  map.addEventListener('click', (e) => {
    const r = map.getBoundingClientRect();
    const n = S.lines.length;
    if (!n || !r.height) return;
    jumpTo(Math.min(n - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * n))));
  });

  tools.addEventListener('click', (e) => {
    const hb = e.target.closest('[data-hit]');
    if (hb) { stepHit(Number(hb.dataset.hit)); return; }
    const t = e.target.closest('[data-tool]');
    if (!t || t.disabled || S.step !== 'edit') return;
    if (t.dataset.tool === 'find') findChange();
    else if (t.dataset.tool === 'end') {
      const start = S.sel.size ? Math.min(...S.sel) : S.anchor;
      if (start < 0) { S.banner = { warn: true, html: 'Click the first sentence to move, then press this again.' }; drawBanner(); return; }
      setSel(new Set(range(start, S.lines.length - 1)));
      drawSide();
    } else if (t.dataset.tool === 'clear') {
      setSel(new Set());
      drawSide();
    }
  });
  let findTimer = 0;
  tools.addEventListener('input', (e) => {
    if (!e.target.matches('[data-find]')) return;
    clearTimeout(findTimer);
    findTimer = setTimeout(() => runSearch(e.target.value), 150);
  });

  bannerEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'bannerx') { S.banner = null; drawBanner(); }
    else if (b.dataset.act === 'movesug') doMove();
    else if (b.dataset.act === 'sugsel') {
      setSel(new Set(S.sugX));
      S.askWhy = true;
      drawSide();
    }
  });

  side.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'keep') setMark('a');
    else if (act === 'move') doMove();
    else if (act === 'drop') { S.askWhy = true; drawSide(); }
    else if (act === 'why') setMark('x', b.dataset.why);
    else if (act === 'change') openPicker(true);
    else if (act === 'pickcancel') { S.picking = false; drawSide(); }
    else if (act === 'pick') {
      S.target = { id: b.dataset.id, name: b.dataset.name };
      S.picking = false;
      const after = S.moveAfterPick && S.sel.size;
      S.moveAfterPick = false;
      if (after) setMark('b');
      else { placeDivider(); drawSide(); drawFoot(); }
    }
  });

  side.addEventListener('input', (e) => {
    if (e.target.matches('[data-q]')) {
      S.q = e.target.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => loadPatients(S.q.trim().length >= 2 ? S.q.trim() : ''), 300);
    } else if (e.target.matches('[data-reason]')) {
      S.reason = e.target.value;
      const s = foot.querySelector('[data-act="save"]');
      if (s) s.disabled = S.reason.trim().length < 3;
    }
  });

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled || side.contains(b) || bannerEl.contains(b)) return;
    const act = b.dataset.act;
    if (act === 'close') close(S.step === 'done');
    else if (act === 'review') {
      S.step = 'review';
      S.picking = false;
      S.askWhy = false;
      setSel(new Set());
      list.classList.add('ro');
      drawAll();
      const ta = side.querySelector('[data-reason]');
      if (ta) ta.focus();
    } else if (act === 'back') { S.step = 'edit'; list.classList.remove('ro'); drawAll(); }
    else if (act === 'save') save();
    else if (act === 'open') { const id = S.result.toRecordId; close(true); onOpenRecord(id); }
  });

  /* ---------- Load ---------- */

  drawHead();
  drawFoot();
  list.innerHTML = '<div class="fx-empty"><span class="fx-spin"></span>Loading the transcript…</div>';
  const fail = (msg) => {
    S.step = 'error';
    list.innerHTML = `<p class="fx-note" style="margin:24px;background:#FEF2F2;color:#991B1B">${esc(msg)}</p>`;
    drawAll();
  };
  api('transcriptFix', { op: 'lines', recordId }).then((r) => {
    if (!r || r.problem || r.ok === false) return fail((r && r.problem) || "The transcript couldn't be loaded.");
    S.info = r;
    S.lines = r.lines || [];
    S.sig = r.sig;
    S.mark = S.lines.map(() => 'a');
    S.step = 'edit';
    mapcol.hidden = false;
    drawHead();
    drawTools();
    build();
    drawAll();
  }).catch(() => fail("The transcript couldn't be loaded. Check your connection and try again."));
}