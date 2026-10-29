/**
 * Seo4.gs — SEO Phase 4: Audience and areas
 * Writes (same build id on each, pointer last):
 *   seo_audience/geo       visitors by country / region / city / channel, last 28 days vs the 28 before (GA4)
 *   seo_audience/months    Australian visitors by month, region and WA city, 13 months (GA4)
 *   seo_audience/tech      device, new vs returning, channel, and age / gender if GA4 has them
 *   seo_audience/areas     each tracked area: searches mentioning it (Search Console), visitors, patients
 *   seo_audience/patients  where patients live: counts only (postcodes with 3+ patients), new patients per month
 *   seo_state/audience     { build, ok, error, at, ms, from, to, prevFrom, prevTo, patientsError, demo }
 * Uses Seo.gs (seoGa4_, seoGsc_, seoDate_, seoFsCommit_, SEO_TZ_, SEO_LAG_DAYS_) and Code.gs (getConfig_, fsGetDoc_,
 * fsPatch_, fsListAll_, fromFields_, uniq_, pcnCtx_, recallPatients_, repVisits_).
 */

const SEO4_WEEKS_ = 68;   // weekly search history per area (Search Console keeps 16 months)

// Used until areas are saved in SEO → Audience → Edit areas. Check the postcodes suit you.
const SEO4_AREAS_ = [
  ['Western suburbs', 'subiaco, claremont, nedlands, dalkeith, cottesloe, mosman park, peppermint grove, swanbourne, city beach, floreat, wembley, shenton park, 6008, 6009, 6010, 6011, 6012, 6014, 6015'],
  ['Perth CBD & inner north', 'perth cbd, northbridge, east perth, west perth, north perth, leederville, mount lawley, highgate, inglewood, 6000, 6003, 6004, 6005, 6006, 6007, 6050, 6052'],
  ['Northern beaches', 'scarborough, trigg, karrinyup, doubleview, innaloo, north beach, sorrento, hillarys, duncraig, 6018, 6019, 6020, 6023, 6025'],
  ['Joondalup & north', 'joondalup, edgewater, currambine, ocean reef, wanneroo, clarkson, 6027, 6065'],
  ['South of the river', 'south perth, como, applecross, mount pleasant, ardross, booragoon, bull creek, 6151, 6152, 6153, 6154'],
  ['Fremantle', 'fremantle, east fremantle, north fremantle, south fremantle, 6158, 6159, 6160'],
  ['Rockingham & Mandurah', 'rockingham, baldivis, mandurah, 6168, 6171, 6210'],
  ['Perth Hills', 'kalamunda, mundaring, darlington, 6073, 6076'],
  ['Regional WA', 'bunbury, busselton, margaret river, geraldton, albany, kalgoorlie, broome, karratha'],
];

/* ===================== The nightly job ===================== */

