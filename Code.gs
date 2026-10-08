/**
 * Dermedica Staff PIN Login endpoint
 * Verifies a PIN against Firestore 'staff_access' and returns a Firebase custom token.
 * Secrets live in Script Properties only. Never hardcode them here.
 */

const STAFF_COLLECTION = 'staff_access';
const MAX_FAILS = 10;           // failed attempts allowed...
const LOCK_SECONDS = 15 * 60;   // ...within this window before lockout
const APPTS_SHEET_ID = '1nbab_cc0hfgGEsjzERwsYv8whH-oJ1CSwgu0vSJ-uGk';
const APPTS_SHEET_NAME = 'pcn_appts_today';
const RESULTS_SHEET_NAME = 'pcn_results';
const PAST_VISITS_SHEET_NAME = 'past_visits';
const FUTURE_VISITS_SHEET_NAME = 'future-visits';
const SESSION_SECONDS = 6 * 60 * 60; // 6 hours (CacheService maximum)

// ===================== Web app entry points =====================

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // Non-login requests
    if (body.action === 'appointments') return json_(handleAppointments_(body));
    if (body.action === 'preconsult') return json_(handlePreconsult_(body));
    if (body.action === 'processRecording') return json_(handleProcessRecording_(body));
    if (body.action === 'deleteRecording') return json_(handleDeleteRecording_(body));
    if (body.action === 'sendTreatmentEmail') return json_(handleSendTreatmentEmail_(body));
    if (body.action === 'regenerateSoap') return json_(handleRegenerateSoap_(body));
    if (body.action === 'emailFromPlan') return json_(handleEmailFromPlan_(body));

    const pin = String(body.pin || '').trim();

    if (!/^\d{4,8}$/.test(pin)) return json_({ ok: false, error: 'INVALID_PIN' });
    if (isLockedOut_()) return json_({ ok: false, error: 'LOCKED' });

    const staff = findStaffByPin_(pin);
    if (!staff) {
      registerFail_();
      Utilities.sleep(800); // slows brute-force attempts
      return json_({ ok: false, error: 'INVALID_PIN' });
    }

    const token = createCustomToken_(staff.id, {
      staffName: staff.name,
      staffRole: staff.role,
      staffPhoto: staff.photo,
      staffEmail: staff.email,
    });

    const session = createSession_(staff);
    return json_({ ok: true, token: token, session: session });
  } catch (err) {
    console.error('Login error:', err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'SERVER_ERROR' });
  }
}

// Health check + warm-up. "?warm=1" pre-loads the staff list so the real login is faster.
// Returns nothing sensitive.
function doGet(e) {
  if (e && e.parameter && e.parameter.warm) {
    try { getStaffDocs_(); } catch (err) { console.warn('Warm-up failed: ' + err); }
  }
  return json_({ ok: true, status: 'alive' });
}

// ===================== Firestore lookup =====================

function findStaffByPin_(pin) {
  const matches = getStaffDocs_().filter(function (s) { return s.pin === pin; });
  if (matches.length > 1) throw new Error('Duplicate PIN found in ' + STAFF_COLLECTION);
  return matches[0] || null;
}

// Staff list from Firestore, cached inside Apps Script (never sent to the browser)
function getStaffDocs_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('staff_docs_v1');
  if (cached) return JSON.parse(cached);

  const cfg = getConfig_();
  const url = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId +
              '/databases/(default)/documents/' + STAFF_COLLECTION + '?pageSize=300';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Firestore ' + res.getResponseCode() + ': ' + res.getContentText());
  }

  const docs = (JSON.parse(res.getContentText()).documents || []).map(function (d) {
    return {
      id: d.name.split('/').pop(), // Firestore doc ID becomes the Auth UID
      pin: field_(d.fields, 'PIN'),
      name: field_(d.fields, 'Staff Name'),
      role: field_(d.fields, 'Role'),
      photo: field_(d.fields, 'Profile Photo'),
      email: field_(d.fields, 'Email address'),
    };
  });

  try {
    cache.put('staff_docs_v1', JSON.stringify(docs), STAFF_CACHE_SECONDS);
  } catch (err) {
    console.warn('Staff cache skipped: ' + err); // still works, just uncached
  }
  return docs;
}

// Field names must match Firestore EXACTLY (case + spaces).
// Also tolerates a PIN accidentally saved as a number.
function field_(fields, key) {
  if (!fields || !fields[key]) return '';
  const v = fields[key];
  if (v.stringValue !== undefined) return String(v.stringValue).trim();
  if (v.integerValue !== undefined) return String(v.integerValue).trim();
  return '';
}

// ===================== Tokens (JWT signing) =====================

function getConfig_() {
  const p = PropertiesService.getScriptProperties();
  const email = p.getProperty('FIRESTORE_EMAIL');
  // Keys copied from JSON often contain literal "\n". Convert to real newlines.
  const key = (p.getProperty('FIRESTORE_KEY') || '').replace(/\\n/g, '\n');
  const projectId = p.getProperty('FIRESTORE_PROJECT_ID');
  if (!email || !key || !projectId) throw new Error('Missing Script Properties');
  return { email: email, key: key, projectId: projectId };
}

function b64url_(input) {
  const bytes = typeof input === 'string' ? Utilities.newBlob(input).getBytes() : input;
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, ''); // JWT needs no padding
}

function signJwt_(payload, cfg) {
  const unsigned = b64url_(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
                   b64url_(JSON.stringify(payload));
  const signature = Utilities.computeRsaSha256Signature(unsigned, cfg.key);
  return unsigned + '.' + b64url_(signature);
}

// OAuth access token for the Firestore REST API (cached ~50 min)
function getAccessToken_(cfg) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('sa_access_token_v3');
  if (cached) return cached;

  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt_({
    iss: cfg.email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/devstorage.read_write',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }, cfg);

  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion },
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  if (!data.access_token) throw new Error('Access token error: ' + res.getContentText());

  cache.put('sa_access_token_v3', data.access_token, 3000);
  return data.access_token;
}

// Firebase custom token, which the browser exchanges via signInWithCustomToken()
function createCustomToken_(uid, claims) {
  const cfg = getConfig_();
  const now = Math.floor(Date.now() / 1000);
  return signJwt_({
    iss: cfg.email,
    sub: cfg.email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid: uid,
    claims: claims,
  }, cfg);
}

// ===================== Brute-force protection =====================

function isLockedOut_() {
  return Number(CacheService.getScriptCache().get('pin_fails') || 0) >= MAX_FAILS;
}

function registerFail_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    const cache = CacheService.getScriptCache();
    const fails = Number(cache.get('pin_fails') || 0) + 1;
    cache.put('pin_fails', String(fails), LOCK_SECONDS);
  } finally {
    lock.releaseLock();
  }
}

// ===================== Manual admin helpers (run from the editor) =====================

function unlockLogins() {
  CacheService.getScriptCache().remove('pin_fails');
  console.log('Login lockout cleared.');
}

function testLookup() {
  const staff = findStaffByPin_('3768'); // test PIN. Remove after testing.
  console.log(staff ? 'Found: ' + staff.name + ' (' + staff.role + ')' : 'No match');
}



// ===================== Response helper =====================

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ===================== Sessions =====================

function createSession_(staff) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  CacheService.getScriptCache().put(
    'sess_' + token,
    JSON.stringify({ uid: staff.id, name: staff.name, role: staff.role }),
    SESSION_SECONDS
  );
  return token;
}

