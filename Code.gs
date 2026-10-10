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
    if (body.action === 'sendFormPdf') return json_(handleSendFormPdf_(body));
    if (body.action === 'imageBank') return json_(handleImageBank_(body));
    if (body.action === 'staffList') return json_(handleStaffList_(body));
    if (body.action === 'sendTaskEmail') return json_(handleSendTaskEmail_(body));
    if (body.action === 'sendAftercareEmail') return json_(handleSendAftercareEmail_(body));
    if (body.action === 'printPdf') return json_(handlePrintPdf_(body));
    if (body.action === 'ssp') return json_(handleSsp_(body));
    if (body.action === 'staff') return json_(handleStaff_(body));
    if (body.action === 'scheduledTask') return json_(handleScheduledTask_(body));
    if (body.action === 'printTask') return json_(handlePrintTask_(body));

    const pin = String(body.pin || '').trim();

    if (!/^\d{4,8}$/.test(pin)) return json_({ ok: false, error: 'INVALID_PIN' });
    if (isLockedOut_()) return json_({ ok: false, error: 'LOCKED' });

    const staff = findStaffByPin_(pin);
    if (!staff) {
      registerFail_();
      Utilities.sleep(800); // slows brute-force attempts
      return json_({ ok: false, error: 'INVALID_PIN' });
    }
    if (staff.active === false) return json_({ ok: false, error: 'INACTIVE' });

    const token = createCustomToken_(staff.id, {
      staffName: staff.name,
      staffRole: staff.role,
      staffPhoto: staff.photo,
      staffEmail: staff.email,
      perms: effectivePerms_(staff),
    });

    const session = createSession_(staff);
    try { fsPatch_(getConfig_(), STAFF_COLLECTION + '/' + staff.id, { 'Last Login': new Date().toISOString() }); }
    catch (e) { console.warn('Last login not saved: ' + e); }
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
  const hash = pinHash_(pin);
  const matches = getStaffDocs_().filter(function (s) {
    return (s.pinHash && s.pinHash === hash) || (!s.pinHash && s.pin && s.pin === pin);
  });
  if (matches.length > 1) throw new Error('Duplicate PIN found in ' + STAFF_COLLECTION);
  const s = matches[0] || null;
  if (s && !s.pinHash) { // an older plain PIN: store it hashed from now on
    try {
      fsPatch_(getConfig_(), STAFF_COLLECTION + '/' + s.id, { 'PIN Hash': hash, 'PIN': '' });
      CacheService.getScriptCache().remove('staff_docs_v1');
    } catch (e) { console.warn('PIN hash not saved: ' + e); }
  }
  return s;
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
    const f = d.fields || {};
    return {
      id: d.name.split('/').pop(), // Firestore doc ID becomes the Auth UID
      pin: field_(f, 'PIN'),        // older plain PINs (converted to PIN Hash)
      pinHash: field_(f, 'PIN Hash'),
      name: field_(f, 'Staff Name'),
      role: field_(f, 'Role'),
      photo: field_(f, 'Profile Photo'),
      email: field_(f, 'Email address'),
      active: !(f['Active'] && f['Active'].booleanValue === false),
      lastLogin: field_(f, 'Last Login'),
      access: f['Access'] ? fromValue_(f['Access']) : null,
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
  const cache = CacheService.getScriptCache();
  const raw = cache.get('sess_' + token);
  if (!raw) return null;
  const sess = JSON.parse(raw);
  if (sess.uid === 'test') { sess.perms = PERMS_ALL_.slice(); return sess; } // editor test functions
  let s = null;
  try {
    s = getStaffDocs_().filter(function (x) { return x.id === sess.uid; })[0] || null;
  } catch (e) {
    return sess; // Firestore hiccup: keep the session working
  }
  if (!s || s.active === false) { cache.remove('sess_' + token); return null; }
  sess.name = s.name || sess.name;
  sess.role = s.role || sess.role;
  sess.perms = effectivePerms_(s);
  return sess;
}
// ===================== Appointments (Google Sheet) =====================

const MONTHS_ = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function handleAppointments_(body) {
  const session = getSession_(String(body.session || ''));
if (!session) return { ok: false, error: 'UNAUTHORIZED' };
if (!can_(session, 'consult.record')) return { ok: false, error: 'FORBIDDEN' };

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
    job._id = id; // always use the job's own document ID, never a value inside it
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
  const id = job._id;

  // Never overwrite a record this pipeline didn't create (e.g. an older or Reviewed consultation)
  const existing = fsGetDoc_(cfg, 'appointment_transcripts/' + id);
  if (existing && String(existing['Source'] || '') !== 'Dashboard recording') {
    throw new Error('A different record already uses this ID. It was not overwritten.');
  }

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
  if (!isOwner && !can_(session, 'consult.delete')) return { ok: false, error: 'FORBIDDEN' };

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
  if (!can_(session, 'send.patients')) return { ok: false, error: 'FORBIDDEN' };
  if (!can_(session, 'consult.record')) return { ok: false, error: 'FORBIDDEN' };

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

// ===================== Completed forms: email a PDF / send to the printer =====================

function handleSendFormPdf_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'send.patients')) return { ok: false, error: 'FORBIDDEN' };

  const id = String(body.submissionId || '').trim();
  const kind = body.kind === 'print' ? 'print' : 'email';
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };

  // The browser normally sends the finished PDF (it looks exactly like the preview).
  // If it couldn't make one, it sends the document and the PDF is made here instead.
  const pdfBytes = pdfBytes_(body.pdf);
  const html = pdfBytes ? '' : sanitizePdfHtml_(body.html);
  if (!pdfBytes && (!html || html.length > 4000000)) return { ok: false, error: 'BAD_REQUEST' };

  // The saved form must really exist (the browser can't invent one)
  const cfg = getConfig_();
  const sub = fsGetDoc_(cfg, 'form_submissions/' + id);
  if (!sub) return { ok: false, error: 'NOT_FOUND' };

  // Printed copies ONLY go to the printer address saved in Form Builder
  let to = '';
  let cc = '';
  if (kind === 'print') {
    const ps = fsGetDoc_(cfg, 'form_settings/printing');
    to = String((ps && ps.printerEmail) || '').trim();
    if (!isEmail_(to)) return { ok: false, error: 'NO_PRINTER' };
  } else {
    to = String(body.to || '').trim();
    cc = String(body.cc || '').trim();
    if (!isEmail_(to) || (cc && !isEmail_(cc))) return { ok: false, error: 'BAD_EMAIL' };
  }

  // Same limits as treatment emails
  const cache = CacheService.getScriptCache();
  const rlKey = 'mail_' + session.uid;
  const sentThisHour = Number(cache.get(rlKey) || 0);
  if (sentThisHour >= MAIL_LIMIT_PER_HOUR_) return { ok: false, error: 'RATE_LIMITED' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'QUOTA' };

  const fileName = cleanFileName_(body.fileName,
    String(sub.templateName || 'Form') + ' - ' + String(sub.patientName || 'Patient'));

  let pdf;
  try {
    pdf = pdfBytes
      ? Utilities.newBlob(pdfBytes, MimeType.PDF, fileName)
      : Utilities.newBlob(html, 'text/html', 'form.html').getAs(MimeType.PDF).setName(fileName);
  } catch (err) {
    console.error('Form PDF failed for ' + id + ': ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'PDF_FAILED' };
  }

  const mail = { to: to, name: 'Dermedica Clinic', attachments: [pdf] };
  if (kind === 'print') {
    mail.subject = 'Print: ' + fileName;
    mail.body = 'Sent from the Dermedica staff portal for printing.';
  } else {
    mail.subject = String(body.subject || '').trim().slice(0, 200) ||
      ('Your ' + String(sub.templateName || 'form') + ' - Dermedica');
    const richMsg = sanitizeEmailHtml_(body.messageHtml);
    if (richMsg && richMsg.length <= 300000) {
      // Rich text message (same design as the other portal emails)
      const inlined = inlineTaskImages_(cfg, richMsg);
      mail.htmlBody = inlined.html;
      mail.body = emailHtmlToText_(inlined.html);
      if (Object.keys(inlined.images).length) mail.inlineImages = inlined.images;
    } else {
      // Older plain text message
      const message = String(body.message || '').slice(0, 5000);
      mail.body = message;
      mail.htmlBody = textToEmailHtml_(message);
    }
    if (cc) mail.cc = cc;
  }
  MailApp.sendEmail(mail);
  cache.put(rlKey, String(sentThisHour + 1), 3600);

  const entry = {
    kind: kind,
    to: to,
    cc: cc,
    sentAt: new Date().toISOString(),
    sentBy: String(session.name || ''),
    sentByUid: String(session.uid || ''),
  };

  // Log on the saved form (shows "Emailed to... / Sent to the printer" in the portal)
  try {
    const log = Array.isArray(sub.deliveries) ? sub.deliveries : [];
    fsPatch_(cfg, 'form_submissions/' + id, { deliveries: log.concat([entry]).slice(-50) });
  } catch (e) { console.warn('Sent, but saving the send log failed: ' + e); }

  console.log('Form ' + id + ' ' + (kind === 'print' ? 'sent to printer' : 'emailed to ' + to) + ' by ' + session.name);
  return { ok: true, entry: entry };
}

// A real PDF from the browser (must start with "%PDF", max ~15 MB), or null
function pdfBytes_(b64) {
  if (typeof b64 !== 'string' || !b64 || b64.length > 20000000) return null;
  let bytes;
  try { bytes = Utilities.base64Decode(b64); } catch (e) { return null; }
  if (bytes.length < 5 || bytes[0] !== 37 || bytes[1] !== 80 || bytes[2] !== 68 || bytes[3] !== 70) return null;
  return bytes;
}


function isEmail_(s) {
  return typeof s === 'string' && s.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(s);
}

function cleanFileName_(name, fallback) {
  const clean = function (s) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, '-').replace(/\s+/g, ' ').trim();
  };
  let s = clean(name).slice(0, 120) || clean(fallback).slice(0, 115) || 'Form';
  if (!/\.pdf$/i.test(s)) s += '.pdf';
  return s;
}