function runSeoAudience() {
  const t0 = Date.now();
  const build = Utilities.formatDate(new Date(), SEO_TZ_, "yyyyMMdd'T'HHmm");
  const cfg = getConfig_();
  try {
    const set = fsGetDoc_(cfg, 'seo_settings/main') || {};
    const areas = seo4Areas_(set);
    const curS = seoDate_(SEO_LAG_DAYS_ + 27), curE = seoDate_(SEO_LAG_DAYS_);
    const prvS = seoDate_(SEO_LAG_DAYS_ + 55), prvE = seoDate_(SEO_LAG_DAYS_ + 28);
    const ranges = [{ startDate: curS, endDate: curE, name: 'cur' }, { startDate: prvS, endDate: prvE, name: 'prev' }];

    const geo = seo4Geo_(ranges);
    const months = seo4Months_(curE);
    const tech = seo4Tech_(ranges);

    let patients = null, pErr = '';
    try { patients = seo4Patients_(cfg, areas); }
    catch (e) { pErr = String(e.message || e).slice(0, 300); console.warn('Audience: patients not counted: ' + e); }

    const areaOut = areas.map(function (a) {
      const out = { name: a.name, words: a.words, search: null, searchError: '',
        visitors: seo4AreaVisitors_(a.words, geo, months), patients: patients ? patients.areas[a.name] || null : null };
      try { out.search = seo4AreaSearch_(a.words, curS, curE); }
      catch (e) { out.searchError = String(e.message || e).slice(0, 200); console.warn('Audience: searches for ' + a.name + ' failed: ' + e); }
      return out;
    });
    if (patients) delete patients.areas;

    let geoJson = JSON.stringify(geo);
    if (geoJson.length > 900000) geoJson = JSON.stringify(seo4RollUp_(geo));   // keeps it under Firestore's 1 MB

    seoFsCommit_([
      { path: 'seo_audience/geo', data: { build: build, json: geoJson } },
      { path: 'seo_audience/months', data: { build: build, json: JSON.stringify(months) } },
      { path: 'seo_audience/tech', data: { build: build, json: JSON.stringify(tech) } },
      { path: 'seo_audience/areas', data: { build: build, json: JSON.stringify(areaOut) } },
      { path: 'seo_audience/patients', data: { build: build, json: JSON.stringify(patients) } },
      { path: 'seo_state/audience', data: {
        build: build, ok: true, error: '', at: new Date(), ms: Date.now() - t0,
        from: curS, to: curE, prevFrom: prvS, prevTo: prvE, patientsError: pErr, demo: tech.demo.length > 0,
      } },
    ]);
    console.log('Audience: ' + areaOut.length + ' areas, ' + geo.rows.length + ' location rows, ' +
      (patients ? patients.totals.patients + ' patients' : 'no patients') + ', ' + Math.round((Date.now() - t0) / 1000) + ' s');
  } catch (e) {
    console.error('Audience failed: ' + (e.stack || e));
    try { fsPatch_(cfg, 'seo_state/audience', { ok: false, error: String(e.message || e).slice(0, 500), at: new Date().toISOString() }); }
    catch (e2) { console.warn('Could not record the failure: ' + e2); }
    throw e;
  }
}

/** Run once: daily at about 9am Perth (after Site health) */
function installSeoAudienceTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoAudience'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoAudience').timeBased().everyDays(1).atHour(9).inTimezone(SEO_TZ_).create();
  console.log('runSeoAudience scheduled daily ~9am Perth');
}

/** Run from the editor: shows what GA4 knows about location, and whether age / gender is available (writes nothing) */
function testSeoAudience() {
  const r = [{ startDate: seoDate_(30), endDate: seoDate_(1), name: 'cur' }];
  const geo = seo4Geo_(r);
  const by = {};
  geo.rows.forEach(function (x) { if (x[1] === 'Western Australia') by[x[2]] = (by[x[2]] || 0) + x[5]; });
  console.log('WA cities, last 30 days: ' + Object.keys(by).sort(function (a, b) { return by[b] - by[a]; }).slice(0, 15)
    .map(function (k) { return k + ' ' + by[k]; }).join(' · '));
  const t = seo4Tech_(r);
  console.log('Age / gender: ' + (t.demo.length ? t.demo.length + ' rows' : 'not available. ' + (t.demoNote || 'Google signals may be off, or there are too few visitors.')));
  const p = seo4Addr_('12 Smith St, Subiaco WA 6008');
  console.log('Address test: ' + JSON.stringify(p));
}

/* ===================== Areas ===================== */

function seo4Areas_(set) {
  const list = Array.isArray(set.areas) ? set.areas
    : SEO4_AREAS_.map(function (a) { return { name: a[0], words: a[1].split(',') }; });
  return list.map(function (a) {
    return {
      name: String((a && a.name) || '').trim().slice(0, 60),
      words: uniq_(((a && a.words) || []).map(function (w) { return String(w).trim().toLowerCase(); }).filter(Boolean)).slice(0, 60),
    };
  }).filter(function (a) { return a.name && a.words.length; }).slice(0, 20);
}

