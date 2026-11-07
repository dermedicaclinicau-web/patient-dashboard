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
  const types = {}, campIds = {};
  try {
    seoGa4_({
      dateRanges: [{ startDate: start, endDate: end }],
      dimensions: [{ name: 'sessionGoogleAdsCampaignName' }, { name: 'sessionGoogleAdsCampaignType' }, { name: 'sessionGoogleAdsCampaignId' }],
      metrics: [{ name: 'sessions' }], dimensionFilter: SEO_ADS_ONLY_, limit: 1000,
    }).forEach(function (r) {
      if (!types[r.d[0]]) types[r.d[0]] = r.d[1] === '(not set)' ? '' : r.d[1];
      if (!campIds[r.d[0]] && r.d[2] && r.d[2] !== '(not set)') campIds[r.d[0]] = r.d[2];
    });
  } catch (e) { warn.push('Campaign types not read: ' + e.message); }

  const ci = {}, camps = [];
  const idx = function (name) {
    if (!(name in ci)) { ci[name] = camps.length; camps.push([name, types[name] || '', campIds[name] || '']); }
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

  // Enquiries that came from an ad (Prospect Dashboard). Counts only: [day, campaign (-1 = not known), enquiries,
  // booked a consultation, came in, treated, lost]. Clicks tagged TEST… are left out (for trying it).
  let leads = [], leadsFrom = '';
  try {
    const byId = {}, byName = {};
    camps.forEach(function (c, i) { if (c[2]) byId[String(c[2])] = i; byName[String(c[0]).toLowerCase()] = i; });
    const agg = {};
    fsListAll_(getConfig_(), PROS_COL_, ['ads', 'milestones', 'createdAt', 'stage']).forEach(function (d) {
      const p = fromFields_(d.fields || {});
      const ad = p.ads;
      if (!ad || !(ad.click || ad.campaign) || /^test/i.test(String(ad.click || ''))) return;
      const at = Date.parse(String(p.createdAt || ''));
      if (!at) return;
      const day = Utilities.formatDate(new Date(at), SEO_TZ_, 'yyyy-MM-dd');
      const c = String(ad.campaign || '');
      const cix = c in byId ? byId[c] : c.toLowerCase() in byName ? byName[c.toLowerCase()] : -1;
      const ms = p.milestones || {};
      const x = agg[day + '|' + cix] || (agg[day + '|' + cix] = [day, cix, 0, 0, 0, 0, 0]);
      x[2]++;
      if (ms.consult_booked) x[3]++;
      if (ms.consulted) x[4]++;
      if (ms.treated) x[5]++;
      if (p.stage === 'lost') x[6]++;
      if (!leadsFrom || day < leadsFrom) leadsFrom = day;
    });
    leads = Object.keys(agg).map(function (k) { return agg[k]; })
      .sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]; });
  } catch (e) { warn.push('Enquiries from ads not read: ' + e.message); }

  return { leads: leads, leadsFrom: leadsFrom, camps: camps, days: days, kw: kw, q: q, lp: lp, from: start, to: end,
    kwFrom: kwFrom, kwTo: end, lpFrom: lpFrom, lpTo: end, orgFrom: orgFrom, orgTo: orgTo, warn: warn };
}

