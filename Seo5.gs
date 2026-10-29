/**
 * Seo5.gs — SEO: Google indexing checks
 * Each morning:
 *   · URL Inspection (Search Console) for every key page: in Google or not, Google's last visit, the version Google uses,
 *     robots.txt / noindex, structured data errors
 *   · the sitemaps: Search Console's list (or robots.txt / sitemap_index.xml), their errors, and the pages in them
 *   · up to SEO5_DAILY_ more sitemap pages that have had no Google impressions, oldest-checked first
 * Writes seo_index/main { build, ok, error, at, ms, json }
 * Uses Seo.gs (seoProp_, seoOrigin_, seoToken_, seoFsCommit_, SEO_TZ_), Seo3.gs (seo3KeyPages_, seo3Fetch_, seo3Norm_,
 * seo3Short_, seo3Decode_) and Code.gs (getConfig_, fsGetDoc_, fsPatch_, fsQuery_).
 */

const SEO5_DAILY_ = 60;                 // extra sitemap pages inspected per day (Google allows 2,000 a day)
const SEO5_MAX_SITEMAP_URLS_ = 5000;

function runSeoIndex() {
  const t0 = Date.now();
  const deadline = t0 + 4.5 * 60000;
  const cfg = getConfig_();
  const build = Utilities.formatDate(new Date(), SEO_TZ_, "yyyyMMdd'T'HHmm");
  try {
    const site = seoProp_('SEO_SITE');
    const origin = seoOrigin_();
    const set = fsGetDoc_(cfg, 'seo_settings/main') || {};
    const keys = seo3KeyPages_(cfg, set, origin);
    let prev = {};
    try { const d = fsGetDoc_(cfg, 'seo_index/main'); prev = d && d.json ? JSON.parse(d.json) : {}; } catch (e) { prev = {}; }

    // Sitemaps and the pages in them
    const sm = seo5Sitemaps_(site, origin);
    const inMap = {};
    sm.urls.forEach(function (u) { inMap[seo3Norm_(u)] = u; });

    // Pages with Google impressions are in Google already, so they don't need inspecting
    const ov = fsGetDoc_(cfg, 'seo_state/overview');
    const pages = ov && ov.build ? fsQuery_(cfg, 'seo_pages', 'build', 'EQUAL', ov.build, 5000) : [];
    const seen = {};
    const clicksNotInMap = [];
    pages.forEach(function (p) {
      const n = seo3Norm_(p.url);
      const m = p.m28 || {};
      if (Number(m.impressions) > 0) seen[n] = 1;
      if (sm.urls.length && Number(m.clicks) > 0 && !inMap[n] && String(p.url).indexOf('?') === -1) clicksNotInMap.push([p.path, Number(m.clicks)]);
    });
    clicksNotInMap.sort(function (a, b) { return b[1] - a[1]; });

    // 1. Key pages (an answer that doesn't come back keeps yesterday's result)
    const kr = seo5Inspect_(keys.map(function (k) { return k.url; }), site, deadline);
    const key = {};
    keys.forEach(function (k) { key[k.path] = kr.out[k.url] || (prev.key && prev.key[k.path]) || null; });

    // 2. Other sitemap pages without impressions, oldest-checked first
    const keySet = {};
    keys.forEach(function (k) { keySet[seo3Norm_(k.url)] = 1; });
    const others = {};
    Object.keys(inMap).forEach(function (n) {
      const path = seo3Short_(inMap[n]);
      if (!seen[n] && prev.others && prev.others[path]) others[path] = prev.others[path];
    });
    const todo = Object.keys(inMap)
      .filter(function (n) { return !keySet[n] && !seen[n]; })
      .sort(function (a, b) {
        const x = (others[seo3Short_(inMap[a])] || {}).at || '', y = (others[seo3Short_(inMap[b])] || {}).at || '';
        return x < y ? -1 : x > y ? 1 : 0;
      })
      .slice(0, SEO5_DAILY_)
      .map(function (n) { return inMap[n]; });
    let quota = kr.quota;
    let checked = Object.keys(kr.out).length;
    if (!kr.quota && !kr.permission && todo.length) {
      const r2 = seo5Inspect_(todo, site, deadline);
      todo.forEach(function (u) { if (r2.out[u]) others[seo3Short_(u)] = r2.out[u]; });
      quota = quota || r2.quota;
      checked += Object.keys(r2.out).length;
    }

    const data = {
      key: key, others: others,
      sitemaps: sm.list, sitemapSource: sm.source, sitemapUrls: sm.urls.length,
      sitemapSeen: Object.keys(inMap).filter(function (n) { return seen[n]; }).length,
      keyNotInSitemap: sm.urls.length ? keys.filter(function (k) { return !inMap[seo3Norm_(k.url)]; }).map(function (k) { return k.path; }) : [],
      notInSitemap: clicksNotInMap.slice(0, 50),
      checkedToday: checked, quota: quota ? 'limit' : '',
    };
    let json = JSON.stringify(data);
    if (json.length > 900000) {   // keep it under Firestore's 1 MB: only pages not in Google
      Object.keys(data.others).forEach(function (p) { if (data.others[p].v === 'PASS') delete data.others[p]; });
      json = JSON.stringify(data);
    }
    seoFsCommit_([{ path: 'seo_index/main', data: {
      build: build, ok: !kr.permission, error: kr.permission || '', at: new Date(), ms: Date.now() - t0, json: json,
    } }]);
    console.log('Google index: ' + keys.length + ' key pages, ' + sm.urls.length + ' sitemap pages (' + data.sitemapSeen +
      ' with impressions), ' + checked + ' inspected today' + (quota ? ' (daily limit reached)' : '') + (kr.permission ? ' · ' + kr.permission : ''));
  } catch (e) {
    console.error('Google index check failed: ' + (e.stack || e));
    try { fsPatch_(cfg, 'seo_index/main', { ok: false, error: String(e.message || e).slice(0, 500), at: new Date().toISOString() }); }
    catch (e2) { console.warn('Could not record the failure: ' + e2); }
    throw e;
  }
}

