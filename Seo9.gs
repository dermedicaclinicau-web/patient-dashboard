/**
 * Seo9.gs — Site health → Content. Every night:
 *  · Priority and cluster pages: main text, FAQs (section and FAQ schema), "medically reviewed by", last saved in WordPress,
 *    other pages linking in, and word count. When a page's text has changed, Claude Haiku proofreads it
 *    (spelling, grammar, Australian English) and checks it against the advertising rules (TGA, AHPRA).
 *  · The whole site, about 60 pages a night (oldest first): a fingerprint of each page's text, to find pages that say
 *    nearly the same thing.
 * Text repeated on many pages (menus, booking blocks, footers) is left out of both.
 * Writes seo_content/deep, seo_content/dups, seo_content/idx_<n> and seo_state/content.
 * Uses Seo.gs (seoOrigin_, seoFsCommit_, SEO_TZ_), Seo3.gs (seo3Fetch_, seo3Text_, seo3Abs_, seo3Short_), Seo7.gs (seo7ClaudeKey_,
 * seo7Json_) and Code.gs (getConfig_, fsGetDoc_, fsQuery_, fsPatch_).
 */

const SEO9_MODEL_ = 'claude-haiku-5-5';   // Script Property CLAUDE_FAST_MODEL overrides it
const SEO9_SITE_PER_NIGHT_ = 60;          // other pages fingerprinted each night
const SEO9_AI_PER_RUN_ = 30;              // pages proofread each night at most
const SEO9_MAX_ISSUES_ = 20;              // per page
const SEO9_CHUNK_ = 150;                  // pages per fingerprint document

// Accepted by the spelling check from the start (Settings → Brand and wording adds your own)
const SEO9_WORDS_ = ['dermedica', 'ultherapy', 'ulthera', 'cosmelan', 'dermamelan', 'hydrafacial', 'exilis', 'coolsculpting', 'coolsculpt',
  'trusculpt', 'pico', 'picosure', 'picoway', 'ipl', 'bbl', 'fraxel', 'profhilo', 'jessner', 'dermaplaning', 'dermaplane', 'microneedling',
  'melasma', 'rosacea', 'telangiectasia', 'hyperpigmentation', 'pigmentation', 'hifu', 'prp', 'skinpen', 'lumecca', 'morpheus8', 'sciton',
  'moxi', 'clearlift', 'obagi', 'skinceuticals', 'medik8', 'cosmedix', 'perth', 'subiaco', 'nedlands', 'claremont', 'cottesloe',
  'joondalup', 'fremantle', 'ahpra', 'tga'];

