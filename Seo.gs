/**
 * Seo.gs — SEO section backend (Phase 1)
 *
 * Writes:
 *   seo_state/overview   16 months of daily totals (GSC + GA4), build id
 *   seo_state/run        last nightly run status
 *   seo_pages/p_<hash>   one doc per page: last 28d vs previous 28d, 12 weekly clicks, GA4 organic
 *
 * Script Properties used:
 *   FIRESTORE_EMAIL, FIRESTORE_KEY, FIRESTORE_PROJECT_ID   (existing service account)
 *   SEO_SITE       https://dermedica.com.au/
 *   GA4_PROPERTY   numeric GA4 property ID
 *   PSI_KEY        PageSpeed Insights API key (Phase 3)
 *
 * Setup: run runSeoNightly() once, then installSeoTriggers() once.
 */

/* ===================== Config ===================== */

const SEO_TZ_ = 'Australia/Perth';
const SEO_SCOPES_ = [
  'https://www.googleapis.com/auth/webmasters.readonly',
  'https://www.googleapis.com/auth/analytics.readonly',
  'https://www.googleapis.com/auth/datastore',
].join(' ');
const SEO_TOKEN_CACHE_ = 'seo_token_v2';
const SEO_LAG_DAYS_ = 3; // GSC data settles after ~3 days; period comparisons end here
const SEO_DAY_COLS_ = ['date', 'clicks', 'impressions', 'position', 'sessions', 'engaged', 'conversions', 'aiSessions'];

function seoProp_(name) {
  return (PropertiesService.getScriptProperties().getProperty(name) || '').trim();
}

function seoDate_(daysAgo) {
  return Utilities.formatDate(new Date(Date.now() - daysAgo * 864e5), SEO_TZ_, 'yyyy-MM-dd');
}

function seoOrigin_() {
  const site = seoProp_('SEO_SITE');
  return site.indexOf('sc-domain:') === 0 ? 'https://' + site.slice(10) : site.replace(/\/+$/, '');
}

function seoHash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); })
    .join('').slice(0, 20);
}

/* ===================== Auth (service account → OAuth token) ===================== */

function seoCfg_() {
  const email = seoProp_('FIRESTORE_EMAIL');
  const key = seoProp_('FIRESTORE_KEY').replace(/\\n/g, '\n');
  if (!email || !key) throw new Error('SEO: FIRESTORE_EMAIL or FIRESTORE_KEY missing from Script Properties');
  return { email: email, key: key };
}

function seoB64_(v) {
  const bytes = typeof v === 'string' ? Utilities.newBlob(v).getBytes() : v;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

function seoSignJwt_(claims, cfg) {
  const head = seoB64_(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = seoB64_(JSON.stringify(claims));
  return head + '.' + body + '.' + seoB64_(Utilities.computeRsaSha256Signature(head + '.' + body, cfg.key));
}

function seoToken_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(SEO_TOKEN_CACHE_);
  if (hit) return hit;
  const cfg = seoCfg_();
  const now = Math.floor(Date.now() / 1000);
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: seoSignJwt_({
        iss: cfg.email, scope: SEO_SCOPES_,
        aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
      }, cfg),
    },
  });
  const d = JSON.parse(res.getContentText());
  if (!d.access_token) throw new Error('SEO token: ' + res.getContentText().slice(0, 300));
  cache.put(SEO_TOKEN_CACHE_, d.access_token, 3000); // 50 min; token lives 60
  return d.access_token;
}

/* ===================== API clients ===================== */

/** Search Console searchAnalytics.query, paged through 25k-row pages */
function seoGsc_(body) {
  const url = 'https://www.googleapis.com/webmasters/v3/sites/' +
    encodeURIComponent(seoProp_('SEO_SITE')) + '/searchAnalytics/query';
  const out = [];
  for (let startRow = 0; startRow < 200000; startRow += 25000) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + seoToken_() },
      payload: JSON.stringify(Object.assign({ rowLimit: 25000, startRow: startRow, dataState: 'all' }, body)),
    });
    if (res.getResponseCode() !== 200) throw new Error('GSC ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    const rows = JSON.parse(res.getContentText()).rows || [];
    for (let i = 0; i < rows.length; i++) out.push(rows[i]);
    if (rows.length < 25000) break;
  }
  return out;
}

