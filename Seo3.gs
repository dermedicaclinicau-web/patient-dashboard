/**
 * Seo3.gs — SEO Phase 3: Site health
 * Each night, for every key page (SEO → Settings → Key pages):
 *   · reads the page: status, redirects, noindex, canonical, title, description, H1, image alt text
 *   · scans its words against the Advertising wording list (SEO → Settings)
 *   · checks the internal links on it (missing pages, redirects)
 *   · runs PageSpeed Insights (mobile): score and Core Web Vitals
 * Writes:
 *   seo_health/p_<hash>   one per key page (the UI shows the current build only)
 *   seo_state/health      { build, ok, error, at, ms, pages, speedDone, speedTotal, speedProblem, linksFound, linksChecked, blocked }
 * Uses Seo.gs (seoProp_, seoOrigin_, seoHash_, seoFsCommit_, SEO_TZ_) and Code.gs (getConfig_, fsGetDoc_, fsPatch_,
 * fsQuery_, fsListAll_, fromFields_, uniq_).
 */

const SEO3_MAX_PAGES_ = 30;    // key pages checked each night
const SEO3_MAX_LINKS_ = 250;   // internal links checked each night
const SEO3_HISTORY_ = 90;      // days of speed history kept per page
const SEO3_SKIP_LINK_ = /\/wp-(admin|login|json|content|includes)\/|\/xmlrpc\.php|\/feed\/?(\?|$)|\/(cart|checkout|my-account)\/?(\?|$)|[?&](add-to-cart|replytocom|s)=|\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|mp4|mov|css|js|xml)(\?|$)/i;

// The starting list when SEO → Settings → Advertising wording has never been saved
const SEO3_COMPLIANCE_ = [
  ['botox', 'Prescription medicine brand name (TGA)'],
  ['dysport', 'Prescription medicine brand name (TGA)'],
  ['xeomin', 'Prescription medicine brand name (TGA)'],
  ['letybo', 'Prescription medicine brand name (TGA)'],
  ['relatox', 'Prescription medicine brand name (TGA)'],
  ['botulinum', 'Prescription medicine (TGA)'],
  ['guarantee', 'Promises a result (AHPRA)'],
  ['guaranteed', 'Promises a result (AHPRA)'],
  ['risk-free', 'Downplays risk (AHPRA)'],
  ['risk free', 'Downplays risk (AHPRA)'],
  ['pain-free', 'Downplays risk (AHPRA)'],
  ['pain free', 'Downplays risk (AHPRA)'],
  ['painless', 'Downplays risk (AHPRA)'],
  ['no downtime', 'Downplays risk (AHPRA)'],
  ['completely safe', 'Downplays risk (AHPRA)'],
  ['100% safe', 'Downplays risk (AHPRA)'],
  ['miracle', 'Creates unrealistic expectations (AHPRA)'],
  ['permanent results', 'Creates unrealistic expectations (AHPRA)'],
  ['lunchtime', 'Trivialises a procedure (AHPRA)'],
];

/* ===================== The nightly job ===================== */

