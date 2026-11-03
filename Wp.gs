/**
 * Wp.gs — SEO → Website: pages and blog posts in WordPress, through the Dermedica Portal Connector plugin.
 * Every request is signed with WP_PORTAL_KEY (the key in WordPress → Settings → Dermedica Portal), so no WordPress
 * password is stored or sent, and the key never reaches the browser.
 * Script Properties: WP_URL (e.g. https://dermedica.com.au), WP_PORTAL_KEY.
 * Permissions: menu.seo to view; seo.pages to edit titles, SEO and drafts; seo.publish to publish, remove,
 * change addresses and hide pages from Google.
 */

const WP_NS_ = '/dermedica-portal/v1';
const WP_LIST_CACHE_ = 'wp_list_v1';

function wpHex_(bytes) { return bytes.map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }

// One signed request to the plugin. Throws with WordPress's own message when it fails.
function wpCall_(method, route, body, query) {
  const p = PropertiesService.getScriptProperties();
  const base = String(p.getProperty('WP_URL') || '').trim().replace(/\/+$/, '');
  const key = String(p.getProperty('WP_PORTAL_KEY') || '').trim();
  if (!base || !key) throw new Error('Add WP_URL and WP_PORTAL_KEY in Script Properties.');
  const path = WP_NS_ + route;
  const payload = body ? JSON.stringify(body) : '';
  const t = String(Math.floor(Date.now() / 1000));
  const bodyHash = wpHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, payload, Utilities.Charset.UTF_8));
  const sig = wpHex_(Utilities.computeHmacSha256Signature(t + '\n' + method.toUpperCase() + '\n' + path + '\n' + bodyHash, key, Utilities.Charset.UTF_8));
  const qs = query ? Object.keys(query).filter(function (k) { return query[k] !== '' && query[k] != null; })
    .map(function (k) { return '&' + encodeURIComponent(k) + '=' + encodeURIComponent(query[k]); }).join('') : '';
  const opt = { method: method.toLowerCase(), muteHttpExceptions: true, followRedirects: false,
    headers: { 'X-DPC-Time': t, 'X-DPC-Sig': sig } };
  if (payload) { opt.payload = payload; opt.contentType = 'application/json'; }
  const res = UrlFetchApp.fetch(base + '/?rest_route=' + encodeURIComponent(path) + qs, opt);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 300 && code < 400) throw new Error('The site redirected the request (' + code + '). Check WP_URL is the exact address, with https and the right www.');
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (code !== 200) {
    const msg = json && json.message ? json.message : text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (code === 404 && /rest_no_route|No route/i.test(text)) throw new Error('The Dermedica Portal Connector plugin is not active on the site.');
    throw new Error('WordPress ' + code + ': ' + msg);
  }
  if (!json) throw new Error('WordPress did not answer as expected. A security plugin or firewall may be blocking it.');
  return json;
}

