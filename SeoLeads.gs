/**
 * SeoLeads.gs — website enquiries by the page people came in on. Runs at the start of runSeoAds.
 * seo_state/leads.rows: [enquiry date, landing page, how they came, first page they found, outcome bits, date they came in]
 *   how: g Google search · s another search engine · a ad · i AI assistant · o social · e email · r another website · d direct
 *   outcome bits: 1 consultation booked · 2 came in · 4 treated (from the Prospect Dashboard stages)
 * Each prospect's outcome counts once, on their first tracked enquiry.
 */
const SEO_LEADS_K_ = { google: 'g', search: 's', ad: 'a', ai: 'i', social: 'o', email: 'e', referral: 'r', direct: 'd' };
const SEO_LEADS_MAX_ = 8000;

function seoLeadsPath_(p) {
  p = String(p || '').split('?')[0].split('#')[0].trim().toLowerCase();
  if (!p) return '';
  return p.replace(/\/+$/, '') || '/';
}

function runSeoLeads() {
  const t0 = Date.now();
  const cfg = getConfig_();
  const since = Utilities.formatDate(new Date(Date.now() - 400 * 864e5), 'Australia/Perth', 'yyyy-MM-dd');
  const rows = [];
  fsListAll_(cfg, 'prospects', ['enquiries', 'milestones']).forEach(function (d) {
    const p = fromFields_(d.fields || {});
    const ms = p.milestones || {};
    const bits = (ms.consult_booked ? 1 : 0) | (ms.consulted ? 2 : 0) | (ms.treated || ms.active ? 4 : 0);
    let counted = false;
    (Array.isArray(p.enquiries) ? p.enquiries : []).slice()
      .sort(function (a, b) { return String((a && a.at) || '').localeCompare(String((b && b.at) || '')); })
      .forEach(function (q) {
        if (!q || !q.at) return;
        let land = '', k = '', first = '';
        if (q.via && (q.via.land || q.via.form)) {
          land = q.via.land || q.via.form;
          k = SEO_LEADS_K_[q.via.kind] || 'r';
          first = q.via.firstLand || '';
        } else if (q.ads && q.ads.landing) {   // ad enquiries from before the visit tracking
          land = q.ads.landing;
          k = 'a';
        }
        if (!land) return;
        const t = new Date(q.at);
        if (isNaN(t)) return;
        const day = Utilities.formatDate(t, 'Australia/Perth', 'yyyy-MM-dd');
        if (day < since) return;
        rows.push([day, seoLeadsPath_(land), k, seoLeadsPath_(first), counted ? 0 : bits, counted ? '' : String(ms.consulted || '')]);
        counted = true;
      });
  });
  rows.sort(function (a, b) { return a[0].localeCompare(b[0]); });
  const keep = rows.slice(-SEO_LEADS_MAX_);
  commitWrites_(cfg, [updateWrite_(cfg, 'seo_state/leads', {
    rows: JSON.stringify(keep), from: keep.length ? keep[0][0] : '', count: keep.length, at: new Date().toISOString(),
  })]);
  console.log('SEO leads: ' + keep.length + ' enquiries by page in ' + (Date.now() - t0) + ' ms');
}