function runSeoHealth() {
  const cache = CacheService.getScriptCache();
  if (cache.get('seo_health_run')) { console.log('Site health is already running.'); return; }
  cache.put('seo_health_run', '1', 420);
  const t0 = Date.now();
  const deadline = t0 + 5 * 60000;
  const build = Utilities.formatDate(new Date(), SEO_TZ_, "yyyyMMdd'T'HHmm");
  const cfg = getConfig_();
  try {
    const origin = seoOrigin_();
    const set = fsGetDoc_(cfg, 'seo_settings/main') || {};
    const pages = seo3KeyPages_(cfg, set, origin);
    if (!pages.length) throw new Error('No key pages to check.');
    const words = seo3Words_(set);
    const old = {};
    fsListAll_(cfg, 'seo_health', ['speed', 'speedAt', 'history']).forEach(function (d) {
      old[d.name.split('/').pop()] = fromFields_(d.fields || {});
    });

    const checks = seo3Pages_(pages);                          // 1. the pages themselves
    const links = seo3Links_(checks, origin, t0 + 150000);     // 2. links on them (up to 2.5 minutes in)
    const speed = seo3Speed_(pages, old, deadline);            // 3. PageSpeed, with the time that's left

    const today = Utilities.formatDate(new Date(), SEO_TZ_, 'yyyy-MM-dd');
    const x = { dupT: seo3Dups_(checks, 'title'), dupD: seo3Dups_(checks, 'desc'), links: links, words: words };
    const docs = checks.map(function (c) {
      const prev = old[c.id] || {};
      const sp = speed.out[c.id] || null;
      const fresh = sp && !sp.error;
      const sNow = fresh ? sp : (prev.speed || null);           // not measured tonight: keep the last result
      let history = (Array.isArray(prev.history) ? prev.history : []).filter(function (r) { return r && r.d !== today; });
      if (fresh) history.push(seo3HistRow_(today, sp));
      history = history.slice(-SEO3_HISTORY_);
      const p = c.parsed || {};
      return { path: 'seo_health/' + c.id, data: {
        url: c.url, path: c.path, build: build, checkedAt: new Date(),
        status: c.status || 0, redirect: c.redirect || '', finalUrl: c.finalUrl || '', error: c.error || '', blocked: !!c.blocked,
        title: p.title || '', desc: p.desc == null ? null : p.desc, canonical: p.canonical || '', robots: p.robots || '',
        h1: p.h1 || 0, h1Text: p.h1Text || '', imgs: p.imgs || 0, noAlt: p.noAlt || 0, words: p.words || 0,
        linksOut: p.hrefs ? p.hrefs.length : 0,
        speed: sNow,
        speedAt: fresh ? new Date() : (prev.speedAt ? new Date(prev.speedAt) : null),
        speedError: sp && sp.error ? sp.error : '',
        history: history,
        issues: seo3Issues_(c, Object.assign({ speed: sNow }, x)),
      } };
    });

    // Pages first, then the pointer, so the portal never shows half a build
    seoFsCommit_(docs.concat([{ path: 'seo_state/health', data: {
      build: build, ok: true, error: '', at: new Date(), ms: Date.now() - t0, pages: docs.length,
      speedDone: speed.done, speedTotal: pages.length, speedProblem: speed.problem || '',
      linksFound: links.found, linksChecked: links.checked,
      blocked: checks.filter(function (c) { return c.blocked; }).length,
    } }]));
    console.log('Site health: ' + docs.length + ' pages, speed ' + speed.done + '/' + pages.length +
      ', links ' + links.checked + '/' + links.found + ', ' + Math.round((Date.now() - t0) / 1000) + ' s');
  } catch (e) {
    console.error('Site health failed: ' + (e.stack || e));
    try { fsPatch_(cfg, 'seo_state/health', { ok: false, error: String(e.message || e).slice(0, 500), at: new Date().toISOString() }); }
    catch (e2) { console.warn('Could not record the failure: ' + e2); }
    throw e;
  } finally {
    cache.remove('seo_health_run');
  }
}

/** Run once: daily at about 8am Perth (after the search data jobs) */
function installSeoHealthTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoHealth'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoHealth').timeBased().everyDays(1).atHour(8).inTimezone(SEO_TZ_).create();
  console.log('runSeoHealth scheduled daily ~8am Perth');
}

/** Run from the editor: checks the home page only and logs what it found (writes nothing) */
function testSeoHealth() {
  const origin = seoOrigin_();
  const c = seo3Pages_([{ id: 'test', url: origin + '/', path: '/' }])[0];
  console.log('Home page: status ' + c.status + (c.redirect ? ' → ' + c.redirect : '') + (c.error ? ' · ' + c.error : '') +
    (c.blocked ? ' · BLOCKED (the site may be refusing automated checks)' : ''));
  if (!c.parsed) return;
  const p = c.parsed;
  console.log('Title (' + p.title.length + '): ' + p.title);
  console.log('Description (' + (p.desc || '').length + '): ' + p.desc);
  console.log('Canonical: ' + (p.canonical || 'none') + ' · robots: ' + (p.robots || 'none') + ' · H1: ' + p.h1 + ' "' + p.h1Text + '"');
  console.log('Images: ' + p.imgs + ' (' + p.noAlt + ' without alt) · links: ' + p.hrefs.length + ' · words: ' + p.words);
  const w = seo3Wording_(p, seo3Words_({}));
  console.log('Advertising wording found: ' + (w.map(function (x) { return x.word + ' ×' + x.count; }).join(', ') || 'none'));
}