function getSession_(token) {
  if (!/^[a-f0-9]{64}$/i.test(token || '')) return null;
  const raw = CacheService.getScriptCache().get('sess_' + token);
  return raw ? JSON.parse(raw) : null;
}

// ===================== Appointments (Google Sheet) =====================

const MONTHS_ = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function handleAppointments_(body) {
  if (!getSession_(String(body.session || ''))) return { ok: false, error: 'UNAUTHORIZED' };

  const dateKey = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return { ok: false, error: 'BAD_DATE' };

  const ss = SpreadsheetApp.openById(APPTS_SHEET_ID);
  const sheet = ss.getSheetByName(APPTS_SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab not found: ' + APPTS_SHEET_NAME);
  const tz = ss.getSpreadsheetTimeZone();

  const appointments = [];
  const lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    const range = sheet.getRange(2, 1, lastRow - 1, 11); // columns A:K
    const values = range.getValues();          // real values (for dates)
    const display = range.getDisplayValues();  // text as shown (for times/names)
    const groups = {};

    for (let i = 0; i < values.length; i++) {
      if (toDateKey_(values[i][0], tz) !== dateKey) continue; // Column A

      const row = display[i];
      const patientName = row[1].trim();             // B
      const timeRange = row[6].trim();               // G  "10:00 am - 11:00 am"
      const staff = row[8].trim() || 'Unassigned';   // I
      const service = row[9].trim();                 // J
      const patientId = row[10].trim();              // K
      if (!patientName && !patientId) continue;

      const start = timeRange.split('-')[0].trim();

      // One card per staff + patient + start time. Extra rows = extra services.
      const key = [staff, patientId || patientName, start].join('|');
      if (!groups[key]) {
        groups[key] = {
          staff: staff,
          patientName: patientName,
          patientId: patientId,
          time: start,
          timeRange: timeRange,
          sortMinutes: toMinutes_(start),
          services: [],
        };
        appointments.push(groups[key]);
      }
      if (service && groups[key].services.indexOf(service) === -1) {
        groups[key].services.push(service);
      }
    }
  }

  return { ok: true, date: dateKey, lastUpdated: getLastUpdated_(), appointments: appointments };
}

// Handles real date cells AND text like "October 7, 2026"
function toDateKey_(value, tz) {
  if (value instanceof Date && !isNaN(value)) return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  const s = String(value || '').trim();

  let m = s.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS_[m[1].slice(0, 3).toLowerCase()];
    if (mo) return m[3] + '-' + pad2_(mo) + '-' + pad2_(m[2]);
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  return '';
}

// "1:15 pm" -> 795 (minutes since midnight), used for sorting
function toMinutes_(t) {
  const m = String(t).toLowerCase().match(/(\d{1,2}):(\d{2})\s*(am|pm)?/);
  if (!m) return 9999;
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (m[3] === 'pm' ? 12 : 0);
  return h * 60 + Number(m[2]);
}

function pad2_(n) {
  return ('0' + n).slice(-2);
}

function getLastUpdated_() {
  try {
    return DriveApp.getFileById(APPTS_SHEET_ID).getLastUpdated().toISOString();
  } catch (err) {
    console.warn('Could not read last updated time:', err);
    return null;
  }
}

// Run from the editor to test (and to authorise Sheets/Drive access)
function testAppointments() {
  const session = createSession_({ id: 'test', name: 'Test', role: 'Admin' });
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const res = handleAppointments_({ session: session, date: today });
  console.log('Appointments today: ' + (res.appointments ? res.appointments.length : res.error));
  console.log(JSON.stringify(res).slice(0, 1500));
}

// ===================== Pre-consultation (pcn_results sheet) =====================

// Columns A..Q, in order
const RESULT_FIELDS_ = [
  'patientName',       // A
  'patientId',         // B
  'apptToday',         // C
  'wrinkleRelaxer',    // D
  'fillerRadiesse',    // E
  'restoraGlow',       // F  RestoraGlow/RF/DermaGlow/Skin Needling
  'laserOplPeel',      // G
  'firmUlthera',       // H  Firm/Ulthera/eST
  'other',             // I
  'futureVisits',      // J
  'overdue',           // K  Overdue Treatments
  'skinScriptDate',    // L  Skin Script Record Date
  'packages',          // M  Customer Package
  'otherInjectables',  // N
  'bodySculpting',     // O
  'hydraRepair',       // P  Hydrarepair/SkinRemod/CG
  'collagenActivator', // Q
];

function handlePreconsult_(body) {
  if (!getSession_(String(body.session || ''))) return { ok: false, error: 'UNAUTHORIZED' };

  const ids = (Array.isArray(body.ids) ? body.ids : [])
    .map(function (s) { return String(s).trim(); })
    .filter(Boolean)
    .slice(0, 3);
  const name = String(body.name || '').trim();
  if (!ids.length && !name) return { ok: false, error: 'BAD_REQUEST' };

  const sheet = SpreadsheetApp.openById(APPTS_SHEET_ID).getSheetByName(RESULTS_SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab not found: ' + RESULTS_SHEET_NAME);

  const lastUpdated = getLastUpdated_();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { ok: true, found: false, lastUpdated: lastUpdated };

  // 1) Match by Patient ID (Column B)
  let row = 0;
  for (let i = 0; i < ids.length && !row; i++) row = findRow_(sheet, 2, ids[i], lastRow, false);

  // 2) Fallback: exact name (Column A), ONLY if exactly one row has that name
  if (!row && name) row = findRow_(sheet, 1, name, lastRow, true);

  if (!row) return { ok: true, found: false, lastUpdated: lastUpdated };

  const values = sheet.getRange(row, 1, 1, RESULT_FIELDS_.length).getDisplayValues()[0];
  const data = {};
  RESULT_FIELDS_.forEach(function (key, i) { data[key] = String(values[i] || '').trim(); });

  return { ok: true, found: true, data: data, lastUpdated: lastUpdated };
}

// Finds a row by exact (case-insensitive) cell match within one column
function findRow_(sheet, col, text, lastRow, mustBeUnique) {
  const matches = sheet.getRange(2, col, lastRow - 1, 1)
    .createTextFinder(text)
    .matchEntireCell(true)
    .matchCase(false)
    .findAll();
  if (!matches.length) return 0;
  if (mustBeUnique && matches.length > 1) return 0;
  return matches[0].getRow();
}

// Run from the editor to test. Change '138' to a real Patient ID.
function testPreconsult() {
  const session = createSession_({ id: 'test', name: 'Test', role: 'Admin' });
  const res = handlePreconsult_({ session: session, ids: ['138'], name: '' });
  console.log(JSON.stringify(res, null, 2));
}

// ===================== Sync: Google Sheets -> Firestore =====================

const SYNC_BATCH_ = 300; // writes per Firestore commit (max 500)

// Main sync. The 10-minute trigger runs this. Skips instantly if the sheet hasn't changed.
function syncSheetsToFirestore() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { console.log('Sync already running. Skipped.'); return; }

  try {
    // SSP + invoices (separate spreadsheet). A failure here must not block the main sync.
    try { syncSspIfChanged_(); } catch (err) { console.error('Skincare sync failed: ' + err); }

    const props = PropertiesService.getScriptProperties();
    const sheetUpdated = DriveApp.getFileById(APPTS_SHEET_ID).getLastUpdated().toISOString();
    if (props.getProperty('LAST_SYNCED_SHEET_UPDATE') === sheetUpdated) {
      console.log('No changes since last sync.');
      return;
    }

    const cfg = getConfig_();
    const ss = SpreadsheetApp.openById(APPTS_SHEET_ID);

    const patients = syncResults_(ss, cfg);
    const days = syncAppointments_(ss, cfg);

    commitWrites_(cfg, [updateWrite_(cfg, 'sync_meta/pcn', {
      sheetUpdatedAt: sheetUpdated,
      syncedAt: new Date().toISOString(),
      patients: patients,
      days: days,
    })]);

    // Only marked done after everything succeeded, so failures retry next run
    props.setProperty('LAST_SYNCED_SHEET_UPDATE', sheetUpdated);
    console.log('Synced ' + patients + ' patients and ' + days + ' day(s) of appointments.');
  } finally {
    lock.releaseLock();
  }
}

