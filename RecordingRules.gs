// ===================== Recording rules (System configuration → Recording rules) =====================
// Admins set the rules in the portal (Firestore recording_config/rules). On every recording:
// - spellings are fixed when the transcript is made (with the Recorder's built-in list until it's imported)
// - note-writing instructions are added to the Gemini prompt (callGeminiComplex in Soap.gs)
// - words and topics are checked when the notes are written: reminders are created, and highlights
//   and note lines are written into the notes. Everything that fired is saved as 'Rule Hits'.
// A problem here never stops the transcript or the notes.

const REC_RULES_CACHE_ = 'rec_rules_v2';
const REC_BUILTIN_ID_ = 'r_builtin'; // the imported copy of applyTranscriptCorrections_ (Soap.gs)

// Every rule, switched on or off (remembered 2 minutes)
function recRulesAll_(cfg) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(REC_RULES_CACHE_);
  if (hit) return JSON.parse(hit);
  let rules;
  try {
    const d = fsGetDoc_(cfg || getConfig_(), 'recording_config/rules');
    rules = (d && Array.isArray(d.rules) ? d.rules : []).filter(function (r) { return r && r.type; });
  } catch (e) {
    console.warn('Recording rules not read: ' + e);
    return []; // not remembered, so the next recording tries again
  }
  try { cache.put(REC_RULES_CACHE_, JSON.stringify(rules), 120); } catch (e) { /* too big to remember */ }
  return rules;
}

// Rules that are switched on
function recRules_(cfg) {
  return recRulesAll_(cfg).filter(function (r) { return r.enabled !== false; });
}

// Run from the editor after changing rules, to apply them straight away
function clearRecordingRulesCache() {
  CacheService.getScriptCache().remove(REC_RULES_CACHE_);
  console.log('Recording rules cache cleared.');
}

/* ---------- Matching (the same as the portal's recording-rules-api.js) ---------- */

