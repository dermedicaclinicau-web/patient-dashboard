/**
 * Seo10.gs — SEO Advisor. Answers questions asked in SEO → Advisor: goals, page reviews and open questions.
 * The portal saves each question to seo_advisor_msgs (status 'new'). This job runs every minute, picks them up and asks Claude,
 * which looks things up with read-only tools, then answers with give_answer (a fixed shape the portal draws).
 * Progress and the answer are written back to the same message. Nothing else is changed.
 * Models: Opus for goal plans, Sonnet for the rest (Script Properties CLAUDE_ADVISOR_OPUS / CLAUDE_MODEL override).
 * Uses Seo.gs (seoOrigin_, seoToken_, SEO_TZ_), Seo2.gs (seo2Project_, seo2Commit_, seo2Write_), Seo3.gs (seo3Fetch_, seo3Words_),
 * Seo7.gs (seo7ClaudeKey_, seo7Outline_, seo7Risky_), Seo9.gs (seo9Read_) and Code.gs (getConfig_, fsGetDoc_, fsQuery_, fsListAll_, fromFields_).
 */

const SEO10_OPUS_ = 'claude-opus-5-5';
const SEO10_SONNET_ = 'claude-sonnet-5-5';
const SEO10_MAX_TURNS_ = 10;
const SEO10_HOURS_ = [6, 22];   // only looks for questions between 6am and 10pm Perth (saves Apps Script time overnight)
const SEO10_CHECKS_ = ['title', 'titleMax', 'titleNot', 'h1', 'desc', 'heading', 'headingAny', 'text', 'words', 'link', 'alt', 'faqSchema'];
const SEO10_GOAL_RE_ = /\b(goal|target|boost|grow|increase|rank|number one|first page|page 1|top \d|before|by the end|this (month|summer|winter|season|christmas)|next (month|season)|january|february|march|april|may|june|july|august|september|october|november|december|christmas|summer|winter|spring|autumn)\b|#\s?1/i;

/* ===================== The job ===================== */

function runSeoAdvisor() {
  const hr = Number(Utilities.formatDate(new Date(), SEO_TZ_, 'H'));
  if (hr < SEO10_HOURS_[0] || hr >= SEO10_HOURS_[1]) return;
  const cache = CacheService.getScriptCache();
  if (cache.get('seo_adv_run')) return;
  cache.put('seo_adv_run', '1', 330);
  const t0 = Date.now();
  const cfg = getConfig_();
  const project = seo2Project_();
  let D = null, lastWork = 0;
  try {
    while (Date.now() - t0 < 4 * 60000) {
      const pending = seo10Query_(project, 'seo_advisor_msgs', 'status', 'new', 5)
        .sort(function (a, b) { return String(a.data.at || '').localeCompare(String(b.data.at || '')); });
      if (!pending.length) {
        if (!lastWork || Date.now() - lastWork > 90000) break;   // stay a little after an answer: follow-ups come quickly
        Utilities.sleep(6000);
        continue;
      }
      D = D || seo10Data_(cfg);
      pending.forEach(function (m) {
        if (Date.now() - t0 > 4.3 * 60000) return;
        seo10Handle_(cfg, project, D, m);
        lastWork = Date.now();
      });
    }
  } finally {
    cache.remove('seo_adv_run');
  }
}

/** Run once: checks for new questions every minute */
function installSeoAdvisorTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoAdvisor'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoAdvisor').timeBased().everyMinutes(1).create();
  console.log('runSeoAdvisor runs every minute (6am–10pm Perth)');
}

/** Run from the editor: answers one question and logs the answer (saves nothing) */
function testSeoAdvisor() {
  const q = 'How do I improve the neck pigmentation page?';
  const D = seo10Data_(getConfig_());
  const res = seo10Claude_(seo10Model_(false), seo10System_(D, false), [{ role: 'user', content: q }], D,
    function (l) { console.log('… ' + l); });
  console.log(JSON.stringify(seo10Clean_(res, D), null, 2));
}

function seo10Model_(goal) {
  const p = PropertiesService.getScriptProperties();
  return goal ? (String(p.getProperty('CLAUDE_ADVISOR_OPUS') || '').trim() || SEO10_OPUS_)
    : (String(p.getProperty('CLAUDE_MODEL') || '').trim() || SEO10_SONNET_);
}

