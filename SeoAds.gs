/**
 * SeoAds.gs — SEO → Ads: Google Ads numbers through GA4 (no Google Ads API needed)
 * Writes seo_state/ads (the numbers) and seo_state/ads_run (how the last update went).
 * Needs Google Ads linked to the GA4 property in GA4_PROPERTY, with auto-tagging on.
 * Setup: testSeoAds() → runSeoAds() → installSeoAdsTrigger().
 */

const SEO_ADS_KEEP_ = 480;      // days of daily campaign numbers (same as the Overview)
const SEO_ADS_KW_DAYS_ = 90;    // keywords and searches: the last 90 days
const SEO_ADS_ONLY_ = { notExpression: { filter: { fieldName: 'sessionGoogleAdsCampaignName',
  inListFilter: { values: ['(not set)'] } } } };   // only visits and costs from Google Ads campaigns

function seoAdsR2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function seoAdsDate_(d) { return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8); }
// "+laser +hair [removal]" → "laser hair removal" (so it can be matched to Search Console)
function seoAdsNorm_(s) { return String(s || '').toLowerCase().replace(/[+\[\]"]/g, ' ').replace(/\s+/g, ' ').trim(); }

// Two GA4 reports with the same dimensions, merged: the cost from Google Ads, and what the visits did
function seoAdsPair_(dims, start, end, limit) {
  const base = {
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: dims.map(function (n) { return { name: n }; }),
    dimensionFilter: SEO_ADS_ONLY_, limit: limit || 100000,
  };
  const out = {};
  const row = function (d) {
    const k = d.join('\u0001');
    return out[k] || (out[k] = { d: d, cost: 0, clicks: 0, impr: 0, sess: 0, eng: 0, ke: 0 });
  };
  seoGa4_(Object.assign({}, base, { metrics: [{ name: 'advertiserAdCost' }, { name: 'advertiserAdClicks' }, { name: 'advertiserAdImpressions' }] }))
    .forEach(function (r) { const x = row(r.d); x.cost += r.m[0]; x.clicks += r.m[1]; x.impr += r.m[2]; });
  seoGa4_(Object.assign({}, base, { metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }] }))
    .forEach(function (r) { const x = row(r.d); x.sess += r.m[0]; x.eng += r.m[1]; x.ke += r.m[2]; });
  return Object.keys(out).map(function (k) { return out[k]; });
}

function seoAdsBuild_() {
  const warn = [];
  const end = seoDate_(1), start = seoDate_(SEO_ADS_KEEP_);

  // Campaigns per day
  const daily = seoAdsPair_(['date', 'sessionGoogleAdsCampaignName'], start, end);
  const types = {};
  try {
    seoGa4_({
      dateRanges: [{ startDate: start, endDate: end }],
      dimensions: [{ name: 'sessionGoogleAdsCampaignName' }, { name: 'sessionGoogleAdsCampaignType' }],
      metrics: [{ name: 'sessions' }], dimensionFilter: SEO_ADS_ONLY_, limit: 1000,
    }).forEach(function (r) { if (!types[r.d[0]]) types[r.d[0]] = r.d[1] === '(not set)' ? '' : r.d[1]; });
  } catch (e) { warn.push('Campaign types not read: ' + e.message); }

  const ci = {}, camps = [];
  const idx = function (name) {
    if (!(name in ci)) { ci[name] = camps.length; camps.push([name, types[name] || '']); }
    return ci[name];
  };
  const days = daily.filter(function (x) { return x.cost || x.clicks || x.sess; })
    .map(function (x) {
      return [seoAdsDate_(x.d[0]), idx(x.d[1]), seoAdsR2_(x.cost), x.clicks, x.impr, x.sess, x.eng, seoAdsR2_(x.ke)];
    })
    .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]; });

  // Organic: each search's position and clicks in Search Console (the same 28 days as the Pages tab)
  const org = {};
  const orgFrom = seoDate_(SEO_LAG_DAYS_ + 27), orgTo = seoDate_(SEO_LAG_DAYS_);
  try {
    seoGsc_({ startDate: orgFrom, endDate: orgTo, dimensions: ['query'] }).forEach(function (r) {
      const k = seoAdsNorm_(r.keys[0]);
      if (!org[k] || r.clicks > org[k][1]) org[k] = [Math.round(r.position * 10) / 10, r.clicks];
    });
  } catch (e) { warn.push('Search Console not read, so organic positions are left out: ' + e.message); }
  const orgOf = function (s) { return org[seoAdsNorm_(s)] || null; };

  // Keywords (last 90 days)
  const kwFrom = seoDate_(SEO_ADS_KW_DAYS_);
  let kw = [];
  try {
    kw = seoAdsPair_(['sessionGoogleAdsKeyword', 'sessionGoogleAdsCampaignName'], kwFrom, end, 10000)
      .filter(function (x) { return x.cost || x.sess; })
      .sort(function (a, b) { return b.cost - a.cost || b.sess - a.sess; })
      .slice(0, 600)
      .map(function (x) {
        const o = orgOf(x.d[0]);
        return [x.d[0], idx(x.d[1]), seoAdsR2_(x.cost), x.clicks, x.impr, x.sess, x.eng, seoAdsR2_(x.ke), o ? o[0] : null, o ? o[1] : 0];
      });
  } catch (e) { warn.push('Keywords not read: ' + e.message); }

  // What people actually searched before clicking an ad (last 90 days)
  let q = [];
  try {
    q = seoGa4_({
      dateRanges: [{ startDate: kwFrom, endDate: end }],
      dimensions: [{ name: 'sessionGoogleAdsQuery' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
      dimensionFilter: SEO_ADS_ONLY_, orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 400,
    }).filter(function (r) { return r.d[0] && r.d[0] !== '(not set)'; })
      .map(function (r) {
        const o = orgOf(r.d[0]);
        return [r.d[0], r.m[0], r.m[1], seoAdsR2_(r.m[2]), o ? o[0] : null, o ? o[1] : 0];
      });
  } catch (e) { warn.push('Searches not read: ' + e.message); }

  // Landing pages: the last 28 days and the 28 before
  const lpOf = function (s, e) {
    const m = {};
    seoGa4_({
      dateRanges: [{ startDate: s, endDate: e }], dimensions: [{ name: 'landingPage' }],
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
      dimensionFilter: SEO_ADS_ONLY_, limit: 3000,
    }).forEach(function (r) {
      const p = String(r.d[0] || '').split('?')[0];
      if (!p || p.charAt(0) !== '/') return;
      const x = m[p] || (m[p] = [0, 0, 0]);
      x[0] += r.m[0]; x[1] += r.m[1]; x[2] += r.m[2];
    });
    return m;
  };
  const lpFrom = seoDate_(28);
  let lp = [];
  try {
    const a = lpOf(lpFrom, end), b = lpOf(seoDate_(56), seoDate_(29));
    lp = Object.keys(a).concat(Object.keys(b).filter(function (k) { return !(k in a); }))
      .map(function (k) {
        const x = a[k] || [0, 0, 0], y = b[k] || [0, 0, 0];
        return [k, x[0], x[1], seoAdsR2_(x[2]), y[0], y[1], seoAdsR2_(y[2])];
      })
      .sort(function (p, r) { return r[1] - p[1]; })
      .slice(0, 300);
  } catch (e) { warn.push('Landing pages not read: ' + e.message); }

  return { camps: camps, days: days, kw: kw, q: q, lp: lp, from: start, to: end,
    kwFrom: kwFrom, kwTo: end, lpFrom: lpFrom, lpTo: end, orgFrom: orgFrom, orgTo: orgTo, warn: warn };
}

// The morning trigger runs this
function runSeoAds() {
  const t0 = Date.now();
  try {
    const a = seoAdsBuild_();
    const doc = {
      camps: JSON.stringify(a.camps), days: JSON.stringify(a.days), kw: JSON.stringify(a.kw),
      q: JSON.stringify(a.q), lp: JSON.stringify(a.lp),
      from: a.from, to: a.to, kwFrom: a.kwFrom, kwTo: a.kwTo, lpFrom: a.lpFrom, lpTo: a.lpTo,
      orgFrom: a.orgFrom, orgTo: a.orgTo, updatedAt: new Date(),
    };
    // A Firestore document holds 1 MB: the smaller lists give way first
    const size = function () { return doc.camps.length + doc.days.length + doc.kw.length + doc.q.length + doc.lp.length; };
    if (size() > 900000) { doc.q = JSON.stringify(a.q.slice(0, 100)); doc.lp = JSON.stringify(a.lp.slice(0, 100)); a.warn.push('Shortened the searches and landing pages to fit.'); }
    if (size() > 900000) { doc.kw = JSON.stringify(a.kw.slice(0, 200)); a.warn.push('Shortened the keywords to fit.'); }
    seoFsCommit_([
      { path: 'seo_state/ads', data: doc },
      { path: 'seo_state/ads_run', data: { ok: true, at: new Date(), ms: Date.now() - t0,
        campaigns: a.camps.length, days: a.days.length, keywords: a.kw.length, warnings: a.warn } },
    ]);
    console.log('SEO ads OK: ' + a.camps.length + ' campaigns, ' + a.days.length + ' campaign-days, ' +
      a.kw.length + ' keywords, ' + (Date.now() - t0) + ' ms' + (a.warn.length ? '\n' + a.warn.join('\n') : ''));
  } catch (e) {
    try {
      seoFsCommit_([{ path: 'seo_state/ads_run', data: { ok: false, at: new Date(), error: String(e.message || e).slice(0, 500) } }]);
    } catch (ignore) {}
    throw e;   // Apps Script emails the failure
  }
}

// Run ONCE: every morning about 7am Perth (after the SEO update at 6)
function installSeoAdsTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoAds'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoAds').timeBased().everyDays(1).atHour(7).inTimezone(SEO_TZ_).create();
  console.log('runSeoAds scheduled daily ~7am Perth');
}

// Run from the editor first: are Google Ads costs in GA4?
function testSeoAds() {
  let rows;
  try { rows = seoAdsPair_(['sessionGoogleAdsCampaignName'], seoDate_(30), seoDate_(1), 1000); }
  catch (e) { console.log('GA4 refused the Ads report: ' + e.message); return; }
  if (!rows.some(function (r) { return r.cost > 0; })) {
    console.log(rows.length
      ? 'GA4 sees visits from ' + rows.length + ' Google Ads campaign(s), but no costs yet. Costs usually appear about a day after GA4 and Google Ads are linked.'
      : 'No Google Ads campaigns in GA4 for the last 30 days. Check GA4 → Admin → Product links → Google Ads links, and that auto-tagging is on in Google Ads.');
    return;
  }
  rows.sort(function (a, b) { return b.cost - a.cost; }).forEach(function (r) {
    console.log(r.d[0] + ': $' + seoAdsR2_(r.cost) + ', ' + r.clicks + ' clicks, ' + r.sess + ' visits, ' + seoAdsR2_(r.ke) + ' key events');
  });
}