function handleWordpress_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'menu.seo')) return { ok: false, error: 'FORBIDDEN' };
  const op = String(body.op || '');
  try {
    if (op === 'ping') return Object.assign({ ok: true }, wpCall_('GET', '/ping'));
    if (op === 'info') return Object.assign({ ok: true }, wpInfo_());
    if (op === 'list') return wpList_(body);
    if (op === 'get') {
      const id = Math.floor(Number(body.id));
      if (!(id > 0)) return { ok: false, error: 'BAD_REQUEST' };
      return { ok: true, item: wpCall_('GET', '/item/' + id).item };
    }
    if (op === 'save') return wpSave_(body, session);
    if (op === 'suggest') return wpSuggest_(body, session);
    if (op === 'create') return wpCreate_(body, session);
    if (op === 'media') return wpMedia_(body, session);
    if (op === 'terms') return wpTerms_();
    if (op === 'check') return wpCheck_(body, session);
  } catch (err) {
    console.error('WordPress ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: true, problem: String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

// Every page and post, remembered 5 minutes (Refresh reads it again)
function wpList_(body) {
  if (body.fresh !== true) {
    const hit = repCacheGet_(WP_LIST_CACHE_);
    if (hit) return Object.assign({ ok: true, cached: true }, hit);
  }
  const r = wpCall_('GET', '/items');
  const out = { items: r.items || [], at: new Date().toISOString() };
  repCachePut_(WP_LIST_CACHE_, out, 300);
  return Object.assign({ ok: true }, out);
}

// Saves a page or post. seo.pages: titles, SEO, words of drafts, categories, tags, images, drafts and "ready for review".
// seo.publish: publishing, scheduling, unpublishing, the words of live posts, addresses of live pages, hiding from Google.
// Publishing a post, or changing the words of a live one, needs a clinician's name (reviewedBy).
function wpSave_(body, session) {
  const id = Math.floor(Number(body.id));
  if (!(id > 0)) return { ok: false, error: 'BAD_REQUEST' };
  if (!can_(session, 'seo.pages')) return { ok: false, error: 'FORBIDDEN' };
  const pub = can_(session, 'seo.publish');
  const f = body.fields || {};
  const one = function (v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); };
  const problem = function (m) { return { ok: true, problem: m }; };
  const reviewedBy = one(f.reviewedBy, 80);
  let cur = null;
  const getCur = function () { return cur || (cur = wpCall_('GET', '/item/' + id).item); };
  const live = function (s) { return s === 'publish' || s === 'future' || s === 'private'; };
  const out = {};

  if ('title' in f) {
    out.title = one(f.title, 200);
    if (!out.title) return problem('The title can\'t be empty.');
  }
  if ('excerpt' in f) out.excerpt = one(f.excerpt, 600);
  if ('content' in f) {
    const html = String(f.content || '');
    if (html.length > 300000) return problem('The post is too long to save from the portal.');
    const c = getCur();
    if (c.elementor) return problem('This is built with Elementor. Edit its words in Elementor.');
    if (live(c.status) && !pub) return problem('Changing the words of a live post needs "Website: publish and remove".');
    out.content = html;
  }
  if ('categories' in f) out.categories = (Array.isArray(f.categories) ? f.categories : []).map(Number).filter(function (n) { return n > 0; }).slice(0, 10);
  if ('tags' in f) out.tags = (Array.isArray(f.tags) ? f.tags : []).map(function (t) { return one(t, 60); }).filter(Boolean).slice(0, 20);
  if ('featured' in f) out.featured = Math.max(0, Math.floor(Number(f.featured) || 0));

  const seo = {};
  if (f.seo && 'title' in f.seo) seo.title = one(f.seo.title, 200);
  if (f.seo && 'description' in f.seo) seo.description = one(f.seo.description, 320);
  if (f.seo && 'focus' in f.seo) seo.focus = one(f.seo.focus, 120);
  if (f.seo && 'noindex' in f.seo) {
    if (!pub) return problem('Hiding a page from Google needs "Website: publish and remove".');
    seo.noindex = f.seo.noindex === true;
  }
  if (Object.keys(seo).length) out.seo = seo;

  if ('slug' in f) {
    const slug = String(f.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 190);
    if (!slug) return problem('The address can\'t be empty.');
    const c = getCur();
    if (c.slug !== slug) {
      if (c.status === 'publish') {
        if (!pub) return problem('Changing a live page\'s address needs "Website: publish and remove".');
        if (!wpInfo_().redirection) return problem('Turn on a redirect plugin before changing a published page\'s address, so the old address doesn\'t become a broken link.');
        out.redirectOld = true;   // the old address sends people to the new one
      }
      out.slug = slug;
    }
  }

  if ('status' in f) {
    const st = String(f.status || '');
    if (['draft', 'pending', 'publish', 'future', 'private'].indexOf(st) === -1) return { ok: false, error: 'BAD_REQUEST' };
    const c = getCur();
    if (st !== c.status) {
      if ((live(st) || live(c.status)) && !pub) return problem('Publishing, scheduling and unpublishing need "Website: publish and remove".');
      if (st === 'future') {
        const d = String(f.date || '');
        const ms = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(d) ? Utilities.parseDate(d, 'Australia/Perth', 'yyyy-MM-dd HH:mm').getTime() : 0;
        if (!ms || ms < Date.now() + 5 * 60000) return problem('Choose a time at least 5 minutes from now.');
        if (ms > Date.now() + 365 * 864e5) return problem('Choose a time in the next 12 months.');
        out.date = d + ':00';
      }
      if ((st === 'publish' || st === 'future') && c.type === 'post' && !reviewedBy) {
        return problem('Tick that a clinician has checked the medical content, and choose who, before publishing.');
      }
      out.status = st;
    }
  }
  if (out.content && live(getCur().status) && getCur().type === 'post' && !out.status && !reviewedBy) {
    return problem('The words of a live post changed: tick that a clinician has checked them, and choose who.');
  }
  if (!Object.keys(out).length) return { ok: true, item: getCur(), unchanged: true };

  const r = wpCall_('POST', '/item/' + id, out);
  try { wpLogChange_(r.before, r.item, out, r.redirect, session, reviewedBy); } catch (e) { console.warn('Saved, but the Change log entry failed: ' + e); }
  CacheService.getScriptCache().remove(WP_LIST_CACHE_);
  console.log('WordPress ' + id + ' saved by ' + session.name + (out.status ? ' (' + out.status + ')' : ''));
  return { ok: true, item: r.item, redirect: r.redirect || null };
}

// Changes to live pages and posts go in SEO → Change log (drafts don't), so their effect shows on the Overview chart
function wpLogChange_(before, after, sent, redirect, session, reviewedBy) {
  const isLive = after.status === 'publish' || after.status === 'future';
  const wasLive = before.status === 'publish';
  if (!isLive && !wasLive) return;
  const seoOf = function (x) { const s = (x && x.seo) || {}; return s.aioseo || s.yoast || {}; };
  const b = seoOf(before), a = seoOf(after);
  const parts = [];
  let type = 'Title / meta';
  if (sent.status && before.status !== after.status) {
    type = 'Content';
    parts.push(after.status === 'publish' ? (after.type === 'post' ? 'Published the blog post' : 'Published the page')
      : after.status === 'future' ? 'Scheduled for ' + String(after.date || '').slice(0, 16)
      : after.status === 'private' ? 'Made private' : 'Unpublished (back to a draft)');
  }
  if ('content' in sent && wasLive && before.content !== after.content) { type = 'Content'; parts.push('Updated the words'); }
  if ('title' in sent && before.title !== after.title) parts.push('Title: "' + before.title + '" → "' + after.title + '"');
  if (sent.seo && 'title' in sent.seo && b.title !== a.title) parts.push('SEO title: "' + (b.title || '(default)') + '" → "' + (a.title || '(default)') + '"');
  if (sent.seo && 'description' in sent.seo && b.description !== a.description) parts.push('Description changed');
  if (sent.seo && 'focus' in sent.seo && b.focus !== a.focus) parts.push('Focus keyphrase: "' + (b.focus || '') + '" → "' + (a.focus || '') + '"');
  if (sent.seo && 'noindex' in sent.seo && b.noindex !== a.noindex) parts.push(a.noindex ? 'Hidden from Google' : 'Shown in Google again');
  if ('slug' in sent && before.path !== after.path) {
    type = 'Technical';
    parts.push('Address: ' + before.path + ' → ' + after.path + (redirect && redirect.ok ? ' (old address redirects)' : redirect ? ' (redirect NOT made: ' + redirect.why + ')' : ''));
  }
  if (!parts.length) return;
  if (reviewedBy && type === 'Content') parts.push('Medical content checked by ' + reviewedBy);
  const cfg = getConfig_();
  commitWrites_(cfg, [updateWrite_(cfg, 'seo_log/wp_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
    date: Utilities.formatDate(new Date(), REC_TZ_, 'yyyy-MM-dd'), type: type, url: String(after.path || before.path || ''),
    title: (after.title + ': ' + parts[0]).slice(0, 200), note: parts.join('\n').slice(0, 1000),
    by: String(session.uid || ''), byName: String(session.name || ''), at: new Date(), source: 'website', wpId: Number(after.id || 0),
  })]);
}