function seo10Handle_(cfg, project, D, m) {
  const id = m.id, q = m.data;
  const write = function (path, o) { seo2Commit_(project, [seo2Write_(project, path, o)]); };
  const progress = ['Reading your question'];
  write('seo_advisor_msgs/' + id, { status: 'working', startedAt: new Date(), progress: progress });
  if (q.threadId) { try { write('seo_advisor/' + q.threadId, { busy: true }); } catch (e) { /* the thread may be gone */ } }
  const tick = function (label) {
    progress.push(label);
    try { write('seo_advisor_msgs/' + id, { progress: progress.slice(-8) }); } catch (e) { /* progress only */ }
  };
  try {
    const thread = (q.threadId && fsGetDoc_(cfg, 'seo_advisor/' + q.threadId)) || {};
    const history = q.threadId ? seo10Query_(project, 'seo_advisor_msgs', 'threadId', q.threadId, 40)
      .filter(function (x) { return x.id !== id && x.data.status === 'done'; })
      .sort(function (a, b) { return String(a.data.at || '').localeCompare(String(b.data.at || '')); }).slice(-6) : [];
    const mode = q.mode || 'auto';
    const goal = mode === 'goal' || (mode === 'auto' && !history.length && SEO10_GOAL_RE_.test(String(q.text || '')));
    const model = seo10Model_(goal);
    const messages = [];
    history.forEach(function (h) {
      messages.push({ role: 'user', content: String(h.data.text || '') });
      messages.push({ role: 'assistant', content: String(h.data.answerText || '(answered)') });
    });
    let ask = String(q.text || '');
    if (q.page) ask += '\n\nThe page this is about: ' + q.page;
    if (mode !== 'auto') ask += '\nKind of request: ' + mode;
    messages.push({ role: 'user', content: ask });

    const raw = seo10Claude_(model, seo10System_(D, goal), messages, D, tick);
    const ans = seo10Clean_(raw, D);
    write('seo_advisor_msgs/' + id, {
      status: 'done', doneAt: new Date(), answer: JSON.stringify(ans), answerText: seo10Summary_(ans), model: model, progress: progress.slice(-8),
    });
    const t = { busy: false, updatedAt: new Date(), kind: ans.kind };
    if (thread.titleAuto !== false && !history.length) { t.title = ans.title; t.titleAuto = false; }
    if (ans.kind === 'goal' && ans.period) {
      t.goal = { from: ans.period.from, to: ans.period.to, pages: ans.pages.map(function (p) { return p.path; }).slice(0, 10),
        clicks: ans.goal_clicks || 0, targets: ans.targets };
    }
    if (q.threadId) write('seo_advisor/' + q.threadId, t);
  } catch (e) {
    console.warn('Advisor: ' + (e.stack || e));
    write('seo_advisor_msgs/' + id, { status: 'error', error: String(e.message || e).slice(0, 300), doneAt: new Date() });
    if (q.threadId) { try { write('seo_advisor/' + q.threadId, { busy: false }); } catch (e2) { /* ignore */ } }
  }
}

/* ===================== Claude, with tools ===================== */

function seo10Claude_(model, system, messages, D, tick) {
  const key = seo7ClaudeKey_();
  if (!key) throw new Error('No Claude API key found.');
  const tools = seo10Tools_();
  const msgs = messages.slice();
  for (let turn = 0; turn < SEO10_MAX_TURNS_; turn++) {
    const last = turn >= SEO10_MAX_TURNS_ - 2;
    const res = seo10Post_(key, {
      model: model, max_tokens: 8000, system: system, tools: tools, messages: msgs,
      tool_choice: last ? { type: 'tool', name: 'give_answer' } : { type: 'auto' },
    });
    const blocks = res.content || [];
    const ans = blocks.filter(function (b) { return b.type === 'tool_use' && b.name === 'give_answer'; })[0];
    if (ans) return ans.input || {};
    const uses = blocks.filter(function (b) { return b.type === 'tool_use'; });
    msgs.push({ role: 'assistant', content: blocks });
    if (!uses.length) { msgs.push({ role: 'user', content: 'Now give your answer with the give_answer tool.' }); continue; }
    msgs.push({ role: 'user', content: uses.map(function (u) {
      tick(seo10Label_(u.name, u.input || {}));
      let out;
      try { out = seo10Tool_(D, u.name, u.input || {}); } catch (e) { out = { error: String(e.message || e).slice(0, 200) }; }
      let s = JSON.stringify(out);
      if (s.length > 14000) s = s.slice(0, 14000) + '…(cut)';
      return { type: 'tool_result', tool_use_id: u.id, content: s };
    }) });
  }
  throw new Error("The Advisor didn't finish its answer. Try asking again.");
}

function seo10Post_(key, body) {
  const payload = JSON.stringify(body);
  for (let a = 0; a < 3; a++) {
    const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: payload,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    const code = r.getResponseCode();
    if (code === 200) return JSON.parse(r.getContentText());
    if ([429, 500, 502, 503, 529].indexOf(code) !== -1 && a < 2) { Utilities.sleep(6000 * (a + 1)); continue; }
    throw new Error('Claude ' + code + ': ' + r.getContentText().slice(0, 200));
  }
  throw new Error('Claude did not answer.');
}

function seo10Label_(name, i) {
  return {
    site_totals: 'Checking the totals for ' + (i.from || '') + ' to ' + (i.to || ''),
    find_pages: 'Finding pages about “' + (i.words || '') + '”',
    page_report: 'Looking at ' + (i.path || 'the page'),
    page_clicks: 'Comparing clicks for ' + ((i.paths || []).length || 1) + ' page' + ((i.paths || []).length === 1 ? '' : 's'),
    movers: 'Finding the pages that moved',
    searches: 'Looking at searches with “' + (i.words || '') + '”',
    site_overview: 'Looking across the whole site',
    change_log: 'Reading the Change log',
    engagement: i.path ? 'Checking how long visitors stay on ' + i.path : 'Checking which pages visitors leave straight away',
  }[name] || 'Looking things up';
}

