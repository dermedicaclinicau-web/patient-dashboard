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
  const cached = cache.get('sa_access_token_v2');
  if (cached) return cached;

  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt_({
    iss: cfg.email,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/devstorage.read_only',
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

  cache.put('sa_access_token_v2', data.access_token, 3000);
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


// ===================== Consultation recordings: Deepgram -> Gemini -> Firestore =====================

const STUCK_AFTER_MS_ = 15 * 60 * 1000; // a job "in progress" this long is assumed to have crashed

function handleProcessRecording_(body) {
  if (!getSession_(String(body.session || ''))) return { ok: false, error: 'UNAUTHORIZED' };
  const id = String(body.recordingId || '');
  if (!/^REC-[A-Z0-9-]{6,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  return processJob_(id, true);
}

// Runs every 5 minutes: finishes any uploaded / stalled / failed jobs
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
          value: { arrayValue: { values: ['uploaded', 'failed', 'transcribing', 'writing']
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
    if (Date.now() - started > 4 * 60 * 1000) return; // leave time before the 6-minute limit
    processJob_(row.document.name.split('/').pop(), false);
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
  const path = 'recording_jobs/' + id;

  try {
    const audio = downloadAudio_(cfg, job.audioPath);
    const dg = deepgram_(audio, job.mimeType);
    if (!dg.transcript) throw new Error('No speech was detected in the recording.');

    fsPatch_(cfg, path, { status: 'writing', stageAt: new Date().toISOString() });
    const soap = gemini_(dg.transcript, job);

    const transcriptId = saveTranscript_(cfg, job, dg, soap);
    fsPatch_(cfg, path, { status: 'ready', stageAt: new Date().toISOString(), transcriptId: transcriptId, error: '' });
    return { ok: true, transcriptId: transcriptId };
  } catch (err) {
    console.error('Recording ' + id + ' failed: ' + (err && err.stack ? err.stack : err));
    fsPatch_(cfg, path, {
      status: 'failed', stageAt: new Date().toISOString(),
      error: String((err && err.message) || err).slice(0, 300),
    });
    return { ok: false, error: 'FAILED' };
  }
}

// Marks a job as in progress so two runs never process the same recording
function claimJob_(cfg, id, manual) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return null;
  try {
    const job = fsGetDoc_(cfg, 'recording_jobs/' + id);
    if (!job) return null;

    const attempts = Number(job.attempts || 0);
    const stuck = (job.status === 'transcribing' || job.status === 'writing') &&
      job.stageAt && (Date.now() - Date.parse(job.stageAt) > STUCK_AFTER_MS_);
    const retryable = job.status === 'failed' && (manual || attempts < 3);

    if (job.status !== 'uploaded' && !retryable && !stuck) return null;

    fsPatch_(cfg, 'recording_jobs/' + id, {
      status: 'transcribing', stageAt: new Date().toISOString(), attempts: attempts + 1, error: '',
    });
    return job;
  } finally {
    lock.releaseLock();
  }
}

function downloadAudio_(cfg, audioPath) {
  if (!/^appointment_audio\//.test(String(audioPath || ''))) throw new Error('Unexpected audio path.');
  const bucket = PropertiesService.getScriptProperties().getProperty('STORAGE_BUCKET');
  if (!bucket) throw new Error('Missing STORAGE_BUCKET script property.');

  const url = 'https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) +
              '/o/' + encodeURIComponent(audioPath) + '?alt=media';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Audio download failed (' + res.getResponseCode() + ').');
  return res.getBlob();
}

function deepgram_(blob, mime) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('DEEPGRAM_API_KEY');
  if (!key) throw new Error('Missing DEEPGRAM_API_KEY script property.');
  const model = props.getProperty('DEEPGRAM_MODEL') || 'nova-3';

  const params = [
    'model=' + encodeURIComponent(model), 'language=en', 'smart_format=true', 'punctuate=true',
    'diarize=true', 'paragraphs=true', 'summarize=v2',
    'mip_opt_out=true', // don't let Deepgram use this audio to improve their models
  ].join('&');

  const res = UrlFetchApp.fetch('https://api.deepgram.com/v1/listen?' + params, {
    method: 'post',
    contentType: String(mime || 'audio/webm'),
    headers: { Authorization: 'Token ' + key },
    payload: blob.getBytes(),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Deepgram ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }

  const data = JSON.parse(res.getContentText());
  const results = data.results || {};
  const channel = (results.channels || [])[0] || {};
  const alt = (channel.alternatives || [])[0] || {};
  const transcript = alt.paragraphs && alt.paragraphs.transcript
    ? String(alt.paragraphs.transcript).trim()
    : String(alt.transcript || '').trim();
  const summary = results.summary && results.summary.short ? String(results.summary.short) : '';
  return { transcript: transcript, summary: summary };
}

function gemini_(transcript, job) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error('Missing GEMINI_API_KEY script property.');
  const model = props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  const prompt = props.getProperty('SOAP_PROMPT') || DEFAULT_SOAP_PROMPT_;

  const tz = Session.getScriptTimeZone();
  const when = job.startedAt ? new Date(job.startedAt) : new Date();

  const generationConfig = { temperature: 0.2, maxOutputTokens: 8192 };
  if (/2\.5-flash/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 }; // faster for note-writing

  const body = {
    systemInstruction: { parts: [{ text: prompt }] },
    contents: [{
      role: 'user',
      parts: [{ text:
        'Consultation date: ' + Utilities.formatDate(when, tz, 'MMMM d, yyyy') + '\n' +
        'Clinician: ' + (job.staffName || 'Unknown') + '\n\n' +
        'TRANSCRIPT:\n' + transcript,
      }],
    }],
    generationConfig: generationConfig,
  };

  const res = UrlFetchApp.fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
  if (res.getResponseCode() !== 200) {
    throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }

  const data = JSON.parse(res.getContentText());
  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).map(function (p) { return p.text || ''; }).join('').trim();
  if (!text) throw new Error('Gemini returned no notes' + (cand.finishReason ? ' (' + cand.finishReason + ')' : '') + '.');
  return text;
}

function saveTranscript_(cfg, job, dg, soap) {
  const tz = Session.getScriptTimeZone();
  const started = job.startedAt ? new Date(job.startedAt) : new Date();
  const id = job.recordingId;

  const data = {
    'Record ID': id,
    'Record Date and Time': Utilities.formatDate(started, tz, 'MMMM d, yyyy h:mm a'), // e.g. October 8, 2026 10:32 AM
    'Patient ID': job.patientId || job.patientDocId || '',
    'Patient Doc ID': job.patientDocId || '',
    'Patient Name': job.patientName || '',
    'Staff Name': job.staffName || '',
    'DeepGram Transcript': dg.summary || '',
    'Full Raw Transcript': dg.transcript,
    'Gemini SOAP': soap,
    'Status': 'Draft',
    'Audio Path': job.audioPath || '',
    'Duration Sec': Number(job.durationSec || 0),
    'Source': 'Dashboard recording',
    'Created At': new Date().toISOString(),
  };
  commitWrites_(cfg, [updateWrite_(cfg, 'appointment_transcripts/' + id, data)]);
  return id;
}

// ---- Small Firestore REST helpers ----

function fsGetDoc_(cfg, path) {
  const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + '/' + path, {
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() === 404) return null;
  if (res.getResponseCode() !== 200) throw new Error('Firestore get ' + res.getResponseCode());
  return fromFields_(JSON.parse(res.getContentText()).fields || {});
}

// Updates only the given (simple-named) fields
function fsPatch_(cfg, path, obj) {
  const mask = Object.keys(obj).map(function (k) { return 'updateMask.fieldPaths=' + encodeURIComponent(k); }).join('&');
  const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + '/' + path + '?' + mask, {
    method: 'patch',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    payload: JSON.stringify({ fields: toFields_(obj) }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Firestore patch ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
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

// ---- Default SOAP prompt (override by pasting your own into the SOAP_PROMPT script property) ----

const DEFAULT_SOAP_PROMPT_ = [
  'You are a clinical scribe for Dermedica, an Australian cosmetic and dermatology clinic.',
  'You will receive a transcript of a consultation between a clinician and a patient. Speakers are labelled',
  '"Speaker 0", "Speaker 1", etc.; work out who is the clinician from context.',
  '',
  'Write concise, professional clinical notes in Australian English. Use ONLY information stated in the transcript.',
  'Never invent findings, doses, prices or plans. If a section was not discussed, write "Not discussed."',
  '',
  'Output plain text only (no markdown, no asterisks, no tables). Use EXACTLY these section headings, each on its own line, in this order:',
  '',
  '!!CLINICAL NOTES:',
  '- Age (if mentioned)',
  '- Reasons for visit / chief complaints',
  '- Aggravating/alleviating factors',
  '- Relevant history / contributing factors',
  '- Examination findings mentioned by the clinician',
  '- Treatment performed today (product, area, units/volume, batch if stated)',
  '- Advice given / aftercare',
  '',
  '!!SOCIAL HISTORY:',
  'One item per line starting with "- " (e.g. occupation, smoking, alcohol, sun exposure, exercise, upcoming events).',
  '',
  '!!PERSONALITY:',
  'Brief, respectful notes useful for rapport (e.g. "- Prefers natural results", "- Anxious about needles").',
  '',
  '!!MEDICATION:',
  'One medication per line starting with "- ", with dose if stated. Write "Nil" if the patient takes none.',
  '',
  '!!MEDICAL CONDITIONS:',
  'One per line starting with "- ". Write "Nil" if none.',
  '',
  '!!ALLERGIES:',
  'One per line starting with "- ". Write "NKDA" if the patient reports no known allergies.',
  '',
  '!!TREATMENT PLAN:',
  'For each concern use exactly this structure:',
  'CONCERN A: <concern> — <short description>',
  'AREA: <area>',
  'TREATMENT:',
  '- <treatment>',
  'FREQUENCY/INTERVAL:',
  '- <frequency>',
  'QUOTE:',
  '- <price as stated, or "Not discussed">',
  'COMMENTS:',
  '- <comments>',
  'Repeat as CONCERN B, CONCERN C and so on for further concerns. Then:',
  'SUGGESTED TIMELINE:',
  '<Month Year>',
  '<treatment (n of N)>',
  'Special instructions BEFORE your treatment: <instruction>   (only if stated)',
  'If no new plan was made, write "REVIEW OF EXISTING PLAN (no new plan generated)" followed by a one-paragraph summary.',
  '',
  '!!TREATMENT INFO TO EMAIL:',
  'A short, friendly patient-facing summary of the recommended treatments and aftercare, addressed to the patient.',
  '',
  '!!BOOK NEXT APPOINTMENT:',
  'What should be booked next and when (e.g. "Review in 2 weeks"), or "Not discussed."',
].join('\n');