/** Run from the editor: checks the connection and shows what it found (changes nothing) */
function wpTest() {
  const ping = wpCall_('GET', '/ping');
  console.log('Connected to "' + ping.site + '" (WordPress ' + ping.wp + '), changes made as ' + ping.user);
  console.log('Yoast: ' + ping.yoast + ' · All in One SEO: ' + ping.aioseo + ' · Elementor: ' + ping.elementor + ' · Redirection: ' + ping.redirection);
  console.log('Clock difference: ' + Math.abs(ping.time - Math.floor(Date.now() / 1000)) + ' s');
  const items = wpCall_('GET', '/items').items || [];
  const pages = items.filter(function (x) { return x.type === 'page'; });
  console.log(items.length + ' pages and posts (' + pages.length + ' pages, ' + (items.length - pages.length) + ' posts, ' +
    items.filter(function (x) { return x.elementor; }).length + ' built with Elementor)');
  const one = pages.filter(function (x) { return x.status === 'publish'; })[0];
  if (one) console.log('Example: ' + one.title + ' ' + one.path + '\n' + JSON.stringify(one.seo, null, 2));
}
// The plugins on the site (remembered 10 minutes): the tab uses it to know whether redirects work
function wpInfo_() {
  const hit = repCacheGet_('wp_info_v1');
  if (hit) return hit;
  const p = wpCall_('GET', '/ping');
  const out = { redirection: p.redirection === true, aioseo: p.aioseo === true, yoast: p.yoast === true, elementor: p.elementor === true };
  repCachePut_('wp_info_v1', out, 600);
  return out;
}