function seo10System_(D, goal) {
  const days = D.days().rows;
  const today = Utilities.formatDate(new Date(), SEO_TZ_, 'yyyy-MM-dd');
  return [
    'You are the SEO Advisor for Dermedica, a cosmetic skin clinic in Perth, Western Australia: a senior SEO specialist and a healthcare marketer working together.',
    'Today is ' + today + '. Search data runs from ' + (days[0] ? days[0].date : '?') + ' to ' + (days.length ? days[days.length - 1].date : '?') +
      '; the last 3 days may still change.',
    '',
    'Use the tools to look things up. Never guess a number: every figure must come from a tool result. For seasonal questions, look up the same period last year.',
    '',
    'How to answer:',
    '- Be direct and practical, in plain Australian English. Explain any jargon.',
    '- Be honest about what is realistic: SEO changes usually take 4 to 12 weeks to show in Google.',
    '- Steps are specific and in order, each one change someone can make. Website steps name the page.',
    '- Add a "check" to a website step when one of these can confirm it on the live page:',
    '  title {has} · titleMax {max} · titleNot {page, has} · h1 {has} · desc {has} · heading {has} (new sections, FAQ questions) ·',
    '  headingAny {any: [...]} · text {any: [...]} · words {min} · link {page, to} · alt · faqSchema',
    '- Marketing steps (Google Business Profile, emails, social posts) are welcome. Emails only go to patients who agreed to marketing.',
    '- Bounce rate (engagement tool, page_report, site_overview): over 65% with 20+ visits means the page isn\'t giving searchers what they wanted.',
    '  Suggest first-screen fixes (a 2–3 sentence answer to the search and a Book a consultation button above the first image), phone fixes when phones bounce',
    '  10+ points more than computers, a faster top image when mobile speed is under 50, and links to related treatments. A high bounce on contact,',
    '  booking or short news pages is normal: don\'t treat it as a problem. Rankings bring visitors; low bounce turns them into bookings.',
    '- Write drafts the team can paste: FAQs (from real searches), titles and descriptions, sections, emails, posts. Base them on the page\'s own content.',
    '  Use [your price] instead of inventing prices. Set clinical: true on drafts that state clinical facts (results, downtime, sessions, risks).',
    '- Australian health advertising rules (AHPRA, TGA) apply to every draft and step: no testimonials, no promises of results,',
    '  no "best" or "leading" claims, never downplay risk, pain or downtime, no prescription medicine names (such as Botox) in advertising.',
    goal
      ? '- This is a goal: give the period (from, to), the pages involved, a dated route up to the deadline with the website work first, measurable targets including goal_clicks, and an honest check.'
      : '- For a page: what is happening, why, the fixes in order, and drafts. For a question: answer it directly with the numbers, then what to do.',
    '- Keep it scannable: a one or two sentence headline, up to 4 numbers, up to 5 findings, and up to 3 follow-up questions worth asking.',
    '- Finish by calling give_answer.',
  ].join('\n');
}

/* ===================== The tools ===================== */

const SEO10_ANSWER_SCHEMA_ = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['goal', 'page', 'question'] },
    title: { type: 'string', description: 'Short title for this conversation, e.g. "Skin lifting for December"' },
    headline: { type: 'string', description: 'The answer in one or two plain sentences' },
    now: { type: 'array', description: 'Up to 4 key numbers', items: { type: 'object', properties: {
      label: { type: 'string' }, value: { type: 'string' }, note: { type: 'string' }, tone: { type: 'string', enum: ['up', 'down', 'flat'] } } } },
    findings: { type: 'array', items: { type: 'string' }, description: "What's happening and why (up to 5)" },
    pages: { type: 'array', items: { type: 'object', properties: {
      path: { type: 'string' }, role: { type: 'string', description: 'Main page, Supporting, Competing or Related' }, note: { type: 'string' },
      status: { type: 'string', enum: ['good', 'watch', 'problem'] } } } },
    steps: { type: 'array', items: { type: 'object', properties: {
      when: { type: 'string', description: 'e.g. "This week", "10–16 Nov", "December"' }, title: { type: 'string' }, detail: { type: 'string' },
      area: { type: 'string', enum: ['website', 'marketing'] }, effort: { type: 'string', enum: ['Quick', 'Medium', 'Bigger'] },
      page: { type: 'string' }, check: { type: 'object', description: 'A website check that confirms this step, e.g. {"k":"heading","has":"ultherapy cost"}' },
      drafts: { type: 'array', items: { type: 'integer' }, description: 'Numbers (from 0) of the drafts that go with this step' } } } },
    drafts: { type: 'array', items: { type: 'object', properties: {
      type: { type: 'string', enum: ['faq', 'title_meta', 'email', 'section', 'gbp', 'social', 'outline', 'text'] }, label: { type: 'string' },
      items: { type: 'array', items: { type: 'object', properties: { q: { type: 'string' }, a: { type: 'string' } } } },
      title: { type: 'string' }, description: { type: 'string' }, subject: { type: 'string' },
      text: { type: 'string', description: 'Use "## " for headings and "- " for bullet points' },
      clinical: { type: 'boolean', description: 'true if it states clinical facts (results, downtime, sessions, risks)' } } } },
    targets: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } } },
    period: { type: 'object', description: 'Goals only: the dates the goal is about', properties: { from: { type: 'string' }, to: { type: 'string' } } },
    goal_clicks: { type: 'integer', description: 'Goals only: target clicks to the goal pages during the period' },
    honest: { type: 'string', description: 'An honest check of what is realistic' },
    followups: { type: 'array', items: { type: 'string' }, description: 'Up to 3 useful follow-up questions' },
  },
  required: ['kind', 'title', 'headline'],
};

