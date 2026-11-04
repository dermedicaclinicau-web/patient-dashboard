/**
 * Seo12.gs — SEO → bounce rate and engagement of Google visitors (organic search), per landing page and device.
 * Daily ~7:30am Perth: runSeoEngagement → seo_state/engagement { json, at, ok, error, pages }.
 * json: { from, to, pfrom, pto, at,
 *         site:  { c: [s, e, t, k], p: [s, e, t, k], dev: { mobile: [s, e, t], desktop: […], tablet: […] } },
 *         pages: { "/address": { c: [s, e, t, k], p: [s, e, t, k], m: [s, e, t], d: [s, e, t] } } }
 *   c = last 28 days, p = the 28 before, m = mobile, d = desktop (last 28 days)
 *   s sessions · e engaged sessions · t engaged seconds (total) · k key events.  Bounce rate = 1 − e / s.
 * Addresses are lower case, without ?query, #part or the end slash ("/" for the home page), like the portal's.
 */

const SEO12_DAYS_ = 28;
const SEO12_DOC_ = 'seo_state/engagement';

function runSeoEngagement() {
  const cfg = getConfig_();
  try {
    const out = seo12Build_();
    let json = JSON.stringify(out);
    if (json.length > 900000) {   // a Firestore document holds 1 MB: keep the busiest pages
      const keep = Object.keys(out.pages).sort(function (a, b) {
        return (out.pages[b].c[0] + out.pages[b].p[0]) - (out.pages[a].c[0] + out.pages[a].p[0]);
      }).slice(0, 1500);
      const pages = {};
      keep.forEach(function (k) { pages[k] = out.pages[k]; });
      out.pages = pages;
      json = JSON.stringify(out);
    }
    commitWrites_(cfg, [updateWrite_(cfg, SEO12_DOC_, {
      json: json, at: new Date(), ok: true, error: '', pages: Object.keys(out.pages).length,
    })]);
    const s = out.site.c;
    console.log('Engagement saved: ' + Object.keys(out.pages).length + ' pages · ' + s[0] + ' Google visits · bounce ' +
      (s[0] ? Math.round((1 - s[1] / s[0]) * 100) : '—') + '%');
  } catch (e) {
    console.error('Engagement update failed: ' + (e && e.stack ? e.stack : e));
    try { fsPatch_(cfg, SEO12_DOC_, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300), failedAt: new Date().toISOString() }); }
    catch (e2) { /* the error is in the log */ }
    throw e;
  }
}

function seo12Build_() {
  const tz = 'Australia/Perth';
  const day = function (n) { return Utilities.formatDate(new Date(Date.now() - n * 864e5), tz, 'yyyy-MM-dd'); };
  const to = day(1), from = day(SEO12_DAYS_), pto = day(SEO12_DAYS_ + 1), pfrom = day(SEO12_DAYS_ * 2);
  const rep = seo12Report_({
    dateRanges: [{ startDate: from, endDate: to, name: 'cur' }, { startDate: pfrom, endDate: pto, name: 'prev' }],
    dimensions: [{ name: 'landingPage' }, { name: 'deviceCategory' }],
    metrics: ['sessions', 'engagedSessions', 'userEngagementDuration', 'keyEvents'].map(function (n) { return { name: n }; }),
    dimensionFilter: { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { matchType: 'EXACT', value: 'Organic Search' } } },
    limit: 25000,
  });
  const dh = (rep.dimensionHeaders || []).map(function (h) { return h.name; });
  const iPage = dh.indexOf('landingPage'), iDev = dh.indexOf('deviceCategory'), iRange = dh.indexOf('dateRange');
  const site = { c: [0, 0, 0, 0], p: [0, 0, 0, 0], dev: {} };
  const pages = {};
  (rep.rows || []).forEach(function (r) {
    const dv = (r.dimensionValues || []).map(function (x) { return x.value; });
    const mv = (r.metricValues || []).map(function (x) { return Number(x.value) || 0; });
    const add = function (arr, n) { for (let i = 0; i < n; i++) arr[i] += mv[i] || 0; };
    const range = iRange >= 0 ? dv[iRange] : 'cur';
    const cur = range === 'cur' || range === 'date_range_0';
    const dev = String(dv[iDev] || '').toLowerCase();
    add(cur ? site.c : site.p, 4);
    if (cur && dev) add(site.dev[dev] || (site.dev[dev] = [0, 0, 0]), 3);
    const key = seo12Key_(dv[iPage]);
    if (!key) return;
    const pg = pages[key] || (pages[key] = { c: [0, 0, 0, 0], p: [0, 0, 0, 0], m: [0, 0, 0], d: [0, 0, 0] });
    add(cur ? pg.c : pg.p, 4);
    if (cur && dev === 'mobile') add(pg.m, 3);
    if (cur && dev === 'desktop') add(pg.d, 3);
  });
  const round = function (a) { return a.map(function (v) { return Math.round(v); }); };
  site.c = round(site.c); site.p = round(site.p);
  Object.keys(site.dev).forEach(function (k) { site.dev[k] = round(site.dev[k]); });
  Object.keys(pages).forEach(function (k) {
    const p = pages[k];
    p.c = round(p.c); p.p = round(p.p); p.m = round(p.m); p.d = round(p.d);
  });
  return { from: from, to: to, pfrom: pfrom, pto: pto, at: new Date().toISOString(), site: site, pages: pages };
}