function textToEmailHtml_(text) {
  const safe = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  return '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1e293b">' + safe + '</div>';
}

// Keeps the document's own styling, removes anything active,
// and only allows embedded images (no outside links or tracking images)
function sanitizePdfHtml_(html) {
  return String(html || '')
    .replace(/<\s*(script|iframe|object|embed|form|link|meta|base)\b[\s\S]*?(<\s*\/\s*\1\s*>|\/?>)/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])(?!\s*(?:data:image\/(?:png|jpeg);base64,|#))[^"']*\2/gi, '$1="#"')
    .trim();
}

// ===================== Image Bank (a Google Drive folder) =====================
// The folder ID lives in Script Properties as IMAGE_BANK_FOLDER_ID.
// Everything here is limited to that folder and its subfolders.

const IMG_MIME_ = { 'image/png': true, 'image/jpeg': true, 'image/gif': true, 'image/webp': true };
const IMG_MAX_BYTES_ = 8 * 1024 * 1024;
const DRIVE_ID_RE_ = /^[A-Za-z0-9_-]{10,80}$/;
const BANK_PAGE_ = 120; // images per folder page (names only, so this is quick)

function handleImageBank_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const rootId = String(PropertiesService.getScriptProperties().getProperty('IMAGE_BANK_FOLDER_ID') || '').trim();
  if (!rootId) return { ok: false, error: 'NO_IMAGE_BANK' };
  const op = String(body.op || '');
  const isAdmin = /^admin$/i.test(String(session.role || ''));
  if (['mkdir', 'upload', 'rename', 'trash'].indexOf(op) !== -1 && !can_(session, 'forms.build')) return { ok: false, error: 'FORBIDDEN' };

  try {
    switch (op) {
      case 'list':   return bankList_(rootId, String(body.folderId || rootId), Number(body.offset || 0));
      case 'thumbs': return bankThumbs_(rootId, body.ids);
      case 'search': return bankSearch_(rootId, String(body.q || ''));
      case 'get':    return bankGet_(rootId, String(body.fileId || ''));
      case 'mkdir':  return bankMkdir_(rootId, String(body.parentId || rootId), body.name);
      case 'upload': return bankUpload_(rootId, String(body.parentId || rootId), body);
      case 'rename': return bankRename_(rootId, String(body.id || ''), body.kind === 'folder', body.name);
      case 'trash':  return bankTrash_(rootId, String(body.id || ''), body.kind === 'folder', session);
    }
    return { ok: false, error: 'BAD_REQUEST' };
  } catch (err) {
    console.error('Image bank ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR' };
  }
}

/* ---------- Is it inside the bank? Climb up through the parents (answers remembered for an hour) ---------- */

function bankInside_(rootId, folder) {
  const cache = CacheService.getScriptCache();
  const seen = [];
  let f = folder;
  let guard = 0;
  while (f && guard++ < 25) {
    const id = f.getId();
    if (id === rootId || cache.get('bank_in_' + id) === '1') {
      if (seen.length) {
        const mark = {};
        seen.forEach(function (s) { mark['bank_in_' + s] = '1'; });
        try { cache.putAll(mark, 3600); } catch (e) { /* not essential */ }
      }
      return true;
    }
    seen.push(id);
    const ps = f.getParents();
    f = ps.hasNext() ? ps.next() : null;
  }
  return false;
}
function inBankFolder_(rootId, id) {
  if (id === rootId) return true;
  if (!DRIVE_ID_RE_.test(id)) return false;
  let f;
  try { f = DriveApp.getFolderById(id); } catch (e) { return false; }
  return !f.isTrashed() && bankInside_(rootId, f);
}
function inBankFile_(rootId, file) {
  const ps = file.getParents();
  while (ps.hasNext()) if (bankInside_(rootId, ps.next())) return true;
  return false;
}
function bankFile_(rootId, id) {
  if (!DRIVE_ID_RE_.test(id)) return null;
  let f;
  try { f = DriveApp.getFileById(id); } catch (e) { return null; }
  if (f.isTrashed() || !IMG_MIME_[f.getMimeType()] || !inBankFile_(rootId, f)) return null;
  return f;
}

/* ---------- Helpers ---------- */

function bankCleanName_(s, max) {
  return String(s || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 120);
}
function bankItem_(f) {
  return { kind: 'image', id: f.getId(), name: f.getName(), mime: f.getMimeType(), size: f.getSize(),
    updated: f.getLastUpdated().getTime() };
}
const bankByName_ = function (a, b) { return String(a.name).localeCompare(String(b.name)); };
function bankPath_(rootId, folder) {
  const path = [];
  let f = folder;
  let guard = 0;
  while (f && f.getId() !== rootId && guard++ < 20) {
    path.unshift({ id: f.getId(), name: f.getName() });
    const ps = f.getParents();
    f = ps.hasNext() ? ps.next() : null;
  }
  path.unshift({ id: rootId, name: 'Image Bank' });
  return path;
}

// A small preview image, remembered for 6 hours (until the image changes)
function bankThumb_(f) {
  const cache = CacheService.getScriptCache();
  const key = 'bank_th_' + f.getId() + '_' + f.getLastUpdated().getTime();
  const hit = cache.get(key);
  if (hit) return hit;
  let url = '';
  try {
    const t = f.getThumbnail();
    if (t) url = 'data:' + (t.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(t.getBytes());
  } catch (e) { /* Drive hasn't made a thumbnail yet */ }
  if (!url && f.getSize() < 200000) {
    url = 'data:' + f.getMimeType() + ';base64,' + Utilities.base64Encode(f.getBlob().getBytes());
  }
  if (url && url.length < 95000) { try { cache.put(key, url, 21600); } catch (e) { /* too big to remember */ } }
  return url;
}

/* ---------- Actions ---------- */

function bankList_(rootId, folderId, offset) {
  if (!inBankFolder_(rootId, folderId)) return { ok: false, error: 'NOT_FOUND' };
  const folder = DriveApp.getFolderById(folderId);
  const start = Math.max(0, Math.floor(offset) || 0);

  const folders = [];
  if (!start) {
    const fi = folder.getFolders();
    while (fi.hasNext()) {
      const f = fi.next();
      if (!f.isTrashed()) folders.push({ kind: 'folder', id: f.getId(), name: f.getName() });
    }
    folders.sort(bankByName_);
  }
  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed() && IMG_MIME_[f.getMimeType()]) files.push(f);
  }
  files.sort(function (a, b) { return a.getName().localeCompare(b.getName()); });

  return {
    ok: true,
    folder: { id: folderId, name: folderId === rootId ? 'Image Bank' : folder.getName() },
    path: bankPath_(rootId, folder),
    folders: folders,
    images: files.slice(start, start + BANK_PAGE_).map(bankItem_),
    next: start + BANK_PAGE_ < files.length ? start + BANK_PAGE_ : null,
  };
}

function bankThumbs_(rootId, ids) {
  const out = {};
  (Array.isArray(ids) ? ids : []).slice(0, 12).forEach(function (raw) {
    const id = String(raw || '');
    const f = bankFile_(rootId, id);
    out[id] = f ? bankThumb_(f) : '';
  });
  return { ok: true, thumbs: out };
}

function bankSearch_(rootId, q) {
  q = String(q || '').trim().slice(0, 60);
  if (q.length < 2) return { ok: true, folders: [], images: [] };
  const safe = q.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const images = [];
  const it = DriveApp.searchFiles("title contains '" + safe + "' and trashed = false");
  while (it.hasNext() && images.length < 60) {
    const f = it.next();
    if (IMG_MIME_[f.getMimeType()] && inBankFile_(rootId, f)) images.push(bankItem_(f));
  }
  const folders = [];
  const fi = DriveApp.searchFolders("title contains '" + safe + "' and trashed = false");
  while (fi.hasNext() && folders.length < 20) {
    const f = fi.next();
    if (f.getId() !== rootId && bankInside_(rootId, f)) folders.push({ kind: 'folder', id: f.getId(), name: f.getName() });
  }
  return { ok: true, folders: folders.sort(bankByName_), images: images.sort(bankByName_) };
}

function bankGet_(rootId, id) {
  const f = bankFile_(rootId, id);
  if (!f) return { ok: false, error: 'NOT_FOUND' };
  if (f.getSize() > IMG_MAX_BYTES_) return { ok: false, error: 'TOO_LARGE' };
  return { ok: true, id: id, name: f.getName(), mime: f.getMimeType(), data: Utilities.base64Encode(f.getBlob().getBytes()) };
}

function bankMkdir_(rootId, parentId, rawName) {
  const name = bankCleanName_(rawName, 80);
  if (!name) return { ok: false, error: 'BAD_NAME' };
  if (!inBankFolder_(rootId, parentId)) return { ok: false, error: 'NOT_FOUND' };
  const f = DriveApp.getFolderById(parentId).createFolder(name);
  return { ok: true, folder: { kind: 'folder', id: f.getId(), name: f.getName() } };
}

function bankUpload_(rootId, parentId, body) {
  if (!inBankFolder_(rootId, parentId)) return { ok: false, error: 'NOT_FOUND' };
  const mime = String(body.mime || '');
  if (!IMG_MIME_[mime]) return { ok: false, error: 'BAD_TYPE' };
  let bytes;
  try { bytes = Utilities.base64Decode(String(body.data || '')); } catch (e) { return { ok: false, error: 'BAD_REQUEST' }; }
  if (!bytes.length || bytes.length > IMG_MAX_BYTES_) return { ok: false, error: 'TOO_LARGE' };
  const name = bankCleanName_(body.name, 120) || 'Image';
  const f = DriveApp.getFolderById(parentId).createFile(Utilities.newBlob(bytes, mime, name));
  return { ok: true, image: bankItem_(f) };
}