/** Run once: daily at about 10am Perth */
function installSeoIndexTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoIndex'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoIndex').timeBased().everyDays(1).atHour(10).inTimezone(SEO_TZ_).create();
  console.log('runSeoIndex scheduled daily ~10am Perth');
}

/** Run from the editor: inspects the home page and lists the sitemaps (writes nothing) */
function testSeoIndex() {
  const site = seoProp_('SEO_SITE');
  const home = seoOrigin_() + '/';
  const r = seo5Inspect_([home], site, Date.now() + 60000);
  if (r.permission) { console.log('✗ ' + r.permission); console.log('In Search Console → Settings → Users and permissions, make the service account a Full user.'); }
  else console.log('Home page: ' + JSON.stringify(r.out[home]));
  const sm = seo5Sitemaps_(site, seoOrigin_());
  console.log('Sitemaps (' + sm.source + '): ' + (sm.list.map(function (s) { return s.path + ' (' + s.errors + ' errors)'; }).join(', ') || 'none in Search Console'));
  console.log('Pages in the sitemaps: ' + sm.urls.length);
}

/* ---------- URL Inspection ---------- */

function seo5Inspect_(urls, site, deadline) {
  const out = {};
  let quota = false, permission = '';
  const today = Utilities.formatDate(new Date(), SEO_TZ_, 'yyyy-MM-dd');
  for (let i = 0; i < urls.length; i += 10) {
    if (Date.now() > deadline || quota || permission) break;
    const part = urls.slice(i, i + 10);
    const token = seoToken_();
    const reqs = part.map(function (u) {
      return {
        url: 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect', method: 'post',
        contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token },
        payload: JSON.stringify({ inspectionUrl: u, siteUrl: site, languageCode: 'en-AU' }),
      };
    });
    let res = null;
    try { res = UrlFetchApp.fetchAll(reqs); } catch (e) { console.warn('URL Inspection batch failed: ' + e); continue; }
    part.forEach(function (u, k) {
      const r = res[k];
      const code = r.getResponseCode();
      if (code === 200) {
        try { out[u] = seo5Compact_(JSON.parse(r.getContentText()), today); } catch (e) { out[u] = { err: 'Unreadable answer', at: today }; }
        return;
      }
      let msg = '';
      try { msg = JSON.parse(r.getContentText()).error.message; } catch (e) { msg = r.getContentText().slice(0, 150); }
      if (code === 429) quota = true;
      else if (code === 401 || code === 403) permission = 'Search Console refused URL Inspection (' + code + '): ' + String(msg).slice(0, 200);
      else out[u] = { err: code + ': ' + String(msg).slice(0, 150), at: today };
    });
  }
  return { out: out, quota: quota, permission: permission };
}