function recEscRe_(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function recPhraseRe_(p, flags) {
  return new RegExp('(^|[^\\p{L}\\p{N}])(' + recEscRe_(p).replace(/\s+/g, '\\s+') + ')(?=$|[^\\p{L}\\p{N}])', flags + 'u');
}

function recSpell_(rules, text) {
  let out = String(text || '');
  (rules || []).forEach(function (r) {
    if (r.type !== 'spelling') return;
    (r.pairs || []).forEach(function (p) {
      if (!p || !p.heard || !p.correct) return;
      out = out.replace(recPhraseRe_(p.heard, 'gi'), function (m, pre) { return pre + p.correct; });
    });
  });
  return out;
}

// The transcript fixer: the Recorder's built-in corrections (until they're imported as a rule), then the spelling rules
function recTranscriptFix_(cfg) {
  const all = recRulesAll_(cfg);
  const on = all.filter(function (r) { return r.enabled !== false; });
  const builtin = !all.some(function (r) { return r.id === REC_BUILTIN_ID_; });
  return function (text) {
    return recSpell_(on, builtin ? applyTranscriptCorrections_(text) : String(text || ''));
  };
}

function recWordsHeard_(rule, text) {
  return (rule.words || []).filter(function (w) { return w && recPhraseRe_(w, 'i').test(text); });
}

function recSentenceWith_(text, words) {
  const parts = String(text || '').split(/(?<=[.!?])\s+|\n+/);
  for (let i = 0; i < parts.length; i++) {
    if (words.some(function (w) { return recPhraseRe_(w, 'i').test(parts[i]); })) return parts[i].trim().slice(0, 300);
  }
  return '';
}

function recFill_(s, vals) {
  return String(s || '').replace(/\{\s*([a-z ]+?)\s*\}/gi, function (m, k) {
    const key = k.toLowerCase().replace(/\s+/g, ' ');
    return key in vals ? vals[key] : m;
  });
}

/* ---------- Note-writing instructions → the Gemini prompt (called from callGeminiComplex) ---------- */

const REC_SECTION_LABEL_ = {
  subjective: 'the "subjective" section (Clinical notes)',
  objective: 'the "objective" section',
  assessment: 'the "assessment" section (Assessment & Plan)',
  plan: 'the "assessment" section (Assessment & Plan)', // older rules
  treatment_plan: 'the "treatment_plan" section',
  social: 'the "social_history" section',
};

function recInstructionsBlock_() {
  let list = [];
  try {
    list = recRules_(getConfig_()).filter(function (r) { return r.type === 'instruction' && String(r.instruction || '').trim(); });
  } catch (e) {
    console.warn('Instruction rules not added: ' + e);
    return '';
  }
  if (!list.length) return '';
  return '\n\n    *** CLINIC RULES (added by the clinic in System configuration) ***\n' +
    '    Follow these as well. They never change the JSON structure, the field names, the 9 concern category names, ' +
    'or the rules above about which facts belong in which section. If one conflicts with the rules above, the rules above win.\n' +
    list.map(function (r, i) {
      const where = REC_SECTION_LABEL_[r.section] ? 'In ' + REC_SECTION_LABEL_[r.section] + ': ' : '';
      return '    ' + (i + 1) + '. ' + where + String(r.instruction).replace(/\s+/g, ' ').trim().slice(0, 1000);
    }).join('\n');
}

/* ---------- "When the conversation is about…": one Gemini call for all topic rules ---------- */

const REC_TOPIC_PROMPT_ = [
  'You check a recorded consultation at an Australian cosmetic clinic against the clinic\'s rules.',
  'For EACH rule, decide whether the conversation is really about what the rule describes.',
  '- matched = true only when the conversation clearly shows it applies (for example, the patient says it is true for them).',
  '- Negatives, questions that were answered "no", and hypotheticals do NOT match ("I\'m not pregnant", "if you were pregnant").',
  '- quote = the shortest exact sentence from the transcript that shows it. Use "" when matched is false.',
  'Return one item for every rule, using its rule_id exactly.',
].join('\n');

// → { ruleId: { quote } } for the rules that matched
function recCheckTopics_(rules, text) {
  const topics = (rules || []).filter(function (r) { return r.type === 'topic' && String(r.topic || '').trim(); });
  if (!topics.length) return {};
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Missing GEMINI_API_KEY script property.');

  const schema = {
    type: 'OBJECT',
    properties: {
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: { rule_id: { type: 'STRING' }, matched: { type: 'BOOLEAN' }, quote: { type: 'STRING' } },
          required: ['rule_id', 'matched', 'quote'],
        },
      },
    },
    required: ['items'],
  };
  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({
        systemInstruction: { parts: [{ text: REC_TOPIC_PROMPT_ }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({
          rules: topics.map(function (r) { return { rule_id: r.id, about: String(r.topic).slice(0, 600) }; }),
          transcript: String(text).slice(0, 120000),
        }) }] }],
        generationConfig: {
          temperature: 0, responseMimeType: 'application/json', responseSchema: schema,
          thinkingConfig: { thinkingBudget: 512 },
        },
      }),
    });
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));

  const data = JSON.parse(res.getContentText());
  const cand = (data.candidates || [])[0] || {};
  const parsed = JSON.parse(((cand.content || {}).parts || []).map(function (p) { return p.text || ''; }).join('') || '{}');
  const ids = {};
  topics.forEach(function (r) { ids[r.id] = true; });
  const out = {};
  (Array.isArray(parsed.items) ? parsed.items : []).forEach(function (it) {
    if (it && it.matched === true && ids[it.rule_id]) out[it.rule_id] = { quote: String(it.quote || '').slice(0, 300) };
  });
  return out;
}

/* ---------- Actions ---------- */

// One reminder per rule per recording: writing the notes again never makes a second one,
// and never re-opens one that was already done.
function recReminder_(cfg, job, rule, a, text) {
  const id = 'rr_' + String(job._id).replace(/[^A-Za-z0-9_-]/g, '') + '_' + String(rule.id).replace(/[^A-Za-z0-9_-]/g, '');
  let toId = '';
  let toName = '';
  if (a.assign === 'staff') { toId = String(a.staffId || ''); toName = String(a.staffName || ''); }
  else if (a.assign !== 'anyone') { toId = String(job.createdByUid || ''); toName = String(job.staffName || ''); }
  const due = Utilities.formatDate(new Date(Date.now() + (Number(a.dueDays) || 0) * 864e5), REC_TZ_, 'yyyy-MM-dd');

  const w = updateWrite_(cfg, 'staff-task-list/' + id, {
    patientId: String(job.patientId || job.patientDocId || ''),   // the same as reminders.js
    patientName: String(job.patientName || ''),
    taskText: String(text || rule.name || 'Recording rule').slice(0, 500),
    dueDate: due,
    status: 'Open',
    assignedToId: toId,
    assignedToName: toName,
    createdAt: new Date().toISOString(),
    createdBy: 'Recording rule: ' + String(rule.name || '').slice(0, 100),
    createdByUid: '',
    recordingId: String(job._id),
    ruleId: String(rule.id || ''),
  });
  w.currentDocument = { exists: false };
  try {
    commitWrites_(cfg, [w]);
  } catch (e) {
    if (!/ALREADY_EXISTS|FAILED_PRECONDITION|already exists/i.test(String(e))) throw e;
  }
  return id;
}

