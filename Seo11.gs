/**
 * Seo11.gs — Overview drill-downs: the searches, landing pages and AI assistant visits behind each number card.
 * For the last 7, 28 and 90 days, the period before each, and the same dates last year:
 *   · Search Console: clicks, impressions and position per search
 *   · GA4: organic sessions, engaged sessions and key events per landing page
 *   · GA4: AI assistant visits per source (ChatGPT, Perplexity…) and landing page
 * Writes seo_windows/w7, w28 and w90 { json, at }.
 * Uses Seo.gs (seoProp_, seoDate_, seoGa4_, seoToken_, seoFsCommit_, SEO_TZ_, SEO_LAG_DAYS_).
 */

const SEO11_WINDOWS_ = [7, 28, 90];
const SEO11_MAX_Q_ = 3000;     // searches kept per window
const SEO11_MAX_PAGES_ = 800;  // landing pages kept per window

function runSeoWindows() {
  const t0 = Date.now();
  const to = seoDate_(SEO_LAG_DAYS_);   // the same last day as the Overview's settled data
  const docs = [];
  SEO11_WINDOWS_.forEach(function (n) {
    const cur = { from: seo11Add_(to, -(n - 1)), to: to };
    const prev = { from: seo11Add_(cur.from, -n), to: seo11Add_(cur.from, -1) };
    const ly = { from: seo11Year_(cur.from), to: seo11Year_(cur.to) };
    const ranges = { cur: cur, prev: prev, ly: ly };

    // Searches: [search, clicks, impressions, position, …previous period, …last year]
    const q = {};
    ['cur', 'prev', 'ly'].forEach(function (k, j) {
      seo11Gsc_(ranges[k].from, ranges[k].to).forEach(function (r) {
        const x = q[r.keys[0]] || (q[r.keys[0]] = [r.keys[0], 0, 0, null, 0, 0, null, 0, 0, null]);
        x[1 + j * 3] = r.clicks;
        x[2 + j * 3] = r.impressions;
        x[3 + j * 3] = Math.round(r.position * 10) / 10;
      });
    });
    const qRows = Object.keys(q).map(function (k) { return q[k]; })
      .sort(function (a, b) { return Math.max(b[2], b[5], b[8]) - Math.max(a[2], a[5], a[8]); })
      .slice(0, SEO11_MAX_Q_);

    // Landing pages from Google: [path, sessions, engaged, key events, …previous period, …last year]
    const ga = {};
    seo11Ga4_(ranges, ['landingPage'], 'Organic Search', ['sessions', 'engagedSessions', 'keyEvents']).forEach(function (r) {
      const path = String(r.d[0] || '').split('?')[0];
      if (!path || path.charAt(0) !== '/') return;
      const j = { cur: 0, prev: 1, ly: 2 }[r.range];
      if (j == null) return;
      const x = ga[path] || (ga[path] = [path, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      x[1 + j * 3] += r.m[0]; x[2 + j * 3] += r.m[1]; x[3 + j * 3] += r.m[2];
    });

    // AI assistants: [source, path, visits, previous period, last year]
    const ai = {};
    try {
      seo11Ga4_(ranges, ['sessionSource', 'landingPage'], 'AI Assistant', ['sessions']).forEach(function (r) {
        const path = String(r.d[1] || '').split('?')[0] || '/';
        const j = { cur: 0, prev: 1, ly: 2 }[r.range];
        if (j == null) return;
        const key = r.d[0] + '|' + path;
        const x = ai[key] || (ai[key] = [r.d[0] || '(unknown)', path, 0, 0, 0]);
        x[2 + j] += r.m[0];
      });
    } catch (e) { console.warn('AI assistant visits not read: ' + e); }

    const top = function (obj, idx, lim) {
      return Object.keys(obj).map(function (k) { return obj[k]; })
        .sort(function (a, b) { return Math.max.apply(null, idx.map(function (i) { return b[i]; })) - Math.max.apply(null, idx.map(function (i) { return a[i]; })); })
        .slice(0, lim);
    };
    docs.push({ path: 'seo_windows/w' + n, data: { at: new Date(), json: JSON.stringify({
      n: n, ranges: ranges, q: qRows, ga: top(ga, [1, 4, 7], SEO11_MAX_PAGES_), ai: top(ai, [2, 3, 4], 400),
    }) } });
  });
  seoFsCommit_(docs);
  console.log('Overview drill-downs saved for 7, 28 and 90 days in ' + Math.round((Date.now() - t0) / 1000) + ' s');
}

/** Run once: every morning at about 7am Perth (with the search data) */
function installSeoWindowsTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoWindows'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoWindows').timeBased().everyDays(1).atHour(7).inTimezone(SEO_TZ_).create();
  console.log('runSeoWindows scheduled daily ~7am Perth');
}

// The busiest 25,000 searches for some dates
function seo11Gsc_(start, end) {
  const url = 'https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(seoProp_('SEO_SITE')) + '/searchAnalytics/query';
  const res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + seoToken_() },
    payload: JSON.stringify({ startDate: start, endDate: end, dimensions: ['query'], rowLimit: 25000, type: 'web' }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Search Console ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText()).rows || [];
}

// One GA4 report for the three periods at once (GA4 adds the period's name as the last value)
function seo11Ga4_(ranges, dims, channel, metrics) {
  return seoGa4_({
    dateRanges: ['cur', 'prev', 'ly'].map(function (k) { return { startDate: ranges[k].from, endDate: ranges[k].to, name: k }; }),
    dimensions: dims.map(function (d) { return { name: d }; }),
    metrics: metrics.map(function (m) { return { name: m }; }),
    dimensionFilter: { filter: { fieldName: 'sessionDefaultChannelGroup', stringFilter: { value: channel } } },
    limit: 10000,
  }).map(function (r) { return { d: r.d.slice(0, dims.length), range: r.d[r.d.length - 1], m: r.m }; });
}

function seo11Add_(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function seo11Year_(iso) {
  const p = iso.split('-').map(Number);
  const d = new Date(Date.UTC(p[0] - 1, p[1] - 1, p[2]));
  if (d.getUTCMonth() !== p[1] - 1) d.setUTCDate(0);   // 29 Feb → 28 Feb
  return d.toISOString().slice(0, 10);
}