// Run manually to force a full sync even if the sheet hasn't changed
function forceSync() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_SYNCED_SHEET_UPDATE');
  PropertiesService.getScriptProperties().deleteProperty('LAST_SYNCED_SSP_UPDATE');
  syncSheetsToFirestore();
}

// Run ONCE to schedule the sync every 10 minutes
function installSyncTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'syncSheetsToFirestore'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('syncSheetsToFirestore').timeBased().everyMinutes(10).create();
  console.log('Sync trigger installed (every 10 minutes).');
}

// ---- pcn_results -> Firestore 'pcn_results/{PatientID}' ----
function syncResults_(ss, cfg) {
  const sheet = ss.getSheetByName(RESULTS_SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab not found: ' + RESULTS_SHEET_NAME);

  const lastRow = sheet.getLastRow();
  const rows = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, RESULT_FIELDS_.length).getDisplayValues()
    : [];

  const writes = [];
  const keep = {};

  rows.forEach(function (r) {
    const data = {};
    RESULT_FIELDS_.forEach(function (key, i) { data[key] = String(r[i] || '').trim(); });

    const id = docId_(data.patientId);
    if (!id || keep[id]) return; // skip blank IDs; for duplicate IDs the first row wins
    keep[id] = true;

    data.nameKey = data.patientName.toLowerCase().replace(/\s+/g, ' ').trim(); // for name fallback
    writes.push(updateWrite_(cfg, 'pcn_results/' + id, data));
  });

  // Safety net: never wipe Firestore because the sheet was caught empty mid-upload
  if (!writes.length) throw new Error('pcn_results looks empty. Sync aborted to protect existing data.');

  // Remove patients that are no longer in the sheet
  listDocIds_(cfg, 'pcn_results').forEach(function (id) {
    if (!keep[id]) writes.push(deleteWrite_(cfg, 'pcn_results/' + id));
  });

  commitWrites_(cfg, writes);
  return Object.keys(keep).length;
}

// ---- Appointments -> Firestore 'appts_by_day/{YYYY-MM-DD}' ----
// Sources: pcn_appts_today (wins for its own dates) + past_visits + future-visits
function syncAppointments_(ss, cfg) {
  const tz = ss.getSpreadsheetTimeZone();
  const days = {};
  const groups = {};

  // 1) Today's schedule: the most current source for its dates
  const todaySheet = ss.getSheetByName(APPTS_SHEET_NAME);
  if (!todaySheet) console.warn('Sheet tab not found (skipped): ' + APPTS_SHEET_NAME);
  collectAppointments_(todaySheet, tz, days, groups, null, false);

  const todayDates = {};
  Object.keys(days).forEach(function (d) { todayDates[d] = true; });

  // 2) Past + future visits: same columns, plus status / balance / resources / category
  [PAST_VISITS_SHEET_NAME, FUTURE_VISITS_SHEET_NAME].forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) { console.warn('Sheet tab not found (skipped): ' + name); return; }
    collectAppointments_(sheet, tz, days, groups, todayDates, true);
  });

  const dates = Object.keys(days).sort();
  if (!dates.length) return 0;

  const writes = dates.map(function (d) {
    return updateWrite_(cfg, 'appts_by_day/' + d, { date: d, appointments: days[d] });
  });

  // Remove day documents INSIDE the synced date range that no longer have any appointments
  const first = dates[0];
  const last = dates[dates.length - 1];
  listDocIds_(cfg, 'appts_by_day').forEach(function (id) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(id) && id >= first && id <= last && !days[id]) {
      writes.push(deleteWrite_(cfg, 'appts_by_day/' + id));
    }
  });

  commitWrites_(cfg, writes, 100);
  return dates.length;
}

// Shared column layout for all three tabs:
// A Date | B Patient Name | C Outstanding Balance | D Contact # | E Resources | F Symbol
// G Time | H Status | I Staff | J Service | K Patient ID | L Category
function collectAppointments_(sheet, tz, days, groups, skipDates, extended) {
  if (!sheet) return;
  const cell = function (row, i) { return String(row[i] || '').trim(); };
  const numCols = Math.min(12, sheet.getMaxColumns()); // today's sheet may have fewer columns

  readRows_(sheet, numCols).forEach(function (r) {
    const v = r.values, d = r.display;

    const dateKey = sheetDateKey_(v[0], tz);
    if (!dateKey) return;
    if (skipDates && skipDates[dateKey]) return; // today's schedule wins for its dates

    const patientName = cell(d, 1);
    const timeRange = cell(d, 6);
    const staff = cell(d, 8) || 'Unassigned';
    const service = cell(d, 9);
    const patientId = cell(d, 10);
    if (!patientName && !patientId) return;

    const start = timeRange.split('-')[0].trim();
    const key = [dateKey, staff, patientId || patientName, start].join('|');

    if (!groups[key]) {
      groups[key] = {
        staff: staff, patientName: patientName, patientId: patientId,
        time: start, timeRange: timeRange, sortMinutes: toMinutes_(start), services: [],
      };
      if (extended) {
        groups[key].status = cell(d, 7);
        groups[key].balance = cell(d, 2);
        groups[key].resources = cell(d, 4);
        groups[key].category = cell(d, 11);
      }
      (days[dateKey] = days[dateKey] || []).push(groups[key]);
    }
    if (service && groups[key].services.indexOf(service) === -1) groups[key].services.push(service);
  });
}

// ---- Firestore REST helpers ----
function fsBase_(cfg) {
  return 'projects/' + cfg.projectId + '/databases/(default)/documents';
}

function docId_(raw) {
  const s = String(raw || '').trim().replace(/\//g, '_'); // "/" isn't allowed in doc IDs
  if (!s || s === '.' || s === '..' || /^__.*__$/.test(s)) return '';
  return s;
}

function updateWrite_(cfg, path, obj) {
  return { update: { name: fsBase_(cfg) + '/' + path, fields: toFields_(obj) } };
}

function deleteWrite_(cfg, path) {
  return { delete: fsBase_(cfg) + '/' + path };
}

function commitWrites_(cfg, writes, batchSize) {
  const size = batchSize || SYNC_BATCH_;
  for (let i = 0; i < writes.length; i += size) {
    const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + ':commit', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
      payload: JSON.stringify({ writes: writes.slice(i, i + size) }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('Firestore commit ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 500));
    }
  }
}

function listDocIds_(cfg, collection) {
  const ids = [];
  let pageToken = '';
  do {
    const url = 'https://firestore.googleapis.com/v1/' + fsBase_(cfg) + '/' + collection +
      '?pageSize=1000&mask.fieldPaths=nameKey' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('Firestore list ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 500));
    }
    const data = JSON.parse(res.getContentText());
    (data.documents || []).forEach(function (d) { ids.push(d.name.split('/').pop()); });
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return ids;
}

function toFields_(obj) {
  const fields = {};
  Object.keys(obj).forEach(function (k) { fields[k] = toValue_(obj[k]); });
  return fields;
}

function toValue_(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue_) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields_(v) } };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  return { stringValue: String(v) };
}