function runSeoContent() {
  const cache = CacheService.getScriptCache();
  if (cache.get('seo_content_run')) { console.log('Content checks are already running.'); return; }
  cache.put('seo_content_run', '1', 420);
  const t0 = Date.now(), deadline = t0 + 5 * 60000;
  const cfg = getConfig_();
  const origin = seoOrigin_();
  const today = Utilities.formatDate(new Date(), SEO_TZ_, 'yyyy-MM-dd');
  try {
    const set = fsGetDoc_(cfg, 'seo_settings/main') || {};

    // Priority and cluster pages
    const deepSet = {}, deepHash = {};
    seo9Deep_(set).forEach(function (p) { const k = seo9N_(p); deepSet[k] = p; deepHash[seo9H_(k)] = k; });

    // Every page on the site: WordPress's list, or else the pages Google shows
    let wpPages = [];
    try { wpPages = JSON.parse((fsGetDoc_(cfg, 'seo_settings/wp') || {}).pages || '[]'); } catch (e) { wpPages = []; }
    const wpMod = {};
    wpPages.forEach(function (p) { wpMod[seo9N_(p.path)] = p.mod || ''; });
    let sitePaths = wpPages.map(function (p) { return p.path; });
    if (!sitePaths.length) {
      const ov = fsGetDoc_(cfg, 'seo_state/overview');
      sitePaths = (ov && ov.build ? fsQuery_(cfg, 'seo_pages', 'build', 'EQUAL', ov.build, 5000) : [])
        .filter(function (p) { return p.m28 && Number(p.m28.impressions) > 0; }).map(function (p) { return p.path; });
    }
    const siteSet = {};
    sitePaths.forEach(function (p) { const k = seo9N_(p); if (k !== '/' && !deepSet[k]) siteSet[k] = seo9P_(p); });

    // What earlier nights found
    const st = fsGetDoc_(cfg, 'seo_state/content') || {};
    const idx = seo9LoadIndex_(cfg, Number(st.chunks || 0));
    Object.keys(idx).forEach(function (k) { if (!siteSet[k] && !deepSet[k]) delete idx[k]; });
    let prevDeep = {}, prevDups = [];
    try { prevDeep = JSON.parse((fsGetDoc_(cfg, 'seo_content/deep') || {}).json || '{}'); } catch (e) { prevDeep = {}; }
    try { prevDups = JSON.parse((fsGetDoc_(cfg, 'seo_content/dups') || {}).json || '[]'); } catch (e) { prevDups = []; }

    // Tonight: every priority and cluster page, and the other pages checked longest ago
    const others = Object.keys(siteSet)
      .sort(function (a, b) { return String((idx[a] || {}).at || '').localeCompare(String((idx[b] || {}).at || '')); })
      .slice(0, SEO9_SITE_PER_NIGHT_);
    const list = Object.keys(deepSet).map(function (k) { return [k, deepSet[k]]; })
      .concat(others.map(function (k) { return [k, siteSet[k]]; }));
    const res = seo3Fetch_(list.map(function (x) { return origin + x[1]; }), false);   // redirects aren't followed
    const read = {}, pathOf = {};
    list.forEach(function (x, i) {
      pathOf[x[0]] = x[1];
      const r = res[i];
      if (r && !r.error && r.code === 200) read[x[0]] = seo9Read_(r.text, origin + x[1], origin, deepHash);
      else if (r && !r.error && r.code >= 300 && r.code < 500) delete idx[x[0]];   // moved or gone: not compared any more
    });

    // Text that repeats on many pages isn't compared or proofread
    const keysRead = Object.keys(read);
    const freq = {};
    keysRead.forEach(function (k) {
      const seen = {};
      read[k].paras.forEach(function (t) { const h = seo9H_(seo9Norm_(t)); if (!seen[h]) { seen[h] = 1; freq[h] = (freq[h] || 0) + 1; } });
    });
    const minPages = Math.max(4, Math.ceil(keysRead.length * 0.2));
    const boiler = {};
    Object.keys(freq).forEach(function (h) { if (freq[h] >= minPages) boiler[h] = 1; });
    keysRead.forEach(function (k) {
      const pg = read[k];
      pg.paras = pg.paras.filter(function (t) { return !boiler[seo9H_(seo9Norm_(t))]; });
      pg.text = pg.paras.join('\n');
      pg.words = pg.text ? pg.text.split(/\s+/).length : 0;
      const fp = seo9Print_(pg.paras);
      idx[k] = { p: pathOf[k], at: today, w: pg.words, ph: fp.ph, mh: fp.mh, lk: pg.lk };
    });

    // Other pages linking to each priority and cluster page (from the pages checked so far)
    const inbound = {};
    Object.keys(idx).forEach(function (k) {
      (idx[k].lk || []).forEach(function (h) { const to = deepHash[h]; if (to && to !== k) inbound[to] = (inbound[to] || 0) + 1; });
    });

    // Priority and cluster pages, and which need proofreading (new text since last time)
    const words = seo9Accepted_(set);
    const key = seo7ClaudeKey_();
    const model = String(PropertiesService.getScriptProperties().getProperty('CLAUDE_FAST_MODEL') || '').trim() || SEO9_MODEL_;
    const deep = {}, queue = [];
    Object.keys(deepSet).forEach(function (k) {
      const pg = read[k], prev = prevDeep[k] || null;
      if (!pg) { if (prev) deep[k] = prev; return; }   // couldn't read it tonight: keep the last result
      const th = seo9H_(pg.text) + '.' + pg.words;
      deep[k] = {
        path: deepSet[k], title: pg.title, words: pg.words, faq: pg.faq, faqQs: pg.faqQs, faqSchema: pg.faqSchema,
        reviewed: pg.reviewed, mod: wpMod[k] || '', inbound: inbound[k] || 0, at: today, th: th,
        ai: prev && prev.ai ? prev.ai : null,   // kept until the new proofread is in
      };
      if (key && pg.words >= 50 && !(prev && prev.ai && prev.ai.th === th)) queue.push(k);
    });

    let aiDone = 0;
    for (let i = 0; i < queue.length && aiDone < SEO9_AI_PER_RUN_; i += 5) {
      if (Date.now() > deadline - 60000) break;
      const part = queue.slice(i, i + 5);
      let out = null;
      try { out = UrlFetchApp.fetchAll(part.map(function (k) { return seo9AiReq_(key, model, read[k], words); })); }
      catch (e) { console.warn('Proofreading batch failed: ' + e); break; }
      part.forEach(function (k, j) {
        const r = out[j];
        if (!r || r.getResponseCode() !== 200) {
          console.warn('Proofreading ' + deepSet[k] + ': ' + (r ? r.getResponseCode() + ' ' + r.getContentText().slice(0, 150) : 'no answer'));
          return;
        }
        try {
          const jj = JSON.parse(r.getContentText());
          const txt = (jj.content || []).filter(function (x) { return x.type === 'text'; }).map(function (x) { return x.text; }).join('');
          deep[k].ai = { th: deep[k].th, at: today, model: model, issues: seo9Issues_(seo7Json_(txt), read[k], words) };
          aiDone++;
        } catch (e) { console.warn('Proofreading ' + deepSet[k] + ': unreadable answer'); }
      });
    }

    const dups = seo9Dups_(idx, read, prevDups);

    // Save
    const writes = [];
    const allKeys = Object.keys(idx).sort();
    const chunks = Math.ceil(allKeys.length / SEO9_CHUNK_);
    for (let n = 0; n < Math.max(chunks, Number(st.chunks || 0)); n++) {
      const part = {};
      allKeys.slice(n * SEO9_CHUNK_, (n + 1) * SEO9_CHUNK_).forEach(function (k) { part[k] = idx[k]; });
      writes.push({ path: 'seo_content/idx_' + n, data: { json: JSON.stringify(part), at: new Date() } });
    }
    let deepJson = JSON.stringify(deep);
    if (deepJson.length > 900000) {   // keep it under Firestore's 1 MB
      Object.keys(deep).forEach(function (k) { if (deep[k].ai) deep[k].ai.issues = deep[k].ai.issues.slice(0, 8); });
      deepJson = JSON.stringify(deep);
    }
    writes.push({ path: 'seo_content/deep', data: { json: deepJson, at: new Date() } });
    writes.push({ path: 'seo_content/dups', data: { json: JSON.stringify(dups), at: new Date() } });
    writes.push({ path: 'seo_state/content', data: {
      ok: true, error: '', at: new Date(), ms: Date.now() - t0, chunks: chunks,
      deepRead: Object.keys(deepSet).filter(function (k) { return read[k]; }).length, deepTotal: Object.keys(deepSet).length,
      siteIndexed: allKeys.length, siteTotal: Object.keys(siteSet).length + Object.keys(deepSet).length,
      aiDone: aiDone, aiLeft: Math.max(0, queue.length - aiDone), boiler: Object.keys(boiler).length, dups: dups.length,
    } });
    seoFsCommit_(writes);
    console.log('Content: ' + keysRead.length + ' pages read, ' + aiDone + ' proofread (' + Math.max(0, queue.length - aiDone) +
      ' waiting), ' + allKeys.length + ' of ' + (Object.keys(siteSet).length + Object.keys(deepSet).length) + ' pages compared, ' +
      dups.length + ' duplicate pairs · ' + Math.round((Date.now() - t0) / 1000) + ' s');
  } catch (e) {
    console.error('Content checks failed: ' + (e.stack || e));
    try { fsPatch_(cfg, 'seo_state/content', { ok: false, error: String(e.message || e).slice(0, 500), at: new Date().toISOString() }); }
    catch (e2) { console.warn('Could not record the failure: ' + e2); }
    throw e;
  } finally {
    cache.remove('seo_content_run');
  }
}