// "/Neck-Pigmentation-Perth/?utm_source=x" → "/neck-pigmentation-perth" (the same as the portal's)
function seo12Key_(v) {
  let s = String(v || '').trim();
  if (!s || s === '(not set)' || s.charAt(0) !== '/') return '';
  s = s.split('?')[0].split('#')[0];
  try { s = decodeURIComponent(s); } catch (e) { /* as it is */ }
  s = s.replace(/\/+$/, '').toLowerCase();
  return s || '/';
}

// One GA4 report. Uses the Analytics Data service if it's turned on, otherwise the API directly.
function seo12Report_(req) {
  let prop = String(PropertiesService.getScriptProperties().getProperty('GA4_PROPERTY') || '').trim();
  if (!prop) throw new Error('GA4_PROPERTY is missing from Script Properties.');
  if (!/^properties\//.test(prop)) prop = 'properties/' + prop.replace(/\D/g, '');
  const run = function (r) {
    if (typeof AnalyticsData !== 'undefined' && AnalyticsData.Properties) {
      return JSON.parse(JSON.stringify(AnalyticsData.Properties.runReport(r, prop)));
    }
    const res = UrlFetchApp.fetch('https://analyticsdata.googleapis.com/v1beta/' + prop + ':runReport', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, payload: JSON.stringify(r),
    });
    if (res.getResponseCode() !== 200) throw new Error('GA4 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    return JSON.parse(res.getContentText());
  };
  try { return run(req); }
  catch (e) {
    if (!/keyEvents/i.test(String(e && e.message ? e.message : e))) throw e;
    const r2 = JSON.parse(JSON.stringify(req));   // older properties call key events "conversions"
    r2.metrics = r2.metrics.map(function (m) { return m.name === 'keyEvents' ? { name: 'conversions' } : m; });
    return run(r2);
  }
}

/** Run ONCE from the editor: daily about 7:30am, and the first update now */
function installSeoEngagementTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoEngagement'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoEngagement').timeBased().everyDays(1).atHour(7).nearMinute(30).create();
  runSeoEngagement();
  console.log('Engagement update installed (daily, about 7:30am).');
}

/** Run from the editor: what the update would save (nothing saved) */
function testSeoEngagement() {
  const out = seo12Build_();
  const b = function (a) { return a && a[0] ? Math.round((1 - a[1] / a[0]) * 100) + '%' : '—'; };
  console.log('Google visits, ' + out.from + ' to ' + out.to + ': ' + out.site.c[0] + ' · bounce ' + b(out.site.c) + ' (the 28 days before: ' + b(out.site.p) + ')');
  Object.keys(out.site.dev).forEach(function (k) { console.log('  ' + k + ': ' + out.site.dev[k][0] + ' visits · bounce ' + b(out.site.dev[k])); });
  Object.keys(out.pages).sort(function (x, y) { return out.pages[y].c[0] - out.pages[x].c[0]; }).slice(0, 10).forEach(function (k) {
    const p = out.pages[k];
    console.log('  ' + k + ': ' + p.c[0] + ' visits · bounce ' + b(p.c) + ' · mobile ' + b(p.m) + ' · desktop ' + b(p.d));
  });
}

/* ---------- For the Advisor (Seo10.gs): engagement lookup ----------
 * seo12Lookup_({ path })      → one page: bounce, engaged time, phones vs computers, key events, vs the 28 days before
 * seo12Lookup_({ limit: 15 }) → the whole site, plus the pages losing the most Google visitors
 * Reads seo_state/engagement (the daily update) once per run; reads GA4 only if that isn't saved yet.
 */
let SEO12_MEMO_ = null;

