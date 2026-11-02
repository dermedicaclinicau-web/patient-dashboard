/**
 * Seo7.gs — SEO Tasks: AI suggestions from Claude, made quietly each night.
 * For a few priority pages a night (each page every 7 or 14 days; sooner if its clicks drop or WordPress shows it changed):
 *   1. gathers the facts: the live page, its searches, target and goal, competing pages, existing and dismissed tasks,
 *      and the advertising wording list
 *   2. asks CLAUDE_MODEL for tasks in a fixed format
 *   3. keeps a task only if its searches are real and big enough, it's worth the effort, every step is a check the
 *      website check understands, the page doesn't already pass it, it isn't a duplicate, and it follows the advertising rules
 *   4. CLAUDE_FAST_MODEL scores what's left; tasks under the quality bar are dropped
 *   5. kept tasks go to seo_tasks (source 'ai'); every run and every dropped idea is saved to seo_ai_runs
 * Settings: seo_settings/main.tasks.ai { on, every, minImpr, minScore, perPage, drafts } (SEO → Settings → Tasks)
 * Script Properties: ClaudeApi, CLAUDE_MODEL, CLAUDE_FAST_MODEL
 * Uses Seo.gs (seoOrigin_, seoHash_, SEO_TZ_), Seo2.gs (seo2Project_, seo2Commit_, seo2Write_), Seo3.gs (seo3Fetch_, seo3Text_,
 * seo3Esc_, seo3Words_), Seo6.gs (seo6Read_, seo6Pass_, seo6Path_) and Code.gs (getConfig_, fsGetDoc_, fsQuery_, fsListAll_, fromFields_).
 */

const SEO7_CHECKS_ = ['title', 'titleMax', 'titleNot', 'h1', 'desc', 'heading', 'headingAny', 'text', 'words', 'link', 'alt'];
const SEO7_CTR_ = [0.28, 0.16, 0.11, 0.08, 0.06, 0.045, 0.035, 0.03, 0.025, 0.02];   // rough click rate by position
const SEO7_MAX_PAGES_ = 4;        // pages reviewed per night at most
const SEO7_MIN_GAIN_ = 3;         // extra clicks per 28 days a task must be worth
const SEO7_RISKY_ = /(^|[^a-z])(guarantee[sd]?|risk[- ]free|pain[- ]free|painless|no downtime|testimonials?|before[- ]and[- ]after|miracle|permanent results?|100% safe|completely safe|lunchtime)([^a-z]|$)/i;

function runSeoAiTasks() { seo7Run_({}); }

/** Run from the editor: reviews one page and logs what it would add, without saving anything */
function testSeoAiTasks() { seo7Run_({ dry: true, max: 1, force: true }); }

/** Run once: every night at about 10pm Perth (after the website check at 9pm) */
function installSeoAiTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoAiTasks'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoAiTasks').timeBased().everyDays(1).atHour(22).inTimezone(SEO_TZ_).create();
  console.log('runSeoAiTasks scheduled daily ~10pm Perth');
}

/* ===================== The run ===================== */