function seo5Compact_(j, today) {
  const ir = j.inspectionResult || {};
  const ix = ir.indexStatusResult || {};
  const rr = ir.richResultsResult || null;
  const rich = rr && rr.detectedItems ? rr.detectedItems.map(function (d) {
    let e = 0, w = 0, m = '';
    (d.items || []).forEach(function (it) {
      (it.issues || []).forEach(function (is) {
        if (is.severity === 'ERROR') { e++; if (!m) m = is.issueMessage || ''; } else w++;
      });
    });
    return { t: d.richResultType || '', e: e, w: w, m: String(m).slice(0, 150) };
  }) : [];
  return {
    v: ix.verdict || '', cs: ix.coverageState || '', is: ix.indexingState || '', rb: ix.robotsTxtState || '',
    pf: ix.pageFetchState || '', lc: ix.lastCrawlTime || '', gc: ix.googleCanonical || '', uc: ix.userCanonical || '',
    ca: ix.crawledAs || '', rr: rich, link: ir.inspectionResultLink || '', at: today,
  };
}

/* ---------- Sitemaps ---------- */

function seo5Sitemaps_(site, origin) {
  const list = [];
  try {
    const r = UrlFetchApp.fetch('https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(site) + '/sitemaps', {
      headers: { Authorization: 'Bearer ' + seoToken_() }, muteHttpExceptions: true,
    });
    if (r.getResponseCode() === 200) {
      (JSON.parse(r.getContentText()).sitemap || []).forEach(function (s) {
        list.push({
          path: s.path, submitted: s.lastSubmitted || '', downloaded: s.lastDownloaded || '', pending: !!s.isPending,
          index: !!s.isSitemapsIndex, errors: Number(s.errors || 0), warnings: Number(s.warnings || 0),
          urls: (s.contents || []).reduce(function (t, c) { return t + Number(c.submitted || 0); }, 0),
        });
      });
    } else console.warn('Sitemap list ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  } catch (e) { console.warn('Sitemap list failed: ' + e); }

  let roots = list.map(function (s) { return s.path; });
  let source = roots.length ? 'Search Console' : '';
  if (!roots.length) {
    try {
      const rb = UrlFetchApp.fetch(origin + '/robots.txt', { muteHttpExceptions: true });
      if (rb.getResponseCode() === 200) {
        roots = (rb.getContentText().match(/^\s*sitemap:\s*\S+/gim) || []).map(function (l) { return l.replace(/^\s*sitemap:\s*/i, '').trim(); });
      }
    } catch (e) { /* tried the usual addresses below */ }
    if (roots.length) source = 'robots.txt';
    else { roots = [origin + '/sitemap_index.xml', origin + '/sitemap.xml']; source = ''; }
  }

  const urls = {};
  const done = {};
  const queue = roots.slice();
  let files = 0;
  while (queue.length && files < 30 && Object.keys(urls).length < SEO5_MAX_SITEMAP_URLS_) {
    const f = queue.shift();
    if (done[f]) continue;
    done[f] = 1;
    files++;
    const r = seo3Fetch_([f], true)[0];
    if (r.error || r.code !== 200) continue;
    const xml = r.text;
    const locs = (xml.match(/<loc>\s*[^<\s]+\s*<\/loc>/gi) || []).map(function (x) { return seo3Decode_(x.replace(/<\/?loc>/gi, '').trim()); });
    if (/<sitemapindex/i.test(xml)) locs.forEach(function (l) { queue.push(l); });
    else locs.forEach(function (l) { if (!/\.(jpe?g|png|gif|webp|pdf)(\?|$)/i.test(l)) urls[l] = 1; });
    if (!source && locs.length) source = 'found at ' + seo3Short_(f);
  }
  return { list: list, source: source, urls: Object.keys(urls).slice(0, SEO5_MAX_SITEMAP_URLS_) };
}