// Run ONCE: replaces the 10-minute trigger with a single daily sync around 8:30am
function installDailySyncTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'syncSheetsToFirestore'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('syncSheetsToFirestore')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .nearMinute(30) // fires roughly 8:15–8:45
    .create();

  console.log('Daily sync trigger installed (~8:30am, script time zone).');
}

// ===================== Sync: SSP + invoices -> Firestore 'skincare/{patient}' =====================

const SSP_SHEET_ID = '10U8XLzg3pkOr4z9Uhg9ToBU7LnGidEoDKj1FjBfTWWs';
const SSP_SHEET_NAME = 'SSP_NEW';
const INVOICE_SHEET_NAME = 'INVOICE RECORD';

function syncSspIfChanged_() {
  const props = PropertiesService.getScriptProperties();
  const updated = DriveApp.getFileById(SSP_SHEET_ID).getLastUpdated().toISOString();
  if (props.getProperty('LAST_SYNCED_SSP_UPDATE') === updated) return;

  const count = syncSkincare_(getConfig_());
  props.setProperty('LAST_SYNCED_SSP_UPDATE', updated);
  console.log('Synced skincare for ' + count + ' patients.');
}

function syncSkincare_(cfg) {
  const ss = SpreadsheetApp.openById(SSP_SHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const patients = {}; // docId -> { patientId, patientName, nameKey, protocols: {recordId: {...}}, purchases: [] }

  // Keyed by Patient ID; rows without an ID fall back to "name__<name>"
  function patientFor(id, name) {
    const nameKey = String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const key = docId_(id) || (nameKey ? docId_('name__' + nameKey) : '');
    if (!key) return null;
    if (!patients[key]) {
      patients[key] = {
        patientId: String(id || '').trim(), patientName: String(name || '').trim(),
        nameKey: nameKey, protocols: {}, purchases: [],
      };
    }
    return patients[key];
  }

  // SSP_NEW: A RECORD ID | B ENCODED DATETIME | C PATIENT NAME | D Patient ID | E PRODUCT NAME | F PROTOCOL
  //          G MAINTENANCE | H RATING | I FULL OR PARTIAL | J AM | K PM | L WHEN TO USE | M STEP
  const ssp = ss.getSheetByName(SSP_SHEET_NAME);
  if (!ssp) throw new Error('Sheet tab not found: ' + SSP_SHEET_NAME);
  readRows_(ssp, 13).forEach(function (r) {
    const v = r.values, d = r.display;
    const p = patientFor(d[3], d[2]);
    const product = d[4].trim();
    if (!p || !product) return;

    const date = sheetDateKey_(v[1], tz);
    const recordId = d[0].trim() || ('undated-' + date);
    if (!p.protocols[recordId]) {
      p.protocols[recordId] = { recordId: recordId, date: date, dateText: d[1].trim(), items: [] };
    }
    p.protocols[recordId].items.push({
      product: product, protocol: d[5].trim(), maintenance: d[6].trim(), rating: d[7].trim(),
      fullOrPartial: d[8].trim(), am: d[9].trim(), pm: d[10].trim(), whenToUse: d[11].trim(), step: d[12].trim(),
    });
  });

  // INVOICE RECORD: A Invoice ID | B InvoiceDate | C CustomerName | D Patient ID | E StaffName | F Product Name
  const inv = ss.getSheetByName(INVOICE_SHEET_NAME);
  if (!inv) throw new Error('Sheet tab not found: ' + INVOICE_SHEET_NAME);
  readRows_(inv, 6).forEach(function (r) {
    const v = r.values, d = r.display;
    const p = patientFor(d[3], d[2]);
    const product = d[5].trim();
    if (!p || !product) return;
    p.purchases.push({
      invoiceId: d[0].trim(), date: sheetDateKey_(v[1], tz), dateText: d[1].trim(),
      staff: d[4].trim(), product: product,
    });
  });

  const keys = Object.keys(patients);
  if (!keys.length) throw new Error('SSP / invoice sheets look empty. Skincare sync aborted to protect existing data.');

  const writes = keys.map(function (key) {
    const p = patients[key];
    return updateWrite_(cfg, 'skincare/' + key, {
      patientId: p.patientId,
      patientName: p.patientName,
      nameKey: p.nameKey,
      protocols: Object.keys(p.protocols).map(function (k) { return p.protocols[k]; }),
      purchases: p.purchases,
    });
  });

  // Remove patients no longer in either sheet
  const keep = {};
  keys.forEach(function (k) { keep[k] = true; });
  listDocIds_(cfg, 'skincare').forEach(function (id) {
    if (!keep[id]) writes.push(deleteWrite_(cfg, 'skincare/' + id));
  });

  commitWrites_(cfg, writes, 50); // smaller batches: these documents hold long instructions
  return keys.length;
}

function readRows_(sheet, numCols) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const range = sheet.getRange(2, 1, lastRow - 1, numCols);
  const values = range.getValues();
  const display = range.getDisplayValues();
  return values.map(function (v, i) {
    return { values: v, display: display[i].map(function (x) { return String(x); }) };
  });
}

// Date cell -> "yyyy-MM-dd" (real dates, "October 22, 2025", "2025-10-22", or Australian "22/10/2025")
function sheetDateKey_(value, tz) {
  const k = toDateKey_(value, tz);
  if (k) return k;
  const s = String(value || '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + pad2_(m[2]) + '-' + pad2_(m[1]);
  const d = new Date(s);
  return isNaN(d) ? '' : Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

// Run from the editor to test the skincare sync on its own
function testSkincareSync() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_SYNCED_SSP_UPDATE');
  syncSspIfChanged_();
}

// ===================== Staff cache =====================

const STAFF_CACHE_SECONDS = 5 * 60; // new/changed PINs take effect within 5 minutes

// Run from the editor after adding staff or changing a PIN, to apply it immediately
function clearStaffCache() {
  CacheService.getScriptCache().remove('staff_docs_v1');
  console.log('Staff cache cleared.');
}


// ===================== Consultation recordings: Deepgram -> Gemini (Recorder prompts) -> Firestore =====================
// Two separate runs per recording (transcribe, then write notes) so each stays well under 6 minutes.
// The prompts, schema and formatting come from Soap.gs (copied from the Recorder app).

const STUCK_AFTER_MS_ = 15 * 60 * 1000; // a stage "in progress" this long is assumed to have crashed
const REC_TZ_ = 'Australia/Perth';

function handleProcessRecording_(body) {
  if (!getSession_(String(body.session || ''))) return { ok: false, error: 'UNAUTHORIZED' };
  const id = String(body.recordingId || '');
  if (!/^REC-[A-Z0-9-]{6,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  return processJob_(id, true);
}

// Runs every 5 minutes: finishes any waiting / stalled / failed jobs
function processPendingRecordings() {
  const cfg = getConfig_();
  const started = Date.now();
  const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + ':runQuery', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    payload: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: 'recording_jobs' }],
        where: { fieldFilter: {
          field: { fieldPath: 'status' }, op: 'IN',
          value: { arrayValue: { values: ['uploaded', 'transcribed', 'failed', 'transcribing', 'writing']
            .map(function (s) { return { stringValue: s }; }) } },
        } },
        limit: 10,
      },
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Job query ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));

  JSON.parse(res.getContentText()).forEach(function (row) {
    if (!row.document) return;
    const id = row.document.name.split('/').pop();
    if (Date.now() - started > 3 * 60 * 1000) return; // leave room before the 6-minute limit
    const r = processJob_(id, false);
    if (r.next && Date.now() - started < 3 * 60 * 1000) processJob_(id, false); // write notes straight after
  });
}