/** GA4 Data API runReport → [{ d: [dimension values], m: [metric numbers] }] */
function seoGa4_(body) {
  const res = UrlFetchApp.fetch('https://analyticsdata.googleapis.com/v1beta/properties/' +
    seoProp_('GA4_PROPERTY') + ':runReport', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + seoToken_() },
    payload: JSON.stringify(body),
  });
  if (res.getResponseCode() !== 200) throw new Error('GA4 ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  return (JSON.parse(res.getContentText()).rows || []).map(function (r) {
    return {
      d: r.dimensionValues.map(function (x) { return x.value; }),
      m: r.metricValues.map(function (x) { return Number(x.value) || 0; }),
    };
  });
}

/* ===================== Firestore writer (REST commit) ===================== */

function seoFsVal_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(seoFsVal_) } };
  switch (typeof v) {
    case 'boolean': return { booleanValue: v };
    case 'string': return { stringValue: v };
    case 'number':
      if (!isFinite(v)) return { nullValue: null };
      return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    case 'object': {
      const fields = {};
      Object.keys(v).forEach(function (k) { fields[k] = seoFsVal_(v[k]); });
      return { mapValue: { fields: fields } };
    }
  }
  return { nullValue: null };
}

/** docs: [{ path: 'seo_pages/abc', data: {...} }] — full overwrite, in order, 400 writes per commit */
function seoFsCommit_(docs) {
  const root = 'projects/' + seoProp_('FIRESTORE_PROJECT_ID') + '/databases/(default)/documents';
  for (let i = 0; i < docs.length; i += 400) {
    const writes = docs.slice(i, i + 400).map(function (d) {
      return { update: { name: root + '/' + d.path, fields: seoFsVal_(d.data).mapValue.fields } };
    });
    const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + root + ':commit', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + seoToken_() },
      payload: JSON.stringify({ writes: writes }),
    });
    if (res.getResponseCode() !== 200) throw new Error('Firestore ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
}

/* ===================== Builders ===================== */

/** 16 months of daily totals: GSC + GA4 Organic Search + GA4 AI Assistant. Rows follow SEO_DAY_COLS_. */
function seoBuildDays_(start, end) {
  const by = {};
  function row(d) { return by[d] || (by[d] = [d, 0, 0, null, 0, 0, 0, 0]); }

  seoGsc_({ startDate: start, endDate: end, dimensions: ['date'] }).forEach(function (r) {
    const x = row(r.keys[0]);
    x[1] = r.clicks;
    x[2] = r.impressions;
    x[3] = Math.round(r.position * 100) / 100;
  });

  seoGa4_({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
    dimensionFilter: { filter: { fieldName: 'sessionDefaultChannelGroup',
      inListFilter: { values: ['Organic Search', 'AI Assistant'] } } },
    limit: 100000,
  }).forEach(function (r) {
    const d = r.d[0]; // GA4 returns YYYYMMDD
    const x = row(d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8));
    if (r.d[1] === 'Organic Search') { x[4] = r.m[0]; x[5] = r.m[1]; x[6] = r.m[2]; }
    else x[7] = r.m[0];
  });

  return Object.keys(by).sort().map(function (k) { return by[k]; });
}

/** GSC reports jump links (#section) as separate URLs; fold them into their page */
function seoNormUrl_(u) {
  return u.split('#')[0];
}

function seoAgg_(map, url, r) {
  const a = map[url] || (map[url] = { c: 0, i: 0, pw: 0 });
  a.c += r.clicks;
  a.i += r.impressions;
  a.pw += r.position * r.impressions; // impression-weighted position
  return a;
}

function seoFin_(a) {
  if (!a) return { clicks: 0, impressions: 0, ctr: 0, position: null };
  return {
    clicks: a.c,
    impressions: a.i,
    ctr: a.i ? Math.round(a.c / a.i * 10000) / 10000 : 0,
    position: a.i ? Math.round(a.pw / a.i * 100) / 100 : null,
  };
}