function bankRename_(rootId, id, isFolder, rawName) {
  let name = bankCleanName_(rawName, 120);
  if (!name) return { ok: false, error: 'BAD_NAME' };
  if (!DRIVE_ID_RE_.test(id) || id === rootId) return { ok: false, error: 'BAD_REQUEST' };
  if (isFolder) {
    if (!inBankFolder_(rootId, id)) return { ok: false, error: 'NOT_FOUND' };
    DriveApp.getFolderById(id).setName(name);
    return { ok: true, name: name };
  }
  const f = bankFile_(rootId, id);
  if (!f) return { ok: false, error: 'NOT_FOUND' };
  const ext = (f.getName().match(/\.[A-Za-z0-9]{2,5}$/) || [''])[0];
  if (ext && !/\.[A-Za-z0-9]{2,5}$/.test(name)) name += ext; // keep the file type
  f.setName(name);
  return { ok: true, name: name };
}

function bankTrash_(rootId, id, isFolder, session) {
  if (!DRIVE_ID_RE_.test(id) || id === rootId) return { ok: false, error: 'BAD_REQUEST' };
  try {
    if (isFolder) {
      if (!inBankFolder_(rootId, id)) return { ok: false, error: 'NOT_FOUND' };
      DriveApp.getFolderById(id).setTrashed(true);
    } else {
      const f = bankFile_(rootId, id);
      if (!f) return { ok: false, error: 'NOT_FOUND' };
      f.setTrashed(true);
    }
  } catch (err) {
    console.warn('Image bank delete refused for ' + id + ': ' + err);
    return { ok: false, error: 'CANT_DELETE' };
  }
  console.log('Image bank: ' + (isFolder ? 'folder ' : 'image ') + id + ' moved to Bin by ' + session.name);
  return { ok: true };
}

// Run from the editor to check the folder is reachable
function testImageBank() {
  const s = createSession_({ id: 'test', name: 'Test', role: 'Admin' });
  const r = handleImageBank_({ session: s, op: 'list' });
  console.log(JSON.stringify({ ok: r.ok, error: r.error, folder: r.folder,
    folders: (r.folders || []).length, images: (r.images || []).length }));
}

// ===================== Staff list (names and roles only, for Task Manager) =====================

function handleStaffList_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const staff = getStaffDocs_()
    .filter(function (s) { return s.name && s.active !== false; })
    .map(function (s) { return { id: s.id, name: s.name, role: s.role, hasEmail: !!s.email }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
  return { ok: true, staff: staff };
}
// ===================== Task Manager: send a task email =====================

const TASK_MAX_RECIPIENTS_ = 20;

function handleSendTaskEmail_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'tasks.run')) return { ok: false, error: 'FORBIDDEN' };
  const taskId = String(body.taskId || '').trim();
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(taskId)) return { ok: false, error: 'BAD_REQUEST' };

  const cfg = getConfig_();
  const task = fsGetDoc_(cfg, 'task_types/' + taskId);
  if (!task || task.status !== 'live') return { ok: false, error: 'TASK_NOT_LIVE' };
  if (task.channel !== 'email') return { ok: false, error: 'BAD_REQUEST' };

  const subjectRaw = String(body.subject || '').trim().slice(0, 200);
  const htmlRaw = sanitizeEmailHtml_(body.html);
  if (!subjectRaw || !htmlRaw || htmlRaw.length > 200000) return { ok: false, error: 'BAD_REQUEST' };
  const cc = String(body.cc || '').trim();
  if (cc && !isEmail_(cc)) return { ok: false, error: 'BAD_EMAIL' };

  // The patient: needed for patient tasks and "about a patient" staff tasks
  let patient = null;
  const patientId = String(body.patientId || '').trim();
  if (patientId) {
    if (patientId.length > 150 || patientId.indexOf('/') !== -1) return { ok: false, error: 'BAD_REQUEST' };
    patient = fsGetDoc_(cfg, 'patient_list/' + encodeURIComponent(patientId));
    if (!patient) return { ok: false, error: 'NO_PATIENT' };
  }
  const patientName = patient
    ? String(patient['Patient Name'] || ((patient['First Name'] || '') + ' ' + (patient['Last Name'] || '')).trim())
    : '';
  const recips = task.recipients || {};

  // Who it goes to. Fixed staff lists are taken from the task, never from the browser.
  const recipients = [];
  if (task.category === 'patient') {
    if (!patient) return { ok: false, error: 'NO_PATIENT' };
    const to = String(body.to || '').trim();
    if (!isEmail_(to)) return { ok: false, error: 'BAD_EMAIL' };
    recipients.push({ name: patientName, first: String(patient['First Name'] || patientName.split(' ')[0] || ''), email: to });
  } else {
    if (recips.aboutPatient && !patient) return { ok: false, error: 'NO_PATIENT' };
    const wanted = recips.mode === 'fixed' ? (recips.staffIds || []) : (Array.isArray(body.staffIds) ? body.staffIds : []);
    const byId = {};
    getStaffDocs_().forEach(function (s) { byId[s.id] = s; });
    wanted.slice(0, TASK_MAX_RECIPIENTS_).forEach(function (id) {
      const s = byId[String(id)];
      if (s && isEmail_(s.email)) recipients.push({ name: s.name, first: String(s.name || '').split(' ')[0], email: s.email });
    });
    if (!recipients.length) return { ok: false, error: 'NO_RECIPIENTS' };
  }

  // Same limits as the other emails
  const cache = CacheService.getScriptCache();
  const rlKey = 'mail_' + session.uid;
  const sentThisHour = Number(cache.get(rlKey) || 0);
  if (sentThisHour + recipients.length > MAIL_LIMIT_PER_HOUR_) return { ok: false, error: 'RATE_LIMITED' };
  if (MailApp.getRemainingDailyQuota() < recipients.length) return { ok: false, error: 'QUOTA' };

  // Attachments: PDFs made in the browser (must be real PDFs)
  const wantedAtt = Array.isArray(body.attachments) ? body.attachments.slice(0, 3) : [];
  const attachments = [];
  for (let i = 0; i < wantedAtt.length; i++) {
    const bytes = pdfBytes_(wantedAtt[i] && wantedAtt[i].pdf);
    if (!bytes) return { ok: false, error: 'PDF_FAILED' };
    attachments.push(Utilities.newBlob(bytes, MimeType.PDF, cleanFileName_(wantedAtt[i].name, 'Attachment')));
  }

  const escH = function (s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };

  // Image Bank pictures and the clinic logo travel inside the email
  const inlined = inlineTaskImages_(cfg, htmlRaw);
  const hasImages = Object.keys(inlined.images).length > 0;

  // One email per person, with their own name filled in (staff tasks)
  recipients.forEach(function (r) {
    const subject = subjectRaw.replace(/\{First name\}/gi, r.first).replace(/\{Full name\}/gi, r.name);
    const html = inlined.html.replace(/\{First name\}/gi, escH(r.first)).replace(/\{Full name\}/gi, escH(r.name));
    const mail = { to: r.email, subject: subject, htmlBody: html, body: emailHtmlToText_(html), name: 'Dermedica Clinic' };
    if (cc) mail.cc = cc;
    if (attachments.length) mail.attachments = attachments;
    if (hasImages) mail.inlineImages = inlined.images;
    MailApp.sendEmail(mail);
  });
  cache.put(rlKey, String(sentThisHour + recipients.length), 3600);

  // Task history (written only here; staff can read it, nobody can change it)
  const runId = 'run_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  try {
    commitWrites_(cfg, [updateWrite_(cfg, 'task_runs/' + runId, {
      taskId: taskId,
      taskName: String(task.name || ''),
      category: String(task.category || ''),
      patientId: patientId,
      patientName: patientName,
      recipients: recipients.map(function (r) { return { name: r.name, email: r.email }; }),
      cc: cc,
      subject: subjectRaw,
      html: htmlRaw.slice(0, 100000),
      attachments: attachments.map(function (a) { return a.getName(); }),
      sentAt: new Date().toISOString(),
      sentBy: String(session.name || ''),
      sentByUid: String(session.uid || ''),
    })]);
  } catch (e) { console.warn('Task sent, but the history log failed: ' + e); }

  console.log('Task "' + task.name + '" sent to ' + recipients.length + ' recipient(s) by ' + session.name);
  return { ok: true, runId: runId, sent: recipients.length };
}

// ===================== Task emails: pictures inside the email =====================