// Run ONCE from the editor to schedule the sweeper
function installRecordingSweeper() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'processPendingRecordings'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('processPendingRecordings').timeBased().everyMinutes(5).create();
  console.log('Recording sweeper installed (every 5 minutes).');
}

function processJob_(id, manual) {
  const cfg = getConfig_();
  const job = claimJob_(cfg, id, manual);
  if (!job) return { ok: false, error: 'NOT_CLAIMABLE' };

  const jobPath = 'recording_jobs/' + id;
  const stage = job._stage;

  try {
    if (stage === 'transcribing') {
      transcribeStage_(cfg, job);
      fsPatch_(cfg, jobPath, { status: 'transcribed', stageAt: new Date().toISOString() });
      return { ok: true, next: true }; // notes are written in a separate run
    }

    writeNotesStage_(cfg, job);
    fsPatch_(cfg, jobPath, { status: 'ready', stageAt: new Date().toISOString(), transcriptId: id, error: '' });
    return { ok: true, transcriptId: id };
  } catch (err) {
    console.error('Recording ' + id + ' failed at ' + stage + ': ' + (err && err.stack ? err.stack : err));
    const failedStage = (stage === 'writing' && !err.retranscribe) ? 'writing' : 'transcribing';
    try {
      fsPatch_(cfg, jobPath, {
        status: 'failed', failedStage: failedStage, stageAt: new Date().toISOString(),
        error: String((err && err.message) || err).slice(0, 300),
      });
    } catch (e2) { console.error('Could not mark job failed: ' + e2); }
    if (stage === 'writing') {
      try { fsPatch_(cfg, 'appointment_transcripts/' + id, { 'Status': 'Transcribed - SOAP Failed (regenerate available)' }); } catch (e3) { }
    }
    return { ok: false, error: 'FAILED' };
  }
}

// Decides which stage to run and marks it in progress (so two runs never do the same work)
function claimJob_(cfg, id, manual) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return null;
  try {
    const job = fsGetDoc_(cfg, 'recording_jobs/' + id);
    if (!job) return null;

    const attempts = Number(job.attempts || 0);
    const stuck = (job.status === 'transcribing' || job.status === 'writing') &&
      job.stageAt && (Date.now() - Date.parse(job.stageAt) > STUCK_AFTER_MS_);

    let stage = null;
    if (job.status === 'uploaded') stage = 'transcribing';
    else if (job.status === 'transcribed') stage = 'writing';
    else if (stuck) stage = job.status;
    else if (job.status === 'failed' && (manual || attempts < 4)) {
      stage = job.failedStage === 'writing' ? 'writing' : 'transcribing';
    }
    if (!stage) return null;

    fsPatch_(cfg, 'recording_jobs/' + id, {
      status: stage, stageAt: new Date().toISOString(), attempts: attempts + 1, error: '',
    });
    job._stage = stage;
    return job;
  } finally {
    lock.releaseLock();
  }
}

// STEP 1: audio -> Deepgram -> appointment_transcripts (Status: "Transcribed - Processing SOAP")
function transcribeStage_(cfg, job) {
  const audio = downloadAudio_(cfg, job.audioPath);
  const dg = deepgram_(audio, job.mimeType, job.staffName);
  const started = job.startedAt ? new Date(job.startedAt) : new Date();
  const id = job.recordingId;

  commitWrites_(cfg, [updateWrite_(cfg, 'appointment_transcripts/' + id, {
    'Record ID': id,
    'Status': 'Transcribed - Processing SOAP',
    'Record Date and Time': Utilities.formatDate(started, REC_TZ_, 'MMMM d, yyyy h:mm a'),
    'Patient ID': job.patientId || job.patientDocId || '',
    'Patient Doc ID': job.patientDocId || '',
    'Patient Name': job.patientName || '',
    'Staff Name': job.staffName || '',
    'DeepGram Transcript': dg.formatted,  // same as the Recorder: formatted, speaker-labelled transcript
    'Full Raw Transcript': dg.formatted,
    'DeepGram Summary': dg.summary || '',
    'Gemini SOAP': '',
    'Audio Path': job.audioPath || '',
    'Duration Sec': Number(job.durationSec || 0),
    'Consent Recorded': true,
    'Source': 'Dashboard recording',
    'Created At': new Date().toISOString(),
  })]);
}

// STEP 2: transcript -> Recorder's callGeminiComplex + formatSoapFromJSON -> Status "Draft"
function writeNotesStage_(cfg, job) {
  const id = job.recordingId;
  const docPath = 'appointment_transcripts/' + id;
  const rec = fsGetDoc_(cfg, docPath);
  const transcript = rec ? String(rec['Full Raw Transcript'] || '') : '';
  if (!transcript) {
    const e = new Error('Transcript missing. It will be transcribed again.');
    e.retranscribe = true;
    throw e;
  }

  const dateObj = job.startedAt ? new Date(job.startedAt) : new Date();
  const soapJson = cleanSoapJson_(callGeminiComplex(transcript.replace(/<[^>]*>?/gm, '\n'), dateObj));
  const formattedSoap = formatSoapFromJSON(soapJson);

  fsPatch_(cfg, docPath, {
    'Status': 'Draft',
    'Gemini SOAP': formattedSoap,
    // Personal preferences Gemini picked up. Offered as suggestions in the review panel.
    'Suggested Personal Notes': Array.isArray(soapJson.personal_notes)
      ? soapJson.personal_notes.map(String).filter(Boolean) : [],
  });

  // Same referral email as the Recorder (non-fatal if it fails)
  sendReferralNotification_(job.patientName || '', job.patientId || job.patientDocId || '',
    soapJson.referral, job.staffName || '');
}

function downloadAudio_(cfg, audioPath) {
  if (!/^appointment_audio\//.test(String(audioPath || ''))) {
    throw new Error('Unexpected audio path: ' + audioPath);
  }

  // Tolerates "gs://", a trailing folder, or stray spaces in the Script Property
  const bucket = String(PropertiesService.getScriptProperties().getProperty('STORAGE_BUCKET') || '')
    .trim()
    .replace(/^gs:\/\//i, '')
    .split('/')[0];
  if (!bucket) throw new Error('Missing STORAGE_BUCKET script property.');

  const url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) +
              '/o/' + encodeURIComponent(audioPath) + '?alt=media';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  if (code !== 200) {
    let reason = '';
    try {
      const j = JSON.parse(res.getContentText());
      reason = j.error && j.error.message ? j.error.message : '';
    } catch (e) { /* not JSON */ }
    throw new Error('Audio download failed (' + code + ')' + (reason ? ': ' + reason : '') +
                    ' [bucket "' + bucket + '"]');
  }
  return res.getBlob();
}

