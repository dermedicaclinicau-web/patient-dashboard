/**
 * Seo6.gs — SEO Tasks: checks the website each night and confirms the steps that are done.
 * Reads seo_tasks (made by the portal), reads each page involved, and for every open step:
 *   · found on the page → status 'confirmed' (permanent), logged
 *   · ticked but not found two nights running → back to 'todo' with missing = true, logged
 * A task whose steps are all confirmed (or 'done', for steps that can't be checked) becomes 'done',
 * and gets a Change log entry so its effect shows in SEO → Change log.
 * Uses Seo.gs (seoOrigin_, seoHash_, SEO_TZ_), Seo2.gs (seo2Project_, seo2Commit_, seo2Write_, seo2Val_),
 * Seo3.gs (seo3Fetch_, seo3Parse_, seo3Abs_, seo3Norm_, seo3Text_, seo3Esc_), Code.gs (getConfig_, fsGetDoc_, fsListAll_, fromFields_).
 */

const SEO6_STOP_ = { in: 1, for: 1, the: 1, a: 1, an: 1, of: 1, and: 1, to: 1, on: 1, with: 1, near: 1, me: 1, my: 1, is: 1, are: 1,
  what: 1, how: 1, best: 1 };
const SEO6_LOG_TYPE_ = { basics: 'Technical', match: 'Title / meta', connect: 'Links', content: 'Content', speed: 'Technical', off: 'Other', ai: 'Content', cluster: 'Links', quality: 'Content' };

function runSeoTaskChecks() { seo6Run_(false); }

/** Run from the editor: shows what tonight's check would do, without saving anything */
function testSeoTaskChecks() { seo6Run_(true); }

/** Run once: checks every night at about 9pm Perth */
function installSeoTaskTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runSeoTaskChecks'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runSeoTaskChecks').timeBased().everyDays(1).atHour(21).inTimezone(SEO_TZ_).create();
  console.log('runSeoTaskChecks scheduled daily ~9pm Perth');
}

