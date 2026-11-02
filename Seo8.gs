/**
 * Seo8.gs — SEO content clusters: reads every page in a cluster each morning (title, main heading, redirects, and which
 * other cluster pages it links to), so SEO → Pages → Clusters shows the right arrows for pages Site health doesn't read.
 * Writes seo_state/clusterpages { json: { "<path>": { path, status, redirect, title, h1, words, links, at } }, at, pages, ms }
 * Uses Seo.gs (seoOrigin_, seoFsCommit_, SEO_TZ_), Seo3.gs (seo3Fetch_, seo3Header_, seo3Abs_, seo3Short_, seo3Parse_,
 * seo3LinkPaths_) and Code.gs (getConfig_, fsGetDoc_).
 */

const SEO8_MAX_PAGES_ = 200;

function runSeoClusterPages() {
  const t0 = Date.now();
  const cfg = getConfig_();
  const origin = seoOrigin_();
  const set = fsGetDoc_(cfg, 'seo_settings/main') || {};
  const clusters = Array.isArray(set.clusters) ? set.clusters : [];

  const paths = {};
  clusters.forEach(function (cl) {
    if (!cl || !cl.main) return;
    paths[seo8N_(cl.main)] = seo8P_(cl.main);
    (cl.pages || []).forEach(function (p) { if (p && p.path) paths[seo8N_(p.path)] = seo8P_(p.path); });
  });
  const keys = Object.keys(paths).slice(0, SEO8_MAX_PAGES_);
  const inSet = {};
  keys.forEach(function (k) { inSet[k] = 1; });

  const out = {};
  if (keys.length) {
    const res = seo3Fetch_(keys.map(function (k) { return origin + paths[k]; }), false);   // not following redirects
    keys.forEach(function (k, i) {
      const r = res[i];
      const e = { path: paths[k], status: 0, redirect: '', title: '', h1: '', words: 0, links: [], at: new Date().toISOString() };
      out[k] = e;
      if (!r || r.error) { e.error = r ? String(r.error).slice(0, 150) : 'No answer'; return; }
      e.status = r.code;
      if (r.code >= 300 && r.code < 400) {
        const abs = seo3Abs_(seo3Header_(r.headers, 'location'), origin + paths[k]);
        e.redirect = abs ? seo3Short_(abs) : '';
        return;
      }
      if (r.code === 200) {
        const p = seo3Parse_(r.text);
        e.title = p.title || '';
        e.h1 = p.h1Text || '';
        e.words = p.words || 0;
        // Only links to other pages in clusters are kept (that's all the graph needs)
        e.links = seo3LinkPaths_({ parsed: p, url: origin + paths[k] }, origin).filter(function (l) { return inSet[seo8N_(l)]; });
      }
    });
  }
  seoFsCommit_([{ path: 'seo_state/clusterpages', data: { json: JSON.stringify(out), at: new Date(), pages: keys.length, ms: Date.now() - t0 } }]);
  console.log('Clusters: ' + clusters.length + ' clusters, ' + keys.length + ' pages read in ' + Math.round((Date.now() - t0) / 1000) + ' s');
}

/** Run once: every morning at about 11am Perth */
function installSeoClusterTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoClusterPages'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoClusterPages').timeBased().everyDays(1).atHour(11).inTimezone(SEO_TZ_).create();
  console.log('runSeoClusterPages scheduled daily ~11am Perth');
}

function seo8P_(p) {
  p = String(p || '').trim().replace(/^https?:\/\/[^\/]+/i, '').split('#')[0].split('?')[0];
  return p.charAt(0) === '/' ? p : '/' + p;
}
function seo8N_(p) { return seo8P_(p).toLowerCase().replace(/\/+$/, '') || '/'; }