/* ===================== Which pages ===================== */

function seo3KeyPages_(cfg, set, origin) {
  let paths = (Array.isArray(set.keyPages) ? set.keyPages : []).map(seo3Path_).filter(Boolean);
  if (!paths.length) {   // none chosen yet: the home page and the 15 busiest pages
    const ov = fsGetDoc_(cfg, 'seo_state/overview');
    const top = ov && ov.build ? fsQuery_(cfg, 'seo_pages', 'build', 'EQUAL', ov.build, 3000) : [];
    paths = ['/'].concat(top
      .filter(function (p) { return p.m28 && Number(p.m28.clicks) > 0; })
      .sort(function (a, b) { return Number(b.m28.clicks) - Number(a.m28.clicks); })
      .slice(0, 15)
      .map(function (p) { return seo3Path_(p.path); }));
  }
  return uniq_(paths.filter(Boolean)).slice(0, SEO3_MAX_PAGES_).map(function (p) {
    return { path: p, url: origin + p, id: 'p_' + seoHash_(origin + p) };
  });
}

function seo3Path_(s) {
  s = String(s || '').trim().replace(/^https?:\/\/[^\/]+/i, '').split('#')[0];
  if (!s) return '';
  return s.charAt(0) === '/' ? s : '/' + s;
}

function seo3Words_(set) {
  const list = Array.isArray(set.compliance) ? set.compliance
    : SEO3_COMPLIANCE_.map(function (x) { return { word: x[0], why: x[1] }; });
  return list.map(function (w) {
    return { word: String((w && w.word) || '').trim().toLowerCase(), why: String((w && w.why) || '').trim() };
  }).filter(function (w) { return w.word; }).slice(0, 200);
}

/* ===================== Reading the pages ===================== */

// [{ code, headers, text }] or [{ error }], in the same order as urls
function seo3Fetch_(urls, follow, withText) {
  const out = [];
  for (let i = 0; i < urls.length; i += 20) {
    const part = urls.slice(i, i + 20);
    const reqs = part.map(function (u) { return { url: u, method: 'get', followRedirects: !!follow, muteHttpExceptions: true }; });
    let res = null;
    try { res = UrlFetchApp.fetchAll(reqs); } catch (e) { res = null; }   // one bad address fails the batch: retried one by one
    part.forEach(function (u, k) {
      let r = res ? res[k] : null;
      if (!r) {
        try { r = UrlFetchApp.fetch(u, reqs[k]); }
        catch (e) { out.push({ error: String(e.message || e).slice(0, 150) }); return; }
      }
      out.push({ code: r.getResponseCode(), headers: r.getHeaders(), text: withText === false ? '' : r.getContentText() });
    });
  }
  return out;
}

function seo3Header_(h, name) {
  name = name.toLowerCase();
  const keys = Object.keys(h || {});
  for (let i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === name) return String(h[keys[i]]);
  return '';
}

function seo3Pages_(pages) {
  const res = seo3Fetch_(pages.map(function (p) { return p.url; }), false);
  const follow = [];
  const checks = pages.map(function (p, i) {
    const c = { id: p.id, url: p.url, path: p.path, status: 0 };
    const r = res[i];
    if (r.error) { c.error = r.error; return c; }
    c.status = r.code;
    if (r.code >= 300 && r.code < 400) {
      c.redirect = seo3Abs_(seo3Header_(r.headers, 'location'), p.url);
      if (c.redirect) follow.push(c);
      return c;
    }
    if (r.code === 403 || r.code === 429 || r.code === 503) c.blocked = true;
    if (r.code === 200) seo3Use_(c, r);
    return c;
  });
  if (follow.length) {   // check the page a redirect lands on
    const res2 = seo3Fetch_(follow.map(function (c) { return c.redirect; }), true);
    follow.forEach(function (c, k) {
      const r = res2[k];
      if (!r.error && r.code === 200) { c.finalUrl = c.redirect; seo3Use_(c, r); }
    });
  }
  return checks;
}