// <img data-bank="ID"> -> the Image Bank picture; <img data-logo> -> the letterhead logo
function inlineTaskImages_(cfg, html) {
  const images = {};
  const rootId = String(PropertiesService.getScriptProperties().getProperty('IMAGE_BANK_FOLDER_ID') || '').trim();
  let n = 0;
  let logo; // looked up once, only if needed
  const out = String(html || '').replace(/<img\b[^>]*>/gi, function (tag) {
    const bankId = (tag.match(/\sdata-bank\s*=\s*["']([A-Za-z0-9_-]{10,80})["']/i) || [])[1];
    const isLogo = /\sdata-logo\s*=/i.test(tag);
    let key = '';
    if (isLogo) {
      if (logo === undefined) logo = letterheadLogoBlob_(cfg);
      if (logo) { key = 'logo'; images.logo = logo; }
    } else if (bankId && n < 12) {
      // New Image Bank (Firebase Storage) first, then older Google Drive pictures
      let blob = null;
      let meta = null;
      try { meta = fsGetDoc_(cfg, 'image_bank/' + bankId); }
      catch (e) { console.warn('Image Bank lookup failed for ' + bankId + ': ' + e); }
      if (meta && meta.fullPath) blob = storageImageBlob_(cfg, String(meta.fullPath), String(meta.name || 'image'));
      if (!blob && rootId) {
        const f = bankFile_(rootId, bankId);
        blob = f ? emailImageBlob_(f) : null;
      }
      if (blob) { key = 'img' + n++; images[key] = blob; }
    }
    if (!key) return '';
    return tag
      .replace(/\s(?:src|data-bank|data-logo)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/^<img/i, '<img src="cid:' + key + '"');
  });
  return { html: out, images: images };
}

// Big photos are sent as a smaller copy (1200px wide) so the email stays light
function emailImageBlob_(file) {
  if (file.getSize() <= 1500000) return file.getBlob();
  try {
    const res = UrlFetchApp.fetch('https://drive.google.com/thumbnail?sz=w1200&id=' + encodeURIComponent(file.getId()), {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true,
      followRedirects: true,
    });
    const h = res.getHeaders();
    const type = String(h['Content-Type'] || h['content-type'] || '');
    if (res.getResponseCode() === 200 && /^image\//i.test(type)) return res.getBlob().setName(file.getName());
  } catch (e) { console.warn('Smaller copy failed for ' + file.getId() + ': ' + e); }
  return file.getSize() <= IMG_MAX_BYTES_ ? file.getBlob() : null;
}

function letterheadLogoBlob_(cfg) {
  try {
    const lh = fsGetDoc_(cfg, 'form_settings/letterhead');
    const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(String((lh && lh.logo) || ''));
    return m ? Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], 'logo') : null;
  } catch (e) {
    console.warn('Logo lookup failed: ' + e);
    return null;
  }
}

// A picture from the Image Bank in Firebase Storage (only from the image_bank folder)
function storageImageBlob_(cfg, path, name) {
  if (!/^image_bank\/[A-Za-z0-9_-]{10,40}\/full$/.test(path)) return null;
  const bucket = String(PropertiesService.getScriptProperties().getProperty('STORAGE_BUCKET') || '')
    .trim().replace(/^gs:\/\//i, '').split('/')[0];
  if (!bucket) return null;
  try {
    const res = UrlFetchApp.fetch('https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) +
      '/o/' + encodeURIComponent(path) + '?alt=media', {
      headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
      muteHttpExceptions: true,
    });
    return res.getResponseCode() === 200 ? res.getBlob().setName(name) : null;
  } catch (e) {
    console.warn('Image Bank picture failed: ' + path + ': ' + e);
    return null;
  }
}

// ===================== Aftercare: email it, or send it to the printer =====================

function handleSendAftercareEmail_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'send.patients')) return { ok: false, error: 'FORBIDDEN' };

  const cfg = getConfig_();
  const patientId = String(body.patientId || '').trim();
  if (!patientId || patientId.length > 150 || patientId.indexOf('/') !== -1) return { ok: false, error: 'NO_PATIENT' };
  const patient = fsGetDoc_(cfg, 'patient_list/' + encodeURIComponent(patientId));
  if (!patient) return { ok: false, error: 'NO_PATIENT' };

  const to = String(body.to || '').trim();
  const cc = String(body.cc || '').trim();
  if (!isEmail_(to) || (cc && !isEmail_(cc))) return { ok: false, error: 'BAD_EMAIL' };
  const subject = String(body.subject || '').trim().slice(0, 200) || 'Your aftercare instructions - Dermedica';
  const htmlRaw = sanitizeEmailHtml_(body.html);
  if (!htmlRaw || htmlRaw.length > 300000) return { ok: false, error: 'BAD_REQUEST' };

  const cache = CacheService.getScriptCache();
  const rlKey = 'mail_' + session.uid;
  const sentThisHour = Number(cache.get(rlKey) || 0);
  if (sentThisHour >= MAIL_LIMIT_PER_HOUR_) return { ok: false, error: 'RATE_LIMITED' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'QUOTA' };

  const inlined = inlineTaskImages_(cfg, htmlRaw);
  const mail = { to: to, subject: subject, htmlBody: inlined.html, body: emailHtmlToText_(inlined.html), name: 'Dermedica Clinic' };
  if (cc) mail.cc = cc;
  if (Object.keys(inlined.images).length) mail.inlineImages = inlined.images;
  MailApp.sendEmail(mail);
  cache.put(rlKey, String(sentThisHour + 1), 3600);

  const patientName = String(patient['Patient Name'] || ((patient['First Name'] || '') + ' ' + (patient['Last Name'] || '')).trim());
  const titles = (Array.isArray(body.titles) ? body.titles : []).map(function (t) { return String(t).slice(0, 200); }).slice(0, 20);
  try {
    const runId = 'run_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
    commitWrites_(cfg, [updateWrite_(cfg, 'task_runs/' + runId, {
      taskId: String(body.templateId || '').slice(0, 40),
      taskName: 'Aftercare email',
      category: 'patient',
      patientId: patientId,
      patientName: patientName,
      recipients: [{ name: patientName, email: to }],
      cc: cc,
      subject: subject,
      html: htmlRaw.slice(0, 100000),
      attachments: [],
      aftercare: titles,
      sentAt: new Date().toISOString(),
      sentBy: String(session.name || ''),
      sentByUid: String(session.uid || ''),
    })]);
  } catch (e) { console.warn('Aftercare sent, but the history log failed: ' + e); }

  console.log('Aftercare emailed to ' + to + ' by ' + session.name);
  return { ok: true };
}

// A PDF made in the browser, sent ONLY to the printer address saved in Form Builder
function handlePrintPdf_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'send.patients')) return { ok: false, error: 'FORBIDDEN' };
  const bytes = pdfBytes_(body.pdf);
  if (!bytes) return { ok: false, error: 'PDF_FAILED' };

  const cfg = getConfig_();
  const ps = fsGetDoc_(cfg, 'form_settings/printing');
  const to = String((ps && ps.printerEmail) || '').trim();
  if (!isEmail_(to)) return { ok: false, error: 'NO_PRINTER' };

  const cache = CacheService.getScriptCache();
  const rlKey = 'mail_' + session.uid;
  const sentThisHour = Number(cache.get(rlKey) || 0);
  if (sentThisHour >= MAIL_LIMIT_PER_HOUR_) return { ok: false, error: 'RATE_LIMITED' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'QUOTA' };

  const fileName = cleanFileName_(body.fileName, 'Aftercare instructions');
  MailApp.sendEmail({
    to: to,
    subject: 'Print: ' + fileName,
    body: 'Sent from the Dermedica staff portal for printing.',
    name: 'Dermedica Clinic',
    attachments: [Utilities.newBlob(bytes, MimeType.PDF, fileName)],
  });
  cache.put(rlKey, String(sentThisHour + 1), 3600);
  console.log('PDF "' + fileName + '" sent to the printer by ' + session.name);
  return { ok: true };
}

// ===================== Skin Script Protocol: product catalogue =====================

const SSP_PRODUCTS_SHEET_NAME = 'product_info';
const SSP_STEP_KEYS_ = ['A', 'BOOST', 'B', 'C', 'D', 'E', 'F'];
const SSP_STEP_LABEL_ = { A: 'Step A', BOOST: 'Boost', B: 'Step B', C: 'Step C', D: 'Step D', E: 'Step E', F: 'Step F' };