/** Pages: last 28d vs previous 28d, 12 weekly click buckets (oldest → newest), GA4 organic landing data */
function seoBuildPages_(build) {
  const curS = seoDate_(SEO_LAG_DAYS_ + 27), curE = seoDate_(SEO_LAG_DAYS_);
  const prvS = seoDate_(SEO_LAG_DAYS_ + 55), prvE = seoDate_(SEO_LAG_DAYS_ + 28);
  const wkS = seoDate_(SEO_LAG_DAYS_ + 83);
  const wkStartMs = Date.parse(wkS + 'T00:00:00Z');

  const cur = {}, prv = {}, weekly = {};

  seoGsc_({ startDate: curS, endDate: curE, dimensions: ['page'] })
    .forEach(function (r) { seoAgg_(cur, seoNormUrl_(r.keys[0]), r); });

  seoGsc_({ startDate: prvS, endDate: prvE, dimensions: ['page'] })
    .forEach(function (r) { seoAgg_(prv, seoNormUrl_(r.keys[0]), r); });

  seoGsc_({ startDate: wkS, endDate: curE, dimensions: ['page', 'date'] }).forEach(function (r) {
    const u = seoNormUrl_(r.keys[0]);
    const w = Math.floor((Date.parse(r.keys[1] + 'T00:00:00Z') - wkStartMs) / (7 * 864e5));
    if (w < 0 || w > 11) return;
    (weekly[u] || (weekly[u] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))[w] += r.clicks;
  });

  const origin = seoOrigin_();
  const ga = {};
  seoGa4_({
    dateRanges: [{ startDate: curS, endDate: curE }],
    dimensions: [{ name: 'landingPage' }],
    metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
    dimensionFilter: { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { value: 'Organic Search' } } },
    limit: 10000,
  }).forEach(function (r) {
    const p = r.d[0];
    if (!p || p.charAt(0) !== '/') return; // skips "(not set)"
    const u = origin + p.split('?')[0];
    const g = ga[u] || (ga[u] = { s: 0, e: 0, k: 0 });
    g.s += r.m[0]; g.e += r.m[1]; g.k += r.m[2];
  });

  const urls = {};
  [cur, prv, ga].forEach(function (m) { Object.keys(m).forEach(function (u) { urls[u] = true; }); });

  return Object.keys(urls).map(function (u) {
    const m28 = seoFin_(cur[u]);
    const g = ga[u] || { s: 0, e: 0, k: 0 };
    m28.sessions = g.s;
    m28.engaged = g.e;
    m28.conversions = g.k;
    return {
      path: 'seo_pages/p_' + seoHash_(u),
      data: {
        url: u,
        path: u.replace(/^https?:\/\/[^\/]+/i, '') || '/',
        build: build,
        m28: m28,
        prev28: seoFin_(prv[u]),
        weekly: weekly[u] || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        updatedAt: new Date(),
      },
    };
  });
}

/* ===================== Nightly job ===================== */

function runSeoNightly() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { console.log('SEO nightly: already running'); return; }
  const t0 = Date.now();
  const build = Utilities.formatDate(new Date(), SEO_TZ_, "yyyyMMdd'T'HHmm");
  try {
    const days = seoBuildDays_(seoDate_(480), seoDate_(1));
    const pages = seoBuildPages_(build);

    // Overview is written LAST: it carries the build id, so the UI only
    // switches to the new page set once every page doc has been written.
    seoFsCommit_(pages.concat([{
      path: 'seo_state/overview',
      data: {
        build: build,
        cols: SEO_DAY_COLS_,
        days: JSON.stringify(days), // Firestore can't hold arrays of arrays
        pageCount: pages.length,
        periodEndLag: SEO_LAG_DAYS_,
        periodEnd: seoDate_(SEO_LAG_DAYS_),
        updatedAt: new Date(),
      },
    }]));

    seoFsCommit_([{ path: 'seo_state/run', data: { ok: true, at: new Date(), ms: Date.now() - t0, build: build } }]);
    console.log('SEO nightly OK: ' + days.length + ' days, ' + pages.length + ' pages, ' + (Date.now() - t0) + ' ms');
  } catch (e) {
    try {
      seoFsCommit_([{ path: 'seo_state/run', data: { ok: false, at: new Date(), error: String(e.message || e).slice(0, 500) } }]);
    } catch (ignore) {}
    throw e; // Apps Script emails the failure
  } finally {
    lock.releaseLock();
  }
}

function installSeoTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoNightly'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoNightly').timeBased().everyDays(1).atHour(6).inTimezone(SEO_TZ_).create();
  console.log('runSeoNightly scheduled daily ~6am Perth');
}

/* ===================== Tests (run from the editor) ===================== */