function seo3Use_(c, r) {
  const type = seo3Header_(r.headers, 'content-type');
  if (type && !/html/i.test(type)) { c.error = 'Not a web page (' + type + ')'; return; }
  c.parsed = seo3Parse_(r.text);
  c.xRobots = seo3Header_(r.headers, 'x-robots-tag');
}

function seo3Parse_(html) {
  const src = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  const headM = /<head[\s>][\s\S]*?<\/head\s*>/i.exec(src);
  const head = headM ? headM[0] : src.slice(0, 100000);
  const titleM = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);
  const metas = (head.match(/<meta\b[^>]*>/gi) || []).map(seo3Attrs_);
  const meta = function (names) {
    const hit = metas.filter(function (a) { return names.indexOf(String(a.name || a.property || '').toLowerCase()) !== -1; });
    return hit.length ? hit.map(function (a) { return String(a.content || '').trim(); }).join(', ') : null;
  };
  const canon = (head.match(/<link\b[^>]*>/gi) || []).map(seo3Attrs_)
    .filter(function (a) { return /(^|\s)canonical(\s|$)/i.test(a.rel || ''); })[0];
  const bodyM = /<body[\s>][\s\S]*$/i.exec(src);
  const body = (bodyM ? bodyM[0] : src).replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const h1s = body.match(/<h1\b[\s\S]*?<\/h1\s*>/gi) || [];
  const imgs = (body.match(/<img\b[^>]*>/gi) || []).map(seo3Attrs_)
    .filter(function (a) { return !/^[01]$/.test(String(a.width || '')) && !/^[01]$/.test(String(a.height || '')); });   // tracking pixels
  const noAlt = imgs.filter(function (a) { return !('alt' in a); });   // alt="" is fine: a decorative image
  const text = seo3Text_(body);
  return {
    title: titleM ? seo3Text_(titleM[1]) : '',
    desc: meta(['description']),
    robots: meta(['robots', 'googlebot']) || '',
    canonical: canon ? String(canon.href || '').trim() : '',
    h1: h1s.length,
    h1Text: h1s.length ? seo3Text_(h1s[0]).slice(0, 150) : '',
    imgs: imgs.length,
    noAlt: noAlt.length,
    noAltSrc: noAlt.slice(0, 5).map(function (a) { return String(a.src || a['data-src'] || '').split('?')[0].split('/').pop().slice(0, 80); }),
    hrefs: (body.match(/<a\b[^>]*>/gi) || []).map(function (t) { return seo3Attrs_(t).href || ''; }).filter(Boolean),
    text: text,
    alts: imgs.map(function (a) { return a.alt || ''; }).join(' '),
    words: text ? text.split(' ').length : 0,
  };
}

function seo3Attrs_(tag) {
  const a = {};
  const inner = String(tag).replace(/^<\s*[\w:-]+/, '').replace(/\/?\s*>$/, '');
  const re = /([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(inner))) {
    const k = m[1].toLowerCase();
    if (!(k in a)) a[k] = seo3Decode_(m[2] != null ? m[2] : m[3] != null ? m[3] : m[4] != null ? m[4] : '');
  }
  return a;
}

function seo3Decode_(s) {
  return String(s)
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(Number(n)); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"').replace(/&hellip;/g, '…').replace(/&amp;/g, '&');
}