// Same Deepgram settings + formatting as the Recorder, but the audio is sent privately (not as a public URL)
function deepgram_(blob, mime, staffName) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('DEEPGRAM_API_KEY');
  if (!key) throw new Error('Missing DEEPGRAM_API_KEY script property.');
  const model = props.getProperty('DEEPGRAM_MODEL') || 'nova-2-medical';

  const url = 'https://api.deepgram.com/v1/listen?model=' + encodeURIComponent(model) +
    '&smart_format=true&summarize=v2&diarize=true' +
    '&mip_opt_out=true'; // don't let Deepgram use this audio to improve their models

  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: String(mime || 'audio/webm'),
    headers: { Authorization: 'Token ' + key },
    payload: blob.getBytes(),
    muteHttpExceptions: true,
  });

  const httpCode = res.getResponseCode();
  const bodyText = res.getContentText();
  let json;
  try { json = JSON.parse(bodyText); }
  catch (e) { throw new Error('Deepgram: HTTP ' + httpCode + ' returned non-JSON: ' + bodyText.substring(0, 300)); }

  const dgRequestId = json.request_id || (json.metadata && json.metadata.request_id) || '';
  if (dgRequestId) console.log('Deepgram request_id: ' + dgRequestId + ' (HTTP ' + httpCode + ')');

  if (httpCode < 200 || httpCode >= 300 || json.err_code || json.error) {
    const dgMsg = json.err_msg || json.reason || (json.error && (json.error.message || json.error)) || bodyText.substring(0, 300);
    let hint = '';
    if (httpCode === 400) hint = ' (audio format not accepted, or the model name is retired)';
    else if (httpCode === 401) hint = ' (API key invalid or rotated)';
    else if (httpCode === 402) hint = ' (OUT OF CREDIT: top up in Deepgram Console > Billing)';
    else if (httpCode === 429) hint = ' (rate limited)';
    else if (httpCode >= 500) hint = ' (Deepgram-side outage: check status.deepgram.com)';
    throw new Error('Deepgram HTTP ' + httpCode + hint + ': ' + dgMsg + (dgRequestId ? ' [request_id: ' + dgRequestId + ']' : ''));
  }

  const results = json.results || {};
  const channel = (results.channels || [])[0] || {};
  const alt = (channel.alternatives || [])[0] || {};

  let rawTranscript = String(alt.transcript || '');
  if (!rawTranscript.trim()) {
    throw new Error('Deepgram returned an EMPTY transcript. The recording contained no recognisable speech' +
      (json.metadata && json.metadata.duration ? ' (duration ' + json.metadata.duration + 's)' : '') + '.');
  }
  rawTranscript = applyTranscriptCorrections_(rawTranscript);

  // Speaker-labelled transcript, formatted exactly like the Recorder's
  let formatted = rawTranscript;
  const paragraphs = alt.paragraphs ? alt.paragraphs.paragraphs : null;
  if (paragraphs && paragraphs.length) {
    formatted = paragraphs.map(function (p) {
      let label = 'Speaker ' + p.speaker;
      let colorClass = 'text-gray-700';
      if (p.speaker === 0) { label = staffName || 'Staff'; colorClass = 'text-blue-800'; }
      else if (p.speaker === 1) { label = 'Patient'; colorClass = 'text-teal-700'; }
      const sentences = (p.sentences || []).map(function (s) { return applyTranscriptCorrections_(s.text); }).join(' ');
      return '<div>\n                <b class="' + colorClass + '">' + label + ':</b> \n                <span class="text-gray-800">' +
        sentences + '</span>\n              </div><br>';
    }).join('');
  }

  return {
    transcript: rawTranscript,
    formatted: formatted,
    summary: results.summary && results.summary.short ? String(results.summary.short) : '',
  };
}

// ---- Firestore REST helpers ----