/* ===================== Fix it: suggested SEO titles and descriptions ===================== */
// Claude writes options from the page's own text and the searches Google shows it for (Search Console, last 90 days).
// Every option is checked here against the advertising rules and the clinic's own words to avoid.

const WP_SUGGEST_PROMPT_ = [
  'You write Google search titles and meta descriptions for Dermedica, a doctor-led cosmetic and skin clinic in Perth,',
  'Western Australia. Write 3 SEO titles and 3 meta descriptions for the page you are given.',
  '',
  'TITLES',
  '- 50 to 60 characters, ending with " - Dermedica". Drop that ending only if the title cannot fit otherwise.',
  '- Lead with what the page is about, using the words people actually search for (searches), naturally.',
  '- Include "Perth" when the page is about a treatment, a concern or the clinic.',
  '- Each option takes a different angle: the concern, the treatment, or the question people ask.',
  '',
  'DESCRIPTIONS',
  '- 140 to 158 characters. One or two plain sentences.',
  '- Say what the page covers and who it helps. Use the focus keyphrase or the top search once, naturally.',
  '- End with a gentle next step, such as "Book a consultation." or "Learn about your options."',
  '',
  'RULES: Australian advertising rules for health services (AHPRA and TGA). Never break these.',
  '- No prescription medicine names or brands (for example Botox, Dysport, Xeomin, Letybo). Say "anti-wrinkle injections".',
  '- No superlatives or claims that cannot be proven: best, leading, top, number one, #1, guaranteed, permanent,',
  '  painless, pain-free, risk-free, safe, miracle, cure, instant results.',
  '- No testimonials or reviews, no before-and-after promises, no promises about how long results last.',
  '- No pressure or inducements: no "limited time", "cheap", discounts or free gifts.',
  '- Nothing the page text does not support: no made-up prices, numbers, results or years of experience.',
  '- Australian English. No emoji. No quotation marks around the text. Not in capitals.',
  '',
  'MUST USE AND KEEP OUT',
  '- If must_use is given, every option must contain those words. In titles, start with them when it reads naturally.',
  '- If keep_out_of_the_title is given, no title may contain those words: another page is the main one for that search.',
  '',
  'why: one short sentence (under 15 words) saying what this option does differently.',
].join('\n');

const WP_SUGGEST_SCHEMA_ = (function () {
  const opt = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'why'],
    properties: { text: { type: 'string' }, why: { type: 'string' } } } };
  return { type: 'object', additionalProperties: false, required: ['titles', 'descriptions'],
    properties: { titles: opt, descriptions: opt } };
})();

