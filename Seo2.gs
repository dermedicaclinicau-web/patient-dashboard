/**
 * Seo2.gs — SEO Phase 2: search queries for Keywords and Opportunities.
 * Pulls Search Console data by query + page for the last 28 complete days and the 28 before.
 * Writes:
 *   seo_queries/c_<n>   { build, n, rows (JSON), updatedAt }
 *   seo_state/queries   { build, chunks, count, from, to, prevFrom, prevTo, ok, error, ms, at }
 * Uses seoToken_() from Seo.gs for the access token.
 */

const SEO2_CHUNK_ = 400;        // searches per Firestore doc (about 100 KB)
const SEO2_MAX_QUERIES_ = 4000; // keep the busiest searches
const SEO2_MIN_IMPR_ = 10;      // drop searches with fewer impressions than this in both periods
const SEO2_MAX_PAGES_ = 5;      // pages kept per search

function runSeoQueries() {
  const t0 = Date.now();
  const build = String(t0);
  const project = seo2Project_();
  try {
    const site = PropertiesService.getScriptProperties().getProperty('SEO_SITE');
    if (!site) throw new Error('Script Property SEO_SITE is not set.');
    const tz = (typeof SEO_TZ_ !== 'undefined') ? SEO_TZ_ : 'Australia/Perth';
    const lag = (typeof SEO_LAG_DAYS_ !== 'undefined') ? SEO_LAG_DAYS_ : 3;
    const to = Utilities.formatDate(new Date(Date.now() - lag * 864e5), tz, 'yyyy-MM-dd');
    const from = seo2Add_(to, -27), prevTo = seo2Add_(to, -28), prevFrom = seo2Add_(to, -55);

    const map = {};
    const get = (q) => map[q] || (map[q] = { c: 0, i: 0, pw: 0, pc: 0, pi: 0, ppw: 0, pages: {} });

    seo2Gsc_(site, from, to).forEach((r) => {
      const o = get(r.keys[0]), path = seo2Path_(r.keys[1]);
      o.c += r.clicks; o.i += r.impressions; o.pw += r.position * r.impressions;
      const p = o.pages[path] || (o.pages[path] = { c: 0, i: 0, pw: 0 });
      p.c += r.clicks; p.i += r.impressions; p.pw += r.position * r.impressions;
    });
    seo2Gsc_(site, prevFrom, prevTo).forEach((r) => {
      const o = get(r.keys[0]);
      o.pc += r.clicks; o.pi += r.impressions; o.ppw += r.position * r.impressions;
    });

    const r1 = (n) => Math.round(n * 10) / 10;
    const rows = Object.keys(map)
      .filter((q) => map[q].i >= SEO2_MIN_IMPR_ || map[q].pi >= SEO2_MIN_IMPR_)
      .sort((a, b) => (map[b].i - map[a].i) || (map[b].pi - map[a].pi))
      .slice(0, SEO2_MAX_QUERIES_)
      .map((q) => {
        const o = map[q];
        const pages = Object.keys(o.pages)
          .map((p) => { const x = o.pages[p]; return [p, x.c, x.i, x.i ? r1(x.pw / x.i) : null]; })
          .sort((a, b) => b[2] - a[2])
          .slice(0, SEO2_MAX_PAGES_);
        // [query, clicks, impressions, position, prevClicks, prevImpressions, prevPosition, pages]
        return [q, o.c, o.i, o.i ? r1(o.pw / o.i) : null, o.pc, o.pi, o.pi ? r1(o.ppw / o.pi) : null, pages];
      });

    const now = new Date();
    const writes = [];
    for (let n = 0; n * SEO2_CHUNK_ < rows.length; n++) {
      writes.push(seo2Write_(project, 'seo_queries/c_' + n, {
        build: build, n: n, rows: JSON.stringify(rows.slice(n * SEO2_CHUNK_, (n + 1) * SEO2_CHUNK_)), updatedAt: now,
      }));
    }
    seo2Commit_(project, writes);   // chunks first…
    seo2Commit_(project, [seo2Write_(project, 'seo_state/queries', {   // …then the pointer, so readers never see half a build
      build: build, chunks: writes.length, count: rows.length, from: from, to: to, prevFrom: prevFrom, prevTo: prevTo,
      ok: true, error: '', ms: Date.now() - t0, at: now,
    })]);
    Logger.log('SEO queries: %s searches in %s chunks (%s to %s)', rows.length, writes.length, from, to);
  } catch (e) {
    Logger.log('SEO queries failed: ' + (e.stack || e));
    try {   // keep the previous build readable, just flag the failure
      seo2Commit_(project, [seo2Write_(project, 'seo_state/queries', { ok: false, error: String(e.message || e).slice(0, 500), at: new Date() })]);
    } catch (e2) { Logger.log('Could not record the failure: ' + e2); }
    throw e;
  }
}