function seoListProps() {
  const p = PropertiesService.getScriptProperties().getProperties();
  Object.keys(p).sort().forEach(function (k) {
    const v = p[k] || '';
    console.log('"' + k + '" = ' + (k.indexOf('KEY') >= 0 ? v.slice(0, 6) + '…(' + v.length + ' chars)' : v));
  });
}

function testPsi() {
  const key = seoProp_('PSI_KEY');
  if (!key) throw new Error('PSI_KEY is missing from Script Properties. Run seoListProps() to check the names.');
  const url = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=' +
    encodeURIComponent(seoOrigin_() + '/') + '&strategy=mobile&category=performance&key=' + key;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) { console.log('PSI ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300)); return; }
  const d = JSON.parse(res.getContentText());
  const score = Math.round((d.lighthouseResult.categories.performance.score || 0) * 100);
  const crux = (d.loadingExperience && d.loadingExperience.overall_category) || 'not enough real-user data';
  console.log('Mobile performance: ' + score + '/100 · Real users (Core Web Vitals): ' + crux);
}

function testSeoAccess() {
  CacheService.getScriptCache().remove(SEO_TOKEN_CACHE_);
  const auth = { headers: { Authorization: 'Bearer ' + seoToken_() }, muteHttpExceptions: true };

  const s = UrlFetchApp.fetch('https://www.googleapis.com/webmasters/v3/sites', auth);
  if (s.getResponseCode() !== 200) {
    console.log('GSC ' + s.getResponseCode() + ': ' + s.getContentText().slice(0, 300));
  } else {
    const sites = JSON.parse(s.getContentText()).siteEntry || [];
    if (!sites.length) console.log('GSC: no properties visible. Add ' + seoCfg_().email + ' as a user in Search Console.');
    sites.forEach(function (e) { console.log('GSC property: "' + e.siteUrl + '"  (' + e.permissionLevel + ')'); });
    const want = seoProp_('SEO_SITE');
    const match = sites.some(function (e) { return e.siteUrl === want; });
    console.log('SEO_SITE = "' + want + '" → ' + (match ? 'MATCH ✓' : 'NO MATCH: copy one of the strings above exactly'));
  }

  try {
    seoGa4_({
      dateRanges: [{ startDate: '7daysAgo', endDate: 'yesterday' }],
      dimensions: [{ name: 'sessionDefaultChannelGroup' }],
      metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
    }).forEach(function (r) {
      console.log('GA4 ' + r.d[0] + ': ' + r.m[0] + ' sessions, ' + r.m[1] + ' key events');
    });
  } catch (e) {
    console.log(String(e.message || e));
  }
}

function testSeoHost() {
  ['https://dermedica.com.au/', 'https://www.dermedica.com.au/'].forEach(function (u) {
    const r = UrlFetchApp.fetch(u, { followRedirects: false, muteHttpExceptions: true });
    const h = r.getHeaders();
    const loc = h.Location || h.location;
    console.log(u + ' → ' + r.getResponseCode() + (loc ? ' redirects to ' + loc : ''));
  });
  const tot = seoGsc_({ startDate: seoDate_(31), endDate: seoDate_(3) })[0];
  console.log('Property "' + seoProp_('SEO_SITE') + '" last 28d: ' +
    (tot ? tot.clicks + ' clicks, ' + tot.impressions + ' impressions' : 'NO DATA'));
  seoGsc_({ startDate: seoDate_(31), endDate: seoDate_(3), dimensions: ['page'], rowLimit: 5 })
    .slice(0, 5)
    .forEach(function (r) { console.log('  ' + r.clicks + ' clicks  ' + r.keys[0]); });
}

/** Quick check after runSeoNightly: reads back what the portal will see */
function testSeoWrite() {
  const root = 'projects/' + seoProp_('FIRESTORE_PROJECT_ID') + '/databases/(default)/documents';
  const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + root + '/seo_state/overview', {
    headers: { Authorization: 'Bearer ' + seoToken_() }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) { console.log('Read ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300)); return; }
  const f = JSON.parse(res.getContentText()).fields;
  const days = JSON.parse(f.days.stringValue);
  console.log('Overview build ' + f.build.stringValue + ': ' + days.length + ' days (' +
    days[0][0] + ' → ' + days[days.length - 1][0] + '), ' + f.pageCount.integerValue + ' pages');
  console.log('Latest day: ' + JSON.stringify(days[days.length - 1]));
}