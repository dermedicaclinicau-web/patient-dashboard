/**
 * SeoWp.gs — reads the list of pages (address + title) from the WordPress site.
 * Saves it to Firestore seo_settings/wp, which SEO Settings uses to show page titles.
 * Runs once a day (seoWpInstallTrigger). Doesn't change anything on the website.
 *
 * Script Properties: WP_URL (required), WP_USER + WP_APP_PASSWORD (optional, used if set).
 */

// WordPress content types that aren't pages people visit
const SEO_WP_SKIP_ = {
  attachment: 1, nav_menu_item: 1, wp_block: 1, wp_template: 1, wp_template_part: 1,
  wp_navigation: 1, wp_global_styles: 1, wp_font_family: 1, wp_font_face: 1, elementor_library: 1,
};
const SEO_WP_MAX_ = 3000;

/** Nightly: read every published page and post, save the list. */
function seoWpSync() {
  const res = seoWpRead_();
  if (!res.pages.length) {
    throw new Error('No pages came back from WordPress, so the saved list was left as it is. ' + res.problems.join(' | '));
  }
  seoWpSave_(res);
  console.log('WordPress pages saved: ' + res.pages.length + ' (' + res.types.join(', ') + ')' +
    (res.problems.length ? ' | Problems: ' + res.problems.join(' | ') : ''));
  return res.pages.length;
}

/** Run this from the editor first: reads from WordPress and logs what it found, without saving. */
function seoWpTest() {
  const res = seoWpRead_();
  console.log('Site: ' + res.site + ' | signed in: ' + (res.who ? res.who.name + ' (' + res.who.roles.join(', ') + ')' : 'no, reading public pages only'));
  console.log('Found ' + res.pages.length + ' pages in: ' + res.types.join(', '));
  res.pages.slice(0, 15).forEach((p) => console.log(p.type + '  ' + p.path + '  →  ' + p.title));
  if (res.problems.length) console.log('Problems: ' + res.problems.join(' | '));
}

/** Run once: reads WordPress every day at about 5 am Perth time. */
function seoWpInstallTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'seoWpSync')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('seoWpSync').timeBased().everyDays(1).atHour(5).inTimezone('Australia/Perth').create();
}

function seoWpRead_() {
  const props = PropertiesService.getScriptProperties();
  const site = String(props.getProperty('WP_URL') || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/i.test(site)) {
    throw new Error('Set the Script Property WP_URL to your website address, e.g. https://www.yoursite.com.au (no slash at the end).');
  }
  const headers = { Accept: 'application/json' };
  const user = String(props.getProperty('WP_USER') || '').trim();
  const pass = String(props.getProperty('WP_APP_PASSWORD') || '').replace(/\s+/g, '');
  if (user && pass) headers.Authorization = 'Basic ' + Utilities.base64Encode(user + ':' + pass);

  const host = seoWpHost_(site);
  const problems = [];
  let who = null;

  // Check the login first. If WordPress refuses it, carry on without it: published pages are public.
  if (headers.Authorization) {
    const me = seoWpGet_(site + '/wp-json/wp/v2/users/me?context=edit&_fields=id,username,name,roles', headers);
    if (me.code === 200 && me.body && me.body.id) {
      who = { name: me.body.username || me.body.name || '', roles: me.body.roles || [] };
    } else {
      problems.push(seoWpWhy_(me.code, 'Login', me.msg));
      delete headers.Authorization;
    }
  }

  // Which content types the site has (pages, posts, and any custom ones like treatments)
  let types = [];
  const t = seoWpGet_(site + '/wp-json/wp/v2/types', headers);
  if (t.code === 200 && t.body && typeof t.body === 'object') {
    types = Object.keys(t.body)
      .filter((k) => !SEO_WP_SKIP_[k] && t.body[k] && t.body[k].rest_base)
      .map((k) => ({ type: k, base: t.body[k].rest_base, ns: t.body[k].rest_namespace || 'wp/v2' }));
  } else {
    problems.push(seoWpWhy_(t.code, 'content types'));
    types = [{ type: 'page', base: 'pages', ns: 'wp/v2' }, { type: 'post', base: 'posts', ns: 'wp/v2' }];
  }

  const byPath = new Map();
  const found = [];
  for (const ty of types) {
    let n = 0;
    for (let page = 1; page <= 30 && byPath.size < SEO_WP_MAX_; page++) {
      const url = site + '/wp-json/' + ty.ns + '/' + ty.base +
        '?per_page=100&page=' + page + '&orderby=id&order=asc&_fields=id,link,title,modified_gmt,parent';
      const r = seoWpGet_(url, headers);
      if (r.code === 400 && page > 1) break;               // past the last page
      if (r.code !== 200 || !Array.isArray(r.body)) { problems.push(seoWpWhy_(r.code, ty.type)); break; }
      for (const it of r.body) {
        const link = String(it.link || '');
        if (!link || seoWpHost_(link) !== host) continue;   // skip links to other sites
        const path = (link.replace(/^https?:\/\/[^/]+/i, '').split('#')[0].split('?')[0]) || '/';
        if (byPath.has(path)) continue;
        byPath.set(path, {
          path,
          title: seoWpText_(it.title && it.title.rendered).slice(0, 200),
          type: ty.type,
          id: it.id,
          mod: it.modified_gmt ? String(it.modified_gmt).slice(0, 10) : '',
        });
        n++;
      }
      if (page >= r.totalPages) break;
    }
    if (n) found.push(ty.type + ' ' + n);
  }

  // The home page isn't always a WordPress "page", so make sure it's there
  if (!byPath.has('/')) byPath.set('/', { path: '/', title: 'Home page', type: 'home', id: 0, mod: '' });

  return { site, signedIn: !!headers.Authorization, who, pages: [...byPath.values()], types: found, problems };
}