function seo10Tools_() {
  const date = { type: 'string', description: 'YYYY-MM-DD' };
  return [
    { name: 'site_totals', description: 'Whole-site Google totals (Search Console and GA4) for a date range, with an optional comparison range. Use for "how are we doing", seasons and last year.',
      input_schema: { type: 'object', properties: { from: date, to: date, compare_from: date, compare_to: date }, required: ['from', 'to'] } },
    { name: 'find_pages', description: 'Find pages about a treatment, concern or area, with clicks, position, priority number and cluster role.',
      input_schema: { type: 'object', properties: { words: { type: 'string', description: 'e.g. "skin lifting ultherapy"' } }, required: ['words'] } },
    { name: 'page_report', description: "Everything about one page: 28-day numbers vs the 28 before, weekly clicks, its searches, competing pages, Site health and content problems, FAQs, cluster, priority details, tasks, recent changes, bounce rate and engaged time (phones vs computers), and the page's headings and text.",
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'e.g. /neck-pigmentation-perth/' } }, required: ['path'] } },
    { name: 'page_clicks', description: 'Clicks from Google to one or more pages for any dates (daily data, about 16 months), with an optional comparison range such as the same time last year.',
      input_schema: { type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } }, from: date, to: date, compare_from: date, compare_to: date }, required: ['paths', 'from', 'to'] } },
    { name: 'movers', description: 'Pages that gained and lost the most clicks between two date ranges.',
      input_schema: { type: 'object', properties: { from: date, to: date, compare_from: date, compare_to: date, limit: { type: 'integer' } }, required: ['from', 'to', 'compare_from', 'compare_to'] } },
    { name: 'searches', description: 'Google searches containing all the given words (last 28 days vs the 28 before), with clicks, impressions, position and the page Google shows.',
      input_schema: { type: 'object', properties: { words: { type: 'string' }, limit: { type: 'integer' } }, required: ['words'] } },
    { name: 'site_overview', description: 'The big picture: priority pages and how they are doing, topics with their clicks, clusters, Site health and content problem counts, duplicate pages, and task progress.',
      input_schema: { type: 'object', properties: {} } },
    { name: 'engagement', description: 'Bounce rate and engaged time of visitors from Google search (GA4, last 28 days vs the 28 before), with phones vs computers. Without a path: the whole site and the pages losing the most visitors. With a path: one page.',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'e.g. /neck-pigmentation-perth/ (leave out for the whole site)' }, limit: { type: 'integer' } } } },
    { name: 'change_log', description: 'Changes made to the website between two dates.',
      input_schema: { type: 'object', properties: { from: date, to: date }, required: ['from', 'to'] } },
    { name: 'give_answer', description: 'Give your final answer. Always finish with this.', input_schema: SEO10_ANSWER_SCHEMA_ },
  ];
}

function seo10Tool_(D, name, i) {
  switch (name) {
    case 'site_totals': return { range: seo10Totals_(D, i.from, i.to), compare: i.compare_from && i.compare_to ? seo10Totals_(D, i.compare_from, i.compare_to) : null };
    case 'find_pages': return seo10Find_(D, i.words);
    case 'page_report': return seo10PageReport_(D, i.path);
    case 'page_clicks': return seo10PageClicks_(D, i.paths || [], i.from, i.to, i.compare_from, i.compare_to);
    case 'movers': return seo10Movers_(D, i.from, i.to, i.compare_from, i.compare_to, Math.min(20, Number(i.limit) || 10));
    case 'searches': return seo10Searches_(D, i.words, Math.min(60, Number(i.limit) || 30));
    case 'site_overview': return seo10Overview_(D);
    case 'engagement': return seo12Lookup_(i);
    case 'change_log': return D.log().filter(function (e) { return e.date >= i.from && e.date <= i.to; })
      .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).slice(0, 60)
      .map(function (e) { return { date: e.date, page: e.url || 'site-wide', change: e.title, type: e.type }; });
  }
  return { error: 'Unknown tool' };
}

/* ===================== The data (read once per run) ===================== */

function seo10Data_(cfg) {
  const memo = {};
  const once = function (k, fn) { if (!(k in memo)) memo[k] = fn(); return memo[k]; };
  const D = {
    origin: seoOrigin_(),
    settings: function () { return once('settings', function () { return fsGetDoc_(cfg, 'seo_settings/main') || {}; }); },
    days: function () {
      return once('days', function () {
        const ov = fsGetDoc_(cfg, 'seo_state/overview') || {};
        const cols = ov.cols || [];
        let rows = [];
        try { rows = JSON.parse(ov.days || '[]'); } catch (e) { rows = []; }
        return { build: ov.build || '', rows: rows.map(function (r) { const o = {}; cols.forEach(function (c, n) { o[c] = r[n]; }); return o; }) };
      });
    },
    pages: function () { return once('pages', function () { const b = D.days().build; return b ? fsQuery_(cfg, 'seo_pages', 'build', 'EQUAL', b, 5000) : []; }); },
    queries: function () {
      return once('queries', function () {
        const st = fsGetDoc_(cfg, 'seo_state/queries') || {};
        let rows = [];
        if (st.build) {
          fsQuery_(cfg, 'seo_queries', 'build', 'EQUAL', st.build, 100).sort(function (a, b) { return Number(a.n) - Number(b.n); })
            .forEach(function (d) { try { rows = rows.concat(JSON.parse(d.rows || '[]')); } catch (e) { /* skip */ } });
        }
        return rows;
      });
    },
    wp: function () {
      return once('wp', function () {
        const m = {};
        try { JSON.parse((fsGetDoc_(cfg, 'seo_settings/wp') || {}).pages || '[]').forEach(function (p) { m[seo10N_(p.path)] = p; }); } catch (e) { /* none */ }
        return m;
      });
    },
    health: function () { return once('health', function () { const st = fsGetDoc_(cfg, 'seo_state/health') || {}; return st.build ? fsQuery_(cfg, 'seo_health', 'build', 'EQUAL', st.build, 200) : []; }); },
    content: function () {
      return once('content', function () {
        const j = function (p, d) { try { return JSON.parse((fsGetDoc_(cfg, p) || {}).json || d); } catch (e) { return JSON.parse(d); } };
        return { deep: j('seo_content/deep', '{}'), dups: j('seo_content/dups', '[]') };
      });
    },
    tasks: function () { return once('tasks', function () { return fsListAll_(cfg, 'seo_tasks', ['path', 'title', 'status', 'steps']).map(function (d) { return fromFields_(d.fields || {}); }); }); },
    log: function () { return once('log', function () { return fsListAll_(cfg, 'seo_log', ['date', 'title', 'url', 'type']).map(function (d) { return fromFields_(d.fields || {}); }); }); },
  };
  return D;
}