/** Run once: every night at about 1am Perth */
function installSeoContentTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoContent'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoContent').timeBased().everyDays(1).atHour(1).inTimezone(SEO_TZ_).create();
  console.log('runSeoContent scheduled daily ~1am Perth');
}

/** Run from the editor: reads the first priority page, proofreads it and logs what it found (saves nothing) */
function testSeoContent() {
  const cfg = getConfig_(), origin = seoOrigin_();
  const set = fsGetDoc_(cfg, 'seo_settings/main') || {};
  const path = seo9Deep_(set)[0];
  if (!path) { console.log('No priority pages.'); return; }
  const r = seo3Fetch_([origin + path], false)[0];
  if (!r || r.error || r.code !== 200) { console.log('Could not read ' + path + ': ' + (r && (r.error || r.code))); return; }
  const pg = seo9Read_(r.text, origin + path, origin, {});
  console.log(path + ': ' + pg.words + ' words · FAQ section: ' + pg.faq + ' · FAQ schema: ' + pg.faqSchema + ' · reviewed line: ' + pg.reviewed);
  console.log('First paragraphs: ' + pg.paras.slice(0, 3).join(' | ').slice(0, 400));
  const key = seo7ClaudeKey_();
  if (!key) { console.log('No Claude key, so no proofreading.'); return; }
  const model = String(PropertiesService.getScriptProperties().getProperty('CLAUDE_FAST_MODEL') || '').trim() || SEO9_MODEL_;
  const resp = UrlFetchApp.fetch(seo9AiReq_(key, model, pg, seo9Accepted_(set)).url, seo9AiReq_(key, model, pg, seo9Accepted_(set)));
  const jj = JSON.parse(resp.getContentText());
  const txt = (jj.content || []).filter(function (x) { return x.type === 'text'; }).map(function (x) { return x.text; }).join('');
  console.log(JSON.stringify(seo9Issues_(seo7Json_(txt), pg, seo9Accepted_(set)), null, 2));
}

