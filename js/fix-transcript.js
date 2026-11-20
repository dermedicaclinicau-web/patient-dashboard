// Notes → Fix transcript: a wide window with the whole transcript, one line per sentence.
// Staff choose lines, then keep them, move them to another patient, or mark them as not needed.
// Apps Script does all the saving (action "transcriptFix", TranscriptFix.gs). This file only shows and chooses.
//
// openFixTranscript({ recordId, api, onDone, onOpenRecord })
//   api(action, body)        → Promise of Apps Script's reply (the portal's own call, which adds the session)
//   onDone(result)           → after a save, so the notes panel can reload
//   onOpenRecord(recordId)   → optional: opens another record's notes ("Open Mark Brown's notes")

const C = { keep: '#0F766E', move: '#7C3AED', drop: '#94A3B8', line: '#E2E8F0' };
const WHY = [['chitchat', 'Chit-chat'], ['staff', 'Talking to staff'], ['lefton', 'Recording left on'], ['other', 'Other']];
const WHY_NAME = Object.fromEntries(WHY);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dayText = (k) => (/^\d{4}-\d{2}-\d{2}$/.test(k || '')
  ? new Date(`${k}T12:00:00`).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }) : '');

const CSS = `
.fx-l{display:flex;gap:10px;padding:5px 10px;border-radius:8px;cursor:pointer;line-height:1.5;font-size:14px;border:1px solid transparent;user-select:none}
.fx-l:hover{background:#F8FAFC}
.fx-l.sel{background:#CCFBF1;border-color:#5EEAD4}
.fx-bar{flex:none;width:4px;border-radius:2px;background:${C.keep}}
.fx-l.m-b .fx-bar{background:${C.move}}
.fx-l.m-x .fx-bar{background:#CBD5E1}
.fx-l.m-x .fx-t{text-decoration:line-through;color:${C.drop}}
.fx-l.sug{outline:1px dashed #F59E0B;outline-offset:-1px}
.fx-who{font-size:12px;font-weight:600;color:#475569;margin:12px 0 2px 24px}
.fx-who.staff{color:#1E40AF}
.fx-sep{margin:16px 0 6px;text-align:center;font-size:12px;color:#B45309}
.fx-chip{display:inline-block;font-size:12px;padding:0 8px;border-radius:999px;margin-left:6px;background:#F1F5F9;color:#475569}
.fx-btn{border:1px solid #CBD5E1;background:#fff;border-radius:8px;padding:7px 12px;font:inherit;font-size:14px;cursor:pointer;color:#0F172A}
.fx-btn:hover:not(:disabled){border-color:${C.keep}}
.fx-btn:disabled{opacity:.5;cursor:default}
.fx-pri{background:${C.keep};color:#fff;border-color:${C.keep}}
.fx-link{background:none;border:0;padding:0;color:${C.keep};text-decoration:underline;cursor:pointer;font:inherit}
.fx-note{padding:10px 12px;border-radius:8px;font-size:14px;margin:0 0 10px;line-height:1.5}
.fx-wrap{display:flex;flex:1;min-height:0}
@media (max-width:760px){.fx-wrap{flex-direction:column}.fx-side{width:auto!important;border-left:0!important;border-top:1px solid ${C.line};max-height:48%}}
`;