/* ===================== Tool helpers ===================== */

function seo10P_(p) {
  p = String(p || '').trim().replace(/^https?:\/\/[^\/]+/i, '').split('#')[0].split('?')[0];
  return p.charAt(0) === '/' ? p : '/' + p;
}
function seo10N_(p) { return seo10P_(p).toLowerCase().replace(/\/+$/, '') || '/'; }
function seo10Title_(D, p) { const w = D.wp()[seo10N_(p)]; return (w && w.title) || seo10P_(p); }

// The page with the most impressions for each address (Search Console can list a page with and without the end slash)
function seo10Best_(D) {
  if (D._best) return D._best;
  const m = {};
  D.pages().forEach(function (p) {
    const k = seo10N_(p.path);
    if (!m[k] || Number((p.m28 || {}).impressions || 0) > Number((m[k].m28 || {}).impressions || 0)) m[k] = p;
  });
  return (D._best = m);
}

function seo10Clicks_(p, from, to) {
  if (!from || !to || typeof p.daily !== 'string' || !p.dailyFrom) return 0;
  if (!p._d) p._d = p.daily ? p.daily.split(',').map(Number) : [];
  const base = Date.parse(p.dailyFrom + 'T00:00:00Z');
  const i0 = Math.max(0, Math.round((Date.parse(from + 'T00:00:00Z') - base) / 864e5));
  const i1 = Math.min(p._d.length - 1, Math.round((Date.parse(to + 'T00:00:00Z') - base) / 864e5));
  let s = 0;
  for (let i = i0; i <= i1; i++) s += p._d[i] || 0;
  return s;
}

function seo10Totals_(D, from, to) {
  const t = { clicks: 0, impressions: 0, pw: 0, pi: 0, sessions: 0, key: 0, brand: 0, days: 0 };
  D.days().rows.forEach(function (d) {
    if (d.date < from || d.date > to) return;
    t.days++; t.clicks += d.clicks || 0; t.impressions += d.impressions || 0;
    if (d.position != null && d.impressions) { t.pw += d.position * d.impressions; t.pi += d.impressions; }
    t.sessions += d.sessions || 0; t.key += d.conversions || 0;
    if (d.brandClicks != null) t.brand += d.brandClicks;
  });
  return { from: from, to: to, days: t.days, clicks: t.clicks, impressions: t.impressions,
    ctr_percent: t.impressions ? Math.round((t.clicks / t.impressions) * 10000) / 100 : 0,
    avg_position: t.pi ? Math.round((t.pw / t.pi) * 10) / 10 : null, organic_sessions: t.sessions, key_events: t.key,
    brand_clicks: t.brand, non_brand_clicks: t.clicks - t.brand };
}

function seo10Where_(D, path) {
  const set = D.settings(), k = seo10N_(path);
  const num = (set.keyPages || []).findIndex(function (p) { return seo10N_(p) === k; });
  const cl = (set.clusters || []).filter(function (c) {
    return c && (seo10N_(c.main) === k || (c.pages || []).some(function (p) { return p && seo10N_(p.path) === k; }));
  })[0];
  return {
    priority: num >= 0 ? '#' + (num + 1) : null,
    cluster: cl ? { name: cl.name, role: seo10N_(cl.main) === k ? 'Main page'
      : ((cl.pages || []).filter(function (p) { return seo10N_(p.path) === k; })[0] || {}).role === 'merge' ? 'Merge into main' : 'Supporting' } : null,
  };
}

function seo10Find_(D, words) {
  const ws = String(words || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 2; });
  const best = seo10Best_(D), wp = D.wp();
  const score = {};
  Object.keys(wp).concat(Object.keys(best)).forEach(function (k) {
    const hay = ((wp[k] || {}).title || '') + ' ' + k.replace(/[-_\/]+/g, ' ');
    const n = ws.filter(function (w) { return hay.toLowerCase().indexOf(w) !== -1; }).length;
    if (n) score[k] = (score[k] || 0) + n * 1000;
  });
  D.queries().forEach(function (r) {   // pages Google shows for searches with these words
    const l = String(r[0]).toLowerCase();
    if (!ws.length || !ws.every(function (w) { return l.indexOf(w) !== -1; })) return;
    (r[7] || []).forEach(function (p) { const k = seo10N_(p[0]); score[k] = (score[k] || 0) + Number(p[2] || 0); });
  });
  return Object.keys(score).sort(function (a, b) { return score[b] - score[a]; }).slice(0, 15).map(function (k) {
    const p = best[k];
    const w = seo10Where_(D, k);
    return { path: p ? p.path : (wp[k] || {}).path || k, title: seo10Title_(D, k),
      clicks_28d: p ? p.m28.clicks : 0, clicks_prev_28d: p ? p.prev28.clicks : 0, avg_position: p ? p.m28.position : null,
      priority: w.priority, cluster: w.cluster };
  });
}