// Checks the rules against a finished transcript and runs the reminders. → the hits (saved as 'Rule Hits')
function recApplyRules_(cfg, job, transcript) {
  const rules = recRules_(cfg);
  const active = rules.filter(function (r) { return r.type === 'words' || r.type === 'topic'; });
  if (!active.length) return [];

  const text = recSpell_(rules, String(transcript || '').replace(/<[^>]*>?/gm, '\n').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n'));
  let topics = {};
  try { topics = recCheckTopics_(rules, text); }
  catch (e) { console.warn('Topic rules not checked for ' + job._id + ': ' + e); }

  const hits = [];
  active.forEach(function (rule) {
    let heard = [];
    let said = '';
    if (rule.type === 'words') {
      heard = recWordsHeard_(rule, text);
      if (!heard.length) return;
      said = recSentenceWith_(text, heard);
    } else {
      if (!topics[rule.id]) return;
      said = topics[rule.id].quote;
    }
    const vals = { 'patient name': String(job.patientName || 'the patient'), 'words heard': heard.join(', '), 'what was said': said };
    const hit = { ruleId: String(rule.id || ''), name: String(rule.name || ''), type: rule.type, heard: heard, said: said,
      flags: [], notes: [], reminders: [] };
    (rule.actions || []).forEach(function (a) {
      const t = recFill_(a.text, vals).trim().slice(0, 500);
      try {
        if (a.type === 'flag') hit.flags.push(t || rule.name);
        else if (a.type === 'note' && t) hit.notes.push({ section: String(a.section || ''), text: t });
        else if (a.type === 'reminder') hit.reminders.push(recReminder_(cfg, job, rule, a, t));
      } catch (e) {
        console.error('Rule "' + rule.name + '" action ' + a.type + ' failed: ' + e);
      }
    });
    hits.push(hit);
  });
  return hits;
}

/* ---------- Highlights and note lines → the notes (before formatSoapFromJSON) ---------- */

function recNoteSection_(s) {
  if (s === 'objective') return 'objective';
  if (s === 'assessment' || s === 'plan' || s === 'treatment_plan') return 'assessment';
  if (s === 'social') return 'social';
  return 'subjective';
}

// Highlights go at the top of the Clinical notes (⚠ lines); note lines go at the end of their section
function recAddToNotes_(data, hits) {
  if (!data || typeof data !== 'object' || !Array.isArray(hits) || !hits.length) return data;
  const flags = [];
  const add = { subjective: [], objective: [], assessment: [], social: [] };
  const one = function (t) { return String(t || '').replace(/\s+/g, ' ').trim(); };
  hits.forEach(function (h) {
    (h.flags || []).forEach(function (f) { f = one(f); if (f && flags.indexOf(f) === -1) flags.push(f); });
    (h.notes || []).forEach(function (n) { const t = one(n && n.text); if (t) add[recNoteSection_(n.section)].push(t); });
  });
  const bullets = function (arr) { return arr.map(function (t) { return '- ' + t; }).join('\n'); };

  data.subjective = [
    flags.map(function (f) { return '⚠ ' + f; }).join('\n'),
    String(data.subjective || '').trim(),
    bullets(add.subjective),
  ].filter(Boolean).join('\n\n');
  ['objective', 'assessment'].forEach(function (k) {
    if (add[k].length) data[k] = [String(data[k] || '').trim(), bullets(add[k])].filter(Boolean).join('\n');
  });
  if (add.social.length) {
    if (!data.social_history || typeof data.social_history !== 'object') data.social_history = {};
    data.social_history.other_relevant_social_history =
      [String(data.social_history.other_relevant_social_history || '').trim(), add.social.join('; ')].filter(Boolean).join('\n');
  }
  return data;
}

/* ---------- Test rules (System configuration → Test rules → Check with Gemini) ---------- */

function handleRecordingRules_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!/^admin$/i.test(String(session.role || ''))) return { ok: false, error: 'FORBIDDEN' };
  if (String(body.op || '') !== 'test') return { ok: false, error: 'BAD_REQUEST' };
  const text = String(body.text || '').slice(0, 50000);
  if (!text.trim()) return { ok: false, error: 'BAD_REQUEST' };

  CacheService.getScriptCache().remove(REC_RULES_CACHE_); // test the rules as saved right now
  const cfg = getConfig_();
  const rules = recRules_(cfg);
  try {
    const t = recCheckTopics_(rules, recSpell_(rules, text));
    return { ok: true, matches: Object.keys(t).map(function (id) { return { ruleId: id, quote: t[id].quote }; }) };
  } catch (e) {
    console.error('Topic test failed: ' + (e && e.stack ? e.stack : e));
    return { ok: false, error: 'GEMINI_FAILED' };
  }
}