function handleSsp_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const isAdmin = /^admin$/i.test(String(session.role || ''));
  const op = String(body.op || '');
    try {
    if (op === 'appendRecord') {
      if (!can_(session, 'ssp.create')) return { ok: false, error: 'FORBIDDEN' };
      return sspAppendRecord_(String(body.recordId || ''));
    }
    if (op === 'deliver') {
      if (!can_(session, 'send.patients')) return { ok: false, error: 'FORBIDDEN' };
      return sspDeliver_(body, session);
    }
    if (op === 'importProducts') {
      if (!can_(session, 'ssp.config')) return { ok: false, error: 'FORBIDDEN' };
      return sspImportProducts_();
    }
    if (op === 'productToSheet') {
      if (!can_(session, 'ssp.config')) return { ok: false, error: 'FORBIDDEN' };
      return sspProductToSheet_(body.product || {});
    }
  } catch (err) {
    console.error('SSP ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}
// "Step A, Boost" / "A" / "STEP C" -> ['A', 'BOOST', 'C'] (in step order)
function sspParseSteps_(raw) {
  const s = String(raw || '').toLowerCase();
  const found = {};
  if (/boost/.test(s)) found.BOOST = true;
  (s.match(/step\s*([a-f])\b/g) || []).forEach(function (m) { found[m.slice(-1).toUpperCase()] = true; });
  if (!Object.keys(found).length) {
    (s.match(/\b([a-f])\b/g) || []).forEach(function (l) { found[l.toUpperCase()] = true; });
  }
  return SSP_STEP_KEYS_.filter(function (k) { return found[k]; });
}

function sspStepsText_(steps) {
  return (Array.isArray(steps) ? steps : [])
    .filter(function (k) { return SSP_STEP_LABEL_[k]; })
    .map(function (k) { return SSP_STEP_LABEL_[k]; })
    .join(', ');
}

function sspProductsSheet_() {
  const sheet = SpreadsheetApp.openById(SSP_SHEET_ID).getSheetByName(SSP_PRODUCTS_SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab not found: ' + SSP_PRODUCTS_SHEET_NAME);
  return sheet;
}

// product_info -> Firestore ssp_products. Matching products are updated, never duplicated.
function sspImportProducts_() {
  const cfg = getConfig_();
  const rows = readRows_(sspProductsSheet_(), 8);
  const existing = fsListAll_(cfg, 'ssp_products', ['name', 'size', 'sheetRow', 'published', 'createdAt', 'createdBy'])
    .map(function (d) { return { id: d.name.split('/').pop(), f: fromFields_(d.fields || {}) }; });
  const byKey = {};
  const byRow = {};
  existing.forEach(function (e) {
    byKey[(String(e.f.name || '') + '|' + String(e.f.size || '')).toLowerCase().trim()] = e;
    if (e.f.sheetRow) byRow[e.f.sheetRow] = e;
  });

  const now = new Date().toISOString();
  const writes = [];
  let added = 0;
  let updated = 0;
  rows.forEach(function (r, i) {
    const d = r.display;
    const name = String(d[0] || '').trim();
    if (!name) return;
    const rowNum = i + 2;
    const hit = byKey[(name + '|' + String(d[4] || '').trim()).toLowerCase()] || byRow[rowNum];
    const id = hit ? hit.id : 'p_' + Utilities.getUuid().replace(/-/g, '').slice(0, 18);
    if (hit) updated++; else added++;
    writes.push(updateWrite_(cfg, 'ssp_products/' + id, {
      name: name.slice(0, 150),
      steps: sspParseSteps_(d[1]),
      defaultInstruction: String(d[2] || '').trim().slice(0, 3000),
      maintenanceInstruction: String(d[3] || '').trim().slice(0, 3000),
      size: String(d[4] || '').trim().slice(0, 60),
      price: String(d[5] || '').trim().slice(0, 30),
      details: String(d[6] || '').trim().slice(0, 3000),
      shopLink: String(d[7] || '').trim().slice(0, 500),
      published: hit ? hit.f.published !== false : true,
      sheetRow: rowNum,
      createdAt: hit && hit.f.createdAt ? hit.f.createdAt : now,
      createdBy: hit && hit.f.createdBy ? hit.f.createdBy : 'Imported from product_info',
      updatedAt: now,
      updatedBy: 'Imported from product_info',
      updatedByUid: '',
    }));
  });
  if (writes.length) commitWrites_(cfg, writes, 100);
  console.log('SSP products imported: ' + added + ' added, ' + updated + ' updated');
  return { ok: true, added: added, updated: updated, total: added + updated };
}

// One product saved in the portal -> its row in product_info (or a new row)
function sspProductToSheet_(p) {
  const name = String(p.name || '').trim().slice(0, 150);
  if (!name) return { ok: false, error: 'BAD_REQUEST' };
  const oldName = String(p.oldName || name).trim().toLowerCase();
  const oldSize = String(p.oldSize != null ? p.oldSize : (p.size || '')).trim().toLowerCase();
  const sheet = sspProductsSheet_();
  const lastRow = sheet.getLastRow();

  let row = 0;
  const wantRow = Number(p.sheetRow || 0);
  if (wantRow >= 2 && wantRow <= lastRow &&
      String(sheet.getRange(wantRow, 1).getDisplayValue()).trim().toLowerCase() === oldName) {
    row = wantRow;
  }
  if (!row && lastRow >= 2) {
    const vals = sheet.getRange(2, 1, lastRow - 1, 5).getDisplayValues();
    for (let i = 0; i < vals.length; i++) {
      if (vals[i][0].trim().toLowerCase() === oldName && vals[i][4].trim().toLowerCase() === oldSize) { row = i + 2; break; }
    }
  }

  const values = [
    name,
    sspStepsText_(p.steps),
    String(p.defaultInstruction || '').slice(0, 3000),
    String(p.maintenanceInstruction || '').slice(0, 3000),
    String(p.size || '').slice(0, 60),
    String(p.price || '').slice(0, 30),
    String(p.details || '').slice(0, 3000),
    String(p.shopLink || '').slice(0, 500),
  ];
  if (row) sheet.getRange(row, 1, 1, 8).setValues([values]);
  else { sheet.appendRow(values); row = sheet.getLastRow(); }
  return { ok: true, row: row };
}


// One saved protocol (Firestore ssp_records) -> one row per product in SSP_NEW. Written once only.
function sspAppendRecord_(id) {
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'BUSY' };
  try {
    const cfg = getConfig_();
    const rec = fsGetDoc_(cfg, 'ssp_records/' + id);
    if (!rec) return { ok: false, error: 'NOT_FOUND' };
    if (rec.sheetSynced) return { ok: true, already: true };

    const sheet = SpreadsheetApp.openById(SSP_SHEET_ID).getSheetByName(SSP_SHEET_NAME);
    if (!sheet) throw new Error('Sheet tab not found: ' + SSP_SHEET_NAME);
    const when = rec.createdAt ? new Date(rec.createdAt) : new Date();
    const clipT = function (v, n) { return String(v == null ? '' : v).slice(0, n || 3000); };
    const rows = (Array.isArray(rec.items) ? rec.items : []).map(function (it) {
      const days = (Array.isArray(it.days) ? it.days : []).join(', ');
      const whenToUse = [days, clipT(it.notes, 300)].filter(Boolean).join(' · ');
      return [
        clipT(rec.recordId || id, 60),                              // A RECORD ID
        when,                                                      // B ENCODED DATETIME
        clipT(rec.patientName, 200),                               // C PATIENT NAME
        clipT(rec.patientPttId || rec.patientId, 80),              // D Patient ID
        clipT(it.name, 200),                                       // E PRODUCT NAME
        it.am && it.pm ? 'AM & PM' : it.am ? 'AM' : 'PM',          // F PROTOCOL
        it.maint ? 'Yes' : 'No',                                   // G MAINTENANCE
        '',                                                        // H RATING (not used)
        '',                                                        // I FULL OR PARTIAL (not used)
        it.am ? clipT(it.amText) : '',                             // J AM INSTRUCTION
        it.pm ? clipT(it.pmText) : '',                             // K PM INSTRUCTION
        whenToUse,                                                 // L WHEN TO USE
        SSP_STEP_LABEL_[it.step] || clipT(it.step, 20),            // M STEP
      ];
    });
    if (rows.length) sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 13).setValues(rows);
    fsPatch_(cfg, 'ssp_records/' + id, { sheetSynced: true, sheetSyncedAt: new Date().toISOString() });
    console.log('SSP ' + (rec.recordId || id) + ': ' + rows.length + ' row(s) added to ' + SSP_SHEET_NAME);
    return { ok: true, rows: rows.length };
  } finally {
    lock.releaseLock();
  }
}

// A saved protocol's PDF -> the printer address, or emailed to the patient. Logged on the protocol.
function sspDeliver_(body, session) {
  const id = String(body.recordId || '');
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  const kind = body.kind === 'print' ? 'print' : 'email';
  const bytes = pdfBytes_(body.pdf);
  if (!bytes) return { ok: false, error: 'PDF_FAILED' };

  const cfg = getConfig_();
  const rec = fsGetDoc_(cfg, 'ssp_records/' + id);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };

  const cache = CacheService.getScriptCache();
  const rlKey = 'mail_' + session.uid;
  const sentThisHour = Number(cache.get(rlKey) || 0);
  if (sentThisHour >= MAIL_LIMIT_PER_HOUR_) return { ok: false, error: 'RATE_LIMITED' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'QUOTA' };

  const fileName = cleanFileName_(body.fileName, 'Skin Script Protocol - ' + String(rec.patientName || 'Patient'));
  const pdf = Utilities.newBlob(bytes, MimeType.PDF, fileName);
  let to = '';
  let cc = '';

  if (kind === 'print') {
    const ps = fsGetDoc_(cfg, 'form_settings/printing');
    to = String((ps && ps.printerEmail) || '').trim();
    if (!isEmail_(to)) return { ok: false, error: 'NO_PRINTER' };
    MailApp.sendEmail({
      to: to, subject: 'Print: ' + fileName, name: 'Dermedica Clinic',
      body: 'Sent from the Dermedica staff portal for printing.', attachments: [pdf],
    });
  } else {
    to = String(body.to || '').trim();
    cc = String(body.cc || '').trim();
    if (!isEmail_(to) || (cc && !isEmail_(cc))) return { ok: false, error: 'BAD_EMAIL' };
    const subject = String(body.subject || '').trim().slice(0, 200) || 'Your Skin Script Protocol - Dermedica';
    const htmlRaw = sanitizeEmailHtml_(body.html);
    if (!htmlRaw || htmlRaw.length > 300000) return { ok: false, error: 'BAD_REQUEST' };
    const inlined = inlineTaskImages_(cfg, htmlRaw);
    const mail = { to: to, subject: subject, htmlBody: inlined.html, body: emailHtmlToText_(inlined.html),
      name: 'Dermedica Clinic', attachments: [pdf] };
    if (cc) mail.cc = cc;
    if (Object.keys(inlined.images).length) mail.inlineImages = inlined.images;
    MailApp.sendEmail(mail);
  }
  cache.put(rlKey, String(sentThisHour + 1), 3600);

  const entry = {
    kind: kind, to: to, cc: cc,
    sentAt: new Date().toISOString(),
    sentBy: String(session.name || ''),
    sentByUid: String(session.uid || ''),
  };
  try {
    const log = Array.isArray(rec.deliveries) ? rec.deliveries : [];
    fsPatch_(cfg, 'ssp_records/' + id, { deliveries: log.concat([entry]).slice(-50) });
  } catch (e) { console.warn('SSP sent, but the log failed: ' + e); }

  console.log('SSP ' + (rec.recordId || id) + (kind === 'print' ? ' sent to printer' : ' emailed to ' + to) + ' by ' + session.name);
  return { ok: true, entry: entry };
}

// ===================== Staff management (Admins only) =====================

const STAFF_ROLES_ = ['Admin', 'Clinician', 'Reception'];

// Secret key for PIN hashes. Lives only in Script Properties. Never change or delete it.
function pinPepper_() {
  const p = PropertiesService.getScriptProperties();
  let v = p.getProperty('PIN_PEPPER');
  if (!v) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      v = p.getProperty('PIN_PEPPER');
      if (!v) { v = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('PIN_PEPPER', v); }
    } finally { lock.releaseLock(); }
  }
  return v;
}

function pinHash_(pin) {
  return Utilities.base64Encode(Utilities.computeHmacSha256Signature(String(pin), pinPepper_()));
}

// Run ONCE after deploying: creates the secret key and hashes every existing PIN (nobody's PIN changes)
function setupPinSecurity() {
  pinPepper_();
  const cfg = getConfig_();
  CacheService.getScriptCache().remove('staff_docs_v1');
  let n = 0;
  getStaffDocs_().forEach(function (s) {
    if (s.pin && !s.pinHash) {
      fsPatch_(cfg, STAFF_COLLECTION + '/' + s.id, { 'PIN Hash': pinHash_(s.pin), 'PIN': '' });
      n++;
    }
  });
  CacheService.getScriptCache().remove('staff_docs_v1');
  console.log('PIN security ready. ' + n + ' PIN(s) hashed.');
}