function seo7Run_(opt) {
  const t0 = Date.now();
  const cfg = getConfig_();
  const set = fsGetDoc_(cfg, 'seo_settings/main') || {};
  const ai = seo7Cfg_(set);
  if (!ai.on && !opt.force) { console.log('AI suggestions are off (SEO → Settings → Tasks).'); return; }

  const props = PropertiesService.getScriptProperties();
  const model = String(props.getProperty('CLAUDE_MODEL') || '').trim();
  const fast = String(props.getProperty('CLAUDE_FAST_MODEL') || '').trim() || model;
  if (!model) throw new Error('Script Property CLAUDE_MODEL is missing.');

  const origin = seoOrigin_();
  const project = seo2Project_();
  const today = Utilities.formatDate(new Date(), SEO_TZ_, 'yyyy-MM-dd');
  const build = Utilities.formatDate(new Date(), SEO_TZ_, "yyyyMMdd'T'HHmm");
  const paths = (Array.isArray(set.keyPages) ? set.keyPages : []).map(seo6Path_);
  if (!paths.length) { console.log('AI suggestions: no priority pages.'); return; }

  // Search data (Seo2.gs)
  const qs = fsGetDoc_(cfg, 'seo_state/queries');
  if (!qs || !qs.build) throw new Error('No search data yet. Run runSeoQueries() first.');
  let rows = [];
  fsQuery_(cfg, 'seo_queries', 'build', 'EQUAL', qs.build, 100)
    .sort(function (a, b) { return Number(a.n) - Number(b.n); })
    .forEach(function (d) { try { rows = rows.concat(JSON.parse(d.rows || '[]')); } catch (e) { /* skip a bad chunk */ } });

  // Pages on the site: WordPress's list, and every page Google shows
  const known = {}, wp = {}, stats = {};
  try {
    JSON.parse((fsGetDoc_(cfg, 'seo_settings/wp') || {}).pages || '[]').forEach(function (p) {
      wp[seo7N_(p.path)] = p; known[seo7N_(p.path)] = 1;
    });
  } catch (e) { /* no WordPress list */ }
  const ov = fsGetDoc_(cfg, 'seo_state/overview');
  (ov && ov.build ? fsQuery_(cfg, 'seo_pages', 'build', 'EQUAL', ov.build, 5000) : []).forEach(function (p) {
    const k = seo7N_(p.path);
    known[k] = 1;
    stats[k] = { now: Number((p.m28 || {}).clicks || 0), before: Number((p.prev28 || {}).clicks || 0) };
  });

  const tasks = fsListAll_(cfg, 'seo_tasks', ['path', 'title', 'status', 'source', 'steps', 'dismissNote'])
    .map(function (d) { const t = fromFields_(d.fields || {}); t.id = d.name.split('/').pop(); return t; });
  let state = {};
  try { state = JSON.parse((fsGetDoc_(cfg, 'seo_ai_state/pages') || {}).json || '{}'); } catch (e) { state = {}; }

  // Which pages are due tonight
  const due = paths.map(function (p) {
    const k = seo7N_(p);
    const last = state[k] && state[k].at ? Date.parse(state[k].at) : 0;
    const age = last ? (Date.now() - last) / 864e5 : 9999;
    const s = stats[k] || { now: 0, before: 0 };
    const dropping = s.before >= 15 && s.now <= s.before * 0.75;
    const changed = !!(last && wp[k] && wp[k].mod && wp[k].mod > new Date(last).toISOString().slice(0, 10));
    const why = !last ? 'first review' : age >= ai.every ? 'due' : dropping && age >= 3 ? 'clicks dropped'
      : changed && age >= 2 ? 'changed in WordPress' : '';
    return { path: p, key: k, why: why || (opt.force ? 'test' : ''), rank: !last ? 0 : dropping ? 1 : changed ? 2 : 3, age: age };
  }).filter(function (x) { return x.why; }).sort(function (a, b) { return a.rank - b.rank || b.age - a.age; });

  const max = opt.max || Math.min(SEO7_MAX_PAGES_, Math.max(1, Math.ceil(paths.length / ai.every) + 1));
  const X = {
    ai: ai, model: model, fast: fast, origin: origin, today: today, rows: rows, known: known, wp: wp, tasks: tasks,
    info: Array.isArray(set.priorityInfo) ? set.priorityInfo : [],
    brand: (Array.isArray(set.brand) ? set.brand : ['dermedica']).map(function (w) { return String(w).toLowerCase().trim(); }).filter(Boolean),
    banned: seo3Words_(set).map(function (w) { return w.word; }),
  };

  const results = [], writes = [];
  due.slice(0, max).forEach(function (d) {
    if (Date.now() - t0 > 3.5 * 60000) { results.push({ path: d.path, skipped: 'out of time, tomorrow' }); return; }
    try {
      const r = seo7Page_(X, d);
      results.push(r.report);
      r.docs.forEach(function (doc) { writes.push(seo2Write_(project, 'seo_tasks/' + doc.id, doc.data)); });
      state[d.key] = { at: new Date().toISOString(), kept: r.docs.length, why: d.why };
    } catch (e) {
      console.warn('AI suggestions: ' + d.path + ' failed: ' + (e.stack || e));
      results.push({ path: d.path, why: d.why, error: String(e.message || e).slice(0, 300) });   // tried again tomorrow
    }
  });

  const kept = results.reduce(function (n, r) { return n + (r.kept ? r.kept.length : 0); }, 0);
  if (opt.dry) {
    console.log(JSON.stringify(results, null, 2));
    console.log('AI suggestions (test): ' + results.length + ' page(s), ' + kept + ' task(s) would be added. Nothing saved.');
    return;
  }
  writes.push(seo2Write_(project, 'seo_ai_state/pages', { json: JSON.stringify(state), at: new Date() }));
  writes.push(seo2Write_(project, 'seo_ai_runs/r_' + build, {
    at: new Date(), ms: Date.now() - t0, model: model, fast: fast, pages: results.length, kept: kept, json: JSON.stringify(results).slice(0, 900000),
  }));
  seo2Commit_(project, writes);
  console.log('AI suggestions: ' + results.length + ' page(s) reviewed, ' + kept + ' task(s) added, ' + Math.round((Date.now() - t0) / 1000) + ' s');
}