// A whole-word match on any of the words (works for both Search Console's RE2 and JavaScript)
function seo4Re2_(words) {
  return '(^|[^a-z0-9])(' + words.map(function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')([^a-z0-9]|$)';
}

function seo4AreaSearch_(words, curS, curE) {
  const wkS = seoDate_(SEO_LAG_DAYS_ + 7 * SEO4_WEEKS_ - 1);
  const filt = { dimensionFilterGroups: [{ filters: [{ dimension: 'query', operator: 'includingRegex', expression: seo4Re2_(words) }] }] };
  const weeks = [];
  for (let i = 0; i < SEO4_WEEKS_; i++) weeks.push([0, 0, 0]);
  const startMs = Date.parse(wkS + 'T00:00:00Z');
  seoGsc_(Object.assign({ startDate: wkS, endDate: curE, dimensions: ['date'] }, filt)).forEach(function (r) {
    const w = Math.floor((Date.parse(r.keys[0] + 'T00:00:00Z') - startMs) / (7 * 864e5));
    if (w < 0 || w >= SEO4_WEEKS_) return;
    weeks[w][0] += r.clicks; weeks[w][1] += r.impressions; weeks[w][2] += r.position * r.impressions;
  });

  const q = {};
  seoGsc_(Object.assign({ startDate: curS, endDate: curE, dimensions: ['query', 'page'] }, filt)).forEach(function (r) {
    const x = q[r.keys[0]] || (q[r.keys[0]] = { c: 0, i: 0, pw: 0, page: '', pi: -1 });
    x.c += r.clicks; x.i += r.impressions; x.pw += r.position * r.impressions;
    if (r.impressions > x.pi) { x.pi = r.impressions; x.page = String(r.keys[1]).replace(/^https?:\/\/[^\/]+/i, '') || '/'; }
  });
  const r1 = function (n) { return Math.round(n * 10) / 10; };
  const queries = Object.keys(q).map(function (k) {
    const x = q[k];
    return [k, x.c, x.i, x.i ? r1(x.pw / x.i) : null, x.page];
  }).sort(function (a, b) { return b[2] - a[2]; }).slice(0, 30);

  const sum = function (a, b) {
    return weeks.slice(a, b).reduce(function (t, w) { return [t[0] + w[0], t[1] + w[1], t[2] + w[2]]; }, [0, 0, 0]);
  };
  const fin = function (t) { return { c: t[0], i: t[1], pos: t[1] ? r1(t[2] / t[1]) : null }; };
  const n = SEO4_WEEKS_;
  return {
    weeks: weeks.map(function (w) { return [w[0], w[1], Math.round(w[2])]; }),
    cur: fin(sum(n - 4, n)), prev: fin(sum(n - 8, n - 4)),   // 4 weeks = the same 28 days as the rest of SEO
    queries: queries, queryCount: Object.keys(q).length,
  };
}

function seo4AreaVisitors_(words, geo, months) {
  const match = function (c) { return words.indexOf(String(c || '').toLowerCase()) !== -1; };
  const cities = {};
  const cur = [0, 0, 0], prev = [0, 0, 0], curO = [0, 0, 0], prevO = [0, 0, 0];
  geo.rows.forEach(function (r) {
    if (r[0] !== 'Australia' || !match(r[2])) return;
    cities[r[2]] = 1;
    const organic = geo.channels[r[3]] === 'Organic Search';
    [r[4] ? prev : cur].concat(organic ? [r[4] ? prevO : curO] : []).forEach(function (t) {
      t[0] += r[5]; t[1] += r[6]; t[2] += r[7];
    });
  });
  const m = {};
  months.forEach(function (x) {
    if (!match(x[2])) return;
    const y = m[x[0]] || (m[x[0]] = [x[0], 0, 0, 0, 0]);
    y[1] += x[3]; y[2] += x[4]; y[3] += x[5]; y[4] += x[6];
  });
  return { cities: Object.keys(cities), cur: cur, prev: prev, curO: curO, prevO: prevO,
    months: Object.keys(m).sort().map(function (k) { return m[k]; }) };
}

/* ===================== Google Analytics ===================== */

// rows: [country, region, city, channel index, 0 = last 28 days / 1 = the 28 before, sessions, engaged, key events]
function seo4Geo_(ranges) {
  const ch = [];
  const ix = function (c) { let i = ch.indexOf(c); if (i < 0) { ch.push(c); i = ch.length - 1; } return i; };
  const rows = seoGa4_({
    dateRanges: ranges,
    dimensions: [{ name: 'country' }, { name: 'region' }, { name: 'city' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }],
    limit: 100000,
  }).map(function (r) {
    const range = r.d.length > 4 && r.d[4] === 'prev' ? 1 : 0;   // GA4 adds the date range as the last value
    return [r.d[0], r.d[1], r.d[2], ix(r.d[3]), range, r.m[0], r.m[1], r.m[2]];
  });
  return { channels: ch, rows: rows };
}

// Other countries rolled up to country level (only used if the data is very large)
function seo4RollUp_(geo) {
  const by = {};
  geo.rows.forEach(function (r) {
    const k = r[0] === 'Australia' ? r.slice(0, 5).join('|') : [r[0], '', '', r[3], r[4]].join('|');
    const x = by[k] || (by[k] = r[0] === 'Australia' ? r.slice(0, 5).concat([0, 0, 0]) : [r[0], '', '', r[3], r[4], 0, 0, 0]);
    x[5] += r[5]; x[6] += r[6]; x[7] += r[7];
  });
  return { channels: geo.channels, rows: Object.keys(by).map(function (k) { return by[k]; }) };
}

// [month 'yyyy-MM', region, WA city or '*', sessions, key events, organic sessions, organic key events]
function seo4Months_(end) {
  const d = new Date(end + 'T00:00:00Z');
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 12, 1)).toISOString().slice(0, 10);
  const by = {};
  seoGa4_({
    dateRanges: [{ startDate: start, endDate: end }],
    dimensions: [{ name: 'yearMonth' }, { name: 'region' }, { name: 'city' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
    dimensionFilter: { filter: { fieldName: 'country', stringFilter: { value: 'Australia' } } },
    limit: 100000,
  }).forEach(function (r) {
    const city = r.d[1] === 'Western Australia' ? r.d[2] : '*';
    const k = r.d[0] + '|' + r.d[1] + '|' + city;
    const x = by[k] || (by[k] = [r.d[0].slice(0, 4) + '-' + r.d[0].slice(4, 6), r.d[1], city, 0, 0, 0, 0]);
    x[3] += r.m[0]; x[4] += r.m[1];
    if (r.d[3] === 'Organic Search') { x[5] += r.m[0]; x[6] += r.m[1]; }
  });
  return Object.keys(by).map(function (k) { return by[k]; });
}

// Each list: [value(s)…, channel, 0/1 date range, sessions, engaged, key events]
function seo4Tech_(ranges) {
  const one = function (dims) {
    return seoGa4_({
      dateRanges: ranges, dimensions: dims.map(function (n) { return { name: n }; }),
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }, { name: 'keyEvents' }], limit: 5000,
    }).map(function (r) {
      const range = r.d.length > dims.length && r.d[r.d.length - 1] === 'prev' ? 1 : 0;
      return r.d.slice(0, dims.length).concat([range], r.m);
    });
  };
  const out = {
    device: one(['deviceCategory', 'sessionDefaultChannelGroup']),
    visitor: one(['newVsReturning', 'sessionDefaultChannelGroup']),
    demo: [], demoNote: '',
  };
  try {
    out.demo = one(['userAgeBracket', 'userGender', 'sessionDefaultChannelGroup'])
      .filter(function (r) { return r[0] !== 'unknown' || r[1] !== 'unknown'; });
  } catch (e) { out.demoNote = String(e.message || e).slice(0, 200); }
  return out;
}