// Field names with spaces must be `quoted` in field paths
function quoteField_(k) {
  return /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : '`' + String(k).replace(/`/g, '\\`') + '`';
}

function fsGetDoc_(cfg, path) {
  const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + '/' + path, {
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) throw new Error('Firestore get ' + res.getResponseCode());
  return fromFields_(JSON.parse(res.getContentText()).fields || {});
}

// Updates only the given fields
function fsPatch_(cfg, path, obj) {
  const mask = Object.keys(obj).map(function (k) {
    return 'updateMask.fieldPaths=' + encodeURIComponent(quoteField_(k));
  }).join('&');
  const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + '/' + path + '?' + mask, {
    method: 'patch',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    payload: JSON.stringify({ fields: toFields_(obj) }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Firestore patch ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
}

// Lists every document in a collection (optionally only some fields)
function fsListAll_(cfg, collectionId, maskFields) {
  const mask = (maskFields || []).map(function (f) {
    return '&mask.fieldPaths=' + encodeURIComponent(quoteField_(f));
  }).join('');
  const docs = [];
  let pageToken = '';
  let pages = 0;
  do {
    const url = 'https://firestore.googleapis.com/v1/' + fsBase_(cfg) + '/' + encodeURIComponent(collectionId) +
      '?pageSize=300' + mask + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error('Firestore list ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
    const body = JSON.parse(res.getContentText());
    (body.documents || []).forEach(function (d) { docs.push(d); });
    pageToken = body.nextPageToken || '';
    pages++;
  } while (pageToken && pages < 200);
  return docs;
}

function fromFields_(fields) {
  const out = {};
  Object.keys(fields).forEach(function (k) { out[k] = fromValue_(fields[k]); });
  return out;
}

function fromValue_(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue_);
  if ('mapValue' in v) return fromFields_(v.mapValue.fields || {});
  return null;
}

// ---- Editor helper ----
// Re-writes the notes for an existing recording using the Recorder prompts.
// Copy the ID from Firestore > recording_jobs (e.g. "REC-20261008-ABC123"), then Run.
function regenerateNotes() {
  const id = 'PASTE_RECORDING_ID_HERE';
  const cfg = getConfig_();
  fsPatch_(cfg, 'recording_jobs/' + id, { status: 'transcribed', error: '' });
  console.log('Result: ' + JSON.stringify(processJob_(id, true)));
}

// ===================== Delete a recording (wrong patient / accidental recording) =====================

function handleDeleteRecording_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };

  const id = String(body.recordId || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 300);
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  if (reason.length < 3) return { ok: false, error: 'REASON_REQUIRED' };

  const cfg = getConfig_();
  const rec = fsGetDoc_(cfg, 'appointment_transcripts/' + id);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };

  // Signed-off notes are never deleted from the dashboard
  if (/^reviewed$/i.test(String(rec['Status'] || ''))) return { ok: false, error: 'REVIEWED' };

  // Only the clinician who recorded it, or an Admin
  const job = fsGetDoc_(cfg, 'recording_jobs/' + id);
  const isOwner = !!(job && job.createdByUid && job.createdByUid === session.uid);
  const isAdmin = /^admin$/i.test(String(session.role || ''));
  if (!isOwner && !isAdmin) return { ok: false, error: 'FORBIDDEN' };

  // 1) Audio first: if this fails, nothing else is removed
  const audioPath = String(rec['Audio Path'] || (job && job.audioPath) || '');
  const audioDeleted = /^appointment_audio\//.test(audioPath) ? deleteAudio_(cfg, audioPath) : false;

  // 2) Audit entry (no clinical content) + remove the record and its job, in one commit
  const writes = [
    updateWrite_(cfg, 'deleted_records/' + id, {
      recordId: id,
      patientId: String(rec['Patient ID'] || ''),
      patientName: String(rec['Patient Name'] || ''),
      recordDate: String(rec['Record Date and Time'] || ''),
      recordedBy: String(rec['Staff Name'] || ''),
      deletedBy: String(session.name || ''),
      deletedByUid: String(session.uid || ''),
      deletedAt: new Date().toISOString(),
      reason: reason,
      audioDeleted: audioDeleted,
      source: String(rec['Source'] || ''),
    }),
    deleteWrite_(cfg, 'appointment_transcripts/' + id),
  ];
  if (job) writes.push(deleteWrite_(cfg, 'recording_jobs/' + id));
  commitWrites_(cfg, writes);

  console.log('Recording ' + id + ' deleted by ' + session.name + ' (' + reason + ')');
  return { ok: true, audioDeleted: audioDeleted };
}

// Deletes one audio file from Storage. A missing file counts as already deleted.
function deleteAudio_(cfg, audioPath) {
  const bucket = String(PropertiesService.getScriptProperties().getProperty('STORAGE_BUCKET') || '')
    .trim().replace(/^gs:\/\//i, '').split('/')[0];
  if (!bucket) throw new Error('Missing STORAGE_BUCKET script property.');

  const res = UrlFetchApp.fetch('https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) +
    '/o/' + encodeURIComponent(audioPath), {
    method: 'delete',
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code === 200 || code === 204) return true;
  if (code === 404) return false;
  throw new Error('Audio delete failed (' + code + '): ' + res.getContentText().slice(0, 200));
}

// ===================== Remove "Nil" / "Not discussed" filler so empty sections stay empty =====================

// A line that is ONLY a placeholder. "Smoking: None" (a real answer) is kept.
const PLACEHOLDER_RE_ = /^(?:nil|none|n\/?a|nkda|nkfa|unknown|not (?:discussed|mentioned|stated|applicable|recorded|provided|specified)|no (?:known )?(?:drug )?(?:allergies|medications?|(?:medical )?conditions?)(?: reported| known)?|nothing (?:to report|recorded|discussed|noted))\.?$/i;

function cleanSoapJson_(v) {
  if (typeof v === 'string') {
    return v.split('\n').filter(function (line) {
      const t = line.replace(/^\s*[-•*]\s*/, '').trim();
      return !t || !PLACEHOLDER_RE_.test(t);
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  if (Array.isArray(v)) {
    return v.map(cleanSoapJson_).filter(function (x) { return !isEmptyValue_(x); });
  }
  if (v && typeof v === 'object') {
    const out = {};
    Object.keys(v).forEach(function (k) { out[k] = cleanSoapJson_(v[k]); });
    return out;
  }
  return v;
}

function isEmptyValue_(x) {
  if (x === null || x === undefined) return true;
  if (typeof x === 'string') return !x.trim();
  if (Array.isArray(x)) return x.length === 0;
  if (typeof x === 'object') return Object.keys(x).every(function (k) { return isEmptyValue_(x[k]); });
  return false;
}

// ===================== Email treatment information to the patient =====================

const MAIL_LIMIT_PER_HOUR_ = 30; // per staff member

function handleSendTreatmentEmail_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };

  const recordId = String(body.recordId || '').trim();
  const to = String(body.to || '').trim();
  const subject = String(body.subject || '').trim().slice(0, 200) || 'Dermedica: Treatment Information';
  const html = sanitizeEmailHtml_(body.html);
  const treatments = (Array.isArray(body.treatments) ? body.treatments : [])
    .map(function (t) { return String(t).trim().slice(0, 120); })
    .filter(Boolean)
    .slice(0, 20);

  if (!/^[A-Za-z0-9_-]{3,80}$/.test(recordId)) return { ok: false, error: 'BAD_REQUEST' };
  if (to.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to)) return { ok: false, error: 'BAD_EMAIL' };
  if (!html || html.length > 100000) return { ok: false, error: 'BAD_REQUEST' };

  // Rate limit per staff member + Gmail's daily allowance
  const cache = CacheService.getScriptCache();
  const rlKey = 'mail_' + session.uid;
  const sentThisHour = Number(cache.get(rlKey) || 0);
  if (sentThisHour >= MAIL_LIMIT_PER_HOUR_) return { ok: false, error: 'RATE_LIMITED' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'QUOTA' };

  // The patient + record details for the logs come from the record itself, not the browser
  const cfg = getConfig_();
  const rec = fsGetDoc_(cfg, 'appointment_transcripts/' + recordId);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };

  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: 'Dermedica Clinic' });
  cache.put(rlKey, String(sentThisHour + 1), 3600);

  const entry = {
    sentAt: new Date().toISOString(),
    sentBy: String(session.name || ''),
    to: to,
    treatments: treatments,
  };

  // Log on the consultation record (powers the "Emailed" badges)
  try {
    const log = Array.isArray(rec['Treatment Emails Sent']) ? rec['Treatment Emails Sent'] : [];
    fsPatch_(cfg, 'appointment_transcripts/' + recordId, { 'Treatment Emails Sent': log.concat([entry]) });
  } catch (e) { console.warn('Email sent, but saving the record log failed: ' + e); }

  // Log in the same sheet the Recorder uses (so the Recorder shows SENT badges too)
  try {
    const sheet = SpreadsheetApp.openById(EMAIL_LOG_SHEET_ID).getSheetByName(EMAIL_LOG_SHEET_NAME);
    if (!sheet) throw new Error('Sheet not found: ' + EMAIL_LOG_SHEET_NAME);
    sheet.appendRow([
      Utilities.formatDate(new Date(), REC_TZ_, 'yyyy-MM-dd HH:mm:ss'), // A Timestamp
      entry.sentBy,                                                    // B Staff Name
      String(rec['Patient Name'] || ''),                              // C Patient Name
      String(rec['Patient ID'] || ''),                                // D Patient ID
      treatments.join('\n'),                                          // E Treatment Info Emailed
      emailHtmlToText_(html),                                         // F Content
      recordId,                                                       // G Record ID
    ]);
  } catch (e) { console.warn('Email sent, but the sheet log failed: ' + e); }

  return { ok: true, entry: entry };
}

// Removes anything unsafe from the staff-edited message
function sanitizeEmailHtml_(html) {
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta)\b[\s\S]*?(<\s*\/\s*\1\s*>|\/?>)/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
    .trim();
}

// Readable plain text for the audit sheet
function emailHtmlToText_(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#8599;/g, '↗')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ===================== Regenerate notes from the saved transcript =====================

function handleRegenerateSoap_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };

  const id = String(body.recordId || '').trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };

  const cfg = getConfig_();
  const docPath = 'appointment_transcripts/' + id;
  const rec = fsGetDoc_(cfg, docPath);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };

  // Signed-off notes are never overwritten
  if (/^reviewed$/i.test(String(rec['Status'] || ''))) return { ok: false, error: 'REVIEWED' };

  const transcript = String(rec['Full Raw Transcript'] || '');
  if (!transcript.trim()) return { ok: false, error: 'NO_TRANSCRIPT' };

  // One regeneration at a time per record
  const cache = CacheService.getScriptCache();
  const busyKey = 'regen_' + id;
  if (cache.get(busyKey)) return { ok: false, error: 'BUSY' };
  cache.put(busyKey, '1', 600);

  try {
    // Dates in the plan ("in 2 weeks") are worked out from the consultation date, not today
    const recordDate = new Date(String(rec['Record Date and Time'] || '').replace(/\s+at\s+/i, ' '));
    const dateObj = isNaN(recordDate) ? new Date() : recordDate;

    let soapJson;
    try {
      soapJson = cleanSoapJson_(callGeminiComplex(transcript.replace(/<[^>]*>?/gm, '\n'), dateObj));
    } catch (err) {
      console.error('Regenerate ' + id + ' failed: ' + (err && err.stack ? err.stack : err));
      return { ok: false, error: 'GEMINI_FAILED' };
    }

    fsPatch_(cfg, docPath, {
      'Status': 'Draft',
      'Gemini SOAP': formatSoapFromJSON(soapJson),
      'Previous Gemini SOAP': String(rec['Gemini SOAP'] || ''), // kept so it can be restored
      'Suggested Personal Notes': Array.isArray(soapJson.personal_notes)
        ? soapJson.personal_notes.map(String).filter(Boolean) : [],
      'Last Regenerated': Utilities.formatDate(new Date(), REC_TZ_, 'MMMM d, yyyy h:mm a'),
      'Regenerated By': String(session.name || ''),
    });
    // Note: the referral email is NOT sent again on a regenerate (avoids duplicates)

    console.log('Notes regenerated for ' + id + ' by ' + session.name);
    return { ok: true };
  } finally {
    cache.remove(busyKey);
  }
}


// ===================== Rebuild "Treatment Info to Email" from the treatment plan =====================

function clip_(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 1500);
}

function handleEmailFromPlan_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };

  const concerns = (Array.isArray(body.plan) ? body.plan : []).slice(0, 6)
    .map(function (c) {
      c = c || {};
      return {
        category: clip_(c.category, 100), area: clip_(c.area, 300), treatment: clip_(c.treatment),
        frequency: clip_(c.frequency), quote: clip_(c.quote), comments: clip_(c.comments),
      };
    })
    .filter(function (c) { return c.treatment; });
  if (!concerns.length) return { ok: false, error: 'BAD_REQUEST' };

  const currentList = (Array.isArray(body.current) ? body.current : []).slice(0, 20)
    .map(function (it) {
      it = it || {};
      return {
        name: clip_(it.name, 120),
        areas: (Array.isArray(it.areas) ? it.areas : []).slice(0, 10).map(function (a) {
          a = a || {};
          return { areaName: clip_(a.areaName, 300), quote: clip_(a.quote), comment: clip_(a.comment) };
        }),
      };
    })
    .filter(function (it) { return it.name; });

  try {
    const items = geminiEmailFromPlan_(concerns, currentList, getOfficialTreatmentNames_());
    return { ok: true, items: items };
  } catch (err) {
    console.error('Email from plan failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'GEMINI_FAILED' };
  }
}

// Official names from TREATMENT-CONFIGURATIONS (cached 10 minutes)
function getOfficialTreatmentNames_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('treatment_names_v1');
  if (cached) return JSON.parse(cached);

  const names = fsListAll_(getConfig_(), 'TREATMENT-CONFIGURATIONS', ['Treatment Name'])
    .map(function (d) {
      const f = d.fields && d.fields['Treatment Name'];
      return f && f.stringValue ? String(f.stringValue).trim() : '';
    })
    .filter(Boolean)
    .sort();

  try { cache.put('treatment_names_v1', JSON.stringify(names), 600); } catch (e) { /* too big to cache */ }
  return names;
}

const EMAIL_FROM_PLAN_PROMPT_ = [
  'You update the "Treatment Info to Email" list for Dermedica, an Australian cosmetic clinic,',
  'using the clinician\'s EDITED treatment plan. The list is sent to the patient, so it must be accurate and patient-friendly.',
  '',
  'RULES',
  '1. Create one item for each distinct treatment in treatment_plan (the "treatment" field). If one concern lists several',
  '   treatments, create one item for each. If the same treatment appears in several concerns, create ONE item with one',
  '   dynamic_areas entry per concern.',
  '2. "name" MUST be copied exactly from official_treatment_names: choose the official treatment that the plan treatment refers to.',
  '   Only if nothing fits, use the plan\'s own wording.',
  '3. If current_email_list already has an item for the same treatment, keep its exact name, and keep its comment wording',
  '   for any detail the plan did not change.',
  '4. areaName = the concern\'s area. quote = the plan\'s quote for that treatment, copied exactly (keep $ amounts and inclusions).',
  '   Use "" if the plan has no quote. Never invent or change a price.',
  '5. comment = short patient-friendly lines separated by "\\n": the frequency/number of treatments, plus any comment the',
  '   patient needs to know (preparation, test patch, downtime). Leave out internal clinical notes. Use "" if nothing applies.',
  '6. Do NOT include treatments that are not in treatment_plan (items removed from the plan must be dropped).',
  '7. Australian English. No markdown.',
].join('\n');

function geminiEmailFromPlan_(concerns, currentList, names) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Missing GEMINI_API_KEY script property.');

  const schema = {
    type: 'OBJECT',
    properties: {
      items: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            name: { type: 'STRING' },
            dynamic_areas: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: { areaName: { type: 'STRING' }, quote: { type: 'STRING' }, comment: { type: 'STRING' } },
                required: ['areaName', 'quote', 'comment'],
              },
            },
          },
          required: ['name', 'dynamic_areas'],
        },
      },
    },
    required: ['items'],
  };

  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify({
        systemInstruction: { parts: [{ text: EMAIL_FROM_PLAN_PROMPT_ }] },
        contents: [{
          role: 'user',
          parts: [{ text: JSON.stringify({
            official_treatment_names: names,
            treatment_plan: concerns,
            current_email_list: currentList,
          }) }],
        }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: schema,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      muteHttpExceptions: true,
    });
  if (res.getResponseCode() !== 200) {
    throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }

  const data = JSON.parse(res.getContentText());
  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).map(function (p) { return p.text || ''; }).join('');
  const parsed = JSON.parse(text || '{}');

  // Tidy: exact official spelling where it matches, drop empties
  const byLower = {};
  names.forEach(function (n) { byLower[n.toLowerCase()] = n; });

  return (Array.isArray(parsed.items) ? parsed.items : [])
    .map(function (it) {
      const name = clip_(it && it.name, 120);
      return {
        name: byLower[name.toLowerCase()] || name,
        dynamic_areas: (Array.isArray(it && it.dynamic_areas) ? it.dynamic_areas : [])
          .map(function (a) {
            return { areaName: clip_(a && a.areaName, 300), quote: clip_(a && a.quote), comment: clip_(a && a.comment) };
          })
          .filter(function (a) { return a.areaName || a.quote || a.comment; }),
      };
    })
    .filter(function (it) { return it.name; });
}