// Bounce rate for page_report and site_overview (Seo12.gs). Never stops the report.
function seo10Eng_(path) {
  try {
    if (path) return seo12Lookup_({ path: path });
    const r = seo12Lookup_({ limit: 8 });
    return { period: r.period, meaning: r.meaning, site: r.site, pages_losing_most_visitors: r.pagesLosingMostVisitors };
  } catch (e) { return 'Not available: ' + String(e.message || e).slice(0, 120); }
}

function seo10PageReport_(D, path) {
  const k = seo10N_(path);
  const best = seo10Best_(D)[k] || null, wp = D.wp()[k] || null;
  if (!best && !wp) return { error: 'No page with that address. Use find_pages first.' };
  const all = D.pages().filter(function (p) { return seo10N_(p.path) === k; });
  const sum = function (per, f) { return all.reduce(function (a, p) { return a + Number(((p[per] || {})[f]) || 0); }, 0); };

  const mine = [], comp = {};
  D.queries().forEach(function (r) {
    const pages = r[7] || [];
    const me = pages.filter(function (p) { return seo10N_(p[0]) === k; })[0];
    if (!me) return;
    const was = (r[8] || []).filter(function (p) { return seo10N_(p[0]) === k; })[0];
    mine.push({ search: r[0], clicks: me[1], impressions: me[2], position: me[3], prev_position: was ? was[3] : null });
    pages.forEach(function (p) {
      const pk = seo10N_(p[0]);
      if (pk === k) return;
      const x = comp[pk] || (comp[pk] = { path: p[0], shared_searches: 0, impressions: 0, clicks: 0 });
      x.shared_searches++; x.impressions += Number(p[2] || 0); x.clicks += Number(p[1] || 0);
    });
  });
  mine.sort(function (a, b) { return b.impressions - a.impressions; });

  const hp = D.health().filter(function (h) { return seo10N_(h.path) === k; })[0] || null;
  const cd = D.content().deep[k] || null;
  const set = D.settings();
  const info = (set.priorityInfo || []).filter(function (x) { return seo10N_(x.path) === k; })[0] || null;
  const where = seo10Where_(D, k);
  const tasks = D.tasks().filter(function (t) { return seo10N_(t.path) === k && t.status !== 'dismissed'; }).map(function (t) {
    const st = Object.keys(t.steps || {}).map(function (id) { return t.steps[id]; });
    return { task: t.title, status: t.status, steps_done: st.filter(function (s) { return s.status === 'confirmed' || s.status === 'done'; }).length,
      steps: st.length, open_steps: st.filter(function (s) { return s.status === 'todo'; }).map(function (s) { return s.text; }).slice(0, 8) };
  });
  let live = null;
  try {
    const url = D.origin + seo10P_(path);
    const r = seo3Fetch_([url], true)[0];
    if (r && !r.error && r.code === 200) {
      const pg = seo9Read_(r.text, url, D.origin, {});
      live = { headings: seo7Outline_(r.text).slice(0, 40), words: pg.words, text: pg.text.slice(0, 3500) };
    }
  } catch (e) { live = null; }

  return {
    path: best ? best.path : wp.path, title: seo10Title_(D, k), wordpress_last_saved: wp ? wp.mod : '',
    last_28_days: { clicks: sum('m28', 'clicks'), impressions: sum('m28', 'impressions'), avg_position: best ? best.m28.position : null,
      organic_sessions: sum('m28', 'sessions'), key_events: sum('m28', 'conversions') },
    previous_28_days: { clicks: sum('prev28', 'clicks'), impressions: sum('prev28', 'impressions'), avg_position: best ? best.prev28.position : null },
    weekly_clicks_last_12_weeks: best ? best.weekly : [],
    searches: mine.slice(0, 25),
    competing_pages: Object.keys(comp).map(function (x) { return comp[x]; }).sort(function (a, b) { return b.impressions - a.impressions; }).slice(0, 6)
      .map(function (x) { x.title = seo10Title_(D, x.path); return x; }),
    priority: where.priority ? { number: where.priority, target_search: info ? info.target : '', goal: info ? info.goal : '' } : null,
    cluster: where.cluster,
    site_health: hp ? {
      title_tag: hp.title, description: hp.desc, main_heading: hp.h1Text, words: hp.words, mobile_speed_score: hp.speed ? hp.speed.score : null,
      problems: (hp.issues || []).slice(0, 15).map(function (i) { return i.sev + ': ' + i.msg + (i.detail ? ' (' + String(i.detail).slice(0, 120) + ')' : ''); }),
    } : 'Not checked by Site health (not a priority page)',
    content_checks: cd ? {
      faq_section: cd.faq, faq_schema: cd.faqSchema, medically_reviewed_line: cd.reviewed, other_pages_linking_in: cd.inbound,
      proofreading: ((cd.ai || {}).issues || []).slice(0, 10).map(function (i) { return i.type + ': "' + i.text + '" → ' + (i.fix || i.why); }),
    } : null,
    tasks: tasks,
    recent_changes: D.log().filter(function (e) { return seo10N_(e.url) === k; }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })
      .slice(0, 8).map(function (e) { return { date: e.date, change: e.title }; }),
    engagement: seo10Eng_(path),
    live_page: live,
  };
}

function seo10PageClicks_(D, paths, from, to, cf, ct) {
  const out = paths.slice(0, 20).map(function (p) {
    const k = seo10N_(p);
    const all = D.pages().filter(function (x) { return seo10N_(x.path) === k; });
    const now = all.reduce(function (a, x) { return a + seo10Clicks_(x, from, to); }, 0);
    const was = cf && ct ? all.reduce(function (a, x) { return a + seo10Clicks_(x, cf, ct); }, 0) : null;
    return { path: p, title: seo10Title_(D, p), clicks: now, compare_clicks: was };
  });
  return { from: from, to: to, compare_from: cf || null, compare_to: ct || null, pages: out,
    total: out.reduce(function (a, x) { return a + x.clicks; }, 0),
    compare_total: cf && ct ? out.reduce(function (a, x) { return a + (x.compare_clicks || 0); }, 0) : null };
}