function seo7Cfg_(set) {
  const t = set.tasks && typeof set.tasks === 'object' ? set.tasks : {};
  const a = t.ai && typeof t.ai === 'object' ? t.ai : {};
  const num = function (v, d, lo, hi) { return Math.min(hi, Math.max(lo, Math.round(Number(v)) || d)); };
  return {
    on: a.on !== false, every: Number(a.every) === 14 ? 14 : 7, minImpr: num(a.minImpr, 30, 10, 500),
    minScore: num(a.minScore, 4, 3, 5), perPage: num(a.perPage, 1, 1, 3), drafts: a.drafts !== false,
  };
}

function seo7N_(p) { return seo6Path_(p).toLowerCase().replace(/\/+$/, '') || '/'; }

/* ===================== One page ===================== */

function seo7Page_(X, d) {
  const url = X.origin + d.path;
  const res = seo3Fetch_([url], true)[0];
  if (!res || res.error || res.code !== 200) throw new Error('Could not read the page (' + (res && (res.error || res.code)) + ')');
  const pg = seo6Read_(res.text, url);
  const report = { path: d.path, why: d.why, asked: 0, kept: [], dropped: [] };

  const S = seo7Searches_(X.rows, d.key, X.brand);
  if (!S.list.length) { report.note = 'No searches for this page yet.'; return { report: report, docs: [] }; }
  const byQ = {};
  S.list.forEach(function (s) { byQ[s.search.toLowerCase()] = s; });

  // What it already has, and what people dismissed before
  const mine = X.tasks.filter(function (t) { return seo7N_(t.path) === d.key; });
  const sigs = {}, existing = [];
  mine.forEach(function (t) {
    Object.keys(t.steps || {}).forEach(function (id) {
      const s = t.steps[id];
      if (!s || !s.check) return;
      sigs[seo7Sig_(s.check, d.path)] = 1;
      if (t.status !== 'dismissed') existing.push(String(s.text || '').slice(0, 160));
    });
  });
  const dismissed = mine.filter(function (t) { return t.status === 'dismissed'; })
    .map(function (t) { return { task: t.title, reason: t.dismissNote || '' }; }).slice(0, 15);

  const pri = X.info.filter(function (x) { return seo7N_(x.path) === d.key; })[0] || {};
  const facts = {
    page: {
      path: d.path, title: pg.title, mainHeading: pg.h1, description: pg.desc, words: pg.words,
      outline: seo7Outline_(res.text).slice(0, 60), text: pg.text.slice(0, 6000),
      wordpressTitle: (X.wp[d.key] || {}).title || '',
    },
    target: { search: pri.target || '', goal: { top3: 'Top 3', top5: 'Top 5', page1: 'Page 1' }[pri.goal] || '' },
    searches: S.list.slice(0, 40),
    competingPages: S.competing.slice(0, 6).map(function (c) { return { path: c.path, title: (X.wp[seo7N_(c.path)] || {}).title || '', sharedSearches: c.shared, theirPosition: c.pos }; }),
    existingSteps: existing.slice(0, 40),
    dismissedBefore: dismissed,
    bannedWords: X.banned,
    maxTasks: X.ai.perPage + 1,
    drafts: X.ai.drafts,
  };

  const out = seo7Claude_(X.model, seo7System_(X.ai), JSON.stringify(facts), 3000);
  const cands = (Array.isArray(out.tasks) ? out.tasks : []).slice(0, 5);
  report.asked = cands.length;

  // Tests every suggestion has to pass
  const pages = {};
  pages[d.key] = pg;
  const readPage = function (path) {
    const k = seo7N_(path);
    if (!(k in pages)) {
      const r = seo3Fetch_([X.origin + seo6Path_(path)], true)[0];
      pages[k] = r && !r.error && r.code === 200 ? seo6Read_(r.text, X.origin + seo6Path_(path)) : null;
    }
    return pages[k];
  };
  const okList = [];
  cands.forEach(function (c) {
    const title = String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    const why = String(c.why || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const drop = function (reason) { report.dropped.push({ title: title || '(no title)', reason: reason }); };
    if (title.length < 8) return drop('no clear title');
    const risky = seo7Risky_(title + ' ' + why, X.banned);
    if (risky) return drop('advertising rules: “' + risky + '”');

    const cited = [];
    (Array.isArray(c.searches) ? c.searches : []).forEach(function (q) {
      const s = byQ[String(q || '').toLowerCase().trim()];
      if (s && cited.indexOf(s) === -1) cited.push(s);
    });
    if (!cited.length) return drop("its searches aren't this page's real searches");
    const impr = cited.reduce(function (n, s) { return n + s.impressions; }, 0);
    if (impr < X.ai.minImpr) return drop('only ' + impr + ' impressions behind it (needs ' + X.ai.minImpr + ')');
    const gain = seo7Gain_(cited);
    if (gain < SEO7_MIN_GAIN_) return drop('not worth it: about +' + gain + ' clicks a month');

    const steps = [], seen = {};
    (Array.isArray(c.steps) ? c.steps : []).slice(0, 6).forEach(function (raw) {
      const v = seo7Step_(raw, X, d);
      if (v.err) { report.dropped.push({ title: title, step: String((raw && raw.text) || '').slice(0, 120), reason: v.err }); return; }
      const st = v.step;
      const bad = seo7Risky_(st.text + ' ' + st.draft, X.banned);
      if (bad) { report.dropped.push({ title: title, step: st.text, reason: 'advertising rules: “' + bad + '”' }); return; }
      const sig = seo7Sig_(st.check, d.path);
      if (sigs[sig] || seen[sig]) { report.dropped.push({ title: title, step: st.text, reason: 'already a task for this' }); return; }
      const page = readPage(st.check.page);
      const pass = page ? seo6Pass_(st.check, page, { origin: X.origin, speed: function () { return null; }, index: function () { return null; } }) : null;
      if (pass === true) { report.dropped.push({ title: title, step: st.text, reason: 'the page already does this' }); return; }
      seen[sig] = 1;
      steps.push(st);
    });
    if (!steps.length) return drop('no steps left after the checks');
    okList.push({ title: title, why: why, cited: cited, gain: gain, steps: steps.slice(0, 4) });
  });

  // Second opinion
  let kept = [];
  if (okList.length) {
    const review = seo7Claude_(X.fast, seo7ReviewSystem_(), JSON.stringify({
      page: { path: d.path, title: pg.title, target: facts.target },
      topSearches: S.list.slice(0, 15),
      tasks: okList.map(function (t, i) {
        return { i: i, title: t.title, why: t.why, searches: t.cited.map(function (s) { return s.search; }),
          steps: t.steps.map(function (s) { return s.text; }) };
      }),
    }), 900);
    const scores = {};
    (Array.isArray(review.scores) ? review.scores : []).forEach(function (s) {
      if (s && s.i != null) scores[Number(s.i)] = { score: Number(s.score) || 0, reason: String(s.reason || '').slice(0, 200) };
    });
    okList.forEach(function (t, i) {
      const sc = scores[i] || { score: 0, reason: 'not scored' };
      t.score = sc.score; t.scoreNote = sc.reason;
      if (sc.score >= X.ai.minScore) kept.push(t);
      else report.dropped.push({ title: t.title, reason: 'quality ' + sc.score + '/5: ' + sc.reason });
    });
  }
  kept.sort(function (a, b) { return b.gain - a.gain; });
  kept.slice(X.ai.perPage).forEach(function (t) { report.dropped.push({ title: t.title, reason: 'over the limit for this page' }); });
  kept = kept.slice(0, X.ai.perPage);

  const docs = kept.map(function (t) {
    const id = 't_ai' + seoHash_(d.path + '|' + t.title + '|' + X.today).slice(0, 14);
    const steps = {}, order = [];
    t.steps.forEach(function (s, i) {
      const sid = 's_' + seoHash_(id + '|' + i).slice(0, 12);
      order.push(sid);
      steps[sid] = {
        text: s.text, effort: s.effort, check: s.check, status: 'todo', by: '', byName: '', at: '',
        detail: s.draft ? 'Draft from Claude, check before publishing: ' + s.draft : '',
      };
    });
    report.kept.push({ title: t.title, gain: t.gain, score: t.score, steps: t.steps.length });
    return { id: id, data: {
      path: d.path, group: 'ai', source: 'ai', title: t.title, why: t.why,
      searches: t.cited.map(function (s) { return s.search; }), gain: t.gain, score: t.score, scoreNote: t.scoreNote,
      order: order, steps: steps, status: 'open', skipUntil: '', skipNote: '', model: X.model,
      createdAt: new Date(), updatedAt: new Date(),
    } };
  });
  return { report: report, docs: docs };
}

/* ===================== Facts ===================== */

// This page's searches (brand left out), and the other pages showing for the same searches
function seo7Searches_(rows, key, brand) {
  const list = [], comp = {};
  rows.forEach(function (r) {
    const q = String(r[0] || ''), l = q.toLowerCase();
    if (!q || brand.some(function (b) { return l.indexOf(b) !== -1; })) return;
    const pages = Array.isArray(r[7]) ? r[7] : [];
    const mine = pages.filter(function (p) { return seo7N_(p[0]) === key; })[0];
    if (!mine) return;
    list.push({ search: q, impressions: Number(mine[2]) || 0, clicks: Number(mine[1]) || 0, position: mine[3] == null ? null : Number(mine[3]) });
    pages.forEach(function (p) {
      const k = seo7N_(p[0]);
      if (k === key) return;
      const x = comp[k] || (comp[k] = { path: p[0], shared: 0, impr: 0, pw: 0 });
      x.shared++; x.impr += Number(p[2]) || 0;
      if (p[3] != null) x.pw += Number(p[3]) * (Number(p[2]) || 0);
    });
  });
  list.sort(function (a, b) { return b.impressions - a.impressions; });
  const competing = Object.keys(comp).map(function (k) {
    const x = comp[k];
    return { path: x.path, shared: x.shared, impr: x.impr, pos: x.impr ? Math.round((x.pw / x.impr) * 10) / 10 : null };
  }).sort(function (a, b) { return b.impr - a.impr; });
  return { list: list, competing: competing };
}

// The page's headings in order, e.g. "H2: How much does it cost?"
function seo7Outline_(html) {
  return (String(html).replace(/<!--[\s\S]*?-->/g, ' ').match(/<h[1-4]\b[\s\S]*?<\/h[1-4]\s*>/gi) || [])
    .map(function (h) { return 'H' + h.charAt(2) + ': ' + seo3Text_(h).slice(0, 120); })
    .filter(function (h) { return h.length > 4; });
}

// Extra clicks a month if the searches reach about position 3
function seo7Gain_(cited) {
  let g = 0;
  cited.forEach(function (s) {
    if (s.position == null) return;
    const to = s.position > 3 ? 3 : Math.max(1, Math.round(s.position) - 1);
    g += Math.max(0, s.impressions * SEO7_CTR_[to - 1] - s.clicks);
  });
  return Math.round(g);
}

/* ===================== Checking a suggested step ===================== */

function seo7Step_(s, X, d) {
  if (!s || typeof s !== 'object' || !s.check) return { err: 'no check' };
  const str = function (v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); };
  const text = str(s.text, 300);
  if (text.length < 10) return { err: 'step too vague' };
  const k = s.check.k;
  if (SEO7_CHECKS_.indexOf(k) === -1) return { err: "not something the website check can confirm" };
  const c = { k: k, page: seo6Path_(s.check.page || d.path) };
  if (seo7N_(c.page) !== d.key && !X.known[seo7N_(c.page)]) return { err: "changes a page that isn't on the site" };
  if (['title', 'titleNot', 'h1', 'heading'].indexOf(k) !== -1) {
    c.has = str(s.check.has, 100).toLowerCase();
    if (c.has.length < 3) return { err: 'no words for the check' };
  }
  if (k === 'desc') { c.min = 70; c.max = 160; if (s.check.has) c.has = str(s.check.has, 100).toLowerCase(); }
  if (k === 'titleMax') c.max = Math.min(70, Math.max(40, Math.round(Number(s.check.max)) || 60));
  if (k === 'headingAny' || k === 'text') {
    c.any = (Array.isArray(s.check.any) ? s.check.any : []).map(function (x) { return str(x, 60).toLowerCase(); })
      .filter(function (x) { return x.length >= 3; }).slice(0, 6);
    if (!c.any.length) return { err: 'no words for the check' };
  }
  if (k === 'words') {
    if (!Number(s.check.min)) return { err: 'no word count' };
    c.min = Math.min(3000, Math.max(300, Math.round(Number(s.check.min))));
  }
  if (k === 'link') {
    if (!s.check.to) return { err: 'no page to link to' };
    c.to = seo6Path_(s.check.to);
    if (seo7N_(c.to) === seo7N_(c.page)) return { err: 'links a page to itself' };
    if (!X.known[seo7N_(c.to)]) return { err: "links to a page that isn't on the site" };
  }
  const effort = { quick: 'Quick', medium: 'Medium', bigger: 'Bigger' }[str(s.effort, 10).toLowerCase()] || 'Medium';
  return { step: { text: text, effort: effort, check: c, draft: X.ai.drafts ? str(s.draft, 600) : '' } };
}