function staffFresh_() {
  CacheService.getScriptCache().remove('staff_docs_v1');
  return getStaffDocs_();
}
function activeAdmins_(all, excludeId) {
  return all.filter(function (s) { return s.id !== excludeId && s.active !== false && /^admin$/i.test(s.role); }).length;
}
function pinInUse_(all, pin, exceptId) {
  const hash = pinHash_(pin);
  return all.some(function (s) {
    return s.id !== exceptId && ((s.pinHash && s.pinHash === hash) || (!s.pinHash && s.pin && s.pin === pin));
  });
}
function newPin_(all) {
  for (let i = 0; i < 50; i++) {
    const pin = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16) % 900000 + 100000);
    if (/^(\d)\1+$/.test(pin) || '0123456789'.indexOf(pin) !== -1) continue; // skip 111111 / 123456
    if (!pinInUse_(all, pin, '')) return pin;
  }
  throw new Error('Could not make a unique PIN');
}
function staffClean_(v, max) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max); }

function staffAudit_(cfg, session, action, target, details) {
  try {
    commitWrites_(cfg, [updateWrite_(cfg, 'staff_audit/a_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
      at: new Date().toISOString(),
      by: String(session.name || ''), byUid: String(session.uid || ''),
      action: action, targetId: String(target.id || ''), targetName: String(target.name || ''),
      details: String(details || '').slice(0, 300),
    })]);
  } catch (e) { console.warn('Staff audit not saved: ' + e); }
}

// Firebase sign-in on/off for a staff member (so a turned-off account can't keep using the portal)
function idtAccessToken_(cfg) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('idt_access_token_v1');
  if (hit) return hit;
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt_({
    iss: cfg.email, scope: 'https://www.googleapis.com/auth/identitytoolkit https://www.googleapis.com/auth/firebase',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }, cfg);
  const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post', muteHttpExceptions: true,
    payload: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion },
  });
  const data = JSON.parse(res.getContentText());
  if (!data.access_token) throw new Error('Identity token error: ' + res.getContentText().slice(0, 200));
  cache.put('idt_access_token_v1', data.access_token, 3000);
  return data.access_token;
}
function setFirebaseUserDisabled_(cfg, uid, disabled) {
  try {
    const body = { localId: uid, disableUser: !!disabled };
    if (disabled) body.validSince = String(Math.floor(Date.now() / 1000)); // signs them out everywhere
    const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/projects/' + cfg.projectId + '/accounts:update', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + idtAccessToken_(cfg) },
      payload: JSON.stringify(body),
    });
    const code = res.getResponseCode();
    if (code === 200) return true;
    if (/USER_NOT_FOUND/.test(res.getContentText())) return true; // never logged in yet
    console.warn('Firebase user update ' + code + ': ' + res.getContentText().slice(0, 200));
    return false;
  } catch (e) {
    console.warn('Firebase user update failed: ' + e);
    return false;
  }
}

function handleStaff_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const op = String(body.op || '');
  if (op === 'me') return staffMe_(session); // anyone logged in
  if (!/^admin$/i.test(String(session.role || ''))) return { ok: false, error: 'FORBIDDEN' };
  try {
    if (op === 'roles') return rolesGet_();
    if (op === 'saveRoles') return rolesSave_(body.roles || {}, session);
    if (op === 'list') return staffList_();
    if (op === 'save') return staffSave_(body.staff || {}, session);
    if (op === 'resetPin') return staffResetPin_(String(body.id || ''), String(body.pin || ''), session);
    if (op === 'setActive') return staffSetActive_(String(body.id || ''), body.active === true, session);
    if (op === 'unlock') {
      CacheService.getScriptCache().remove('pin_fails');
      staffAudit_(getConfig_(), session, 'Unlocked logins', {}, '');
      return { ok: true };
    }
    if (op === 'audit') return staffAuditList_();
  } catch (err) {
    console.error('Staff ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

function staffList_() {
  const staff = staffFresh_().map(function (s) {
    return { id: s.id, name: s.name, role: s.role, email: s.email, photo: s.photo,
      active: s.active !== false, lastLogin: s.lastLogin || '', hasPin: !!(s.pinHash || s.pin),
      access: s.access || { allow: [], deny: [] } };
  }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  return { ok: true, staff: staff, roles: STAFF_ROLES_, locked: isLockedOut_() };
}

function staffSave_(p, session) {
  const cfg = getConfig_();
  const name = staffClean_(p.name, 120);
  if (!name) return { ok: false, error: 'BAD_NAME' };
  const role = STAFF_ROLES_.filter(function (r) { return r.toLowerCase() === String(p.role || '').toLowerCase(); })[0];
  if (!role) return { ok: false, error: 'BAD_ROLE' };
  const email = String(p.email || '').trim();
  if (email && !isEmail_(email)) return { ok: false, error: 'BAD_EMAIL' };
  const photo = String(p.photo || '').trim().slice(0, 1000);
  if (photo && !/^https:\/\//i.test(photo)) return { ok: false, error: 'BAD_PHOTO' };
  const all = staffFresh_();
  const now = new Date().toISOString();
  const access = cleanAccess_(p.access, role);

  if (p.id) {
    const cur = all.filter(function (s) { return s.id === String(p.id); })[0];
    if (!cur) return { ok: false, error: 'NOT_FOUND' };
    if (/^admin$/i.test(cur.role) && role !== 'Admin' && cur.active !== false && !activeAdmins_(all, cur.id)) {
      return { ok: false, error: 'LAST_ADMIN' };
    }
    fsPatch_(cfg, STAFF_COLLECTION + '/' + cur.id, {
      'Staff Name': name, 'Role': role, 'Email address': email, 'Profile Photo': photo, 'Access': access,
      'Updated At': now, 'Updated By': String(session.name || ''),
    });
    const changes = [];
    if (cur.name !== name) changes.push('name');
    if (cur.role !== role) changes.push('role ' + cur.role + ' → ' + role);
    if (cur.email !== email) changes.push('email');
    if (cur.photo !== photo) changes.push('photo');
    if (JSON.stringify(cur.access || { allow: [], deny: [] }) !== JSON.stringify(access)) changes.push('access');
    staffAudit_(cfg, session, 'Edited', { id: cur.id, name: name }, changes.join(', '));
    CacheService.getScriptCache().remove('staff_docs_v1');
    return { ok: true, id: cur.id };
  }

  const pin = p.pin ? String(p.pin).trim() : newPin_(all);
  if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: 'BAD_PIN' };
  if (pinInUse_(all, pin, '')) return { ok: false, error: 'PIN_TAKEN' };
  const id = 'st_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  commitWrites_(cfg, [updateWrite_(cfg, STAFF_COLLECTION + '/' + id, {
    'Staff Name': name, 'Role': role, 'Email address': email, 'Profile Photo': photo,
    'PIN': '', 'PIN Hash': pinHash_(pin), 'Active': true, 'Access': access,
    'Created At': now, 'Created By': String(session.name || ''),
  })]);
  staffAudit_(cfg, session, 'Added', { id: id, name: name }, 'role ' + role);
  CacheService.getScriptCache().remove('staff_docs_v1');
  return { ok: true, id: id, pin: pin };
}

function staffResetPin_(id, wanted, session) {
  const all = staffFresh_();
  const cur = all.filter(function (s) { return s.id === id; })[0];
  if (!cur) return { ok: false, error: 'NOT_FOUND' };
  const pin = wanted ? wanted.trim() : newPin_(all);
  if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: 'BAD_PIN' };
  if (pinInUse_(all, pin, id)) return { ok: false, error: 'PIN_TAKEN' };
  const cfg = getConfig_();
  fsPatch_(cfg, STAFF_COLLECTION + '/' + id, {
    'PIN Hash': pinHash_(pin), 'PIN': '', 'Updated At': new Date().toISOString(), 'Updated By': String(session.name || ''),
  });
  staffAudit_(cfg, session, 'Reset PIN', cur, wanted ? 'typed by admin' : 'made by the portal');
  CacheService.getScriptCache().remove('staff_docs_v1');
  return { ok: true, pin: pin };
}

function staffSetActive_(id, active, session) {
  const all = staffFresh_();
  const cur = all.filter(function (s) { return s.id === id; })[0];
  if (!cur) return { ok: false, error: 'NOT_FOUND' };
  if (!active && id === session.uid) return { ok: false, error: 'SELF' };
  if (!active && /^admin$/i.test(cur.role) && !activeAdmins_(all, id)) return { ok: false, error: 'LAST_ADMIN' };
  const cfg = getConfig_();
  fsPatch_(cfg, STAFF_COLLECTION + '/' + id, {
    'Active': active, 'Updated At': new Date().toISOString(), 'Updated By': String(session.name || ''),
  });
  const firebase = setFirebaseUserDisabled_(cfg, id, !active);
  staffAudit_(cfg, session, active ? 'Turned on' : 'Turned off', cur, firebase ? '' : 'Firebase sign-in not updated');
  CacheService.getScriptCache().remove('staff_docs_v1');
  return { ok: true, firebase: firebase };
}

function staffAuditList_() {
  const cfg = getConfig_();
  const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + ':runQuery', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'staff_audit' }],
      orderBy: [{ field: { fieldPath: 'at' }, direction: 'DESCENDING' }],
      limit: 100,
    } }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Audit query ' + res.getResponseCode());
  const entries = JSON.parse(res.getContentText())
    .filter(function (r) { return r.document; })
    .map(function (r) { return fromFields_(r.document.fields || {}); });
  return { ok: true, entries: entries };
}

// ===================== Roles & access =====================