function seo12Lookup_(input) {
  input = input || {};
  let out = SEO12_MEMO_;
  if (!out) {
    try { const d = fsGetDoc_(getConfig_(), SEO12_DOC_); if (d && d.json) out = JSON.parse(d.json); } catch (e) { /* read GA4 instead */ }
    if (!out) out = seo12Build_();
    SEO12_MEMO_ = out;
  }
  const pct = function (a) { return a && a[0] ? Math.round((1 - a[1] / a[0]) * 100) : null; };
  const secs = function (a) { return a && a[0] ? Math.round(a[2] / a[0]) : null; };
  const one = function (k, p) {
    return {
      page: k, googleVisits: p.c[0], bounceRatePct: pct(p.c), bounceBeforePct: p.p[0] >= 20 ? pct(p.p) : null,
      engagedSecondsPerVisit: secs(p.c), keyEvents: p.c[3] || 0,
      phonesBouncePct: p.m[0] >= 10 ? pct(p.m) : null, computersBouncePct: p.d[0] >= 10 ? pct(p.d) : null,
      enoughVisits: p.c[0] >= 20,
    };
  };
  const base = {
    period: out.from + ' to ' + out.to + ' (compared with the 28 days before)',
    meaning: 'Bounce = a visit from Google search that left without engaging (under 10 seconds, no second page, no booking or enquiry). Lower is better: up to 45% good, over 65% high. Pages with under 20 visits are not reliable.',
  };
  if (input.path) {
    const k = seo12Key_(String(input.path).replace(/^https?:\/\/[^/]+/i, '') || '/');
    const p = out.pages[k];
    return p ? Object.assign(base, one(k, p))
      : Object.assign(base, { page: k, note: 'No visits from Google search to this page in the last 28 days.' });
  }
  const limit = Math.max(1, Math.min(30, Number(input.limit) || 15));
  const dev = {};
  Object.keys(out.site.dev || {}).forEach(function (d) {
    dev[d] = { googleVisits: out.site.dev[d][0], bounceRatePct: pct(out.site.dev[d]), engagedSecondsPerVisit: secs(out.site.dev[d]) };
  });
  const losing = Object.keys(out.pages).filter(function (k) { return out.pages[k].c[0] >= 20; })
    .sort(function (a, b) {
      const pa = out.pages[a], pb = out.pages[b];
      return (pb.c[0] - pb.c[1]) - (pa.c[0] - pa.c[1]);
    })
    .slice(0, limit).map(function (k) { return one(k, out.pages[k]); });
  return Object.assign(base, {
    site: { googleVisits: out.site.c[0], bounceRatePct: pct(out.site.c), bounceBeforePct: pct(out.site.p),
      engagedSecondsPerVisit: secs(out.site.c), keyEvents: out.site.c[3] || 0, byDevice: dev },
    pagesLosingMostVisitors: losing,
  });
}

/** Run from the editor: checks PSI_KEY can use PageSpeed Insights */
function testPsiKey() {
  const key = String(PropertiesService.getScriptProperties().getProperty('PSI_KEY') || '').trim();
  if (!key) { console.log('PSI_KEY is missing from Script Properties.'); return; }
  const url = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance&url=' +
    encodeURIComponent(seoOrigin_() + '/') + '&key=' + encodeURIComponent(key);
  const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const code = r.getResponseCode();
  if (code === 200) {
    const j = JSON.parse(r.getContentText());
    const s = j.lighthouseResult && j.lighthouseResult.categories.performance.score;
    console.log('✓ PSI_KEY works. Home page mobile speed score: ' + (s != null ? Math.round(s * 100) : '?'));
    return;
  }
  let err = {};
  try { err = JSON.parse(r.getContentText()).error || {}; } catch (e) { /* not JSON */ }
  const info = (err.details || []).filter(function (d) { return d.reason; })[0] || {};
  const fix = {
    API_KEY_SERVICE_BLOCKED: 'The key is restricted to other APIs. Credentials → the key → API restrictions: add "PageSpeed Insights API".',
    SERVICE_DISABLED: 'PageSpeed Insights API is off in the key\'s project. Enable it: ' + ((info.metadata || {}).activationUrl || 'APIs & Services → Library'),
    API_KEY_HTTP_REFERRER_BLOCKED: 'The key only works from certain websites. Set Application restrictions to None.',
    API_KEY_IP_ADDRESS_BLOCKED: 'The key only works from certain IP addresses. Set Application restrictions to None.',
    API_KEY_INVALID: 'The key is wrong or deleted. Copy it again from Credentials.',
    RATE_LIMIT_EXCEEDED: 'Too many checks today. It resets at midnight Pacific time (about 3–4pm Perth).',
  }[info.reason] || '';
  console.log('✗ PageSpeed ' + code + (info.reason ? ' (' + info.reason + ')' : '') + ': ' + String(err.message || r.getContentText()).slice(0, 300));
  if ((info.metadata || {}).consumer) console.log('  The key belongs to ' + info.metadata.consumer + '. Check you edited that project.');
  if (fix) console.log('  Fix: ' + fix);
}