/* ===================== Patients (counts only) ===================== */

// "12 Smith St, Subiaco WA 6008" → { pc: '6008', sub: 'Subiaco', hay: 'subiaco 6008' }
function seo4Addr_(raw) {
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const pcs = s.match(/\b6\d{3}\b/g);
  const pc = pcs ? pcs[pcs.length - 1] : '';
  const parts = s.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  let sub = parts.slice(-2).join(' ')
    .replace(/\b\d{4}\b/g, ' ')
    .replace(/\b(western australia|australia|w\.?a\.?)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  sub = sub.replace(/^.*\b(st|street|rd|road|ave|avenue|dr|drive|cres|crescent|pl|place|way|ct|court|tce|terrace|pde|parade|cl|close|hwy|highway|ln|lane|bvd|blvd|boulevard|cct|circuit|loop|mews|rise|vista|esp|esplanade|gdns|gardens)\.?\s+/i, '');
  sub = sub.replace(/^\d+[a-z]?\s*/i, '').replace(/[^A-Za-z' -]/g, ' ').replace(/\s+/g, ' ').trim();
  if (sub.length > 30) sub = '';
  sub = sub.toLowerCase().replace(/\b[a-z]/g, function (ch) { return ch.toUpperCase(); });
  if (!pc && !sub) return null;
  return { pc: pc, sub: sub, hay: (sub + ' ' + pc).toLowerCase().trim() };
}

function seo4MonthKeys_(n) {
  const now = new Date();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - i, 1), SEO_TZ_, 'yyyy-MM'));
  return out;
}