// [key, group, label]
const PERMS_ = [
  ['menu.patients', 'Menus', 'Patient List'],
  ['menu.calendar', 'Menus', 'Calendar'],
  ['menu.forms', 'Menus', 'Form Builder (see forms)'],
  ['menu.tasks', 'Menus', 'Task Manager'],
  ['patients.edit', 'Patients', 'Add and edit patient details'],
  ['patients.merge', 'Patients', 'Merge duplicate patients'],
  ['clinical.view', 'Patients', 'See clinical notes, treatment plans and social history'],
  ['billing.view', 'Patients', 'See billing and prescriptions'],
  ['consult.record', 'Consultations', 'Record consultations and edit notes'],
  ['consult.delete', 'Consultations', 'Delete any recording (staff can always delete their own)'],
  ['send.patients', 'Sending', 'Email and print to patients'],
  ['tasks.run', 'Sending', 'Run tasks'],
  ['tasks.build', 'Building', 'Build task types'],
  ['forms.build', 'Building', 'Build forms, Image Bank and Aftercare Bank'],
  ['ssp.create', 'Skin Script', 'Create Skin Script Protocols'],
  ['ssp.config', 'Skin Script', 'Skin Script products and design'],
];
const PERMS_ALL_ = PERMS_.map(function (p) { return p[0]; });
const ROLE_DEFAULTS_ = {
  Clinician: ['menu.patients', 'menu.calendar', 'menu.tasks', 'patients.edit', 'clinical.view', 'billing.view',
    'consult.record', 'send.patients', 'tasks.run', 'ssp.create'],
  Reception: ['menu.patients', 'menu.calendar', 'menu.tasks', 'patients.edit', 'send.patients', 'tasks.run'],
};

function rolesConfig_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('roles_cfg_v1');
  if (hit) return JSON.parse(hit);
  let doc = null;
  try { doc = fsGetDoc_(getConfig_(), 'staff_roles/config'); } catch (e) { console.warn('Roles config not read: ' + e); }
  const out = {};
  Object.keys(ROLE_DEFAULTS_).forEach(function (r) {
    const v = doc && doc.roles && Array.isArray(doc.roles[r]) ? doc.roles[r] : ROLE_DEFAULTS_[r];
    out[r] = v.filter(function (p) { return PERMS_ALL_.indexOf(p) !== -1; });
  });
  try { cache.put('roles_cfg_v1', JSON.stringify(out), 300); } catch (e) { /* not essential */ }
  return out;
}

// What a staff member can do: their role's ticks, plus "always allow", minus "always block". Admins: everything.
function effectivePerms_(s) {
  if (!s) return [];
  if (/^admin$/i.test(String(s.role || ''))) return PERMS_ALL_.slice();
  const roles = rolesConfig_();
  const key = Object.keys(roles).filter(function (r) { return r.toLowerCase() === String(s.role || '').toLowerCase(); })[0];
  const set = {};
  (key ? roles[key] : []).forEach(function (p) { set[p] = true; });
  const acc = s.access || {};
  (Array.isArray(acc.allow) ? acc.allow : []).forEach(function (p) { if (PERMS_ALL_.indexOf(p) !== -1) set[p] = true; });
  (Array.isArray(acc.deny) ? acc.deny : []).forEach(function (p) { delete set[p]; });
  return PERMS_ALL_.filter(function (p) { return set[p]; });
}

function can_(session, perm) {
  return !!session && (/^admin$/i.test(String(session.role || '')) || (session.perms || []).indexOf(perm) !== -1);
}

function cleanAccess_(acc, role) {
  if (/^admin$/i.test(String(role || ''))) return { allow: [], deny: [] };
  acc = acc || {};
  const allow = (Array.isArray(acc.allow) ? acc.allow : []).map(String).filter(function (k) { return PERMS_ALL_.indexOf(k) !== -1; });
  const deny = (Array.isArray(acc.deny) ? acc.deny : []).map(String)
    .filter(function (k) { return PERMS_ALL_.indexOf(k) !== -1 && allow.indexOf(k) === -1; });
  return { allow: allow, deny: deny };
}

// Anyone logged in: their current access, and a fresh login token carrying it (for the Firestore rules)
function staffMe_(session) {
  const s = getStaffDocs_().filter(function (x) { return x.id === session.uid; })[0];
  if (!s) return { ok: false, error: 'UNAUTHORIZED' };
  const perms = effectivePerms_(s);
  const token = createCustomToken_(s.id, {
    staffName: s.name, staffRole: s.role, staffPhoto: s.photo, staffEmail: s.email, perms: perms,
  });
  return { ok: true, role: s.role, name: s.name, perms: perms, token: token };
}

function rolesGet_() {
  return {
    ok: true,
    perms: PERMS_.map(function (p) { return { key: p[0], group: p[1], label: p[2] }; }),
    roles: rolesConfig_(),
    roleNames: STAFF_ROLES_,
  };
}

function rolesSave_(roles, session) {
  const out = {};
  Object.keys(ROLE_DEFAULTS_).forEach(function (r) {
    const v = roles && Array.isArray(roles[r]) ? roles[r] : [];
    out[r] = PERMS_ALL_.filter(function (p) { return v.indexOf(p) !== -1; });
  });
  const cfg = getConfig_();
  commitWrites_(cfg, [updateWrite_(cfg, 'staff_roles/config', {
    roles: out, updatedAt: new Date().toISOString(), updatedBy: String(session.name || ''),
  })]);
  CacheService.getScriptCache().remove('roles_cfg_v1');
  staffAudit_(cfg, session, 'Changed role access', {}, Object.keys(out).map(function (r) { return r + ': ' + out[r].length + ' ticks'; }).join(', '));
  return { ok: true, roles: out };
}

// ===================== Scheduled staff tasks =====================
// A trigger runs runScheduledTasks every 15 minutes. Times are Perth (UTC+8, no daylight saving).

const SCH_DOW_ = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const SCH_PERTH_ = 8 * 3600000;
function schDayNum_(y, m, d) { return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }
function schFromNum_(n) { const t = new Date(n * 86400000); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() }; }
function schKey_(p) { return p.y + '-' + pad2_(p.m) + '-' + pad2_(p.d); }
function schDaysIn_(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function schSlotMs_(p, time) { const t = String(time || '08:00').split(':'); return Date.UTC(p.y, p.m - 1, p.d, Number(t[0]), Number(t[1])) - SCH_PERTH_; }

function schMatches_(s, p) {
  const st = String(s.date).split('-').map(Number);
  const startN = schDayNum_(st[0], st[1], st[2]);
  const n = schDayNum_(p.y, p.m, p.d);
  const diff = n - startN;
  if (diff < 0) return false;
  const code = SCH_DOW_[p.dow];
  switch (s.freq) {
    case 'once': return diff === 0;
    case 'daily': return true;
    case 'weekdays': return p.dow >= 1 && p.dow <= 5;
    case 'weekly': {
      if ((s.days || []).indexOf(code) === -1) return false;
      if (Number(s.everyWeeks) !== 2) return true;
      const mon = function (x) { return x - ((schFromNum_(x).dow + 6) % 7); };
      return Math.round((mon(n) - mon(startN)) / 7) % 2 === 0;
    }
    case 'monthlyDate': {
      const dim = schDaysIn_(p.y, p.m);
      return p.d === (s.monthDay === 'last' ? dim : Math.min(Number(s.monthDay) || 1, dim));
    }
    case 'monthlyNth': {
      if (code !== s.nthDay) return false;
      return String(s.nth) === 'last' ? p.d + 7 > schDaysIn_(p.y, p.m) : Math.ceil(p.d / 7) === Number(s.nth);
    }
    case 'everyN': return diff % Math.max(2, Number(s.everyN) || 2) === 0;
  }
  return false;
}
function schBlocked_(s, p, closed) {
  return (s.skipWeekends === true && (p.dow === 0 || p.dow === 6)) || (s.skipClosed !== false && closed[schKey_(p)] === true);
}

// The same rules as the portal's preview (js/task-schedule.js)
function nextSlots_(s, afterMs, closedList, count) {
  const closed = {};
  (closedList || []).forEach(function (k) { closed[k] = true; });
  const out = [];
  const seen = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.date || ''))) return out;
  const a = new Date(afterMs + SCH_PERTH_);
  let n = schDayNum_(a.getUTCFullYear(), a.getUTCMonth() + 1, a.getUTCDate()) - 31;
  for (let i = 0; i < 800 && out.length < count; i++, n++) {
    let p = schFromNum_(n);
    if (!schMatches_(s, p)) continue;
    let moved = false;
    if (schBlocked_(s, p, closed)) {
      if (s.onSkip !== 'next') continue;
      let q = null;
      for (let k = 1; k <= 14; k++) { const c = schFromNum_(n + k); if (!schBlocked_(s, c, closed)) { q = c; break; } }
      if (!q) continue;
      p = q;
      moved = true;
    }
    const key = schKey_(p);
    if (s.end === 'date' && s.endDate && key > s.endDate) break;
    if (seen[key]) continue;
    seen[key] = true;
    const ms = schSlotMs_(p, s.time);
    if (ms <= afterMs) continue;
    out.push({ ms: ms, key: key, moved: moved });
  }
  return out.sort(function (x, y) { return x.ms - y.ms; });
}

function hasAppointments_(cfg, key) {
  try {
    const d = fsGetDoc_(cfg, 'appts_by_day/' + key);
    return !!(d && Array.isArray(d.appointments) && d.appointments.length);
  } catch (e) { return true; } // if unsure, send
}