/* ===================== Reading a page ===================== */

function seo9Deep_(set) {
  const out = {};
  const add = function (p) { if (p) out[seo9N_(p)] = seo9P_(p); };
  (Array.isArray(set.keyPages) ? set.keyPages : []).forEach(add);
  (Array.isArray(set.clusters) ? set.clusters : []).forEach(function (cl) {
    if (!cl) return;
    add(cl.main);
    (cl.pages || []).forEach(function (p) { if (p) add(p.path); });
  });
  return Object.keys(out).slice(0, 120).map(function (k) { return out[k]; });
}

function seo9Read_(html, url, origin, deepHash) {
  let src = String(html || '').replace(/<!--[\s\S]*?-->/g, ' ');
  const faqSchema = /FAQPage/i.test(src);
  const titleM = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(src);

  // Which priority and cluster pages it links to (anywhere on the page, menus included)
  const host = origin.replace(/^https?:\/\//i, '').toLowerCase().replace(/^www\./, '');
  const lk = {};
  (src.match(/<a\b[^>]*\bhref\s*=\s*["'][^"']+["']/gi) || []).forEach(function (a) {
    const m = /\bhref\s*=\s*["']([^"']+)["']/i.exec(a);
    const abs = m ? seo3Abs_(m[1], url) : '';
    const hm = abs ? /^https?:\/\/([^\/?#]+)/i.exec(abs) : null;
    if (!hm || hm[1].toLowerCase().replace(/^www\./, '') !== host) return;
    const h = seo9H_(seo9N_(seo3Short_(abs.split('#')[0].split('?')[0])));
    if (deepHash[h]) lk[h] = 1;
  });

  // The page's own content: <main> or <article>, without header, footer, menus, sidebars, forms and scripts
  src = src.replace(/<(script|style|noscript|svg|template|iframe|form)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  let main = (/<main\b[\s\S]*?<\/main\s*>/i.exec(src) || /<article\b[\s\S]*?<\/article\s*>/i.exec(src) ||
    /<body[\s>][\s\S]*$/i.exec(src) || [src])[0];
  main = main.replace(/<(header|footer|nav|aside)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const heads = (main.match(/<h[1-6]\b[\s\S]*?<\/h[1-6]\s*>/gi) || []).map(function (h) { return seo3Text_(h); });

  // Paragraphs: the text of each block
  const paras = [], seen = {};
  main.split(/<\/?(?:p|li|h[1-6]|td|th|blockquote|dd|dt|div|section)\b[^>]*>/i).forEach(function (chunk) {
    const t = seo3Text_(chunk);
    if (t.split(' ').length < 6 || seen[t]) return;
    seen[t] = 1;
    paras.push(t);
  });
  const text = paras.join('\n');
  const qHeads = heads.filter(function (h) { return /\?\s*$/.test(h); }).length;
  return {
    title: titleM ? seo3Text_(titleM[1]) : '', paras: paras, text: text, words: text ? text.split(/\s+/).length : 0,
    faq: heads.some(function (h) { return /\bfaqs?\b|frequently asked/i.test(h); }) || qHeads >= 2,
    faqQs: qHeads, faqSchema: faqSchema,
    reviewed: /\b(medically reviewed|clinically reviewed|reviewed by|written by)\b/i.test(seo3Text_(src)),
    lk: Object.keys(lk),
  };
}

/* ===================== Fingerprints and duplicates ===================== */

const SEO9_SEEDS_ = (function () {
  const s = [];
  let x = 0x2545f491;
  for (let i = 0; i < 32; i++) { x = Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) >>> 0; s.push(x || 1); }
  return s;
})();

// Paragraph hashes, and a MinHash of the 5-word phrases (32 numbers), so pages can be compared without storing their text
function seo9Print_(paras) {
  const ph = [], sh = {};
  paras.forEach(function (t) {
    const n = seo9Norm_(t);
    ph.push(seo9H_(n));
    const w = n.split(' ');
    for (let i = 0; i + 5 <= w.length; i++) sh[seo9Fnv_(w.slice(i, i + 5).join(' '))] = 1;
  });
  const keys = Object.keys(sh).map(Number);
  if (keys.length < 10) return { ph: ph.slice(0, 120), mh: '' };
  const mh = SEO9_SEEDS_.map(function (seed) {
    let min = 0xffffffff;
    for (let i = 0; i < keys.length; i++) {
      let v = Math.imul(keys[i] ^ seed, 0x9e3779b1);
      v ^= v >>> 16;
      v = Math.imul(v, 0x85ebca6b) >>> 0;
      if (v < min) min = v;
    }
    return min.toString(36);
  });
  return { ph: ph.slice(0, 120), mh: mh.join(',') };
}

function seo9Dups_(idx, read, prevDups) {
  const prevSample = {};
  (prevDups || []).forEach(function (d) { if (d.sample) prevSample[seo9N_(d.a) + '|' + seo9N_(d.b)] = d.sample; });
  const ks = Object.keys(idx).filter(function (k) { return idx[k].mh; });
  const M = {}, P = {};
  ks.forEach(function (k) {
    M[k] = String(idx[k].mh).split(',');
    const s = {};
    (idx[k].ph || []).forEach(function (h) { s[h] = 1; });
    P[k] = s;
  });
  const out = [];
  for (let a = 0; a < ks.length; a++) {
    for (let b = a + 1; b < ks.length; b++) {
      const A = M[ks[a]], B = M[ks[b]];
      if (A.length !== B.length) continue;
      let eq = 0;
      for (let i = 0; i < A.length; i++) if (A[i] === B[i]) eq++;
      const sim = eq / A.length;
      if (sim < 0.4) continue;
      let shared = 0, first = '';
      for (const h in P[ks[a]]) if (P[ks[b]][h]) { shared++; if (!first) first = h; }
      if (!((sim >= 0.5 && shared >= 3) || shared >= 8)) continue;
      let sample = '';
      [read[ks[a]], read[ks[b]]].forEach(function (pg) {
        if (sample || !pg) return;
        const hit = pg.paras.filter(function (t) { return seo9H_(seo9Norm_(t)) === first; })[0];
        if (hit) sample = hit.slice(0, 220);
      });
      const pa = idx[ks[a]].p, pb = idx[ks[b]].p;
      out.push({ a: pa, b: pb, sim: Math.round(sim * 100), shared: shared,
        sample: sample || prevSample[seo9N_(pa) + '|' + seo9N_(pb)] || prevSample[seo9N_(pb) + '|' + seo9N_(pa)] || '' });
    }
  }
  return out.sort(function (x, y) { return y.sim - x.sim || y.shared - x.shared; }).slice(0, 50);
}

function seo9LoadIndex_(cfg, chunks) {
  const idx = {};
  for (let n = 0; n < chunks; n++) {
    try {
      const d = fsGetDoc_(cfg, 'seo_content/idx_' + n);
      const part = d && d.json ? JSON.parse(d.json) : {};
      Object.keys(part).forEach(function (k) { idx[k] = part[k]; });
    } catch (e) { console.warn('Fingerprints ' + n + ' not read: ' + e); }
  }
  return idx;
}

/* ===================== Proofreading (Claude Haiku) ===================== */

function seo9Accepted_(set) {
  const w = {};
  const add = function (x) { const s = String(x || '').trim().toLowerCase(); if (s) w[s] = 1; };
  SEO9_WORDS_.forEach(add);
  (Array.isArray(set.spellWords) ? set.spellWords : []).forEach(add);
  (Array.isArray(set.brand) ? set.brand : []).forEach(add);
  (Array.isArray(set.topics) ? set.topics : []).forEach(function (t) { ((t && t.words) || []).forEach(add); });
  return Object.keys(w).slice(0, 400);
}

function seo9System_() {
  return [
    'You proofread web pages for Dermedica, a cosmetic skin clinic in Perth, Western Australia. Check the page text for:',
    '1. spelling: misspelt words, in Australian English. Do not flag names of people, brands, products, treatments, medicines or places, or anything in "acceptedWords".',
    '2. grammar: clear mistakes only (agreement, missing or doubled words, the wrong word). Not style preferences.',
    '3. au: American spellings that should be Australian (personalized → personalised, color → colour, center → centre).',
    '4. compliance: Australian health advertising rules (AHPRA and TGA): testimonials or patient reviews about results;',
    '   promises or guarantees of results; claims like best, leading, number one or most advanced that cannot be proven;',
    '   downplaying risk, pain or downtime (painless, no downtime, completely safe); prescription medicine names (such as Botox or Dysport)',
    '   used to promote; offers, discounts or gifts without clear terms, or pressure to book quickly; comparisons with other clinics;',
    '   before-and-after claims.',
    'For each problem, copy "text" EXACTLY from the page: the shortest span that shows it (a word or a few words, at most 12 words).',
    '"fix" is the corrected text, or for compliance a compliant rewrite of that span. "why" is a short reason (for compliance, name the rule).',
    'Only report real problems. If there are none, return {"issues":[]}.',
    'Reply with JSON only: {"issues":[{"type":"spelling|grammar|au|compliance","text":"...","fix":"...","why":"..."}]}',
  ].join('\n');
}

function seo9AiReq_(key, model, pg, words) {
  return {
    url: 'https://api.anthropic.com/v1/messages', method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: model, max_tokens: 2500, system: seo9System_(),
      messages: [{ role: 'user', content: JSON.stringify({ title: pg.title, acceptedWords: words, text: pg.text.slice(0, 12000) }) }],
    }),
  };
}

// Keeps only problems whose words are really on the page, with a little of the sentence around them
function seo9Issues_(out, pg, words) {
  const okW = {};
  words.forEach(function (w) { okW[w] = 1; });
  const low = pg.text.toLowerCase();
  const seen = {}, res = [];
  (out && Array.isArray(out.issues) ? out.issues : []).forEach(function (i) {
    if (res.length >= SEO9_MAX_ISSUES_ || !i) return;
    const type = ['spelling', 'grammar', 'au', 'compliance'].indexOf(i.type) !== -1 ? i.type : '';
    const text = String(i.text || '').replace(/\s+/g, ' ').trim();
    if (!type || text.length < 2 || text.length > 140) return;
    const at = low.indexOf(text.toLowerCase());
    if (at < 0) return;   // not on the page
    if ((type === 'spelling' || type === 'au') && okW[text.toLowerCase()]) return;
    const fix = String(i.fix || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (type !== 'compliance' && (!fix || fix.toLowerCase() === text.toLowerCase())) return;
    const k = type + '|' + text.toLowerCase();
    if (seen[k]) return;
    seen[k] = 1;
    const s = Math.max(0, at - 70), e = Math.min(pg.text.length, at + text.length + 70);
    const ctx = (s > 0 ? '…' : '') + pg.text.slice(s, e).replace(/\n/g, ' ') + (e < pg.text.length ? '…' : '');
    res.push({ type: type, text: pg.text.slice(at, at + text.length), fix: fix, why: String(i.why || '').slice(0, 200), ctx: ctx,
      ph: seo9Phrase_(pg.text, at, text.length) });
  });
  return res;
}

// A phrase long enough for the nightly website check to find just this place (a few words either side)
function seo9Phrase_(t, at, len) {
  const text = t.slice(at, at + len);
  if (text.split(' ').length >= 3) return text;
  const left = t.slice(0, at).split('\n').pop().split(' ').slice(-3).join(' ');
  const right = t.slice(at + len).split('\n')[0].split(' ').slice(0, 3).join(' ');
  return (left + text + right).replace(/\s+/g, ' ').trim().slice(0, 140);
}

/* ===================== Small helpers ===================== */

function seo9P_(p) {
  p = String(p || '').trim().replace(/^https?:\/\/[^\/]+/i, '').split('#')[0].split('?')[0];
  return p.charAt(0) === '/' ? p : '/' + p;
}
function seo9N_(p) { return seo9P_(p).toLowerCase().replace(/\/+$/, '') || '/'; }
function seo9Norm_(t) { return String(t || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function seo9Fnv_(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
function seo9H_(s) { return ('0000000' + seo9Fnv_(String(s)).toString(16)).slice(-8); }