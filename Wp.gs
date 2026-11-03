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

// Page title, SEO title, description, focus keyphrase (seo.pages); address and hide from Google (seo.publish)
function wpSave_(body, session) {
  const id = Math.floor(Number(body.id));
  if (!(id > 0)) return { ok: false, error: 'BAD_REQUEST' };
  if (!can_(session, 'seo.pages')) return { ok: false, error: 'FORBIDDEN' };
  const f = body.fields || {};
  const one = function (v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); };
  const out = {};
  if ('title' in f) {
    out.title = one(f.title, 200);
    if (!out.title) return { ok: true, problem: 'The page title can\'t be empty.' };
  }
  const seo = {};
  if (f.seo && 'title' in f.seo) seo.title = one(f.seo.title, 200);
  if (f.seo && 'description' in f.seo) seo.description = one(f.seo.description, 320);
  if (f.seo && 'focus' in f.seo) seo.focus = one(f.seo.focus, 120);
  if ('slug' in f || (f.seo && 'noindex' in f.seo)) {
    if (!can_(session, 'seo.publish')) {
      return { ok: true, problem: 'Changing a page\'s address or hiding it from Google needs "Website: publish and remove".' };
    }
    if ('slug' in f) {
      out.slug = String(f.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 190);
      if (!out.slug) return { ok: true, problem: 'The address can\'t be empty.' };
      const cur = wpCall_('GET', '/item/' + id).item;
      if (cur.slug === out.slug) delete out.slug;
      else if (cur.status === 'publish' && !wpInfo_().redirection) {
        return { ok: true, problem: 'Turn on a redirect plugin before changing a published page\'s address, so the old address doesn\'t become a broken link.' };
      } else out.redirectOld = true;   // the old address sends people to the new one
    }
    if (f.seo && 'noindex' in f.seo) seo.noindex = f.seo.noindex === true;
  }
  if (Object.keys(seo).length) out.seo = seo;
  if (!Object.keys(out).length) return { ok: true, problem: 'Nothing to save.' };

  const r = wpCall_('POST', '/item/' + id, out);
  try { wpLogChange_(r.before, r.item, out, r.redirect, session); } catch (e) { console.warn('Saved, but the Change log entry failed: ' + e); }
  CacheService.getScriptCache().remove(WP_LIST_CACHE_);
  console.log('WordPress ' + id + ' saved by ' + session.name);
  return { ok: true, item: r.item, redirect: r.redirect || null };
}

// Every change goes in SEO → Change log, so its effect shows on the Overview chart
function wpLogChange_(before, after, sent, redirect, session) {
  const seoOf = function (x) { const s = (x && x.seo) || {}; return s.yoast || s.aioseo || {}; };
  const b = seoOf(before), a = seoOf(after);
  const parts = [];
  if ('title' in sent && before.title !== after.title) parts.push('Page title: "' + before.title + '" → "' + after.title + '"');
  if (sent.seo && 'title' in sent.seo && b.title !== a.title) parts.push('SEO title: "' + (b.title || '(default)') + '" → "' + (a.title || '(default)') + '"');
  if (sent.seo && 'description' in sent.seo && b.description !== a.description) parts.push('Description changed');
  if (sent.seo && 'focus' in sent.seo && b.focus !== a.focus) parts.push('Focus keyphrase: "' + (b.focus || '') + '" → "' + (a.focus || '') + '"');
  if (sent.seo && 'noindex' in sent.seo && b.noindex !== a.noindex) parts.push(a.noindex ? 'Hidden from Google' : 'Shown in Google again');
  if ('slug' in sent && before.path !== after.path) {
    parts.push('Address: ' + before.path + ' → ' + after.path + (redirect && redirect.ok ? ' (old address redirects)' : redirect ? ' (redirect NOT made: ' + redirect.why + ')' : ''));
  }
  if (!parts.length) return;
  const cfg = getConfig_();
  const type = ('slug' in sent) ? 'Technical' : 'Title / meta';
  commitWrites_(cfg, [updateWrite_(cfg, 'seo_log/wp_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
    date: Utilities.formatDate(new Date(), REC_TZ_, 'yyyy-MM-dd'), type: type, url: String(after.path || before.path || ''),
    title: parts[0].slice(0, 200), note: parts.join('\n').slice(0, 1000),
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