function seo10Movers_(D, f, t, cf, ct, lim) {
  const by = {};
  D.pages().forEach(function (p) {
    const k = seo10N_(p.path);
    const x = by[k] || (by[k] = { path: p.path, now: 0, was: 0 });
    x.now += seo10Clicks_(p, f, t); x.was += seo10Clicks_(p, cf, ct);
  });
  const list = Object.keys(by).map(function (k) { return by[k]; }).filter(function (x) { return x.now + x.was >= 5; })
    .map(function (x) { return { path: x.path, title: seo10Title_(D, x.path), clicks: x.now, compare_clicks: x.was, change: x.now - x.was }; });
  return {
    gaining: list.filter(function (x) { return x.change > 0; }).sort(function (a, b) { return b.change - a.change; }).slice(0, lim),
    losing: list.filter(function (x) { return x.change < 0; }).sort(function (a, b) { return a.change - b.change; }).slice(0, lim),
  };
}

function seo10Searches_(D, words, lim) {
  const ws = String(words || '').toLowerCase().split(/\s+/).filter(Boolean);
  return D.queries().filter(function (r) { const l = String(r[0]).toLowerCase(); return ws.every(function (w) { return l.indexOf(w) !== -1; }); })
    .sort(function (a, b) { return b[2] - a[2]; }).slice(0, lim).map(function (r) {
      const top = (r[7] || [])[0];
      return { search: r[0], clicks: r[1], impressions: r[2], position: r[3], prev_clicks: r[4], prev_impressions: r[5], prev_position: r[6],
        page_google_shows: top ? top[0] : '' };
    });
}

function seo10Overview_(D) {
  const set = D.settings(), best = seo10Best_(D);
  const rows = D.queries();
  const pri = (set.keyPages || []).map(function (p, n) {
    const k = seo10N_(p), pg = best[k];
    const info = (set.priorityInfo || []).filter(function (x) { return seo10N_(x.path) === k; })[0] || {};
    let pos = null;
    if (info.target) {
      const r = rows.filter(function (r) { return String(r[0]).toLowerCase() === String(info.target).toLowerCase(); })[0];
      const me = r && (r[7] || []).filter(function (x) { return seo10N_(x[0]) === k; })[0];
      pos = me ? me[3] : null;
    }
    return { number: n + 1, path: p, title: seo10Title_(D, p), clicks_28d: pg ? pg.m28.clicks : 0, clicks_prev_28d: pg ? pg.prev28.clicks : 0,
      target_search: info.target || '', target_position: pos };
  });
  const topics = (set.topics || []).map(function (t) { return { name: t.name, words: (t.words || []).map(function (w) { return String(w).toLowerCase(); }) }; });
  const tsum = topics.map(function (t) { return { topic: t.name, clicks: 0, prev_clicks: 0, impressions: 0 }; });
  rows.forEach(function (r) {
    const l = String(r[0]).toLowerCase();
    const i = topics.findIndex(function (t) { return t.words.some(function (w) { return w && l.indexOf(w) !== -1; }); });
    if (i < 0) return;
    tsum[i].clicks += r[1]; tsum[i].impressions += r[2]; tsum[i].prev_clicks += r[4];
  });
  const issues = { high: 0, medium: 0, low: 0 };
  D.health().forEach(function (h) { (h.issues || []).forEach(function (i) { issues[i.sev] = (issues[i.sev] || 0) + 1; }); });
  const C = D.content();
  let spelling = 0, compliance = 0, noFaq = 0;
  Object.keys(C.deep).forEach(function (k) {
    const d = C.deep[k];
    ((d.ai || {}).issues || []).forEach(function (i) { if (i.type === 'compliance') compliance++; else spelling++; });
    if (!d.faq) noFaq++;
  });
  const T = D.tasks();
  return {
    priority_pages: pri, topics: tsum,
    clusters: (set.clusters || []).map(function (c) { return { name: c.name, main: c.main, pages: (c.pages || []).length + 1 }; }),
    site_health_problems: issues,
    content: { spelling_grammar: spelling, advertising_rules: compliance, pages_without_faq: noFaq, duplicate_pairs: (C.dups || []).slice(0, 8) },
    tasks: { open: T.filter(function (t) { return t.status === 'open'; }).length, done: T.filter(function (t) { return t.status === 'done'; }).length },
    engagement: seo10Eng_(),
  };
}

/* ===================== Tidying the answer ===================== */