function seo6Run_(dry) {
  const t0 = Date.now();
  const cfg = getConfig_();
  const project = seo2Project_();
  const origin = seoOrigin_();
  const today = Utilities.formatDate(new Date(), SEO_TZ_, 'yyyy-MM-dd');
  const nowIso = new Date().toISOString();

  const tasks = fsListAll_(cfg, 'seo_tasks', ['path', 'title', 'group', 'status', 'steps', 'order'])
    .map(function (d) { const t = fromFields_(d.fields || {}); t.id = d.name.split('/').pop(); return t; })
    .filter(function (t) { return t.status !== 'done' && t.steps && typeof t.steps === 'object'; });
  if (!tasks.length) { console.log('Tasks: nothing open.'); return; }

  // 1. Read every page an open step needs (once each)
  const urls = {};
  tasks.forEach(function (t) {
    Object.keys(t.steps).forEach(function (id) {
      const s = t.steps[id];
      if (!s || !s.check || s.status === 'confirmed' || s.status === 'done') return;
      if (['manual', 'speed', 'index', 'redirect'].indexOf(s.check.k) !== -1) return;
      const p = seo6Path_(s.check.page || t.path);
      urls[seo3Norm_(origin + p)] = origin + p;
    });
  });
  const keys = Object.keys(urls);
  const pages = {};
  const res = seo3Fetch_(keys.map(function (k) { return urls[k]; }), true);
  keys.forEach(function (k, i) {
    const r = res[i];
    if (r && !r.error && r.code === 200) pages[k] = seo6Read_(r.text, urls[k]);
    else console.warn('Tasks: could not read ' + urls[k] + ' (' + (r && (r.error || r.code)) + ')');
  });

  // Speed (Site health) and Google indexing (seo_index) are read only if a step needs them
  const healthCache = {};
  const speedOf = function (path) {
    const p = seo6Path_(path);
    if (!(p in healthCache)) {
      let d = null;
      try { d = fsGetDoc_(cfg, 'seo_health/p_' + seoHash_(origin + p)); } catch (e) { d = null; }
      healthCache[p] = d && d.speed && d.speed.score != null ? Number(d.speed.score) : null;
    }
    return healthCache[p];
  };
  let indexData;
  const indexOf = function (path) {
    if (indexData === undefined) {
      try { const d = fsGetDoc_(cfg, 'seo_index/main'); indexData = d && d.json ? JSON.parse(d.json) : null; } catch (e) { indexData = null; }
    }
    if (!indexData || !indexData.key) return null;
    const p = seo6Path_(path);
    const hit = indexData.key[p] || indexData.key[p.replace(/\/+$/, '')] || indexData.key[p.replace(/\/?$/, '/')];
    return hit && !hit.err ? hit.v : null;
  };

  // Redirects ("merge into the main page"): read without following, once per page. '' = not redirecting, null = no answer.
  const redirCache = {};
  const redirectOf = function (path) {
    const p = seo6Path_(path);
    if (!(p in redirCache)) {
      const r = seo3Fetch_([origin + p], false, false)[0];
      if (!r || r.error) redirCache[p] = null;
      else if (r.code >= 300 && r.code < 400) {
        const abs = seo3Abs_(seo3Header_(r.headers, 'location'), origin + p);
        redirCache[p] = abs ? seo3Short_(abs) : '';
      } else redirCache[p] = '';
    }
    return redirCache[p];
  };

  // When WordPress last saved each page (from SeoWp.gs), for the log
  const wpMod = {};
  try {
    const wp = fsGetDoc_(cfg, 'seo_settings/wp');
    JSON.parse((wp && wp.pages) || '[]').forEach(function (p) { if (p.mod) wpMod[seo3Norm_(origin + p.path)] = p.mod; });
  } catch (e) { /* no WordPress list: the log just doesn't mention it */ }

  // 2. Check each open step
  const writes = [], logs = [];
  let confirmed = 0, missing = 0, finished = 0;
  const logEntry = function (t, id, s, action, note) {
    logs.push(seo2Write_(project, 'seo_task_log/w' + Utilities.getUuid().replace(/-/g, ''), {
      taskId: t.id, stepId: id || '', path: t.path || '', taskTitle: String(t.title || ''), text: s ? String(s.text || '') : '',
      action: action, note: note || '', by: 'website', byName: 'Website check', role: '', day: today, at: new Date(),
    }));
  };

  tasks.forEach(function (t) {
    const order = Array.isArray(t.order) && t.order.length ? t.order : Object.keys(t.steps);
    const fields = {}, mask = [];
    const set = function (id, k, v) {
      fields.steps = fields.steps || {};
      (fields.steps[id] = fields.steps[id] || {})[k] = v;
      mask.push('steps.' + id + '.' + k);
    };
    order.forEach(function (id) {
      const s = t.steps[id];
      if (!s || !s.check || s.status === 'confirmed' || s.status === 'done' || s.check.k === 'manual') return;
      const pagePath = seo6Path_(s.check.page || t.path);
      const pg = pages[seo3Norm_(origin + pagePath)];
      const pass = seo6Pass_(s.check, pg, { origin: origin, speed: speedOf, index: indexOf, redirect: redirectOf });
      if (pass === null) return;   // couldn't read the page tonight: try again tomorrow
      if (pass) {
        const was = s.status;
        set(id, 'status', 'confirmed'); set(id, 'confirmedAt', nowIso); set(id, 'missing', false);
        s.status = 'confirmed';
        confirmed++;
        const mod = wpMod[seo3Norm_(origin + pagePath)];
        logEntry(t, id, s, 'confirm', (was === 'ticked' ? 'Confirmed on the website' : 'Found already done on the website') +
          (mod ? ' · WordPress shows the page saved on ' + mod : ''));
      } else if (s.status === 'ticked') {
        const m = Number(s.misses || 0) + 1;
        set(id, 'misses', m);
        if (m >= 2) {
          set(id, 'status', 'todo'); set(id, 'missing', true);
          s.status = 'todo';
          missing++;
          logEntry(t, id, s, 'missing', 'Ticked, but not found on the website two nights running. Back on the list.');
        }
      }
    });

    const all = order.filter(function (id) { return t.steps[id]; });
    const done = all.length && all.every(function (id) { return t.steps[id].status === 'confirmed' || t.steps[id].status === 'done'; });
    if (done) {
      fields.status = 'done'; fields.doneAt = new Date(); mask.push('status', 'doneAt');
      finished++;
      logEntry(t, '', null, 'taskdone', all.length + ' step' + (all.length === 1 ? '' : 's'));
      logs.push(seo2Write_(project, 'seo_log/t' + Utilities.getUuid().replace(/-/g, ''), {
        date: today, type: SEO6_LOG_TYPE_[t.group] || 'Other', title: ('Task done: ' + (t.title || '')).slice(0, 200),
        url: t.path || '', note: all.map(function (id) { return '• ' + t.steps[id].text; }).join('\n').slice(0, 2000),
        by: 'website', byName: 'Website check', taskId: t.id, createdAt: new Date(), updatedAt: new Date(),
      }));
    }
    if (mask.length) {
      fields.updatedAt = new Date(); mask.push('updatedAt');
      writes.push(seo6Write_(project, 'seo_tasks/' + t.id, fields, mask));
    }
  });

  console.log('Tasks: ' + tasks.length + ' open, ' + keys.length + ' pages read · ' + confirmed + ' steps confirmed, ' +
    missing + ' not found, ' + finished + ' tasks finished' + (dry ? ' (test: nothing saved)' : '') + ' · ' + Math.round((Date.now() - t0) / 1000) + ' s');
  if (!dry && (writes.length || logs.length)) seo2Commit_(project, writes.concat(logs));
}