// The morning trigger runs this
function runSeoAds() {
  const t0 = Date.now();
  // Website enquiries by page (SeoLeads.gs). First, so it still runs if the Ads update fails.
  try { runSeoLeads(); } catch (e) { console.warn('SEO leads: ' + (e && e.stack ? e.stack : e)); }
  try {
    const a = seoAdsBuild_();
    const doc = {
      camps: JSON.stringify(a.camps), days: JSON.stringify(a.days), kw: JSON.stringify(a.kw),
      q: JSON.stringify(a.q), lp: JSON.stringify(a.lp),
      from: a.from, to: a.to, kwFrom: a.kwFrom, kwTo: a.kwTo, lpFrom: a.lpFrom, lpTo: a.lpTo,
      orgFrom: a.orgFrom, orgTo: a.orgTo, updatedAt: new Date(),
      leads: JSON.stringify(a.leads), leadsFrom: a.leadsFrom,
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
    // Claude's suggestions, every Monday (a problem here never stops the update)
    try { if (seoCoachDue_()) seoAdsCoach_('Every Monday'); } catch (e) { console.warn('Ads coach not run: ' + e.message); }
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

/* ===================== Ads coach: Claude's suggestions ===================== */
// Every Monday (after runSeoAds) and from "Ask Claude now" on the Ads tab.
// seo_state/ads_coach: the suggestions · seo_state/ads_coach_status: what was marked Done or Not now
// Script Properties: ClaudeApi (already there). Optional CLAUDE_COACH_MODEL (default: CLAUDE_MODEL, then claude-sonnet-5-5).

const SEO_COACH_SYSTEM_ = [
  'You are a senior Google Ads strategist advising Dermedica, a doctor-led cosmetic and medical skin clinic in Perth, Western Australia.',
  'The owner runs the Google Ads account herself. Her goal is more new patients who actually come in, at a sensible cost.',
  'The best measure is cost per patient who came in, then cost per enquiry. GA4 key events are a rougher guide.',
  '',
  'You get a JSON summary: each campaign for the last 28 days and the 28 before (spend in AUD, clicks, visits, key events, bounce,',
  'and enquiries and patients from the clinic\'s own Prospect Dashboard once tracking has started), the costliest keywords with',
  'their organic Google position, what people searched, landing pages, and actions she has already done or declined.',
  '',
  'Give 4 to 8 actions, most valuable first. Each one must:',
  '- be specific: name the campaign, keyword or page, and quote the numbers that justify it;',
  '- say exactly where to do it in Google Ads (e.g. "Campaigns → Laser → Keywords → pause \'laser hair removal cheap\'");',
  '- be something she can do herself in under an hour, unless the impact is high;',
  '- not repeat anything in alreadyDecided unless the numbers now clearly say otherwise, and then say why.',
  'Look first for: moving budget from campaigns with a high cost per patient to ones with a low cost; pausing keywords or adding',
  'negative keywords where money is spent with no enquiries; lowering bids where the clinic already ranks in the top 3 for free;',
  'landing pages where ad visitors leave straight away; gaps in tracking. Only suggest spending more where a campaign is clearly',
  'profitable. If the numbers are too small to judge (under about 10 clicks or $50), say so instead of guessing.',
  'You also get "seo": the priority pages (each with the search it targets) and website changes from the last 45 days.',
  'Don\'t suggest cutting ads on a priority page\'s target search until that page ranks in the top 3 for free.',
  'If a page was changed in the last 4 weeks, say it\'s too soon to judge it, rather than suggesting another change.',
  'Where ads keep paying for a search a priority page targets, say so: it\'s a reason to finish that page\'s SEO work.',
  '',
  'Only when suggesting ad text (kind "ads"): up to 8 headlines of at most 30 characters and up to 4 descriptions of at most',
  '90 characters. Otherwise leave headlines and descriptions empty.',
  '',
  'ADVERTISING RULES (Australia). Every suggestion and every piece of ad text must follow these:',
  '- Never name or hint at prescription-only medicines (e.g. Botox, Dysport, Xeomin, botulinum toxin, "anti-wrinkle injections").',
  '  For those treatments, promote a consultation with the doctor about the concern (e.g. frown lines), not the medicine.',
  '- No testimonials or reviews, no before-and-after claims, no guarantees, and no "permanent", "pain-free", "risk-free" or "no downtime".',
  '- No discounts, free treatments, time-limited offers or other inducements for cosmetic procedures. No "best" or "cheapest".',
  '- Don\'t create unrealistic expectations or play down risks. Keep the language factual and calm.',
  'If an action could raise a compliance question, explain it in "risk". Otherwise "risk" is "".',
  '',
  'summary: two or three plain sentences on how the ads are doing and the single most important thing to do. Australian English.',
].join('\n');

const SEO_COACH_SCHEMA_ = {
  type: 'object', additionalProperties: false, required: ['summary', 'actions'],
  properties: {
    summary: { type: 'string' },
    actions: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['title', 'why', 'how', 'impact', 'effort', 'kind', 'campaign', 'keyword', 'page', 'headlines', 'descriptions', 'risk'],
      properties: {
        title: { type: 'string' }, why: { type: 'string' }, how: { type: 'string' },
        impact: { type: 'string', enum: ['high', 'medium', 'low'] },
        effort: { type: 'string', enum: ['quick', 'medium', 'big'] },
        kind: { type: 'string', enum: ['budget', 'bids', 'keywords', 'negatives', 'ads', 'landing', 'tracking', 'other'] },
        campaign: { type: 'string' }, keyword: { type: 'string' }, page: { type: 'string' },
        headlines: { type: 'array', items: { type: 'string' } },
        descriptions: { type: 'array', items: { type: 'string' } },
        risk: { type: 'string' },
      },
    } },
  },
};

// Checked in the ad text Claude writes (flagged, not removed: you decide)
const SEO_COACH_RISKY_ = [
  [/\b(botox|dysport|xeomin|relatox|letybo|daxxify|botulinum|toxin|anti[- ]?wrinkle injections?)\b/i, 'names or hints at a prescription medicine'],
  [/\b(guarantee[ds]?|permanent|pain[- ]?free|risk[- ]?free|no downtime)\b/i, 'a promise about results or risk'],
  [/\b(best|cheapest|number one)\b|#1/i, 'a "best" or "cheapest" claim'],
  [/\d+\s*% off|\bfree (consult|consultation|treatment)|\bdiscount|\blimited time|\bspecial offer|\bsale\b/i, 'an offer or inducement'],
  [/\b(testimonials?|reviews?|before (and|&) after)\b/i, 'testimonials, reviews or before-and-after'],
];

function seoCoachRead_(path) {
  try { return fsGetDoc_(getConfig_(), path); } catch (e) { console.warn('Not read: ' + path + ': ' + e); return null; }
}
function seoCoachStatus_() {
  const d = seoCoachRead_('seo_state/ads_coach_status');
  try { return d && d.s ? JSON.parse(d.s) : {}; } catch (e) { return {}; }
}
// Your compliance words (SEO → Settings)
function seoCoachWords_() {
  const s = seoCoachRead_('seo_settings/main') || {};
  return [].concat(s.compliance || [], s.complianceWords || [], s.bannedWords || [])
    .map(function (w) { return String(w || '').trim().toLowerCase(); })
    .filter(function (w) { return w.length >= 3; }).slice(0, 100);
}
function seoCoachDue_() {
  if (Utilities.formatDate(new Date(), SEO_TZ_, 'u') !== '1') return false;   // Mondays
  const c = seoCoachRead_('seo_state/ads_coach');
  const at = c ? Date.parse(String(c.at || '')) : 0;
  return !at || Date.now() - at > 5 * 864e5;
}

// What Claude reads: the last 28 days vs the 28 before, per campaign, plus keywords, searches and landing pages
function seoCoachSummary_(ad) {
  const P = function (s) { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };
  const camps = P(ad.camps), days = P(ad.days), kw = P(ad.kw), q = P(ad.q), lp = P(ad.lp), leads = P(ad.leads);
  const end = String(ad.to || seoDate_(1));
  const c0 = flowAddDaysKey_(end, -27), p1 = flowAddDaysKey_(end, -28), p0 = flowAddDaysKey_(end, -55);
  const r2 = seoAdsR2_;
  const blank = function () { return { cost: 0, clicks: 0, impr: 0, sess: 0, eng: 0, ke: 0, enq: 0, came: 0 }; };
  const cur = {}, prv = {};
  const into = function (m, i) { return m[i] || (m[i] = blank()); };
  const which = function (d) { return d >= c0 && d <= end ? cur : d >= p0 && d <= p1 ? prv : null; };
  days.forEach(function (d) {
    const m = which(d[0]);
    if (!m) return;
    const x = into(m, d[1]);
    x.cost += d[2]; x.clicks += d[3]; x.impr += d[4]; x.sess += d[5]; x.eng += d[6]; x.ke += d[7];
  });
  leads.forEach(function (l) {
    const m = which(l[0]);
    if (!m) return;
    const x = into(m, l[1]);
    x.enq += l[2]; x.came += l[4];
  });
  const pc = function (a, b) { return b ? Math.round((1 - a / b) * 100) + '%' : null; };
  const view = function (x) {
    if (!x) return null;
    return { spend: r2(x.cost), clicks: x.clicks, impressions: x.impr, costPerClick: x.clicks ? r2(x.cost / x.clicks) : null,
      visits: x.sess, bounce: pc(x.eng, x.sess), keyEvents: r2(x.ke), costPerKeyEvent: x.ke ? r2(x.cost / x.ke) : null,
      enquiries: x.enq, cameIn: x.came, costPerEnquiry: x.enq ? r2(x.cost / x.enq) : null,
      costPerPatientWhoCameIn: x.came ? r2(x.cost / x.came) : null };
  };
  const total = function (m) {
    const t = blank();
    Object.keys(m).forEach(function (k) { Object.keys(t).forEach(function (f) { t[f] += m[k][f]; }); });
    return view(t);
  };
  const campaigns = camps.map(function (c, i) { return { name: c[0], type: c[1] || '', last28: view(cur[i]), prev28: view(prv[i]) }; })
    .filter(function (c) { return c.last28 || c.prev28; });
  if (cur[-1] || prv[-1]) campaigns.push({ name: '(enquiries from ads where the campaign isn\'t known)', type: '', last28: view(cur[-1]), prev28: view(prv[-1]) });
  return {
    dates: { last28: c0 + ' to ' + end, prev28: p0 + ' to ' + p1 },
    totals: { last28: total(cur), prev28: total(prv) },
    enquiriesTrackedFrom: ad.leadsFrom || 'not yet: only GA4 key events so far',
    brandWords: seoBrandWords_(),
    campaigns: campaigns,
    keywords90days: kw.slice(0, 40).map(function (k) {
      return { keyword: k[0], campaign: (camps[k[1]] || [])[0] || '', spend: k[2], clicks: k[3], keyEvents: k[7],
        costPerKeyEvent: k[7] ? r2(k[2] / k[7]) : null, organicPosition: k[8], organicClicks28days: k[9] };
    }),
    searches90days: q.slice(0, 30).map(function (x) {
      return { search: x[0], visits: x[1], keyEvents: x[3], bounce: pc(x[2], x[1]), organicPosition: x[4] };
    }),
    landingPages28days: lp.slice(0, 15).map(function (x) {
      return { page: x[0], visits: x[1], bounce: pc(x[2], x[1]), keyEvents: x[3], visitsBefore: x[4], bounceBefore: pc(x[5], x[4]) };
    }),
  };
}

function seoCoachClaude_(system, user) {
  const p = PropertiesService.getScriptProperties();
  const key = String(p.getProperty('ClaudeApi') || '').trim();
  if (!key) throw new Error('Add your Claude API key as "ClaudeApi" in Script Properties.');
  const model = p.getProperty('CLAUDE_COACH_MODEL') || p.getProperty('CLAUDE_MODEL') || 'claude-sonnet-5-5';
  const opts = {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21' },
    payload: JSON.stringify({
      model: model, max_tokens: 8000, system: system,
      messages: [{ role: 'user', content: user }],
      output_config: { format: { type: 'json_schema', schema: SEO_COACH_SCHEMA_ } },
    }),
  };
  let data;
  for (let attempt = 0; ; attempt++) {
    const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', opts);
    const code = r.getResponseCode();
    if (code === 200) { data = JSON.parse(r.getContentText()); break; }
    if ((code === 429 || code === 529 || code >= 500) && attempt < 2) { Utilities.sleep(2000 * (attempt + 1)); continue; }
    throw new Error('Claude ' + code + ': ' + r.getContentText().slice(0, 300));
  }
  if (data.stop_reason === 'refusal') throw new Error('Claude declined this request.');
  if (data.stop_reason === 'max_tokens') throw new Error('Claude ran out of room. Try again.');
  const text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  return { out: JSON.parse(text), model: model };
}

function seoAdsCoach_(by) {
  const t0 = Date.now();
  const ad = seoCoachRead_('seo_state/ads');
  if (!ad || !ad.days) throw new Error('There are no Ads numbers yet. Run runSeoAds first.');
  const status = seoCoachStatus_();
  const decided = Object.keys(status).map(function (k) { return status[k]; })
    .filter(function (s) { return s && s.title; })
    .sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); }).slice(0, 40)
    .map(function (s) { return { action: s.title, decision: s.st === 'done' ? 'done' : 'declined', on: s.date }; });
  const res = seoCoachClaude_(SEO_COACH_SYSTEM_,
    JSON.stringify({ today: seoDate_(0), numbers: seoCoachSummary_(ad), seo: seoCoachSeo_(), alreadyDecided: decided }));

  const words = seoCoachWords_();
  const clean = function (s, n) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n); };
  const actions = (Array.isArray(res.out.actions) ? res.out.actions : []).slice(0, 10).map(function (a) {
    const heads = (a.headlines || []).map(function (x) { return clean(x, 80); }).filter(Boolean);
    const descs = (a.descriptions || []).map(function (x) { return clean(x, 150); }).filter(Boolean);
    const hOk = heads.filter(function (x) { return x.length <= 30; });
    const dOk = descs.filter(function (x) { return x.length <= 90; });
    const flags = [];
    if (hOk.length < heads.length) flags.push((heads.length - hOk.length) + ' headline(s) were over 30 characters, so they were left out.');
    if (dOk.length < descs.length) flags.push((descs.length - dOk.length) + ' description(s) were over 90 characters, so they were left out.');
    const copy = hOk.concat(dOk).join('\n');
    SEO_COACH_RISKY_.forEach(function (r) { if (r[0].test(copy)) flags.push('The ad text has ' + r[1] + '. Check it before using it.'); });
    const hit = words.filter(function (w) { return copy.toLowerCase().indexOf(w) !== -1; });
    if (hit.length) flags.push('The ad text uses words from your compliance list: ' + hit.slice(0, 5).join(', ') + '.');
    const item = {
      title: clean(a.title, 160), why: clean(a.why, 1200), how: clean(a.how, 800),
      impact: ['high', 'medium', 'low'].indexOf(a.impact) !== -1 ? a.impact : 'medium',
      effort: ['quick', 'medium', 'big'].indexOf(a.effort) !== -1 ? a.effort : 'medium',
      kind: clean(a.kind, 20) || 'other', campaign: clean(a.campaign, 120), keyword: clean(a.keyword, 120), page: clean(a.page, 200),
      headlines: hOk.slice(0, 15), descriptions: dOk.slice(0, 4), risk: clean(a.risk, 600), flags: flags,
    };
    item.key = seoHash_([item.title.toLowerCase(), item.campaign.toLowerCase(), item.keyword.toLowerCase()].join('|'));
    return item;
  }).filter(function (a) { return a.title; });

  const at = new Date();
  const summary = clean(res.out.summary, 1500);
  seoFsCommit_([{ path: 'seo_state/ads_coach', data: {
    at: at, by: String(by || ''), summary: summary, actions: JSON.stringify(actions),
    model: res.model, basedOn: String(ad.updatedAt || ''), ms: Date.now() - t0,
  } }]);
  console.log('Ads coach: ' + actions.length + ' suggestion(s) in ' + (Date.now() - t0) + ' ms (' + res.model + ')');
  return { at: at.toISOString(), by: String(by || ''), summary: summary, actions: actions };
}