function seoWpGet_(url, headers) {
  let r;
  try {
    r = UrlFetchApp.fetch(url, { headers, muteHttpExceptions: true, followRedirects: true });
  } catch (e) {
    return { code: 0, body: null, totalPages: 1 };
  }
  const h = {};
  const all = r.getAllHeaders();
  Object.keys(all).forEach((k) => { h[k.toLowerCase()] = all[k]; });
  let body = null;
  try { body = JSON.parse(r.getContentText()); } catch (e) { /* not JSON: blocked or an error page */ }
  const msg = body && !Array.isArray(body) && body.code ? String(body.code) : '';
  return { code: r.getResponseCode(), body, msg, totalPages: Number(h['x-wp-totalpages'] || 1) };
}

function seoWpWhy_(code, what, msg) {
  const why = {
    incorrect_password: 'the application password is wrong. Create a new one and paste it into WP_APP_PASSWORD (not your normal login password).',
    invalid_username: "WordPress doesn't know that username. Use the login name shown under Users → Username, not the display name.",
    invalid_email: "WordPress doesn't know that email. Use the login name instead.",
    application_passwords_disabled: 'application passwords are turned off on the site, usually by a security plugin.',
    rest_not_logged_in: "the login didn't reach WordPress: the web server removed it. See the .htaccess fix.",
  }[msg];
  if (why) return what + ': ' + why;
  if (code === 401 || code === 403) return what + ': WordPress refused access (' + code + (msg ? ', ' + msg : '') + '). A security plugin may be blocking it.';
  if (code === 404) return what + ': not found (404). Check WP_URL.';
  if (code === 0) return what + ': the website could not be reached.';
  return what + ': WordPress answered ' + code + (msg ? ' (' + msg + ')' : '') + '. A firewall such as Cloudflare may be blocking Google servers.';
}

function seoWpHost_(url) {
  return String(url).replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
}

// WordPress titles come with HTML entities (&#8211; and so on): turn them into plain text
function seoWpText_(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

/* ---------- Firestore: seo_settings/wp ---------- */

function seoWpSave_(res) {
  const pid = PropertiesService.getScriptProperties().getProperty('FIRESTORE_PROJECT_ID');
  const url = 'https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents/seo_settings/wp';
  const body = {
    fields: {
      pages: { stringValue: JSON.stringify(res.pages.slice(0, SEO_WP_MAX_)) },
      count: { integerValue: String(Math.min(res.pages.length, SEO_WP_MAX_)) },
      site: { stringValue: res.site },
      types: { stringValue: res.types.join(', ') },
      problems: { stringValue: res.problems.join(' | ').slice(0, 1000) },
      at: { timestampValue: new Date().toISOString() },
    },
  };
  const r = UrlFetchApp.fetch(url, {
    method: 'patch', contentType: 'application/json', payload: JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + seoWpFsToken_() }, muteHttpExceptions: true,
  });
  if (r.getResponseCode() >= 300) throw new Error('Saving to Firestore failed: ' + r.getContentText().slice(0, 300));
}

// Signs in as the service account (FIRESTORE_EMAIL / FIRESTORE_KEY). Kept here so this file stands on its own.
function seoWpFsToken_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('seoWpFsTok');
  if (hit) return hit;
  const p = PropertiesService.getScriptProperties();
  const email = p.getProperty('FIRESTORE_EMAIL');
  const key = String(p.getProperty('FIRESTORE_KEY') || '').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => Utilities.base64EncodeWebSafe(JSON.stringify(o)).replace(/=+$/, '');
  const head = enc({ alg: 'RS256', typ: 'JWT' });
  const claim = enc({
    iss: email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  });
  const sig = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(head + '.' + claim, key)).replace(/=+$/, '');
  const r = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig },
  });
  if (r.getResponseCode() !== 200) throw new Error('Firestore sign-in failed: ' + r.getContentText().slice(0, 200));
  const tok = JSON.parse(r.getContentText()).access_token;
  cache.put('seoWpFsTok', tok, 3000);
  return tok;
}