export function openFixTranscript({ recordId, api, onDone, onOpenRecord }) {
  const S = {
    step: 'loading', lines: [], sig: '', info: {}, mark: [], why: {}, sel: new Set(), anchor: -1, els: [],
    target: null, picking: false, moveAfterPick: false, askWhy: false, q: '', res: null, sugX: new Set(),
    suggestName: '', banner: null, reason: '', err: '', result: null,
  };

  if (!document.getElementById('fx-css')) {
    const st = document.createElement('style');
    st.id = 'fx-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }
  const root = document.createElement('div');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Fix transcript');
  root.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:16px';
  root.innerHTML = `<div style="background:#fff;border-radius:14px;width:min(1180px,100%);height:min(880px,100%);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.25)">
    <div data-hd style="display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid ${C.line}"></div>
    <div class="fx-wrap">
      <div style="flex:1;min-width:0;display:flex;flex-direction:column">
        <div data-tools style="display:flex;flex-wrap:wrap;gap:6px;padding:10px 14px;border-bottom:1px solid ${C.line}"></div>
        <div data-banner style="padding:0 14px"></div>
        <div data-list style="flex:1;overflow:auto;padding:4px 10px 20px"></div>
      </div>
      <div data-side class="fx-side" style="width:320px;flex:none;border-left:1px solid ${C.line};padding:14px 16px;overflow:auto"></div>
    </div>
    <div data-ft style="display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid ${C.line}"></div>
  </div>`;
  document.body.appendChild(root);
  const $ = (s) => root.querySelector(s);
  const head = $('[data-hd]'), tools = $('[data-tools]'), bannerEl = $('[data-banner]');
  const list = $('[data-list]'), side = $('[data-side]'), foot = $('[data-ft]');

  const nameA = () => S.info.patientName || 'this patient';
  const counts = () => {
    let a = 0, b = 0, x = 0;
    S.mark.forEach((m) => (m === 'b' ? b++ : m === 'x' ? x++ : a++));
    return { a, b, x };
  };

  /* ---------- Drawing ---------- */

  function drawHead() {
    const i = S.info;
    const before = (i.fixes || []).slice(-1)[0];
    head.innerHTML = `<div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:16px">Fix transcript</div>
        <div style="font-size:13px;color:#64748b">${esc([i.patientName, i.recordDate, i.staffName].filter(Boolean).join(' · '))}${
          before ? ` · fixed before by ${esc(before.by)}` : ''}</div>
      </div>
      <button class="fx-btn" data-act="close" aria-label="Close" style="padding:4px 10px">✕</button>`;
    tools.innerHTML = S.step === 'edit' ? `
      <button class="fx-btn" data-tool="find">Find where it changed patient</button>
      <button class="fx-btn" data-tool="end">Select from here to the end</button>
      <button class="fx-btn" data-tool="clear">Clear selection</button>` : '';
  }

  function drawLines() {
    let html = '', lastPart = -1, lastKey = '';
    S.lines.forEach((l, i) => {
      if (lastPart !== -1 && l.part !== lastPart) html += '<div class="fx-sep">— Next recording —</div>';
      const k = `${l.part}|${l.para}`;
      if (k !== lastKey) html += `<div class="fx-who${l.staff ? ' staff' : ''}">${esc(l.who || 'Speaker')}</div>`;
      lastPart = l.part;
      lastKey = k;
      html += `<div class="fx-l" data-i="${i}"><span class="fx-bar"></span><span class="fx-t"></span></div>`;
    });
    list.innerHTML = html;
    S.els = [...list.querySelectorAll('.fx-l')];
    S.lines.forEach((_, i) => paint(i));
  }

  function paint(i) {
    const el = S.els[i];
    if (!el) return;
    const m = S.mark[i];
    el.className = `fx-l${S.sel.has(i) ? ' sel' : ''}${m === 'b' ? ' m-b' : m === 'x' ? ' m-x' : ''}${S.sugX.has(i) ? ' sug' : ''}`;
    el.querySelector('.fx-t').innerHTML = esc(S.lines[i].text) +
      (m === 'x' ? `<span class="fx-chip">${esc(WHY_NAME[S.why[i]] || 'Not needed')}</span>` : '');
  }
  const paintAll = () => S.lines.forEach((_, i) => paint(i));

  function drawBanner() {
    const b = S.banner;
    bannerEl.innerHTML = b ? `<div class="fx-note" style="margin-top:10px;background:${b.warn ? '#FEF2F2' : '#F0FDFA'};color:${b.warn ? '#991B1B' : '#134E4A'}">${b.html}</div>` : '';
  }

  function resultsHtml() {
    const R = S.res;
    if (!R || R.loading) return '<p style="color:#64748b;font-size:13px">Looking…</p>';
    if (R.problem) return `<p class="fx-note" style="background:#FEF2F2;color:#991B1B">${esc(R.problem)}</p>`;
    const rows = R.results || [];
    if (!rows.length) {
      return `<p style="color:#64748b;font-size:13px">${R.mode === 'day' ? 'No other bookings that day. Search for the patient.' : 'No patients found.'}</p>`;
    }
    const sub = (p) => (R.mode === 'day'
      ? [p.time, p.staff, (p.services || []).join(', ')]
      : [p.dob ? `Born ${dayText(p.dob) || p.dob}` : '', p.mobile]).filter(Boolean).join(' · ');
    return `<div style="font-size:12px;color:#64748b;margin:0 0 4px">${R.mode === 'day' ? `Booked on ${esc(dayText(R.day))}` : 'Patients'}</div>` +
      rows.map((p) => `<button class="fx-btn" data-act="pick" data-id="${esc(p.id)}" data-name="${esc(p.name)}" style="display:block;width:100%;text-align:left;margin:0 0 4px">
        <div style="font-weight:600">${esc(p.name)}</div><div style="font-size:12px;color:#64748b">${esc(sub(p))}</div></button>`).join('');
  }
  const paintRes = () => { const r = side.querySelector('[data-res]'); if (r) r.innerHTML = resultsHtml(); };

  function drawSide() {
    const c = counts();
    const n = S.sel.size;
    let h = '';
    if (S.step === 'edit') {
      h += `<div style="font-size:13px;color:#475569;margin:0 0 14px;line-height:1.8">
        <div><span style="color:${C.keep}">■</span> Keep with ${esc(nameA())}: <b>${c.a}</b></div>
        <div><span style="color:${C.move}">■</span> Move to ${esc(S.target ? S.target.name : 'another patient')}: <b>${c.b}</b></div>
        <div><span style="color:${C.drop}">■</span> Not needed: <b>${c.x}</b></div></div>`;
      if (S.picking) {
        h += `<div style="font-weight:600;margin:0 0 8px">${S.moveAfterPick ? `Move ${plural(n, 'line')} to` : 'Move lines to'}</div>
          <input data-q type="search" placeholder="Search patients" value="${esc(S.q)}" aria-label="Search patients"
            style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #CBD5E1;border-radius:8px;margin:0 0 8px;font:inherit">
          <div data-res>${resultsHtml()}</div>
          <button class="fx-btn" data-act="pickcancel" style="margin-top:8px">Cancel</button>`;
      } else {
        const dis = n ? '' : ' disabled';
        h += `<div style="font-weight:600;margin:0 0 8px">${n ? `${plural(n, 'line')} selected` : 'No lines selected'}</div>`;
        if (!n) h += '<p style="font-size:13px;color:#64748b;margin:0 0 10px">Click a line to select it. Shift-click another line to select everything in between.</p>';
        h += `<button class="fx-btn" data-act="keep" style="width:100%;margin:0 0 6px;text-align:left"${dis}><span style="color:${C.keep}">■</span> Keep with ${esc(nameA())}</button>
          <button class="fx-btn" data-act="move" style="width:100%;margin:0 0 6px;text-align:left"${dis}><span style="color:${C.move}">■</span> Move to ${esc(S.target ? S.target.name : 'another patient…')}</button>
          <button class="fx-btn" data-act="drop" style="width:100%;text-align:left"${dis}><span style="color:${C.drop}">■</span> Not needed</button>`;
        if (S.askWhy && n) {
          h += `<div style="margin:10px 0 0"><div style="font-size:13px;color:#475569;margin:0 0 6px">Why isn't it needed?</div>${
            WHY.map(([k, l]) => `<button class="fx-btn" data-act="why" data-why="${k}" style="margin:0 6px 6px 0;padding:4px 10px;font-size:13px">${l}</button>`).join('')}</div>`;
        }
        if (S.target) h += `<p style="font-size:13px;color:#475569;margin:14px 0 0">Moved lines go to <b>${esc(S.target.name)}</b>. <button class="fx-link" data-act="change">Change</button></p>`;
        h += `<p style="font-size:12px;color:#64748b;margin:14px 0 0">Lines that aren't needed are left out of everyone's notes. The original transcript is kept for Admins.</p>`;
      }
    } else if (S.step === 'review') {
      const whyCount = {};
      Object.keys(S.why).forEach((i) => { if (S.mark[i] === 'x') whyCount[S.why[i]] = (whyCount[S.why[i]] || 0) + 1; });
      const whyText = Object.keys(whyCount).map((k) => `${whyCount[k]} ${(WHY_NAME[k] || 'other').toLowerCase()}`).join(', ');
      h += `<div style="font-weight:600;margin:0 0 10px">Check the changes</div>
        <ul style="margin:0 0 14px;padding-left:18px;font-size:14px;line-height:1.6">
          <li><b>${esc(nameA())}</b> keeps ${plural(c.a, 'line')}. Their notes are written again from these.</li>
          ${c.b ? `<li><b>${esc(S.target.name)}</b> gets ${plural(c.b, 'line')}. If they have Draft notes by ${esc(S.info.staffName || 'the same clinician')} that day, these join them. Otherwise they get new notes.</li>` : ''}
          ${c.x ? `<li>${plural(c.x, 'line')} left out: ${esc(whyText)}.</li>` : ''}
        </ul>
        <label for="fx-reason" style="display:block;font-size:13px;font-weight:600;margin:0 0 4px">Reason (needed)</label>
        <textarea id="fx-reason" data-reason rows="3" placeholder="For example: recording wasn't stopped after ${esc(nameA())}"
          style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #CBD5E1;border-radius:8px;font:inherit;margin:0 0 10px">${esc(S.reason)}</textarea>
        ${S.err ? `<p class="fx-note" style="background:#FEF2F2;color:#991B1B">${esc(S.err)}</p>` : ''}
        <p style="font-size:12px;color:#64748b;margin:0">The audio stays with ${esc(nameA())}'s record. The original transcript and notes are kept for Admins.</p>`;
    } else if (S.step === 'working') {
      h += `<div style="font-weight:600;margin:0 0 8px">Saving…</div>
        <p style="font-size:14px;color:#475569;line-height:1.6;margin:0">Writing ${esc(nameA())}'s notes${
          counts().b ? ` and ${esc(S.target.name)}'s notes` : ''}. This can take a minute or two. Keep this window open.</p>`;
    } else if (S.step === 'done') {
      const r = S.result;
      h += `<div style="font-weight:600;color:${C.keep};margin:0 0 8px">Transcript fixed</div>
        <p style="font-size:14px;line-height:1.6;margin:0 0 8px">${esc(nameA())}'s notes were written again from the lines they kept.</p>
        ${r.moved ? `<p style="font-size:14px;line-height:1.6;margin:0 0 8px">${plural(r.moved, 'line')} went to ${esc(r.toPatientName)}${r.joined ? ', joining their notes from that day.' : ', as new notes.'}</p>` : ''}
        ${r.dropped ? `<p style="font-size:14px;line-height:1.6;margin:0 0 8px">${plural(r.dropped, 'line')} left out.</p>` : ''}
        <p style="font-size:13px;color:#64748b;margin:0">Check both sets of notes before marking them Reviewed.</p>`;
    }
    side.innerHTML = h;
    if (S.picking) { const q = side.querySelector('[data-q]'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
  }

  function drawFoot() {
    const c = counts();
    const changed = c.b + c.x > 0;
    if (S.step === 'edit') {
      foot.innerHTML = `<span style="flex:1;font-size:13px;color:#B91C1C">${c.a ? '' : `Keep at least one line with ${esc(nameA())}.`}</span>
        <button class="fx-btn" data-act="close">Cancel</button>
        <button class="fx-btn fx-pri" data-act="review"${changed && c.a ? '' : ' disabled'}>Review changes</button>`;
    } else if (S.step === 'review') {
      foot.innerHTML = `<span style="flex:1"></span><button class="fx-btn" data-act="back">Back</button>
        <button class="fx-btn fx-pri" data-act="save"${S.reason.trim().length >= 3 ? '' : ' disabled'}>${c.b ? 'Split and rewrite notes' : 'Rewrite notes'}</button>`;
    } else if (S.step === 'working') {
      foot.innerHTML = '<span style="flex:1;font-size:13px;color:#64748b">Saving. Keep this open.</span>';
    } else if (S.step === 'done') {
      const r = S.result;
      foot.innerHTML = `<span style="flex:1"></span>${r.moved && r.toRecordId && onOpenRecord
        ? `<button class="fx-btn" data-act="open">Open ${esc(r.toPatientName)}'s notes</button>` : ''}
        <button class="fx-btn fx-pri" data-act="close">Done</button>`;
    } else {
      foot.innerHTML = '<span style="flex:1"></span><button class="fx-btn" data-act="close">Close</button>';
    }
  }

  const drawAll = () => { drawHead(); drawBanner(); drawSide(); drawFoot(); };

  /* ---------- Choosing ---------- */

  function setMark(m, why) {
    const idx = [...S.sel];
    idx.forEach((i) => {
      S.mark[i] = m;
      if (m === 'x') S.why[i] = why || 'other'; else delete S.why[i];
      S.sugX.delete(i);
    });
    S.sel.clear();
    S.askWhy = false;
    idx.forEach(paint);
    drawSide();
    drawFoot();
  }

  function selectRange(a, b, replace) {
    const old = replace ? [...S.sel] : [];
    if (replace) S.sel.clear();
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) S.sel.add(k);
    old.forEach(paint);
    for (let k = Math.min(a, b); k <= Math.max(a, b); k++) paint(k);
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
    loadPatients(S.q);
  }

  async function findChange() {
    const btn = tools.querySelector('[data-tool="find"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Looking…'; }
    let r;
    try { r = await api('transcriptFix', { op: 'suggest', recordId }); } catch { r = null; }
    if (btn) { btn.disabled = false; btn.textContent = 'Find where it changed patient'; }
    if (!r || r.problem || r.ok === false) {
      S.banner = { warn: true, html: esc((r && r.problem) || "Gemini couldn't look at it just now. You can still choose the lines yourself.") };
      return drawBanner();
    }
    if (r.sig !== S.sig) {
      S.banner = { warn: true, html: 'The transcript changed since you opened it. Close this and open Fix transcript again.' };
      return drawBanner();
    }
    const n = S.lines.length;
    const oldSug = [...S.sugX];
    S.sugX = new Set((r.notNeeded || []).filter((i) => S.mark[i] !== 'x'));
    oldSug.concat([...S.sugX]).forEach(paint);
    let html = '';
    if (r.start >= 0) {
      selectRange(r.start, n - 1, true);
      S.anchor = r.start;
      S.suggestName = r.name || '';
      html += `It looks like ${r.name ? `<b>${esc(r.name)}</b>` : 'another patient'} starts at “${esc(S.lines[r.start].text.slice(0, 80))}”. ${esc(r.reason)} Those lines are selected. Check them, then choose where they go.`;
      S.els[r.start]?.scrollIntoView({ block: 'center' });
    } else {
      html += "Gemini didn't find another patient in this recording.";
    }
    if (S.sugX.size) {
      html += ` ${plural(S.sugX.size, 'line')} might not be needed (dashed outline). <button class="fx-link" data-act="sugsel">Select them</button>`;
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

  function onKey(e) { if (e.key === 'Escape') close(); }
  function close(force) {
    if (S.step === 'working') return;
    const c = counts();
    if (!force && (S.step === 'edit' || S.step === 'review') && c.b + c.x > 0 &&
      !window.confirm('Close without saving? Your changes will be lost.')) return;
    document.removeEventListener('keydown', onKey);
    root.remove();
    if (S.result && onDone) onDone(S.result);
  }
  document.addEventListener('keydown', onKey);

  /* ---------- Events ---------- */

  list.addEventListener('click', (e) => {
    const el = e.target.closest('.fx-l');
    if (!el || S.step !== 'edit') return;
    const i = Number(el.dataset.i);
    if (e.shiftKey && S.anchor >= 0) selectRange(S.anchor, i, false);
    else { if (S.sel.has(i)) S.sel.delete(i); else S.sel.add(i); paint(i); S.anchor = i; }
    if (S.picking && !S.moveAfterPick) S.picking = false;
    drawSide();
  });

  tools.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tool]');
    if (!t || t.disabled) return;
    const n = S.lines.length;
    if (t.dataset.tool === 'find') findChange();
    else if (t.dataset.tool === 'end') {
      const start = S.sel.size ? Math.min(...S.sel) : S.anchor;
      if (start < 0) { S.banner = { warn: true, html: 'Click the first line to move, then press this again.' }; return drawBanner(); }
      selectRange(start, n - 1, true);
      drawSide();
    } else if (t.dataset.tool === 'clear') {
      const old = [...S.sel];
      S.sel.clear();
      old.forEach(paint);
      drawSide();
    }
  });

  bannerEl.addEventListener('click', (e) => {
    if (!e.target.closest('[data-act="sugsel"]')) return;
    const old = [...S.sel];
    S.sel = new Set(S.sugX);
    old.concat([...S.sel]).forEach(paint);
    S.askWhy = true;
    drawSide();
  });

  side.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'keep') setMark('a');
    else if (act === 'move') { if (S.target) setMark('b'); else openPicker(false); }
    else if (act === 'drop') { S.askWhy = true; drawSide(); }
    else if (act === 'why') setMark('x', b.dataset.why);
    else if (act === 'change') openPicker(true);
    else if (act === 'pickcancel') { S.picking = false; drawSide(); }
    else if (act === 'pick') {
      S.target = { id: b.dataset.id, name: b.dataset.name };
      S.picking = false;
      if (S.moveAfterPick && S.sel.size) setMark('b'); else { drawSide(); drawFoot(); }
      S.moveAfterPick = false;
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
    else if (act === 'review') { S.step = 'review'; S.sel.clear(); paintAll(); drawAll(); side.querySelector('[data-reason]')?.focus(); }
    else if (act === 'back') { S.step = 'edit'; drawAll(); }
    else if (act === 'save') save();
    else if (act === 'open') { const id = S.result.toRecordId; close(true); onOpenRecord(id); }
  });

  /* ---------- Load ---------- */

  drawAll();
  list.innerHTML = '<p style="padding:20px;color:#64748b">Loading the transcript…</p>';
  api('transcriptFix', { op: 'lines', recordId }).then((r) => {
    if (!r || r.problem || r.ok === false) {
      S.step = 'error';
      list.innerHTML = `<p class="fx-note" style="margin:20px;background:#FEF2F2;color:#991B1B">${esc((r && r.problem) || "The transcript couldn't be loaded.")}</p>`;
      return drawAll();
    }
    S.info = r;
    S.lines = r.lines;
    S.sig = r.sig;
    S.mark = r.lines.map(() => 'a');
    S.step = 'edit';
    drawLines();
    drawAll();
  }).catch(() => {
    S.step = 'error';
    list.innerHTML = `<p class="fx-note" style="margin:20px;background:#FEF2F2;color:#991B1B">The transcript couldn't be loaded. Check your connection and try again.</p>`;
    drawAll();
  });
}