// Checked on every suggestion: [pattern, what it is]
const WP_FLAG_RULES_ = [
  [/\b(botox|dysport|xeomin|letybo|relatox|botulinum)\b/i, 'Names a prescription medicine'],
  [/\b(best|leading|top-rated|number one|no\.?\s?1)\b|#1\b/i, 'A superlative'],
  [/\bguarantee[ds]?\b/i, 'A guarantee'],
  [/\b(permanent(ly)?|painless|pain-free|risk-free|miracle|cure[sd]?|instant results?)\b/i, 'A claim that may not be allowed'],
  [/\b(cheap|discount(ed)?|limited time|free gift)\b/i, 'An inducement'],
];

function wpSuggest_(body, session) {
  if (!can_(session, 'seo.pages')) return { ok: false, error: 'FORBIDDEN' };
  const id = Math.floor(Number(body.id));
  if (!(id > 0)) return { ok: false, error: 'BAD_REQUEST' };
  const cache = CacheService.getScriptCache();
  const rk = 'ws_sug_' + session.uid;
  const used = Number(cache.get(rk) || 0);
  if (used >= 40) return { ok: true, problem: 'You\'ve asked for a lot of suggestions in the last hour. Try again a bit later.' };
  cache.put(rk, String(used + 1), 3600);

  const it = wpCall_('GET', '/item/' + id).item;
  const page = wpPageText_(it);
  let searches = [];
  let searchNote = '';
  try { searches = wpSearches_(it.link); }
  catch (e) {
    console.warn('Search Console not read for ' + it.link + ': ' + e);
    searchNote = 'Google\'s searches for this page couldn\'t be read, so these are based on the page text only.';
  }
  const avoid = wpAvoidWords_();
  const s = (it.seo && (it.seo.aioseo || it.seo.yoast)) || {};
  const live = (it.seo && it.seo.live) || {};
  const fix = ['title', 'desc'].indexOf(String(body.fix)) !== -1 ? String(body.fix) : 'both';

  const input = {
    page_title: it.title, type: it.type === 'post' ? 'blog post' : 'page', address: it.path,
    focus_keyphrase: s.focus || '', current_seo_title: live.title || s.title || '', current_description: s.description || '',
    what_to_fix: fix === 'title' ? 'The SEO title' : fix === 'desc' ? 'The description' : 'The SEO title and the description',
    headings: page.h1.concat(page.h2), page_text: page.body,
    searches: searches.slice(0, 15).map(function (q) {
      return { search: q.q, impressions: q.impressions, clicks: q.clicks, position: q.position };
    }),
  };
  // From a task step: words every option must use, or ("!…") words to keep out of the title
  const target = String(body.target || '').replace(/\s+/g, ' ').trim().slice(0, 121);
  if (target.charAt(0) === '!') { if (target.length > 1) input.keep_out_of_the_title = target.slice(1); }
  else if (target) input.must_use = target;
  const out = wpClaude_(WP_SUGGEST_PROMPT_ + (avoid.length ? '\n\nTHE CLINIC\'S OWN WORDS TO AVOID: ' + avoid.join(', ') : ''),
    JSON.stringify(input), WP_SUGGEST_SCHEMA_);

  const tidy = function (list, max) {
    return (Array.isArray(list) ? list : []).map(function (o) {
      const text = String((o && o.text) || '').replace(/^["'“‘]+|["'”’]+$/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
      return text ? { text: text, why: String((o && o.why) || '').slice(0, 140), flags: wpFlags_(text, avoid) } : null;
    }).filter(Boolean).slice(0, 4);
  };
  console.log('Suggestions for ' + it.path + ' by ' + session.name);
  return { ok: true, titles: tidy(out.titles, 90), descriptions: tidy(out.descriptions, 220),
    searches: searches.slice(0, 10), searchNote: searchNote };
}

// The page's headings and text: the live page when it's published, otherwise its saved content
function wpPageText_(it) {
  let html = '';
  if (it.status === 'publish') {
    try {
      const r = UrlFetchApp.fetch(it.link, { muteHttpExceptions: true, followRedirects: true });
      if (r.getResponseCode() === 200) html = r.getContentText();
    } catch (e) { console.warn('Page not read: ' + it.link + ': ' + e); }
  }
  if (!html && it.content) html = String(it.content);
  const clean = function (s) {
    return String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&#8217;|&rsquo;/g, '\'').replace(/&#8211;|&ndash;/g, '-').replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  };
  const pick = function (re, n) { return (html.match(re) || []).map(clean).filter(Boolean).slice(0, n); };
  const main = html.replace(/<(script|style|noscript|svg|header|footer|nav|form)\b[\s\S]*?<\/\1>/gi, ' ');
  return {
    h1: pick(/<h1\b[^>]*>[\s\S]*?<\/h1>/gi, 2),
    h2: pick(/<h2\b[^>]*>[\s\S]*?<\/h2>/gi, 12),
    body: clean(main).slice(0, 3500),
  };
}

// The searches Google showed this page for in the last 90 days, most impressions first
function wpSearches_(link) {
  const site = String(PropertiesService.getScriptProperties().getProperty('SEO_SITE') || '').trim();
  if (!site || !link) return [];
  const f = function (ms) { return Utilities.formatDate(new Date(ms), 'Australia/Perth', 'yyyy-MM-dd'); };
  const base = String(link).split(/[?#]/)[0].replace(/\/+$/, '');
  const res = UrlFetchApp.fetch('https://www.googleapis.com/webmasters/v3/sites/' + encodeURIComponent(site) + '/searchAnalytics/query', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({
      startDate: f(Date.now() - 93 * 864e5), endDate: f(Date.now() - 3 * 864e5), dimensions: ['query'], rowLimit: 25,
      dimensionFilterGroups: [{ filters: [{ dimension: 'page', operator: 'includingRegex',
        expression: '^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/?$' }] }],
    }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Search Console ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return (JSON.parse(res.getContentText()).rows || []).map(function (r) {
    return { q: String(r.keys[0]), clicks: Math.round(r.clicks || 0), impressions: Math.round(r.impressions || 0),
      position: Math.round((r.position || 0) * 10) / 10 };
  }).sort(function (a, b) { return b.impressions - a.impressions; });
}

// The clinic's own words to avoid (SEO → Settings), remembered 10 minutes
function wpAvoidWords_() {
  const hit = repCacheGet_('ws_avoid_v1');
  if (hit) return hit;
  const words = [];
  try {
    const d = fsGetDoc_(getConfig_(), 'seo_settings/main') || {};
    Object.keys(d).forEach(function (k) {
      if (!/complian|banned|avoid|forbid/i.test(k) || !Array.isArray(d[k])) return;
      d[k].forEach(function (x) {
        const w = typeof x === 'string' ? x : x && (x.word || x.term || x.text || x.phrase);
        if (w && String(w).trim().length >= 3) words.push(String(w).trim().toLowerCase());
      });
    });
  } catch (e) { console.warn('Words to avoid not read: ' + e); }
  const out = uniq_(words).slice(0, 200);
  repCachePut_('ws_avoid_v1', out, 600);
  return out;
}

function wpFlags_(text, avoid) {
  const out = [];
  WP_FLAG_RULES_.forEach(function (r) { const m = r[0].exec(text); if (m) out.push(r[1] + ': "' + m[0] + '"'); });
  (avoid || []).forEach(function (w) {
    const re = new RegExp('(^|[^a-z])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z])', 'i');
    if (re.test(text)) out.push('On the clinic\'s list of words to avoid: "' + w + '"');
  });
  return uniq_(out).slice(0, 3);
}

// One Claude call that answers in JSON (the same key as the SEO Advisor)
function wpClaude_(system, user, schema, modelIn) {
  const model = modelIn || PropertiesService.getScriptProperties().getProperty('CLAUDE_MODEL') || 'claude-sonnet-5-5';
  const body = {
    model: model, max_tokens: 4000, system: system,
    messages: [{ role: 'user', content: user }],
    output_config: { format: { type: 'json_schema', schema: schema }, effort: 'low' },
  };
  const thinking = claudeThinking_(model);
  if (thinking) body.thinking = thinking;
  const opts = {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': seo7ClaudeKey_(), 'anthropic-version': '2026-10-21' },
    payload: JSON.stringify(body),
  };
  let data = null;
  for (let attempt = 0; ; attempt++) {
    const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', opts);
    const code = r.getResponseCode();
    if (code === 200) { data = JSON.parse(r.getContentText()); break; }
    if ((code === 429 || code === 529 || code >= 500) && attempt < 2) { Utilities.sleep(1000 * (attempt + 1)); continue; }
    throw new Error('Claude ' + code + ': ' + r.getContentText().slice(0, 200));
  }
  if (data.stop_reason === 'refusal') throw new Error('Claude declined to write suggestions for this page.');
  const text = (data.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('');
  return JSON.parse(text);
}

/** Run from the editor: suggestions for one page (change the id), nothing saved */
function wpTestSuggest() {
  const id = 0;   // a page id: open the page in the Website tab, it's in the address (#/seo/website/<id>)
  const s = createSession_({ id: 'test', name: 'Test', role: 'Admin' });
  console.log(JSON.stringify(wpSuggest_({ session: s, id: id }, getSession_(s)), null, 2));
}

/* ===================== Blog posts: new drafts, images, categories and the check ===================== */

// A new post, always as a draft. The rest (categories, publishing…) is saved straight after with wpSave_.
function wpCreate_(body, session) {
  if (!can_(session, 'seo.pages')) return { ok: false, error: 'FORBIDDEN' };
  const f = body.fields || {};
  const one = function (v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); };
  const html = String(f.content || '');
  if (html.length > 300000) return { ok: true, problem: 'The post is too long to save from the portal.' };
  const seo = {};
  if (f.seo) ['title', 'description', 'focus'].forEach(function (k) {
    if (f.seo[k]) seo[k] = one(f.seo[k], k === 'description' ? 320 : 200);
  });
  const r = wpCall_('POST', '/items', {
    type: 'post', status: 'draft', title: one(f.title, 200) || 'Untitled post', content: html,
    excerpt: one(f.excerpt, 600), seo: seo,
  });
  CacheService.getScriptCache().remove(WP_LIST_CACHE_);
  console.log('New blog post draft ' + (r.item && r.item.id) + ' by ' + session.name);
  return { ok: true, item: r.item };
}

function wpMedia_(body, session) {
  if (!can_(session, 'seo.pages')) return { ok: false, error: 'FORBIDDEN' };
  const data = String(body.data || '');
  if (!data) return { ok: false, error: 'BAD_REQUEST' };
  if (data.length > 11 * 1024 * 1024) return { ok: true, problem: 'The image is too big. Use one under 8 MB.' };
  const one = function (v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); };
  const r = wpCall_('POST', '/media', {
    data: data, name: one(body.name, 120) || 'image', alt: one(body.alt, 200), title: one(body.alt, 200),
    post: Math.max(0, Math.floor(Number(body.post) || 0)),
  });
  console.log('Image ' + r.id + ' uploaded by ' + session.name);
  return { ok: true, id: r.id, url: r.url };
}

function wpTerms_() {
  const hit = repCacheGet_('wp_terms_v1');
  if (hit) return Object.assign({ ok: true }, hit);
  const out = { categories: wpCall_('GET', '/terms').categories || [] };
  repCachePut_('wp_terms_v1', out, 600);
  return Object.assign({ ok: true }, out);
}

const WP_CHECK_PROMPT_ = [
  'You check a blog post for Dermedica, a doctor-led cosmetic and skin clinic in Perth, Western Australia, before it is published.',
  'Find these problems:',
  '- spelling: misspelt words, and American spellings that should be Australian (color → colour, optimize → optimise, center → centre).',
  '- grammar: clear grammar mistakes only, not style preferences.',
  '- advertising: anything against Australian advertising rules for health services (AHPRA and TGA): prescription medicine',
  '  names or brands (Botox, Dysport, Xeomin, Letybo…), testimonials or reviews, before-and-after promises, superlatives',
  '  (best, leading, number one), guarantees, claims of no risk, no pain or permanent results, pressure or inducements',
  '  (limited time, discounts, free gifts), or anything that creates unrealistic expectations or plays down risks.',
  '- claim: a medical or results claim that needs evidence or a clinician to check it (for example "reduces wrinkles by 80%",',
  '  "results last 2 years").',
  '- clarity: a sentence that is very hard to follow. At most 3 of these.',
  '',
  'RULES',
  '- quote: the exact words from the text, copied character for character, as short as possible (1 to 12 words).',
  '- fix: the corrected words, or a compliant way to say it. Empty if it should simply be removed.',
  '- why: one short plain sentence.',
  '- Don\'t flag names of people, places, the clinic, generic treatment names, or the accepted words.',
  '- If there are no problems, return no issues. Never invent problems.',
].join('\n');

const WP_CHECK_SCHEMA_ = { type: 'object', additionalProperties: false, required: ['issues'], properties: {
  issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['type', 'quote', 'fix', 'why'], properties: {
    type: { type: 'string', enum: ['spelling', 'grammar', 'advertising', 'claim', 'clarity'] },
    quote: { type: 'string' }, fix: { type: 'string' }, why: { type: 'string' },
  } } },
} };

// Spelling, grammar and the advertising rules for a post's words. Every quote must be the post's own words.
function wpCheck_(body, session) {
  if (!can_(session, 'seo.pages')) return { ok: false, error: 'FORBIDDEN' };
  const cache = CacheService.getScriptCache();
  const rk = 'ws_chk_' + session.uid;
  const used = Number(cache.get(rk) || 0);
  if (used >= 60) return { ok: true, problem: 'You\'ve run a lot of checks in the last hour. Try again a bit later.' };
  cache.put(rk, String(used + 1), 3600);
  const flat = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 24000);
  if (flat.replace(/\s/g, '').length < 20) return { ok: true, issues: [] };
  const accept = wpSpellWords_();
  const avoid = wpAvoidWords_();
  const sys = WP_CHECK_PROMPT_
    + (accept.length ? '\n\nACCEPTED WORDS (spelt correctly for this clinic): ' + accept.join(', ') : '')
    + (avoid.length ? '\n\nTHE CLINIC\'S OWN WORDS TO AVOID (always an advertising problem): ' + avoid.join(', ') : '');
  let out;
  try { out = wpClaude_(sys, flat, WP_CHECK_SCHEMA_, PropertiesService.getScriptProperties().getProperty('CLAUDE_FAST_MODEL') || 'claude-haiku-5-5'); }
  catch (e) { console.warn('Post check failed: ' + e); return { ok: true, problem: 'The check couldn\'t run just now. Try again in a minute.' }; }

  const ok = {};
  accept.forEach(function (w) { ok[w.toLowerCase()] = true; });
  const seen = {};
  const issues = [];
  const push = function (x) {
    const k = x.type + '|' + x.quote.toLowerCase();
    if (!seen[k] && issues.length < 80) { seen[k] = true; issues.push(x); }
  };
  (out.issues || []).forEach(function (o) {
    const quote = String(o.quote || '').replace(/\s+/g, ' ').trim();
    if (!quote || quote.length > 200 || flat.indexOf(quote) === -1) return;
    if (o.type === 'spelling' && ok[quote.toLowerCase()]) return;
    push({ type: String(o.type), quote: quote, fix: String(o.fix || '').replace(/\s+/g, ' ').trim().slice(0, 200), why: String(o.why || '').slice(0, 200) });
  });
  // The fixed rules apply whatever Claude found
  WP_FLAG_RULES_.forEach(function (r) {
    const re = new RegExp(r[0].source, 'gi');
    let m;
    while ((m = re.exec(flat))) push({ type: 'advertising', quote: m[0], fix: '', why: r[1] + '.' });
  });
  avoid.forEach(function (w) {
    const re = new RegExp('(^|[^a-z])(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')($|[^a-z])', 'i');
    const m = re.exec(flat);
    if (m) push({ type: 'advertising', quote: m[2], fix: '', why: 'On the clinic\'s list of words to avoid.' });
  });
  return { ok: true, issues: issues };
}

// SEO → Settings → Brand and wording → Spelling: words to accept (remembered 10 minutes)
function wpSpellWords_() {
  const hit = repCacheGet_('ws_spell_v1');
  if (hit) return hit;
  let out = [];
  try {
    const d = fsGetDoc_(getConfig_(), 'seo_settings/main') || {};
    out = uniq_((Array.isArray(d.spellWords) ? d.spellWords : []).map(function (w) { return String(w || '').trim(); }).filter(Boolean)).slice(0, 400);
  } catch (e) { console.warn('Spelling words not read: ' + e); }
  repCachePut_('ws_spell_v1', out, 600);
  return out;
}