// Sends a scheduled task's prepared email. onlyTo = { name, first, email } for a test.
function sendScheduledTask_(cfg, id, t, slot, onlyTo) {
  const s = t.schedule || {};
  const htmlRaw = sanitizeEmailHtml_(s.renderedHtml);
  const subjectRaw = String(s.renderedSubject || '').trim().slice(0, 200);
  if (!htmlRaw || !subjectRaw) throw new Error('Open the task in the Task Builder and let it save once.');
  const r = t.recipients || {};
  let recipients;
  if (onlyTo) {
    recipients = [onlyTo];
  } else {
    const byId = {};
    getStaffDocs_().forEach(function (x) { byId[x.id] = x; });
    recipients = (r.staffIds || []).map(function (i) { return byId[String(i)]; })
      .filter(function (x) { return x && x.active !== false && isEmail_(x.email); })
      .map(function (x) { return { name: x.name, first: String(x.name || '').split(' ')[0], email: x.email }; });
  }
  if (!recipients.length) throw new Error('None of the chosen staff have an email address.');
  if (MailApp.getRemainingDailyQuota() < recipients.length) throw new Error("The clinic's daily email limit has been reached.");

  const today = Utilities.formatDate(new Date(slot ? slot.ms : Date.now()), 'Australia/Perth', 'EEEE d MMMM yyyy');
  const escH = function (x) { return String(x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const inlined = inlineTaskImages_(cfg, htmlRaw);
  const hasImages = Object.keys(inlined.images).length > 0;
  const cc = !onlyTo && isEmail_(String(r.cc || '').trim()) ? String(r.cc).trim() : '';

  recipients.forEach(function (p) {
    const fill = function (str, html) {
      return str
        .replace(/\{\s*first name\s*\}/gi, html ? escH(p.first) : p.first)
        .replace(/\{\s*full name\s*\}/gi, html ? escH(p.name) : p.name)
        .replace(/\{\s*today\s*\}/gi, today);
    };
    const html = fill(inlined.html, true);
    const mail = { to: p.email, subject: (onlyTo ? '[Test] ' : '') + fill(subjectRaw, false),
      htmlBody: html, body: emailHtmlToText_(html), name: 'Dermedica Clinic' };
    if (cc) mail.cc = cc;
    if (hasImages) mail.inlineImages = inlined.images;
    MailApp.sendEmail(mail);
  });
  if (onlyTo) return recipients.length;

  try {
    commitWrites_(cfg, [updateWrite_(cfg, 'task_runs/run_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20), {
      taskId: id, taskName: String(t.name || ''), category: 'staff',
      patientId: r.aboutPatient === true ? String(s.patientId || '') : '',
      patientName: r.aboutPatient === true ? String(s.patientName || '') : '',
      recipients: recipients.map(function (x) { return { name: x.name, email: x.email }; }),
      cc: cc, subject: subjectRaw, html: htmlRaw.slice(0, 100000), attachments: [],
      sentAt: new Date().toISOString(), sentBy: 'Sent automatically', sentByUid: '', scheduled: true, slot: slot.key,
    })]);
  } catch (e) { console.warn('Scheduled task sent, but the history log failed: ' + e); }
  return recipients.length;
}

function runOneSchedule_(cfg, id, t, closed, now) {
  const s = t.schedule;
  const sig = JSON.stringify([s.freq, s.time, s.date, s.days, s.everyWeeks, s.monthDay, s.nth, s.nthDay, s.everyN,
    s.skipWeekends, s.skipClosed, s.onSkip]);
  const st = fsGetDoc_(cfg, 'task_schedules/' + id) || {};
  let lastSlot = Number(st.lastSlot || 0);
  // New or changed schedule, or a long gap: start from now (never a flood of catch-up emails)
  if (!lastSlot || st.sig !== sig || now - lastSlot > 2 * 86400000) lastSlot = Math.max(lastSlot, now - 20 * 60000);

  const state = {
    sig: sig, lastSlot: lastSlot, count: Number(st.count || 0), lastSentAt: st.lastSentAt || '',
    lastError: st.lastError || '', failCount: Number(st.failCount || 0), lastSkip: st.lastSkip || '',
  };
  const done = s.end === 'count' && s.freq !== 'once' && state.count >= Number(s.endCount || 0);
  if (!done) {
    const due = nextSlots_(s, lastSlot, closed, 60).filter(function (x) { return x.ms <= now; });
    if (due.length) {
      const slot = due[due.length - 1]; // only the latest due send
      if (s.onlyApptDays === true && !hasAppointments_(cfg, slot.key)) {
        state.lastSlot = slot.ms;
        state.lastSkip = slot.key + ': no appointments';
      } else {
        try {
          sendScheduledTask_(cfg, id, t, slot, null);
          state.lastSlot = slot.ms;
          state.count += 1;
          state.lastSentAt = new Date().toISOString();
          state.lastError = '';
          state.failCount = 0;
        } catch (e) {
          state.failCount += 1;
          state.lastError = String(e && e.message ? e.message : e).slice(0, 200);
          if (state.failCount >= 3) { state.lastSlot = slot.ms; state.failCount = 0; } // give up on this one
          console.error('Scheduled task ' + id + ' failed: ' + state.lastError);
        }
      }
    }
  }
  state.finished = s.end === 'count' && s.freq !== 'once' && state.count >= Number(s.endCount || 0);
  const nxt = state.finished ? null : nextSlots_(s, Math.max(now, state.lastSlot), closed, 1)[0];
  state.nextMs = nxt ? nxt.ms : 0;
  state.next = nxt ? new Date(nxt.ms).toISOString() : '';
  state.updatedAt = new Date().toISOString();
  commitWrites_(cfg, [updateWrite_(cfg, 'task_schedules/' + id, state)]);
}

// The trigger runs this every 15 minutes
function runScheduledTasks() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const cfg = getConfig_();
    const now = Date.now();
    const tasks = fsListAll_(cfg, 'task_types')
      .map(function (d) { return { id: d.name.split('/').pop(), t: fromFields_(d.fields || {}) }; })
      .filter(function (x) {
        const s = x.t.schedule;
        return x.t.status === 'live' && x.t.category === 'staff' && s && s.enabled === true && s.paused !== true;
      });
    if (!tasks.length) return;
    let closed = [];
    try { const c = fsGetDoc_(cfg, 'task_settings/closed'); closed = (c && Array.isArray(c.dates)) ? c.dates : []; }
    catch (e) { console.warn('Closed days not read: ' + e); }
    tasks.forEach(function (x) {
      try { runOneSchedule_(cfg, x.id, x.t, closed, now); }
      catch (e) { console.error('Schedule ' + x.id + ' error: ' + (e && e.stack ? e.stack : e)); }
    });
  } finally {
    lock.releaseLock();
  }
}

// Run ONCE from the editor to start the scheduler
function installTaskScheduler() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runScheduledTasks'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runScheduledTasks').timeBased().everyMinutes(15).create();
  console.log('Task scheduler installed (every 15 minutes).');
}

// "Send a test to me" from the Task Builder
function handleScheduledTask_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'tasks.build')) return { ok: false, error: 'FORBIDDEN' };
  if (String(body.op || '') !== 'test') return { ok: false, error: 'BAD_REQUEST' };
  const id = String(body.taskId || '');
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  const cfg = getConfig_();
  const t = fsGetDoc_(cfg, 'task_types/' + id);
  if (!t) return { ok: false, error: 'NOT_FOUND' };
  const me = getStaffDocs_().filter(function (x) { return x.id === session.uid; })[0];
  if (!me || !isEmail_(me.email)) return { ok: false, error: 'NO_EMAIL' };
  try {
    sendScheduledTask_(cfg, id, t, null, { name: me.name, first: String(me.name || '').split(' ')[0], email: me.email });
  } catch (e) {
    console.error('Scheduled task test failed: ' + e);
    return { ok: false, error: 'SEND_FAILED', detail: String(e && e.message ? e.message : e).slice(0, 200) };
  }
  return { ok: true, to: me.email };
}

// ===================== Task Manager → To Print =====================
// Emails the PDF to the clinic printer once per copy, and logs it in Task history.
function handlePrintTask_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'tasks.run')) return { ok: false, error: 'FORBIDDEN' };

  const cfg = getConfig_();
  const settings = fsGetDoc_(cfg, 'form_settings/printing') || {};
  const printer = String(settings.printerEmail || '').trim();
  if (!isEmail_(printer)) return { ok: false, error: 'NO_PRINTER' };

  const copies = Math.max(1, Math.min(10, parseInt(body.copies, 10) || 1));
  let fileName = String(body.fileName || 'Form.pdf').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 150);
  if (!/\.pdf$/i.test(fileName)) fileName += '.pdf';

  let blob;
  try {
    if (body.pdf) blob = Utilities.newBlob(Utilities.base64Decode(String(body.pdf)), 'application/pdf', fileName);
    else if (body.html) blob = Utilities.newBlob(String(body.html), 'text/html', 'form.html').getAs('application/pdf').setName(fileName);
    else return { ok: false, error: 'BAD_REQUEST' };
  } catch (e) {
    console.error('Print PDF failed: ' + e);
    return { ok: false, error: 'PDF_FAILED' };
  }
  if (blob.getBytes().length > 20 * 1024 * 1024) return { ok: false, error: 'PDF_FAILED' };
  if (MailApp.getRemainingDailyQuota() < copies) return { ok: false, error: 'QUOTA' };

  const me = getStaffDocs_().filter(function (x) { return x.id === session.uid; })[0];
  const who = me ? String(me.name || '') : '';
  const title = fileName.replace(/\.pdf$/i, '');
  for (let i = 0; i < copies; i++) {
    MailApp.sendEmail({
      to: printer,
      subject: title + (copies > 1 ? ' (copy ' + (i + 1) + ' of ' + copies + ')' : ''),
      body: 'Printed from the Dermedica Staff Portal' + (who ? ' by ' + who : '') + '.',
      attachments: [blob],
      name: 'Dermedica Clinic',
    });
  }

  const modeLabel = { blank: 'Blank', patient: 'Blank, for a patient', saved: 'Completed form' }[String(body.mode)] || 'Form';
  const escH = function (x) { return String(x || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  try {
    commitWrites_(cfg, [updateWrite_(cfg, 'task_runs/run_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20), {
      taskId: String(body.templateId || '').slice(0, 60),
      taskName: 'Print: ' + String(body.templateName || title).slice(0, 120),
      category: 'print',
      patientId: String(body.patientId || '').slice(0, 80),
      patientName: String(body.patientName || '').slice(0, 120),
      recipients: [{ name: 'Clinic printer', email: printer }],
      cc: '',
      subject: title,
      html: '<p><strong>' + escH(modeLabel) + '</strong> · ' + copies + ' cop' + (copies === 1 ? 'y' : 'ies') +
        ' sent to the clinic printer.</p><p>' + escH(fileName) + '</p>',
      attachments: [fileName],
      copies: copies,
      mode: String(body.mode || ''),
      submissionId: String(body.submissionId || '').slice(0, 80),
      sentAt: new Date().toISOString(),
      sentBy: who,
      sentByUid: String(session.uid || ''),
    })]);
  } catch (e) { console.warn('Printed, but the history log failed: ' + e); }

  return { ok: true, sent: copies, printer: printer };
}