function seo3Text_(h) {
  return seo3Decode_(String(h || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function seo3Abs_(href, base) {
  href = String(href || '').trim();
  if (!href || href.charAt(0) === '#') return '';
  if (/^https?:\/\//i.test(href)) return href;
  if (href.indexOf('//') === 0) return 'https:' + href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return '';   // mailto:, tel:, javascript:
  const m = /^(https?:\/\/[^\/?#]+)(\/[^?#]*)?/i.exec(base);
  if (!m) return '';
  if (href.charAt(0) === '/') return m[1] + href;
  return m[1] + (m[2] || '/').replace(/[^\/]*$/, '') + href;
}

function seo3Short_(u) { return String(u).replace(/^https?:\/\/[^\/]+/i, '') || '/'; }
function seo3Norm_(u) { return String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/#.*$/, '').replace(/\/+$/, ''); }
function seo3Esc_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* ===================== Internal links ===================== */

function seo3Links_(checks, origin, until) {
  const host = origin.replace(/^https?:\/\//i, '').toLowerCase().replace(/^www\./, '');
  const known = {};
  checks.forEach(function (c) { if (c.status) known[c.url] = c.status; });
  const from = {};
  checks.forEach(function (c) {
    ((c.parsed && c.parsed.hrefs) || []).forEach(function (h) {
      const abs = seo3Abs_(h, c.finalUrl || c.url).replace(/#.*$/, '');
      const m = /^https?:\/\/([^\/?#]+)/i.exec(abs);
      if (!m || m[1].toLowerCase().replace(/^www\./, '') !== host || SEO3_SKIP_LINK_.test(abs)) return;
      const list = from[abs] || (from[abs] = []);
      if (list.indexOf(c.path) === -1) list.push(c.path);
    });
  });
  const all = Object.keys(from);
  const status = {};
  const todo = [];
  all.forEach(function (u) { if (u in known) status[u] = known[u]; else todo.push(u); });
  for (let i = 0; i < todo.length && i < SEO3_MAX_LINKS_; i += 20) {
    if (Date.now() > until) break;
    const part = todo.slice(i, Math.min(i + 20, SEO3_MAX_LINKS_));
    seo3Fetch_(part, false, false).forEach(function (r, k) { status[part[k]] = r.error ? 0 : r.code; });
  }
  return { from: from, status: status, found: all.length, checked: Object.keys(status).length };
}

/* ===================== PageSpeed Insights ===================== */

function seo3Speed_(pages, old, deadline) {
  const key = seoProp_('PSI_KEY');
  const out = {};
  if (!key) return { out: out, done: 0, problem: 'PSI_KEY is missing from Script Properties, so speed was not checked.' };
  // Pages measured longest ago go first, so any that don't fit tonight are done tomorrow
  const order = pages.slice().sort(function (a, b) {
    return (Date.parse((old[a.id] || {}).speedAt || '') || 0) - (Date.parse((old[b.id] || {}).speedAt || '') || 0);
  });
  let done = 0, failed = 0;
  for (let i = 0; i < order.length; i += 5) {
    if (Date.now() > deadline - 75000) break;   // leave time to save
    const part = order.slice(i, i + 5);
    const reqs = part.map(function (p) {
      return { url: 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed?strategy=mobile&category=performance&url=' +
        encodeURIComponent(p.url) + '&key=' + encodeURIComponent(key), muteHttpExceptions: true };
    });
    let res = null;
    try { res = UrlFetchApp.fetchAll(reqs); } catch (e) { console.warn('PageSpeed batch failed: ' + e); }
    part.forEach(function (p, k) {
      const r = res && res[k];
      if (!r) { out[p.id] = { error: 'Timed out' }; failed++; return; }
      if (r.getResponseCode() !== 200) {
        let msg = '';
        try { msg = JSON.parse(r.getContentText()).error.message; } catch (e) { msg = r.getContentText().slice(0, 120); }
        out[p.id] = { error: 'PageSpeed ' + r.getResponseCode() + ': ' + String(msg).slice(0, 150) };
        failed++;
        return;
      }
      try { out[p.id] = seo3Psi_(JSON.parse(r.getContentText())); done++; }
      catch (e) { out[p.id] = { error: 'Unreadable answer from PageSpeed' }; failed++; }
    });
  }
  return { out: out, done: done, problem: failed && !done ? "PageSpeed Insights didn't answer, so speed shows the last results." : '' };
}

function seo3Psi_(j) {
  const lh = j.lighthouseResult || {};
  const au = lh.audits || {};
  const num = function (k) { return au[k] && typeof au[k].numericValue === 'number' ? au[k].numericValue : null; };
  const r3 = function (v) { return v == null ? null : Math.round(v * 1000) / 1000; };
  const ms = function (v) { return v == null ? null : Math.round(v); };
  const le = j.loadingExperience || {};
  const m = le.metrics || {};
  const fm = function (k, div) { return m[k] && m[k].percentile != null ? { v: r3(m[k].percentile / (div || 1)), c: String(m[k].category || '') } : null; };
  const perf = lh.categories && lh.categories.performance;
  return {
    score: perf && perf.score != null ? Math.round(perf.score * 100) : null,
    lab: { lcp: ms(num('largest-contentful-paint')), fcp: ms(num('first-contentful-paint')),
      tbt: ms(num('total-blocking-time')), cls: r3(num('cumulative-layout-shift')) },
    field: Object.keys(m).length ? {
      src: le.origin_fallback ? 'site' : 'page', overall: String(le.overall_category || ''),
      lcp: fm('LARGEST_CONTENTFUL_PAINT_MS'), inp: fm('INTERACTION_TO_NEXT_PAINT'), cls: fm('CUMULATIVE_LAYOUT_SHIFT_SCORE', 100),
    } : null,
  };
}

function seo3HistRow_(d, sp) {
  const f = sp.field && sp.field.src === 'page' ? sp.field : null;
  return {
    d: d, s: sp.score,
    lcp: f && f.lcp ? f.lcp.v : sp.lab.lcp,
    inp: f && f.inp ? f.inp.v : null,
    cls: f && f.cls ? f.cls.v : sp.lab.cls,
    src: f ? 'page' : 'lab',
  };
}

/* ===================== Issues ===================== */

function seo3Dups_(checks, field) {
  const by = {};
  checks.forEach(function (c) {
    const v = c.parsed && c.parsed[field] ? String(c.parsed[field]).trim().toLowerCase() : '';
    if (v) (by[v] = by[v] || []).push(c.path);
  });
  return by;
}

function seo3Wording_(p, words) {
  const orig = [p.title, p.desc || '', p.text, p.alts].join(' · ');
  const low = orig.toLowerCase();
  const out = [];
  words.forEach(function (w) {
    const re = new RegExp('(^|[^a-z0-9])(' + seo3Esc_(w.word) + ')(?=$|[^a-z0-9])', 'g');
    let m, n = 0, snip = '';
    while ((m = re.exec(low)) && n < 100) {
      n++;
      if (!snip) {
        const at = m.index + m[1].length;
        snip = orig.slice(Math.max(0, at - 60), at + w.word.length + 60).trim();
      }
    }
    if (n) out.push({ word: w.word, why: w.why, count: n, snip: snip });
  });
  return out;
}

function seo3SpeedIssues_(sp, add) {
  if (!sp) return;
  const f = sp.field && sp.field.src === 'page' ? sp.field : null;   // whole-site data would repeat on every page
  if (f) {
    [
      ['lcp', 'Loads slowly for real visitors', function (v) { return 'LCP ' + (v / 1000).toFixed(1) + ' s (good is under 2.5 s)'; }],
      ['inp', 'Slow to respond to taps for real visitors', function (v) { return 'INP ' + Math.round(v) + ' ms (good is under 200 ms)'; }],
      ['cls', 'Content jumps around while loading', function (v) { return 'CLS ' + Number(v).toFixed(2) + ' (good is under 0.1)'; }],
    ].forEach(function (x) {
      const m = f[x[0]];
      if (!m || m.v == null) return;
      if (m.c === 'SLOW') add('speed', 'high', 'cwv_' + x[0], x[1], x[2](m.v));
      else if (m.c === 'AVERAGE') add('speed', 'medium', 'cwv_' + x[0], x[1], x[2](m.v));
    });
    return;
  }
  if (sp.score != null && sp.score < 50) add('speed', 'medium', 'score', 'Mobile speed score ' + sp.score + '/100', "Google's lab test (not enough real visits to this page for real-visitor data)");
  else if (sp.score != null && sp.score < 70) add('speed', 'low', 'score', 'Mobile speed score ' + sp.score + '/100', "Google's lab test");
}

function seo3Issues_(c, x) {
  const out = [];
  const add = function (group, sev, code, msg, detail, key) {
    out.push({ group: group, sev: sev, code: code, msg: msg, detail: String(detail || '').slice(0, 400), key: key || code });
  };

  if (c.error && !c.parsed) add('index', 'medium', 'fetch', "Couldn't check this page", c.error);
  else if (c.blocked) add('index', 'medium', 'blocked', "Couldn't check this page: the website answered " + c.status, 'The website may be blocking automated checks.');
  else if (c.status >= 400) add('index', 'high', 'status', 'The page returns error ' + c.status, '');
  if (c.redirect) add('index', 'medium', 'redirect', 'This key page redirects', 'It goes to ' + c.redirect);

  const p = c.parsed;
  if (p) {
    const self = c.finalUrl || c.url;
    const robots = (p.robots + ' ' + (c.xRobots || '')).toLowerCase();
    if (/noindex/.test(robots)) {
      add('index', 'high', 'noindex', 'Hidden from Google (noindex)', p.robots && /noindex/i.test(p.robots) ? 'Set in the robots meta tag.' : 'Set in the X-Robots-Tag header.');
    }
    if (!p.canonical) add('index', 'low', 'no_canonical', 'No canonical tag', '');
    else if (seo3Norm_(seo3Abs_(p.canonical, self)) !== seo3Norm_(self)) add('index', 'medium', 'canonical', 'Canonical points to another page', p.canonical);

    const others = function (map, v) { return (map[String(v).trim().toLowerCase()] || []).filter(function (q) { return q !== c.path; }); };
    if (!p.title) add('content', 'high', 'no_title', 'No page title', '');
    else {
      if (p.title.length > 60) add('content', 'low', 'title_long', 'Title is ' + p.title.length + ' characters (Google shows about 60)', p.title);
      else if (p.title.length < 20) add('content', 'low', 'title_short', 'Title is only ' + p.title.length + ' characters', p.title);
      const d = others(x.dupT, p.title);
      if (d.length) add('content', 'medium', 'dup_title', 'Same title as ' + d.length + ' other key page' + (d.length === 1 ? '' : 's'), d.join(', ') + ' · ' + p.title);
    }
    if (p.desc == null || !p.desc.trim()) add('content', 'medium', 'no_desc', 'No meta description', '');
    else {
      if (p.desc.length > 160) add('content', 'low', 'desc_long', 'Description is ' + p.desc.length + ' characters (Google shows about 155)', p.desc);
      else if (p.desc.length < 70) add('content', 'low', 'desc_short', 'Description is only ' + p.desc.length + ' characters', p.desc);
      const d = others(x.dupD, p.desc);
      if (d.length) add('content', 'medium', 'dup_desc', 'Same description as ' + d.length + ' other key page' + (d.length === 1 ? '' : 's'), d.join(', '));
    }
    if (!p.h1) add('content', 'medium', 'no_h1', 'No main heading (H1)', '');
    else if (p.h1 > 1) add('content', 'low', 'many_h1', p.h1 + ' main headings (H1)', 'The first is "' + p.h1Text + '"');
    if (p.noAlt) {
      add('images', 'low', 'alt', p.noAlt + ' of ' + p.imgs + ' image' + (p.imgs === 1 ? '' : 's') + ' have no alt text', p.noAltSrc.filter(Boolean).join(', '));
    }

    seo3Wording_(p, x.words).forEach(function (w) {
      add('wording', 'high', 'wording', 'Uses “' + w.word + '”' + (w.count > 1 ? ' (' + w.count + ' times)' : ''),
        (w.why ? w.why + '. ' : '') + '“…' + w.snip + '…”', 'word:' + w.word);
    });

    const broken = [], redir = [];
    Object.keys(x.links.from).forEach(function (u) {
      if (x.links.from[u].indexOf(c.path) === -1) return;
      const s = x.links.status[u];
      if (s === 404 || s === 410 || s === 500 || s === 502 || s === 504) broken.push([u, s]);
      else if (s >= 300 && s < 400) redir.push(u);
    });
    broken.slice(0, 20).forEach(function (b) {
      add('links', 'high', 'broken_link', 'Links to a page that ' + (b[1] >= 500 ? 'shows an error' : "doesn't exist") + ' (' + b[1] + ')',
        seo3Short_(b[0]), 'link:' + seo3Short_(b[0]));
    });
    if (redir.length) {
      add('links', 'low', 'redirect_links', redir.length + ' link' + (redir.length === 1 ? ' goes' : 's go') + ' through a redirect',
        redir.slice(0, 5).map(seo3Short_).join(', ') + (redir.length > 5 ? ' and ' + (redir.length - 5) + ' more' : ''));
    }
  }

  seo3SpeedIssues_(x.speed, add);
  return out;
}