// What a step checks, so the same change isn't suggested twice
function seo7Sig_(c, path) {
  return [c.k, seo7N_(c.page || path), String(c.has || '').toLowerCase().trim(), c.to ? seo7N_(c.to) : '',
    (c.any || []).join(','), c.min || '', c.max || ''].join('|');
}

// The first banned or risky word in the text, or ''
function seo7Risky_(text, banned) {
  const t = String(text || '').toLowerCase();
  for (let i = 0; i < banned.length; i++) {
    const w = String(banned[i] || '').toLowerCase();
    if (w && new RegExp('(^|[^a-z0-9])' + seo3Esc_(w) + '([^a-z0-9]|$)').test(t)) return w;
  }
  const m = SEO7_RISKY_.exec(t);
  return m ? m[2] : '';
}

/* ===================== Claude ===================== */

function seo7System_(ai) {
  return [
    'You are an SEO specialist for Dermedica, a cosmetic skin clinic in Perth, Western Australia.',
    'You suggest concrete, high-impact tasks for ONE web page, using only the facts given in the JSON.',
    '',
    'Rules:',
    '- Every task targets searches copied EXACTLY from "searches". Prefer searches at positions 4 to 20 with many impressions, and the target search.',
    '- Each task has 1 to 4 steps. Every step is ONE specific change to the website that one of these checks can confirm:',
    '  title: the page title contains "has" · titleMax: the title is at most "max" characters · titleNot: page "page"\'s title no longer contains "has"',
    '  h1: the main heading contains "has" · desc: the meta description is 120 to 155 characters and contains "has"',
    '  heading: a heading on the page contains "has" (use for new sections and FAQ questions) · headingAny: a heading contains any of "any"',
    '  text: the page text contains any of "any" (short exact phrases) · words: the page has at least "min" words',
    '  link: page "page" (default: this page) links to "to" (a path from competingPages or this page) · alt: every image has alt text',
    '- Do not repeat anything in "existingSteps" or "dismissedBefore". Do not suggest what the page already does: read its title, outline and text.',
    '- Australian health advertising rules (TGA and AHPRA): never use prescription medicine names (such as Botox or Dysport) or any word in "bannedWords";',
    '  no promises or guarantees of results; never downplay risks, pain or downtime; no testimonials or reviews on the website; no before-and-after claims.',
    '- Australian English, plain and specific. Page titles under 60 characters. Meta descriptions 120 to 155 characters.',
    ai.drafts
      ? '- Give each step a "draft": the exact wording to use (the new title, the description, or the heading with a 2 to 3 sentence answer).'
      : '- Leave "draft" empty.',
    '- If nothing is clearly worth doing, return {"tasks":[]}. Fewer, stronger tasks are better than many weak ones.',
    '',
    'Reply with JSON only, no other text:',
    '{"tasks":[{"title":"short task name","why":"one sentence on why this will win the searches",',
    '"searches":["exact search from the list"],',
    '"steps":[{"text":"the change to make","effort":"Quick|Medium|Bigger","check":{"k":"heading","has":"words to find"},"draft":"wording"}]}]}',
  ].join('\n');
}