/** Run once: daily at about 7am Perth (after the Phase 1 job). */
function installSeoQueriesTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'runSeoQueries')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runSeoQueries').timeBased().everyDays(1).atHour(7).inTimezone('Australia/Perth').create();
}

/* ---------- helpers ---------- */

function seo2Gsc_(site, start, end) {
  const url = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(site) + '/searchAnalytics/query';
  const out = [];
  for (let startRow = 0; startRow < 100000; startRow += 25000) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + seo2Token_() },
      payload: JSON.stringify({ startDate: start, endDate: end, dimensions: ['query', 'page'], rowLimit: 25000, startRow: startRow, type: 'web' }),
    });
    if (res.getResponseCode() !== 200) throw new Error('Search Console ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
    const rows = JSON.parse(res.getContentText()).rows || [];
    for (let k = 0; k < rows.length; k++) out.push(rows[k]);
    if (rows.length < 25000) break;
  }
  return out;
}

function seo2Token_() {
  if (typeof seoToken_ !== 'function') throw new Error('seoToken_() from Seo.gs was not found.');
  const t = seoToken_();
  if (!t || typeof t !== 'string') throw new Error('seoToken_() did not return an access token string.');
  return t;
}

function seo2Project_() {
  const p = PropertiesService.getScriptProperties();
  const v = p.getProperty('SEO_FS_PROJECT') || p.getProperty('FIREBASE_PROJECT_ID') || p.getProperty('FIREBASE_PROJECT')
    || p.getProperty('FIRESTORE_PROJECT') || p.getProperty('PROJECT_ID');
  if (v) return v;
  if (typeof seoCfg_ === 'function') {
    try { const c = seoCfg_(); const x = c && (c.project || c.projectId || c.fsProject); if (x) return x; } catch (e) {}
  }
  throw new Error('Firebase project id not found. Add Script Property SEO_FS_PROJECT = your Firebase project id.');
}

function seo2Commit_(project, writes) {
  const url = 'https://firestore.googleapis.com/v1/projects/' + project + '/databases/(default)/documents:commit';
  for (let k = 0; k < writes.length; k += 20) {   // chunk docs are large, so small batches
    const payload = JSON.stringify({ writes: writes.slice(k, k + 20) });
    let res = seo2Post_(url, payload, seo2Token_());
    if (res.getResponseCode() === 401 || res.getResponseCode() === 403) res = seo2Post_(url, payload, ScriptApp.getOAuthToken());
    if (res.getResponseCode() !== 200) throw new Error('Firestore ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
}

function seo2Post_(url, payload, token) {
  return UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', payload: payload, muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + token },
  });
}

/** One write that sets only the given fields (other fields on the doc are kept). */
function seo2Write_(project, path, obj) {
  const fields = {};
  Object.keys(obj).forEach((k) => { fields[k] = seo2Val_(obj[k]); });
  return {
    update: { name: 'projects/' + project + '/databases/(default)/documents/' + path, fields: fields },
    updateMask: { fieldPaths: Object.keys(obj) },
  };
}

function seo2Val_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(seo2Val_) } };
  if (typeof v === 'object') {
    const f = {};
    Object.keys(v).forEach((k) => { f[k] = seo2Val_(v[k]); });
    return { mapValue: { fields: f } };
  }
  return { stringValue: String(v) };
}

function seo2Path_(u) { return String(u).replace(/^https?:\/\/[^/]+/i, '') || '/'; }

function seo2Add_(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}