function seo10Clean_(a, D) {
  a = a || {};
  const s = function (v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); };
  const arr = function (v, n) { return (Array.isArray(v) ? v : []).slice(0, n); };
  const known = function (p) { const k = seo10N_(p); return !!(seo10Best_(D)[k] || D.wp()[k]); };
  const banned = seo3Words_(D.settings()).map(function (w) { return w.word; });
  const okDate = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); };
  return {
    kind: ['goal', 'page', 'question'].indexOf(a.kind) !== -1 ? a.kind : 'question',
    title: s(a.title, 90) || 'Answer',
    headline: s(a.headline, 400),
    now: arr(a.now, 4).map(function (x) { x = x || {}; return { label: s(x.label, 60), value: s(x.value, 30), note: s(x.note, 90),
      tone: ['up', 'down', 'flat'].indexOf(x.tone) !== -1 ? x.tone : 'flat' }; }),
    findings: arr(a.findings, 6).map(function (x) { return s(x, 400); }).filter(Boolean),
    pages: arr(a.pages, 10).filter(function (p) { return p && p.path && known(p.path); }).map(function (p) {
      return { path: seo10P_(p.path), title: seo10Title_(D, p.path), role: s(p.role, 30), note: s(p.note, 220),
        status: ['good', 'watch', 'problem'].indexOf(p.status) !== -1 ? p.status : 'watch' };
    }),
    steps: arr(a.steps, 14).map(function (st) {
      st = st || {};
      const page = st.page && known(st.page) ? seo10P_(st.page) : '';
      return { when: s(st.when, 40), title: s(st.title, 180), detail: s(st.detail, 600), area: st.area === 'marketing' ? 'marketing' : 'website',
        effort: ['Quick', 'Medium', 'Bigger'].indexOf(st.effort) !== -1 ? st.effort : 'Medium', page: page,
        check: st.area === 'marketing' ? null : seo10Check_(st.check, page),
        drafts: arr(st.drafts, 4).map(Number).filter(function (n) { return n >= 0 && n < 8; }) };
    }).filter(function (st) { return st.title; }),
    drafts: arr(a.drafts, 8).map(function (d, n) { return seo10Draft_(d, n, banned, s); }),
    targets: arr(a.targets, 4).map(function (t) { t = t || {}; return { label: s(t.label, 100), value: s(t.value, 40) }; }).filter(function (t) { return t.label; }),
    period: a.period && okDate(a.period.from) && okDate(a.period.to) ? { from: a.period.from, to: a.period.to } : null,
    goal_clicks: Number(a.goal_clicks) > 0 ? Math.round(Number(a.goal_clicks)) : null,
    honest: s(a.honest, 500),
    followups: arr(a.followups, 3).map(function (x) { return s(x, 160); }).filter(Boolean),
  };
}

function seo10Draft_(d, n, banned, s) {
  d = d || {};
  const type = ['faq', 'title_meta', 'email', 'section', 'gbp', 'social', 'outline', 'text'].indexOf(d.type) !== -1 ? d.type : 'text';
  const o = { i: n, type: type, label: s(d.label, 100) || 'Draft', clinical: !!d.clinical };
  if (type === 'faq') {
    o.items = (Array.isArray(d.items) ? d.items : []).slice(0, 10).map(function (x) { return { q: s(x && x.q, 220), a: s(x && x.a, 900) }; })
      .filter(function (x) { return x.q && x.a; });
  } else if (type === 'title_meta') { o.title = s(d.title, 90); o.description = s(d.description, 220); }
  else if (type === 'email') { o.subject = s(d.subject, 140); o.text = String(d.text || '').slice(0, 4000); }
  else o.text = String(d.text || '').slice(0, 5000);
  const all = [o.title, o.description, o.subject, o.text].concat((o.items || []).map(function (x) { return x.q + ' ' + x.a; })).join(' ');
  const bad = seo7Risky_(all, banned);
  if (bad) o.warn = 'Uses “' + bad + '”, which your advertising rules don\'t allow. Reword it before publishing.';
  return o;
}

function seo10Check_(c, page) {
  if (!c || SEO10_CHECKS_.indexOf(c.k) === -1) return null;
  if (!page && !c.page) return null;
  const str = function (v) { return String(v || '').trim().toLowerCase().slice(0, 100); };
  const o = { k: c.k, page: seo10P_(c.page || page) };
  if (['title', 'titleNot', 'h1', 'heading'].indexOf(c.k) !== -1) { o.has = str(c.has); if (o.has.length < 3) return null; }
  if (c.k === 'desc') { o.min = 70; o.max = 160; if (c.has) o.has = str(c.has); }
  if (c.k === 'titleMax') o.max = Math.min(70, Math.max(40, Math.round(Number(c.max)) || 60));
  if (c.k === 'headingAny' || c.k === 'text') {
    o.any = (Array.isArray(c.any) ? c.any : []).map(str).filter(function (x) { return x.length >= 3; }).slice(0, 6);
    if (!o.any.length) return null;
  }
  if (c.k === 'words') { const n = Number(c.min); if (!n) return null; o.min = Math.min(3000, Math.max(300, Math.round(n))); }
  if (c.k === 'link') { if (!c.to) return null; o.to = seo10P_(c.to); }
  return o;
}

// A short version of the answer, so follow-up questions know what was said
function seo10Summary_(a) {
  return [a.headline, a.findings.map(function (f) { return '- ' + f; }).join('\n'),
    a.steps.map(function (s, n) { return (n + 1) + '. ' + (s.when ? s.when + ': ' : '') + s.title; }).join('\n'),
    a.drafts.length ? 'Drafts written: ' + a.drafts.map(function (d) { return d.label; }).join(', ') : '', a.honest]
    .filter(Boolean).join('\n\n').slice(0, 4000);
}

/* ===================== Firestore query (with document ids) ===================== */

function seo10Query_(project, coll, field, value, lim) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + project + '/databases/(default)/documents:runQuery';
  const body = { structuredQuery: { from: [{ collectionId: coll }],
    where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: String(value) } } }, limit: lim || 50 } };
  const r = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + seoToken_() }, muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('Firestore query ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText()).filter(function (x) { return x.document; })
    .map(function (x) { return { id: x.document.name.split('/').pop(), data: fromFields_(x.document.fields || {}) }; });
}