function seo4Patients_(cfg, areas) {
  const where = {};
  fsListAll_(cfg, 'patient_list', ['Address', 'MergedInto']).forEach(function (d) {
    const f = fromFields_(d.fields || {});
    if (f.MergedInto) return;
    const a = seo4Addr_(f.Address);
    if (a) where[d.name.split('/').pop()] = a;
  });
  const idx = repVisits_(pcnCtx_(), recallPatients_(cfg));   // first and last visit for every patient, from the appointment book

  const yearAgo = Utilities.formatDate(new Date(Date.now() - 365 * 864e5), SEO_TZ_, 'yyyy-MM-dd');
  const keys = seo4MonthKeys_(13);
  const blank = function () { return { total: 0, active: 0, new12: 0, m: {} }; };
  const res = areas.map(function (a) { return { name: a.name, re: new RegExp(seo4Re2_(a.words)), o: blank() }; });
  const all = blank();
  const pcs = {};
  let wa = 0, other = 0, unknown = 0;

  Object.keys(idx).forEach(function (k) {
    const v = idx[k];
    if (!v.first) return;   // only future bookings so far
    const loc = where[k];
    const active = v.last >= yearAgo, isNew = v.first >= yearAgo, month = v.first.slice(0, 7);
    const count = function (o) { o.total++; if (active) o.active++; if (isNew) o.new12++; o.m[month] = (o.m[month] || 0) + 1; };
    count(all);
    if (!loc) { unknown++; return; }
    if (loc.pc) {
      wa++;
      const p = pcs[loc.pc] || (pcs[loc.pc] = { subs: {}, total: 0, active: 0, new12: 0 });
      p.total++; if (active) p.active++; if (isNew) p.new12++;
      if (loc.sub) p.subs[loc.sub] = (p.subs[loc.sub] || 0) + 1;
    } else other++;
    res.forEach(function (r) { if (r.re.test(loc.hay)) count(r.o); });
  });

  const fin = function (o) {
    return { total: o.total, active: o.active, new12: o.new12, months: keys.map(function (m) { return [m, o.m[m] || 0]; }) };
  };
  const areaOut = {};
  res.forEach(function (r) { areaOut[r.name] = fin(r.o); });
  const postcodes = Object.keys(pcs).filter(function (pc) { return pcs[pc].total >= 3; }).map(function (pc) {
    const p = pcs[pc];
    const sub = Object.keys(p.subs).sort(function (a, b) { return p.subs[b] - p.subs[a]; })[0] || '';
    return [pc, sub, p.total, p.active, p.new12];
  }).sort(function (a, b) { return b[3] - a[3] || b[2] - a[2]; });
  const a = fin(all);
  return {
    areas: areaOut, postcodes: postcodes, months: a.months,
    totals: { patients: a.total, active: a.active, new12: a.new12, wa: wa, other: other, unknown: unknown },
  };
}