function seo7ReviewSystem_() {
  return [
    'You review SEO task suggestions for a cosmetic skin clinic web page in Perth, Australia.',
    'Score each task from 1 to 5 for how likely it is to move this page up for its searches:',
    '5 = clearly targets the page\'s important searches with a strong, specific change; 4 = good and specific;',
    '3 = useful but minor; 2 = weak or generic; 1 = irrelevant, vague, duplicated or risky under health advertising rules.',
    'Be strict. Reply with JSON only: {"scores":[{"i":0,"score":4,"reason":"one short sentence"}]}',
  ].join('\n');
}

function seo7Claude_(model, system, user, maxTokens) {
  const key = String(PropertiesService.getScriptProperties().getProperty('ClaudeApi') || '').trim();
  if (!key) throw new Error('Script Property ClaudeApi is missing.');
  const payload = JSON.stringify({ model: model, max_tokens: maxTokens, system: system, messages: [{ role: 'user', content: user }] });
  for (let a = 0; a < 3; a++) {
    const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: payload,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    const code = r.getResponseCode();
    if (code === 200) {
      const j = JSON.parse(r.getContentText());
      const txt = (j.content || []).filter(function (x) { return x.type === 'text'; }).map(function (x) { return x.text; }).join('');
      return seo7Json_(txt);
    }
    if ([429, 500, 502, 503, 529].indexOf(code) !== -1 && a < 2) { Utilities.sleep(5000 * (a + 1)); continue; }
    throw new Error('Claude ' + code + ': ' + r.getContentText().slice(0, 300));
  }
  throw new Error('Claude did not answer.');
}

function seo7Json_(txt) {
  const s = String(txt || '').replace(/```(?:json)?/gi, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error("Claude's answer wasn't JSON");
  return JSON.parse(s.slice(a, b + 1));
}