/* ---------- From the portal: Ask Claude now, Done, Not now ---------- */

function handleSeoAds_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const op = String(body.op || '');
  if (!can_(session, 'menu.seo')) return { ok: false, error: 'FORBIDDEN' };
  // Read only: anyone who can open SEO (names only with Prospect access)
  if (op === 'adLeads') {
    try { return seoAdsLeadList_(session); }
    catch (err) {
      console.error('SEO ads leads: ' + (err && err.stack ? err.stack : err));
      return { ok: true, problem: String(err && err.message ? err.message : err).slice(0, 300) };
    }
  }
  if (!can_(session, 'seo.work')) return { ok: false, error: 'FORBIDDEN' };
  try {
    if (op === 'coach') {
      const cache = CacheService.getScriptCache();
      if (cache.get('adscoach_busy')) return { ok: true, problem: 'Claude is already working on this. Give it a minute, then press Refresh.' };
      const dk = 'adscoach_n_' + seoDate_(0);
      const n = Number(cache.get(dk) || 0);
      if (n >= 6) return { ok: true, problem: 'Claude has been asked 6 times today. Try again tomorrow.' };
      cache.put('adscoach_busy', '1', 300);
      cache.put(dk, String(n + 1), 86400);
      try { return { ok: true, coach: seoAdsCoach_(String(session.name || '')) }; }
      finally { cache.remove('adscoach_busy'); }
    }
    if (op === 'act') {
      const key = String(body.key || ''), st = String(body.st || '');
      if (!/^[a-f0-9]{8,40}$/.test(key) || ['done', 'later', 'undo'].indexOf(st) === -1) return { ok: false, error: 'BAD_REQUEST' };
      const unlock = staffTaskLock_('adscoach');
      if (!unlock) return { ok: true, problem: 'Someone else is saving a suggestion. Try again.' };
      try {
        const cfg = getConfig_();
        const cur = seoCoachStatus_();
        const old = cur[key];
        const writes = [];
        let logEntry = null;
        // Undo, or Not now: its Change log entry comes out (Done again just updates the same entry)
        const removedLog = old && old.logId && st !== 'done' ? old.logId : '';
        if (removedLog) writes.push(deleteWrite_(cfg, 'seo_log/' + removedLog));
        if (st === 'undo') delete cur[key];
        else {
          let a = {};
          try {
            const c = seoCoachRead_('seo_state/ads_coach');
            a = JSON.parse((c && c.actions) || '[]').filter(function (x) { return x.key === key; })[0] || {};
          } catch (e) { /* the title is only for the history */ }
          const s = { st: st, at: new Date().toISOString(), date: seoDate_(0), by: String(session.name || ''),
            title: String(a.title || '').slice(0, 160) };
          if (st === 'done') {
            const logId = 'ads_' + key;
            logEntry = {
              date: s.date, type: 'Google Ads', title: ('Google Ads: ' + (a.title || "Claude's suggestion")).slice(0, 200),
              url: seoCoachPath_(a.page),
              note: [a.campaign ? 'Campaign: ' + a.campaign : '', a.keyword ? 'Keyword: ' + a.keyword : '', a.how || '']
                .filter(Boolean).join('\n').slice(0, 2000),
              by: String(session.uid || ''), byName: String(session.name || ''), source: 'ads', coachKey: key,
            };
            writes.push(updateWrite_(cfg, 'seo_log/' + logId, Object.assign({ createdAt: new Date(), updatedAt: new Date() }, logEntry)));
            s.logId = logId;
            logEntry.id = logId;
          }
          cur[key] = s;
        }
        const cut = new Date(Date.now() - 365 * 864e5).toISOString();   // kept a year (the Change log keeps its entries)
        Object.keys(cur).forEach(function (k) { if (String(cur[k].at || '') < cut) delete cur[k]; });
        writes.push(updateWrite_(cfg, 'seo_state/ads_coach_status', { s: JSON.stringify(cur), updatedAt: new Date() }));
        commitWrites_(cfg, writes);
        return { ok: true, status: cur, log: logEntry, removedLog: removedLog };
      } finally { unlock(); }
    }
  } catch (err) {
    console.error('SEO ads ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: true, problem: String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

// SEO → Ads → the enquiry cards → People: each enquiry traced to an ad. The same ones (and the same rules)
// as the counts in seo_state/ads.leads. Names and prospect IDs only for people with Prospect access.
// Never phone numbers or emails. Remembered 10 minutes.
function seoAdsLeadList_(session) {
  const key = 'seo_adleads_v1';
  let rows = repCacheGet_(key);
  if (!rows) {
    rows = [];
    fsListAll_(getConfig_(), PROS_COL_, ['ads', 'milestones', 'createdAt', 'stage', 'name', 'concern', 'lostReason'])
      .forEach(function (d) {
        const p = fromFields_(d.fields || {});
        const ad = p.ads;
        if (!ad || !(ad.click || ad.campaign) || /^test/i.test(String(ad.click || ''))) return;
        const at = Date.parse(String(p.createdAt || ''));
        if (!at) return;
        const ms = p.milestones || {};
        rows.push({
          id: d.name.split('/').pop(), name: String(p.name || '').slice(0, 120),
          day: Utilities.formatDate(new Date(at), SEO_TZ_, 'yyyy-MM-dd'),
          camp: String(ad.campaign || ''), kw: String(ad.keyword || '').slice(0, 120), land: String(ad.landing || '').slice(0, 200),
          concern: String(p.concern || '').slice(0, 120),
          stage: String(p.stage || 'new'), lost: p.stage === 'lost' ? String(p.lostReason || '').slice(0, 60) : '',
          cb: ms.consult_booked ? 1 : 0, came: ms.consulted ? 1 : 0, tx: ms.treated ? 1 : 0,
        });
      });
    rows.sort(function (a, b) { return String(b.day).localeCompare(String(a.day)); });   // newest first
    repCachePut_(key, rows, 600);
  }
  const names = can_(session, 'menu.prospects');
  return { ok: true, names: names, rows: names ? rows : rows.map(function (r) {
    const o = Object.assign({}, r);
    o.id = ''; o.name = '';
    return o;
  }) };
}

// A page from Claude ("https://dermedica.com.au/laser/" or "laser") → "/laser/", or ""
function seoCoachPath_(p) {
  const s = String(p || '').trim().replace(/^https?:\/\/[^/]+/i, '').split('#')[0].split('?')[0];
  if (!s) return '';
  return (s.charAt(0) === '/' ? s : '/' + s).slice(0, 300);
}

// The SEO side, for the coach: priority pages and their target searches, and recent website changes
function seoCoachSeo_() {
  const out = { priorityPages: [], recentSiteChanges: [] };
  const s = seoCoachRead_('seo_settings/main') || {};
  const info = Array.isArray(s.priorityInfo) ? s.priorityInfo : [];
  (Array.isArray(s.keyPages) ? s.keyPages : []).slice(0, 30).forEach(function (p) {
    const i = info.filter(function (x) { return x && String(x.path) === String(p); })[0] || {};
    out.priorityPages.push({ page: String(p), targetSearch: String(i.target || ''), goal: String(i.goal || '') });
  });
  try {
    const since = flowAddDaysKey_(seoDate_(0), -45);
    out.recentSiteChanges = fsListAll_(getConfig_(), 'seo_log', ['date', 'type', 'title', 'url'])
      .map(function (d) { return fromFields_(d.fields || {}); })
      .filter(function (e) { return String(e.date || '') >= since; })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })
      .slice(0, 25)
      .map(function (e) { return { date: e.date, type: String(e.type || ''), change: String(e.title || '').slice(0, 140), page: String(e.url || '') }; });
  } catch (e) { console.warn('Change log not read for the Ads coach: ' + e); }
  return out;
}