function seo6Path_(p) {
  p = String(p || '').trim().replace(/^https?:\/\/[^\/]+/i, '').split('#')[0].split('?')[0];
  return p.charAt(0) === '/' ? p : '/' + p;
}

// What a check needs from a page
function seo6Read_(html, url) {
  const p = seo3Parse_(html);
  const heads = (String(html).replace(/<!--[\s\S]*?-->/g, ' ').match(/<h[1-6]\b[\s\S]*?<\/h[1-6]\s*>/gi) || [])
    .map(function (h) { return seo3Text_(h).toLowerCase(); });
  const links = {};
  (p.hrefs || []).forEach(function (h) {
    const abs = seo3Abs_(h, url);
    if (abs) links[seo3Norm_(abs.split('?')[0])] = 1;
  });
  return {
    title: p.title || '', h1: p.h1Text || '', h1n: p.h1 || 0, desc: String(p.desc || ''),
    text: String(p.text || '').toLowerCase(), words: p.words || 0, noAlt: p.noAlt || 0, heads: heads, links: links,
    faqSchema: /FAQPage/i.test(String(html)),
  };
}

// Every meaningful word of the phrase appears in the text ("treatments" matches "treatment")
function seo6Has_(text, phrase) {
  const t = String(text || '').toLowerCase();
  const ws = String(phrase || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(function (w) { return w.length > 1 && !SEO6_STOP_[w]; });
  return ws.length > 0 && ws.every(function (w) { return t.indexOf(w.replace(/s$/, '')) !== -1; });
}

// true = done, false = not done, null = couldn't tell tonight
function seo6Pass_(k, pg, x) {
  if (k.k === 'redirect') {
    const to = x.redirect ? x.redirect(k.page) : null;
    return to == null ? null : !!to && seo3Norm_(x.origin + seo6Path_(to)) === seo3Norm_(x.origin + seo6Path_(k.to));
  }
  if (k.k === 'speed') { const s = x.speed(k.page); return s == null ? null : s >= (k.min || 50); }
  if (k.k === 'index') { const v = x.index(k.page); return v == null ? null : v === 'PASS'; }
  if (!pg) return null;
  switch (k.k) {
    case 'title': return seo6Has_(pg.title, k.has);
    case 'titleMax': return !!pg.title && pg.title.length <= (k.max || 60);
    case 'titleNot': return !!pg.title && !seo6Has_(pg.title, k.has);
    case 'h1': return pg.h1n >= 1 && seo6Has_(pg.h1, k.has);
    case 'desc': return pg.desc.length >= (k.min || 70) && pg.desc.length <= (k.max || 160) && (!k.has || seo6Has_(pg.desc, k.has));
    case 'heading': return pg.heads.some(function (h) { return seo6Has_(h, k.has); });
    case 'headingAny': return pg.heads.some(function (h) { return (k.any || []).some(function (a) { return h.indexOf(a) !== -1; }); });
    case 'text': return (k.any || []).some(function (a) { return pg.text.indexOf(String(a).toLowerCase()) !== -1; });
    case 'words': return pg.words >= (k.min || 800);
    case 'link': return !!pg.links[seo3Norm_(x.origin + seo6Path_(k.to))];
    case 'absent': {
      const re = new RegExp('(^|[^a-z0-9])' + seo3Esc_(String(k.word || '').toLowerCase()) + '([^a-z0-9]|$)');
      return !re.test(pg.text + ' ' + pg.title.toLowerCase() + ' ' + pg.desc.toLowerCase());
    }
    case 'alt': return pg.noAlt === 0;
    case 'faqSchema': return !!pg.faqSchema;
  }
  return null;
}

/** Sets only the listed fields (e.g. steps.s_ab12.status), so ticks made during the day aren't overwritten */
function seo6Write_(project, path, obj, mask) {
  const fields = {};
  Object.keys(obj).forEach(function (k) { fields[k] = seo2Val_(obj[k]); });
  return {
    update: { name: 'projects/' + project + '/databases/(default)/documents/' + path, fields: fields },
    updateMask: { fieldPaths: mask },
  };
}