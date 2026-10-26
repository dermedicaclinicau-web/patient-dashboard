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
    if (body.action === 'renewSession') return json_(handleRenewSession_(body)); // expired session, still signed in
    if (body.action === 'reports') return json_(handleReports_(body));
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
    if (body.action === 'inventory') return json_(handleInventory_(body));
    if (body.action === 'ssp') return json_(handleSsp_(body));
    if (body.action === 'staff') return json_(handleStaff_(body));
    if (body.action === 'scheduledTask') return json_(handleScheduledTask_(body));
    if (body.action === 'printTask') return json_(handlePrintTask_(body));
    if (body.action === 'notify') return json_(handleNotify_(body));
    if (body.action === 'plan') return json_(handlePlan_(body));
    if (body.action === 'recordingRules') return json_(handleRecordingRules_(body));
    if (body.action === 'scanner') return json_(scannerAction_(body));
    if (body.action === 'records') return json_(handleRecords_(body));
    if (body.action === 'scheduleTaskEmail') return json_(handleScheduleTaskEmail_(body));
    if (body.action === 'emailFlow') return json_(handleEmailFlow_(body));
    if (body.action === 'staffTask') return json_(handleStaffTask_(body));
    if (body.action === 'upload') return json_(handleUpload_(body));
    if (body.action === 'marketing') return json_(handleMarketing_(body));
    if (body.action === 'recall') return json_(handleRecall_(body));
    if (body.action === 'sms') return json_(handleSms_(body));
    if (body.action === 'marketingPublic') return json_(handleMarketingPublic_(body)); // the unsubscribe page (no login)
    if (body.action === 'publicForm') return json_(handlePublicForm_(body)); // a patient's online form (no login)

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
      injector: staff.injector === true,
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

// Health check + warm-up ("?warm=1"), and marketing email opens ("?o=<token>"). Returns nothing sensitive.
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.o) {
    try { mktOpen_(String(p.o)); } catch (err) { console.warn('Open not recorded: ' + err); }
    return ContentService.createTextOutput('');
  }
  if (p.warm) {
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
      injector: !!(f['Injector'] && f['Injector'].booleanValue === true),
      providerNo: field_(f, 'Provider Number'),
      prescriberNo: field_(f, 'Prescriber Number'),
      ahpraNo: field_(f, 'AHPRA Number'),
      quals: field_(f, 'Qualifications'),
      schedule: f['Schedule'] ? fromValue_(f['Schedule']) : null,
      eodPopup: !(f['EOD Popup'] && f['EOD Popup'].booleanValue === false),   // missing = on
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
  const size = Utilities.newBlob(JSON.stringify(claims)).getBytes().length;
  if (size > 900) console.warn('Login token for ' + uid + ' carries ' + size + ' bytes of details (keep under about 1,000).');
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
// A session is a signed pass: "s1.<staff id>.<expiry>.<signature>". Apps Script checks the signature itself,
// so nothing is stored, and a busy cache can't log anyone out. Renewed by the access check (staffMe_).
// Older sessions (64 hex characters, kept in the cache) still work until they expire.

const SESSION_TTL_ = 12 * 60 * 60; // 12 hours, renewed while the portal is open

// Secret key for signing sessions. Lives only in Script Properties. Changing it logs everyone out.
function sessionKey_() {
  const p = PropertiesService.getScriptProperties();
  let v = p.getProperty('SESSION_KEY');
  if (!v) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      v = p.getProperty('SESSION_KEY');
      if (!v) { v = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('SESSION_KEY', v); }
    } finally { lock.releaseLock(); }
  }
  return v;
}

function sessionSig_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, sessionKey_())).replace(/=+$/, '');
}

function createSession_(staff) {
  const payload = 's1.' + b64url_(String(staff.id)) + '.' + (Math.floor(Date.now() / 1000) + SESSION_TTL_);
  return payload + '.' + sessionSig_(payload);
}

// { uid } from a signed session, or null if it's not one, has been changed, or has expired
function readSignedSession_(token) {
  const m = /^s1\.([A-Za-z0-9_-]{1,200})\.(\d{9,11})\.([A-Za-z0-9_-]{20,60})$/.exec(String(token || ''));
  if (!m) return null;
  const payload = 's1.' + m[1] + '.' + m[2];
  if (sessionSig_(payload) !== m[3]) return null;
  if (Number(m[2]) * 1000 < Date.now()) return null;
  try {
    const s = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const uid = Utilities.newBlob(Utilities.base64Decode(s + '==='.slice((s.length + 3) % 4))).getDataAsString();
    return uid ? { uid: uid, name: '', role: '' } : null;
  } catch (e) { return null; }
}

function getSession_(token) {
  let sess = readSignedSession_(token);
  if (!sess) {
    // An older session from before signed passes
    if (!/^[a-f0-9]{64}$/i.test(token || '')) return null;
    const raw = CacheService.getScriptCache().get('sess_' + token);
    if (!raw) return null;
    sess = JSON.parse(raw);
  }
  if (sess.uid === 'test') { sess.perms = PERMS_ALL_.slice(); return sess; } // editor test functions
  let s = null;
  try {
    s = getStaffDocs_().filter(function (x) { return x.id === sess.uid; })[0] || null;
  } catch (e) {
    sess.perms = sess.perms || [];
    return sess; // Firestore hiccup: stay logged in (actions needing access say so instead)
  }
  if (!s || s.active === false) return null;
  sess.name = s.name || sess.name;
  sess.role = s.role || sess.role;
  sess.perms = effectivePerms_(s);
  return sess;
}

// A new Apps Script session from the person's Firebase login. Used when the 12-hour session has run out
// (e.g. an iPad left asleep overnight) but they're still signed in to the portal.
// Google checks the login is genuine, current and not turned off (accounts:lookup).
function handleRenewSession_(body) {
  const idToken = String(body.idToken || '');
  if (idToken.length > 4000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken)) {
    return { ok: false, error: 'UNAUTHORIZED' };
  }
  const key = String(PropertiesService.getScriptProperties().getProperty('FIREBASE_API_KEY') || '').trim();
  if (!key) { console.warn('renewSession: FIREBASE_API_KEY is missing from Script Properties'); return { ok: false, error: 'UNAUTHORIZED' }; }

  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + encodeURIComponent(key), {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ idToken: idToken }),
  });
  if (res.getResponseCode() !== 200) return { ok: false, error: 'UNAUTHORIZED' };   // expired, revoked or not genuine
  const u = (JSON.parse(res.getContentText()).users || [])[0];
  if (!u || !u.localId || u.disabled) return { ok: false, error: 'UNAUTHORIZED' };

  let s = null;
  try { s = getStaffDocs_().filter(function (x) { return x.id === u.localId; })[0] || null; }
  catch (e) { return { ok: false, error: 'BUSY' }; }
  if (!s || s.active === false) return { ok: false, error: 'UNAUTHORIZED' };
  return { ok: true, session: createSession_(s) };
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

    const deadline = Date.now() + 5 * 60000;
    const patients = syncResults_(ss, cfg, deadline);
    const days = syncAppointments_(ss, cfg, deadline);

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

// Run manually to force a full sync even if the sheet hasn't changed (everything is sent again)
function forceSync() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_SYNCED_SHEET_UPDATE');
  PropertiesService.getScriptProperties().deleteProperty('LAST_SYNCED_SSP_UPDATE');
  syncResetHashes_();
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
function syncResults_(ss, cfg, deadline) {
  const sheet = ss.getSheetByName(RESULTS_SHEET_NAME);
  if (!sheet) throw new Error('Sheet tab not found: ' + RESULTS_SHEET_NAME);

  const lastRow = sheet.getLastRow();
  const rows = lastRow >= 2
    ? sheet.getRange(2, 1, lastRow - 1, RESULT_FIELDS_.length).getDisplayValues()
    : [];

  const docs = {};
  rows.forEach(function (r) {
    const data = {};
    RESULT_FIELDS_.forEach(function (key, i) { data[key] = String(r[i] || '').trim(); });
    const id = docId_(data.patientId);
    if (!id || docs[id]) return; // skip blank IDs; for duplicate IDs the first row wins
    data.nameKey = data.patientName.toLowerCase().replace(/\s+/g, ' ').trim(); // for name fallback
    docs[id] = { path: 'pcn_results/' + id, data: data };
  });

  // Safety net: never wipe Firestore because the sheet was caught empty mid-upload
  if (!Object.keys(docs).length) throw new Error('pcn_results looks empty. Sync aborted to protect existing data.');

  // Remove patients that are no longer in the sheet
  const deletes = listDocIds_(cfg, 'pcn_results')
    .filter(function (id) { return !docs[id]; })
    .map(function (id) { return 'pcn_results/' + id; });

  syncCommitChanged_(cfg, 'pcn_results', docs, deletes, 200, deadline);
  return Object.keys(docs).length;
}


// ---- Appointments -> Firestore 'appts_by_day/{YYYY-MM-DD}' ----
// Sources: pcn_appts_today (wins for its own dates) + past_visits + future-visits
function syncAppointments_(ss, cfg, deadline) {
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

  const docs = {};
  dates.forEach(function (d) { docs[d] = { path: 'appts_by_day/' + d, data: { date: d, appointments: days[d] } }; });

  // Remove day documents INSIDE the synced date range that no longer have any appointments
  const first = dates[0];
  const last = dates[dates.length - 1];
  const deletes = listDocIds_(cfg, 'appts_by_day')
    .filter(function (id) { return /^\d{4}-\d{2}-\d{2}$/.test(id) && id >= first && id <= last && !days[id]; })
    .map(function (id) { return 'appts_by_day/' + id; });

  syncCommitChanged_(cfg, 'appts_by_day', docs, deletes, 25, deadline); // day documents are big: small batches
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

// Retries when Firestore is busy or throttling (429 / 409 / 5xx), waiting longer each time
function commitWrites_(cfg, writes, batchSize) {
  const size = batchSize || SYNC_BATCH_;
  for (let i = 0; i < writes.length; i += size) {
    let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + ':commit', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
        payload: JSON.stringify({ writes: writes.slice(i, i + size) }),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      if (code === 200) break;
      if ((code === 429 || code === 409 || code >= 500) && attempt < 5) {
        Utilities.sleep(wait + Math.floor(Math.random() * 400));
        wait *= 2;
        continue;
      }
      throw new Error('Firestore commit ' + code + ': ' + res.getContentText().slice(0, 500));
    }
    if (writes.length > size * 3 && i + size < writes.length) Utilities.sleep(200); // a gentle pace on big syncs
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
  if (v instanceof Date) return { timestampValue: v.toISOString() };
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

  const docs = {};
  keys.forEach(function (key) {
    const p = patients[key];
    docs[key] = {
      path: 'skincare/' + key,
      data: {
        patientId: p.patientId,
        patientName: p.patientName,
        nameKey: p.nameKey,
        protocols: Object.keys(p.protocols).map(function (k) { return p.protocols[k]; }),
        purchases: p.purchases,
      },
    };
  });

  // Remove patients no longer in either sheet
  const deletes = listDocIds_(cfg, 'skincare')
    .filter(function (id) { return !docs[id]; })
    .map(function (id) { return 'skincare/' + id; });

  syncCommitChanged_(cfg, 'skincare', docs, deletes, 40, Date.now() + 4 * 60000); // long instructions: small batches
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

/* ---------- Sending only what changed ---------- */
// A fingerprint of every document sent is kept in sync_hashes/{name}. Documents whose content hasn't changed
// aren't written again. Progress is saved after every batch, so a run that stops part-way carries on next time.
// forceSync() clears the fingerprints, so everything is sent again.

const SYNC_HASH_COL_ = 'sync_hashes';

function syncHashes_(cfg, name) {
  try {
    const d = fsGetDoc_(cfg, SYNC_HASH_COL_ + '/' + name);
    return (d && d.h && typeof d.h === 'object') ? d.h : {};
  } catch (e) {
    console.warn('Sync fingerprints not read (' + name + '), sending everything: ' + e);
    return {};
  }
}

// docs: { id: { path, data } }   deletes: [path]   deadline: stop before this time (ms)
function syncCommitChanged_(cfg, name, docs, deletes, batchSize, deadline) {
  const prev = syncHashes_(cfg, name);
  const next = {};
  const items = [];
  Object.keys(docs).forEach(function (id) {
    const h = flowHash_(JSON.stringify(docs[id].data)).slice(0, 12);
    if (prev[id] === h) { next[id] = h; return; }
    items.push({ w: updateWrite_(cfg, docs[id].path, docs[id].data), id: id, h: h });
  });
  (deletes || []).forEach(function (p) { items.push({ w: deleteWrite_(cfg, p) }); });

  const size = batchSize || SYNC_BATCH_;
  let err = null;
  for (let i = 0; i < items.length && !err; i += size) {
    if (deadline && Date.now() > deadline) {
      err = new Error('Not everything was sent in time. Press "Send to the portal again" to send the rest.');
      break;
    }
    const part = items.slice(i, i + size);
    try {
      commitWrites_(cfg, part.map(function (x) { return x.w; }), size);
      part.forEach(function (x) { if (x.id) next[x.id] = x.h; });
    } catch (e) { err = e; }
  }
  // Saved even after a failure, so the next run only sends what's still to go
  try {
    commitWrites_(cfg, [updateWrite_(cfg, SYNC_HASH_COL_ + '/' + name, { h: next, at: new Date().toISOString() })]);
  } catch (e) { console.warn('Sync fingerprints not saved (' + name + '): ' + e); }
  if (err) throw err;
  console.log('Sync ' + name + ': ' + items.length + ' write(s), ' + (Object.keys(docs).length - items.length + (deletes || []).length) + ' unchanged');
  return items.length;
}

function syncResetHashes_() {
  const cfg = getConfig_();
  commitWrites_(cfg, ['pcn_results', 'appts_by_day', 'skincare'].map(function (n) {
    return deleteWrite_(cfg, SYNC_HASH_COL_ + '/' + n);
  }));
}

// STEP 2: transcript -> Recorder's callGeminiComplex + formatSoapFromJSON -> Status "Draft"
function writeNotesStage_(cfg, job) {
  const id = job._id;
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

  // Recording rules (System configuration): reminders, highlights and note lines. Never stops the notes.
  let ruleHits = [];
  let ruleError = '';
  try {
    ruleHits = recApplyRules_(cfg, job, transcript);
    recAddToNotes_(soapJson, ruleHits);
  } catch (e) {
    console.error('Recording rules failed for ' + id + ': ' + (e && e.stack ? e.stack : e));
    ruleError = String((e && e.message) || e).slice(0, 300);
  }

  fsPatch_(cfg, docPath, {
    'Status': 'Draft',
    'Gemini SOAP': formatSoapFromJSON(soapJson),
    // Personal preferences Gemini picked up. Offered as suggestions in the review panel.
    'Suggested Personal Notes': Array.isArray(soapJson.personal_notes)
      ? soapJson.personal_notes.map(String).filter(Boolean) : [],
    'Rule Hits': ruleHits,
    'Rules Checked At': new Date().toISOString(),
    'Rule Error': ruleError,
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
  const fixText = recTranscriptFix_(getConfig_()); // built-in corrections + Recording rules → Words and spellings
  rawTranscript = fixText(rawTranscript);

  // Speaker-labelled transcript, formatted exactly like the Recorder's
  let formatted = rawTranscript;
  const paragraphs = alt.paragraphs ? alt.paragraphs.paragraphs : null;
  if (paragraphs && paragraphs.length) {
    formatted = paragraphs.map(function (p) {
      let label = 'Speaker ' + p.speaker;
      let colorClass = 'text-gray-700';
      if (p.speaker === 0) { label = staffName || 'Staff'; colorClass = 'text-blue-800'; }
      else if (p.speaker === 1) { label = 'Patient'; colorClass = 'text-teal-700'; }
      const sentences = (p.sentences || []).map(function (s) { return fixText(s.text); }).join(' ');
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
  try { return deleteRecording_(body); }
  catch (err) {
    console.error('Delete recording failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  }
}

function deleteRecording_(body) {
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

// Removes anything unsafe from an email. keepStyle: keep <style> blocks (emails written in HTML code)
function sanitizeEmailHtml_(html, keepStyle) {
  const tags = (keepStyle ? '' : 'style|') + 'script|iframe|object|embed|form|input|button|textarea|select|link|meta';
  return String(html || '')
    // Whole blocks: the tags and everything inside them
    .replace(/<\s*(script|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*style\b[^>]*>([\s\S]*?)<\s*\/\s*style\s*>/gi, function (m, css) {
      return keepStyle && !/expression\s*\(|javascript:|@import|behavior\s*:/i.test(css) ? m : '';
    })
    // Any of these tags left on their own (their contents stay)
    .replace(new RegExp('<\\s*\\/?\\s*(' + tags + ')\\b[^>]*>', 'gi'), '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
    .trim();
}
// Readable plain text for the audit sheet
function emailHtmlToText_(html) {
  return String(html || '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
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

    // Recording rules: put this recording's highlights and note lines back (no new reminders)
    try { recAddToNotes_(soapJson, Array.isArray(rec['Rule Hits']) ? rec['Rule Hits'] : []); }
    catch (e) { console.warn('Rule lines not re-added on regenerate: ' + e); }

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
    .map(function (s) {
      return { id: s.id, name: s.name, role: s.role, hasEmail: !!s.email,
        photo: s.photo || '',                 // profile photo link (chat avatars)
        injector: s.injector === true,        // carries a kit (Inventory → Set an injector's kit, chat "Injectors")
        providerNo: s.providerNo || '', prescriberNo: s.prescriberNo || '', ahpraNo: s.ahpraNo || '', quals: s.quals || '' };
    })
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
  if (!can_(session, task.category === 'patient' ? 'tasks.patient' : 'tasks.staff')) return { ok: false, error: 'FORBIDDEN' };

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
      if (s && isEmail_(s.email)) recipients.push({ id: s.id, name: s.name, first: String(s.name || '').split(' ')[0], email: s.email });
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
    const a = wantedAtt[i] || {};
    const name = cleanFileName_(a.name, 'Attachment');
    const bytes = pdfBytes_(a.pdf);
    if (bytes) { attachments.push(Utilities.newBlob(bytes, MimeType.PDF, name)); continue; }
    // The browser couldn't make this PDF, so it's made here from the form instead
    const html = sanitizePdfHtml_(a.html);
    if (!html || html.length > 4000000) return { ok: false, error: 'PDF_FAILED' };
    try {
      attachments.push(Utilities.newBlob(html, 'text/html', 'form.html').getAs(MimeType.PDF).setName(name));
    } catch (err) {
      console.error('Task attachment PDF failed: ' + (err && err.stack ? err.stack : err));
      return { ok: false, error: 'PDF_FAILED' };
    }
  }

  const escH = function (s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };

  // Image Bank pictures and the clinic logo travel inside the email
  const inlined = inlineTaskImages_(cfg, htmlRaw);
  const hasImages = Object.keys(inlined.images).length > 0;

  // One email per person, with their own name filled in (staff tasks)
  recipients.forEach(function (r) {
    const subject = subjectRaw.replace(/\{First name\}/gi, r.first).replace(/\{Full name\}/gi, r.name);
    const html = fillPersonTagsInLinks_(inlined.html, { 'first name': r.first, 'full name': r.name })
      .replace(/\{First name\}/gi, escH(r.first)).replace(/\{Full name\}/gi, escH(r.name));
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

  let todos = 0;
  const todo = staffTodoOpts_(body.todo);
  if (task.category === 'staff' && todo.on) {
    todos = staffTodoCreate_(cfg, {
      recipients: recipients, text: subjectRaw, due: todo.due, patientId: patientId, patientName: patientName,
      taskId: taskId, taskName: String(task.name || ''), runId: runId,
      by: String(session.name || ''), byUid: String(session.uid || ''),
    });
  }
  console.log('Task "' + task.name + '" sent to ' + recipients.length + ' recipient(s) by ' + session.name);
  return { ok: true, runId: runId, sent: recipients.length, todos: todos };
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
    // Not an Image Bank picture or the logo: an ordinary https picture is kept as it is (email apps load it)
    if (!key) return /\ssrc\s*=\s*["']https:\/\//i.test(tag) ? tag : '';
    return tag
      .replace(/\s(?:src|data-bank|data-logo)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/^<img/i, '<img src="cid:' + key + '"');
  });
  return { html: out, images: images };
}

// {First name} / {Full name} / {Today} inside a link (href) are made URL-safe; elsewhere they're filled as text
function fillPersonTagsInLinks_(html, vals) {
  return String(html || '').replace(/(\shref\s*=\s*")([^"]*)(")/gi, function (m, a, url, c) {
    return a + url.replace(/\{\s*(first name|full name|today)\s*\}/gi, function (t, k) {
      const v = vals[k.toLowerCase().replace(/\s+/g, ' ')];
      return v === undefined ? t : encodeURIComponent(v);
    }) + c;
  });
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
    if (op === 'replaceRecord') {
      if (!can_(session, 'ssp.create')) return { ok: false, error: 'FORBIDDEN' };
      return sspAppendRecord_(String(body.recordId || ''), true);
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
// replace = true (after an edit): the protocol's old rows are removed first, then the new ones written
function sspAppendRecord_(id, replace) {
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'BUSY' };
  try {
    const cfg = getConfig_();
    const rec = fsGetDoc_(cfg, 'ssp_records/' + id);
    if (!rec) return { ok: false, error: 'NOT_FOUND' };
    if (rec.sheetSynced && !replace) return { ok: true, already: true };

    const sheet = SpreadsheetApp.openById(SSP_SHEET_ID).getSheetByName(SSP_SHEET_NAME);
    if (!sheet) throw new Error('Sheet tab not found: ' + SSP_SHEET_NAME);
    let removed = 0;
    if (replace) {
      const rid = String(rec.recordId || id);
      const last = sheet.getLastRow();
      if (last >= 2) {
        const hits = sheet.getRange(2, 1, last - 1, 1).createTextFinder(rid).matchEntireCell(true).findAll()
          .map(function (r) { return r.getRow(); })
          .sort(function (a, b) { return b - a; }); // bottom up, so row numbers don't shift
        hits.forEach(function (r) { sheet.deleteRow(r); });
        removed = hits.length;
      }
    }
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
    console.log('SSP ' + (rec.recordId || id) + ': ' + (replace ? removed + ' old row(s) replaced with ' : '') +
      rows.length + ' row(s) in ' + SSP_SHEET_NAME);
    return { ok: true, rows: rows.length, removed: removed };
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

// The starting roles. Admins can add more in Staff → Roles & access (stored in staff_roles/config).
const STAFF_ROLES_ = ['Admin', 'Clinician', 'Reception'];
const ROLE_NAME_RE_ = /^[A-Za-z][A-Za-z0-9 &'-]{0,39}$/;

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
// A partial update (only these fields) for commitWrites_. The document must already exist.
function patchWrite_(cfg, path, obj) {
  return {
    update: { name: fsBase_(cfg) + '/' + path, fields: toFields_(obj) },
    updateMask: { fieldPaths: Object.keys(obj).map(quoteField_) },
    currentDocument: { exists: true },
  };
}

// The Activity entry as a write, so it's saved together with the change it describes
function staffAuditWrite_(cfg, session, action, target, details) {
  return updateWrite_(cfg, 'staff_audit/a_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
    at: new Date().toISOString(),
    by: String(session.name || ''), byUid: String(session.uid || ''),
    action: action, targetId: String(target.id || ''), targetName: String(target.name || ''),
    details: String(details || '').slice(0, 300),
  });
}

function staffAudit_(cfg, session, action, target, details) {
  try { commitWrites_(cfg, [staffAuditWrite_(cfg, session, action, target, details)]); }
  catch (e) { console.warn('Staff audit not saved: ' + e); }
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
  if (op === 'setPhoto') return staffSetPhoto_(String(body.photo || ''), session); // anyone: their own photo
  if (op === 'mySchedule') return staffMySchedule_(session); // anyone: their own schedule
  if (!/^admin$/i.test(String(session.role || ''))) return { ok: false, error: 'FORBIDDEN' };
  try {
    if (op === 'roles') return rolesGet_();
    if (op === 'saveRoles') return rolesSave_(body.roles || {}, body.roleNames, session);
    if (op === 'list') return staffList_();
    if (op === 'save') return staffSave_(body.staff || {}, session);
    if (op === 'resetPin') return staffResetPin_(String(body.id || ''), String(body.pin || ''), session);
    if (op === 'setActive') return staffSetActive_(String(body.id || ''), body.active === true, session);
    if (op === 'setEodPopup') return staffSetEodPopup_(String(body.id || ''), body.on === true, session);
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
      injector: s.injector === true,
      providerNo: s.providerNo || '', prescriberNo: s.prescriberNo || '', ahpraNo: s.ahpraNo || '', quals: s.quals || '',
      access: s.access || { allow: [], deny: [] },
      schedule: s.schedule || null, eodPopup: s.eodPopup !== false };
  }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  return { ok: true, staff: staff, roles: roleNames_(), locked: isLockedOut_() };
}

// Provider / prescriber / AHPRA numbers and the title line. All optional; checked loosely.
function staffRegClean_(p) {
  const code = function (v, n) { return String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase().slice(0, n); };
  const out = {
    providerNo: code(p.providerNo, 12),
    prescriberNo: code(p.prescriberNo, 10),
    ahpraNo: code(p.ahpraNo, 16),
    quals: staffClean_(p.quals, 150),
  };
  if (out.providerNo && !/^\d{5,6}[0-9A-Z][A-Z]$/.test(out.providerNo)) return { error: 'BAD_PROVIDER' };
  if (out.prescriberNo && !/^\d{6,7}$/.test(out.prescriberNo)) return { error: 'BAD_PRESCRIBER' };
  if (out.ahpraNo && !/^[A-Z]{3}\d{10}$/.test(out.ahpraNo)) return { error: 'BAD_AHPRA' };
  return out;
}

// Work schedule (Staff → Edit → Work schedule): the usual week, leave, and their name in the appointment book.
// { schedule } (null when nothing is set) or { error }
const SCHED_DAY_KEYS_ = ['mo', 'tu', 'we', 'th', 'fr', 'sa', 'su'];
const LEAVE_TYPES_ = ['Annual leave', 'Sick', 'Other'];
function hmMin_(s) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function staffSchedClean_(raw) {
  if (!raw || typeof raw !== 'object') return { schedule: null };
  const hm = function (v) { v = String(v || ''); return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : ''; };
  const dk = function (v) { v = String(v || ''); return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ''; };
  const week = {};
  let any = false;
  for (let i = 0; i < SCHED_DAY_KEYS_.length; i++) {
    const k = SCHED_DAY_KEYS_[i];
    const d = (raw.week && raw.week[k]) || {};
    if (d.on !== true) { week[k] = { on: false, start: '', end: '' }; continue; }
    const s = hm(d.start), e = hm(d.end);
    if (!s || !e || e <= s) return { error: 'BAD_HOURS' };
    week[k] = { on: true, start: s, end: e };
    any = true;
  }
  const cutoff = Utilities.formatDate(new Date(Date.now() - 90 * 86400000), REC_TZ_, 'yyyy-MM-dd');
  const leave = [];
  const list = Array.isArray(raw.leave) ? raw.leave : [];
  for (let i = 0; i < list.length && leave.length < 40; i++) {
    const l = list[i] || {};
    const from = dk(l.from);
    const to = dk(l.to) || from;
    if (!from) continue;
    if (to < from) return { error: 'BAD_LEAVE' };
    if (to < cutoff) continue;   // leave that ended over 90 days ago is tidied away
    leave.push({ from: from, to: to, type: LEAVE_TYPES_.indexOf(l.type) !== -1 ? l.type : 'Other', note: staffClean_(l.note, 120) });
  }
  leave.sort(function (a, b) { return a.from.localeCompare(b.from); });
  const apptName = staffClean_(raw.apptName, 80);
  if (!any && !leave.length && !apptName) return { schedule: null };
  return { schedule: { week: week, leave: leave, apptName: apptName } };
}

// Anyone logged in: their own work schedule (for the End of day reminder)
function staffMySchedule_(session) {
  let s = null;
  try { s = getStaffDocs_().filter(function (x) { return x.id === session.uid; })[0] || null; }
  catch (e) { return { ok: false, error: 'BUSY' }; }
  if (!s) return { ok: false, error: 'UNAUTHORIZED' };
  return { ok: true, schedule: staffSchedClean_(s.schedule).schedule || null, popup: s.eodPopup !== false };
}

function staffSave_(p, session) {
  const cfg = getConfig_();
  const name = staffClean_(p.name, 120);
  if (!name) return { ok: false, error: 'BAD_NAME' };
  const role = roleNames_().filter(function (r) { return r.toLowerCase() === String(p.role || '').toLowerCase(); })[0];
  if (!role) return { ok: false, error: 'BAD_ROLE' };
  const email = String(p.email || '').trim();
  if (email && !isEmail_(email)) return { ok: false, error: 'BAD_EMAIL' };
  const photo = String(p.photo || '').trim().slice(0, 1000);
  if (photo && !/^https:\/\//i.test(photo)) return { ok: false, error: 'BAD_PHOTO' };
  const all = staffFresh_();
  const now = new Date().toISOString();
  const access = cleanAccess_(p.access, role);
  const injector = p.injector === true;
  const reg = staffRegClean_(p);
  if (reg.error) return { ok: false, error: reg.error };

  const sched = staffSchedClean_(p.schedule);
  if (sched.error) return { ok: false, error: sched.error };
  const schedule = sched.schedule;
  const popupOf = (cur) => (p.eodPopup === undefined ? !(cur && cur.eodPopup === false) : p.eodPopup !== false);

  if (p.id) {
    const cur = all.filter(function (s) { return s.id === String(p.id); })[0];
    if (!cur) return { ok: false, error: 'NOT_FOUND' };
    if (/^admin$/i.test(cur.role) && role !== 'Admin' && cur.active !== false && !activeAdmins_(all, cur.id)) {
      return { ok: false, error: 'LAST_ADMIN' };
    }
    const changes = [];
    if (cur.name !== name) changes.push('name');
    if (cur.role !== role) changes.push('role ' + cur.role + ' → ' + role);
    if (cur.email !== email) changes.push('email');
    if (cur.photo !== photo) changes.push('photo');
    if ((cur.injector === true) !== injector) changes.push(injector ? 'now an injector' : 'no longer an injector');
    if ((cur.providerNo || '') !== reg.providerNo) changes.push('provider number');
    if ((cur.prescriberNo || '') !== reg.prescriberNo) changes.push('prescriber number');
    if ((cur.ahpraNo || '') !== reg.ahpraNo) changes.push('AHPRA number');
    if ((cur.quals || '') !== reg.quals) changes.push('title');
    if (JSON.stringify(cur.access || { allow: [], deny: [] }) !== JSON.stringify(access)) changes.push('access');
    if (JSON.stringify(staffSchedClean_(cur.schedule).schedule || null) !== JSON.stringify(schedule)) changes.push('work schedule');
    const eodPopup = popupOf(cur);
    if ((cur.eodPopup !== false) !== eodPopup) changes.push(eodPopup ? 'End of day pop-up on' : 'End of day pop-up off');

    // The change and its Activity entry in one write
    commitWrites_(cfg, [
      patchWrite_(cfg, STAFF_COLLECTION + '/' + cur.id, {
        'Staff Name': name, 'Role': role, 'Email address': email, 'Profile Photo': photo, 'Access': access,
        'Injector': injector, 'Provider Number': reg.providerNo, 'Prescriber Number': reg.prescriberNo,
        'AHPRA Number': reg.ahpraNo, 'Qualifications': reg.quals, 'Schedule': schedule, 'EOD Popup': eodPopup,
        'Updated At': now, 'Updated By': String(session.name || ''),
      }),
      staffAuditWrite_(cfg, session, 'Edited', { id: cur.id, name: name }, changes.join(', ')),
    ]);
    CacheService.getScriptCache().remove('staff_docs_v1');
    return { ok: true, id: cur.id };
  }

  const pin = p.pin ? String(p.pin).trim() : newPin_(all);
  if (!/^\d{4,8}$/.test(pin)) return { ok: false, error: 'BAD_PIN' };
  if (pinInUse_(all, pin, '')) return { ok: false, error: 'PIN_TAKEN' };
  const id = 'st_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  commitWrites_(cfg, [
    updateWrite_(cfg, STAFF_COLLECTION + '/' + id, {
      'Staff Name': name, 'Role': role, 'Email address': email, 'Profile Photo': photo,
      'PIN': '', 'PIN Hash': pinHash_(pin), 'Active': true, 'Access': access, 'Injector': injector,
      'Provider Number': reg.providerNo, 'Prescriber Number': reg.prescriberNo,
      'AHPRA Number': reg.ahpraNo, 'Qualifications': reg.quals, 'Schedule': schedule, 'EOD Popup': popupOf(null),
      'Created At': now, 'Created By': String(session.name || ''),
    }),
    staffAuditWrite_(cfg, session, 'Added', { id: id, name: name }, 'role ' + role),
  ]);
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
  commitWrites_(cfg, [
    patchWrite_(cfg, STAFF_COLLECTION + '/' + id, {
      'PIN Hash': pinHash_(pin), 'PIN': '', 'Updated At': new Date().toISOString(), 'Updated By': String(session.name || ''),
    }),
    staffAuditWrite_(cfg, session, 'Reset PIN', cur, wanted ? 'typed by admin' : 'made by the portal'),
  ]);
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
  const firebase = setFirebaseUserDisabled_(cfg, id, !active);
  commitWrites_(cfg, [
    patchWrite_(cfg, STAFF_COLLECTION + '/' + id, {
      'Active': active, 'Updated At': new Date().toISOString(), 'Updated By': String(session.name || ''),
    }),
    staffAuditWrite_(cfg, session, active ? 'Turned on' : 'Turned off', cur, firebase ? '' : 'Firebase sign-in not updated'),
  ]);
  CacheService.getScriptCache().remove('staff_docs_v1');
  return { ok: true, firebase: firebase };
}

// Staff list → Pop-up On / Off: whether End of day opens by itself for this person
function staffSetEodPopup_(id, on, session) {
  const cur = staffFresh_().filter(function (s) { return s.id === id; })[0];
  if (!cur) return { ok: false, error: 'NOT_FOUND' };
  if ((cur.eodPopup !== false) === on) return { ok: true, on: on };
  const cfg = getConfig_();
  commitWrites_(cfg, [
    patchWrite_(cfg, STAFF_COLLECTION + '/' + id, {
      'EOD Popup': on, 'Updated At': new Date().toISOString(), 'Updated By': String(session.name || ''),
    }),
    staffAuditWrite_(cfg, session, on ? 'End of day pop-up on' : 'End of day pop-up off', cur, ''),
  ]);
  CacheService.getScriptCache().remove('staff_docs_v1');
  return { ok: true, on: on };
}

// Only a photo uploaded into this person's own folder: staff_photos/<their id>/…
function staffPhotoOk_(url, uid) {
  if (url.length > 1000) return false;
  const m = /^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^\/?#]+\/o\/([^?#]+)\?/.exec(url);
  if (!m) return false;
  try { return decodeURIComponent(m[1]).indexOf('staff_photos/' + uid + '/') === 0; } catch (e) { return false; }
}

// Any staff member changing (or removing) their own profile photo
function staffSetPhoto_(url, session) {
  url = url.trim();
  if (url && !staffPhotoOk_(url, session.uid)) return { ok: false, error: 'BAD_PHOTO' };
  const cur = getStaffDocs_().filter(function (s) { return s.id === session.uid; })[0];
  if (!cur) return { ok: false, error: 'UNAUTHORIZED' };
  const cfg = getConfig_();
  commitWrites_(cfg, [
    patchWrite_(cfg, STAFF_COLLECTION + '/' + cur.id, {
      'Profile Photo': url, 'Updated At': new Date().toISOString(), 'Updated By': String(session.name || ''),
    }),
    staffAuditWrite_(cfg, session, url ? 'Changed own photo' : 'Removed own photo', cur, ''),
  ]);
  CacheService.getScriptCache().remove('staff_docs_v1');
  return { ok: true, photo: url };
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
  ['calendar.book', 'Menus', 'Calendar: add last-minute bookings (until the next Day Sheet upload)'],
  ['menu.forms', 'Menus', 'Form Builder (see forms)'],
  ['menu.tasks', 'Menus', 'Task Manager'],
  ['patients.edit', 'Patients', 'Add and edit patient details'],
  ['patients.merge', 'Patients', 'Merge duplicate patients'],
  ['records.move', 'Patients', 'Move records to another patient'],
  ['clinical.view', 'Patients', 'See clinical notes, treatment plans and social history'],
  ['billing.view', 'Patients', 'See billing and prescriptions'],
  ['consult.record', 'Consultations', 'Record consultations and edit notes'],
  ['consult.delete', 'Consultations', 'Delete any recording (staff can always delete their own)'],
  ['send.patients', 'Sending', 'Email and print to patients'],
  ['sms.send', 'Sending', 'Text patients from their page (Textmagic)'],
  ['tasks.run', 'Task Manager', 'Run tasks (turn this off to stop all task sending and printing)'],
  ['tasks.patient', 'Task Manager', 'Create new task → To Patient'],
  ['tasks.staff', 'Task Manager', 'Create new task → To Staff'],
  ['tasks.print', 'Task Manager', 'Create new task → To Print'],
  ['tasks.history', 'Task Manager', 'Task history'],
  ['data.upload', 'Task Manager', 'Daily uploads: Timely day sheet, invoices and packages'],
  ['marketing.manage', 'Task Manager', 'Marketing: campaigns, email templates and the do-not-contact list'],
  ['recall.work', 'Recall', 'Recall: work the list (call, log, give to someone, stop)'],
  ['recall.manage', 'Recall', 'Recall settings: intervals, the recall team and reasons'],
  ['tasks.build', 'Task Manager', 'Task types and End of day setup'],
  ['forms.build', 'Building', 'Build forms, Image Bank and Aftercare Bank'],
  ['flows.build', 'Building', 'Build email flows (System configuration)'],
  ['ssp.create', 'Skin Script', 'Create Skin Script Protocols'],
  ['ssp.config', 'Skin Script', 'Skin Script products and design'],
  ['menu.inventory', 'Inventory', 'Inventory menu (open Inventory)'],
  ['inventory.view', 'Inventory', 'See stock, products, suppliers and activity'],
  ['inventory.request', 'Inventory', 'Request orders'],
  ['inventory.receive', 'Inventory', 'Receive deliveries'],
  ['inventory.order', 'Inventory', 'Ordering team: purchase orders and moving stock (includes receiving)'],
  ['inventory.manage', 'Inventory', 'Manage products, suppliers and stock counts'],
  ['inventory.kit', 'Inventory', 'Carries a kit (set by the Injector tick on each staff member)'],
  ['inventory.jt', 'Inventory', 'Approves releases from JT storage'],
  ['inventory.count', 'Inventory', 'Does the opening count (Shelf and JT storage)'],
  ['inventory.history', 'Inventory', 'Record orders received before the portal (no stock change)'],
  ['menu.scanner', 'Scanner', 'Scanner menu (open the Scanner)'],
  ['scanner.billing', 'Scanner', 'Scan billing sheets (takes products off the Shelf)'],
  ['scanner.docket', 'Scanner', 'Scan delivery dockets'],
  ['scanner.rx', 'Scanner', 'Scan product prescriptions (adds them to the patient)'],
  ['menu.reports', 'Menus', 'Reporting: variance, wastage, kit reconciliation and usage'],
  ['reports.patients', 'Menus', 'Reporting: patient lists (packages left, Skin Scripts expiring, new patients) with contact details'],
  ['dash.attention', 'My dashboard', 'Needs my attention'],
  ['dash.appts', 'My dashboard', 'My appointments today'],
  ['dash.tasks', 'My dashboard', 'Open staff tasks'],
  ['dash.kit', 'My dashboard', 'My kit (injectors only)'],
  ['dash.records', 'My dashboard', 'My records'],
  ['dash.usage', 'My dashboard', 'What I used'],
  ['dash.requests', 'My dashboard', 'My requests'],
  ['dash.stock', 'My dashboard', 'Stock I use'],
  ['dash.overview', 'My dashboard', 'Clinic overview'],
];
const PERMS_ALL_ = PERMS_.map(function (p) { return p[0]; });
const ROLE_DEFAULTS_ = {
  Clinician: ['menu.patients', 'menu.calendar', 'menu.tasks', 'patients.edit', 'clinical.view', 'billing.view',
    'consult.record', 'send.patients', 'tasks.run', 'tasks.patient', 'tasks.staff', 'tasks.print', 'tasks.history', 
    'ssp.create', 'menu.inventory', 'inventory.request', 'inventory.receive',
    'menu.scanner', 'scanner.billing', 'scanner.docket',
    'dash.attention', 'dash.appts', 'dash.tasks', 'dash.kit', 'dash.records', 'dash.usage', 'dash.requests', 'dash.stock'],
  Reception: ['menu.patients', 'menu.calendar', 'calendar.book', 'menu.tasks', 'patients.edit', 'send.patients', 'tasks.run',
    'tasks.patient', 'tasks.staff', 'tasks.print', 'tasks.history',
    'menu.inventory', 'inventory.view', 'inventory.request', 'inventory.receive', 'inventory.order', 'inventory.count', 'menu.reports',
    'menu.scanner', 'scanner.billing', 'scanner.docket',
    'dash.attention', 'dash.appts', 'dash.tasks', 'dash.requests', 'dash.overview', 'recall.work'],
};


// Run ONCE from the editor after adding the Scanner permissions: every existing role keeps the Scanner.
// Untick it afterwards in Staff → Roles & access for any role that shouldn't have it.
function grantScannerAccess() {
  const cfg = getConfig_();
  const doc = fsGetDoc_(cfg, 'staff_roles/config');
  if (!doc || !doc.roles) { console.log('Roles have never been saved, so the defaults apply. Nothing to do.'); return; }
  const add = ['menu.scanner', 'scanner.billing', 'scanner.docket'];
  const roles = doc.roles;
  const changed = [];
  Object.keys(roles).forEach(function (r) {
    if (/^admin$/i.test(r)) return;
    const list = Array.isArray(roles[r]) ? roles[r].slice() : [];
    const before = list.length;
    add.forEach(function (p) { if (list.indexOf(p) === -1) list.push(p); });
    roles[r] = list;
    if (list.length !== before) changed.push(r);
  });
  fsPatch_(cfg, 'staff_roles/config', {
    roles: roles, updatedAt: new Date().toISOString(), updatedBy: 'grantScannerAccess (editor)',
  });
  CacheService.getScriptCache().remove('roles_cfg_v2');
  console.log('Scanner access added to: ' + (changed.join(', ') || 'nobody (already had it)'));
}

// Run ONCE from the editor after adding the Task Manager ticks: everyone who can run tasks keeps every section.
// Untick sections afterwards in Staff → Roles & access (or per person in their Edit window).
function grantTaskSections() {
  const cfg = getConfig_();
  const add = ['tasks.patient', 'tasks.staff', 'tasks.print', 'tasks.history'];
  const roleNames = [];
  const doc = fsGetDoc_(cfg, 'staff_roles/config');
  if (doc && doc.roles) {
    const roles = doc.roles;
    Object.keys(roles).forEach(function (r) {
      const list = Array.isArray(roles[r]) ? roles[r].slice() : [];
      if (list.indexOf('tasks.run') === -1) return;
      add.forEach(function (p) { if (list.indexOf(p) === -1) list.push(p); });
      roles[r] = list;
      roleNames.push(r);
    });
    fsPatch_(cfg, 'staff_roles/config', {
      roles: roles, updatedAt: new Date().toISOString(), updatedBy: 'grantTaskSections (editor)',
    });
  }
  // People given "Always allow: Run tasks" in their own Edit window
  let people = 0;
  staffFresh_().forEach(function (s) {
    const acc = s.access || {};
    const allow = Array.isArray(acc.allow) ? acc.allow.slice() : [];
    const deny = Array.isArray(acc.deny) ? acc.deny.slice() : [];
    if (allow.indexOf('tasks.run') === -1) return;
    add.forEach(function (p) { if (allow.indexOf(p) === -1 && deny.indexOf(p) === -1) allow.push(p); });
    fsPatch_(cfg, STAFF_COLLECTION + '/' + s.id, { 'Access': { allow: allow, deny: deny } });
    people++;
  });
  CacheService.getScriptCache().remove('roles_cfg_v2');
  CacheService.getScriptCache().remove('staff_docs_v1');
  console.log('Task Manager sections added to roles: ' + (roleNames.join(', ') || 'none (defaults apply)') +
    ' · and ' + people + ' person/people with their own exception.');
}

// Role names + each role's ticks, from staff_roles/config (defaults until it's first saved).
// Cached 5 minutes. If Firestore can't be read, the last roles that loaded properly are used,
// never the defaults, so a hiccup can't change anyone's access.
function rolesData_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('roles_cfg_v2');
  if (hit) return JSON.parse(hit);
  const props = PropertiesService.getScriptProperties();
  let doc = null;
  try { doc = fsGetDoc_(getConfig_(), 'staff_roles/config'); }
  catch (e) {
    console.warn('Roles config not read: ' + e);
    const last = props.getProperty('ROLES_LAST_GOOD');
    if (last) return JSON.parse(last);
    // Nothing remembered yet: fall through to the defaults (only ever on a brand-new setup)
  }

  const seen = { admin: true };
  const names = ['Admin'];
  ((doc && Array.isArray(doc.roleNames)) ? doc.roleNames : STAFF_ROLES_).forEach(function (raw) {
    const n = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!n || seen[n.toLowerCase()] || !ROLE_NAME_RE_.test(n)) return;
    seen[n.toLowerCase()] = true;
    names.push(n);
  });

  const roles = {};
  names.forEach(function (r) {
    if (/^admin$/i.test(r)) return;
    const v = doc && doc.roles && Array.isArray(doc.roles[r]) ? doc.roles[r] : (ROLE_DEFAULTS_[r] || []);
    roles[r] = v.filter(function (p) { return PERMS_ALL_.indexOf(p) !== -1; });
  });

  const out = { names: names, roles: roles };
  const json = JSON.stringify(out);
  try { cache.put('roles_cfg_v2', json, 300); } catch (e) { /* not essential */ }
  try { if (props.getProperty('ROLES_LAST_GOOD') !== json) props.setProperty('ROLES_LAST_GOOD', json); }
  catch (e) { console.warn('Roles backup not saved: ' + e); }
  return out;
}

function rolesConfig_() { return rolesData_().roles; }
function roleNames_() { return rolesData_().names; }
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
  if (s.injector === true) set['inventory.kit'] = true; else delete set['inventory.kit'];
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
  let s;
  try { s = getStaffDocs_().filter(function (x) { return x.id === session.uid; })[0]; }
  catch (e) { console.warn('Access check skipped: ' + e); return { ok: false, error: 'BUSY' }; }
  if (!s) return { ok: false, error: 'UNAUTHORIZED' };
  const perms = effectivePerms_(s);
  const token = createCustomToken_(s.id, {
    staffName: s.name, staffRole: s.role, staffPhoto: s.photo, staffEmail: s.email,
    injector: s.injector === true, perms: perms,
  });
  return { ok: true, role: s.role, name: s.name, perms: perms, injector: s.injector === true, token: token,
    session: createSession_(s) };
}
function rolesGet_() {
  const d = rolesData_();
  return {
    ok: true,
    perms: PERMS_.map(function (p) { return { key: p[0], group: p[1], label: p[2] }; }),
    roles: d.roles,
    roleNames: d.names,
  };
}

// roles: { RoleName: [perm keys] }. roleNames: the full list in order (Admin is always kept).
function rolesSave_(roles, roleNames, session) {
  const cur = rolesData_();
  let names = cur.names;
  if (Array.isArray(roleNames)) {
    const seen = { admin: true };
    names = ['Admin'];
    for (let i = 0; i < roleNames.length; i++) {
      const n = String(roleNames[i] == null ? '' : roleNames[i]).replace(/\s+/g, ' ').trim();
      if (/^admin$/i.test(n)) continue;
      if (!ROLE_NAME_RE_.test(n)) return { ok: false, error: 'BAD_ROLE_NAME' };
      if (seen[n.toLowerCase()]) return { ok: false, error: 'ROLE_EXISTS' };
      seen[n.toLowerCase()] = true;
      names.push(n);
    }
    if (names.length > 21) return { ok: false, error: 'BAD_ROLE_NAME' };
  }

  // A role can't be removed while anyone (including turned-off staff) still has it
  const keep = {};
  names.forEach(function (n) { keep[n.toLowerCase()] = true; });
  const removed = cur.names.filter(function (n) { return !keep[n.toLowerCase()]; });
  if (removed.length) {
    const all = staffFresh_();
    const used = removed.filter(function (r) {
      return all.some(function (s) { return String(s.role || '').toLowerCase() === r.toLowerCase(); });
    });
    if (used.length) return { ok: false, error: 'ROLE_IN_USE', detail: used.join(', ') };
  }
  const added = names.filter(function (n) {
    return !cur.names.some(function (c) { return c.toLowerCase() === n.toLowerCase(); });
  });

  const out = {};
  names.forEach(function (r) {
    if (/^admin$/i.test(r)) return;
    const v = roles && Array.isArray(roles[r]) ? roles[r] : [];
    out[r] = PERMS_ALL_.filter(function (p) { return v.indexOf(p) !== -1; });
  });

  const cfg = getConfig_();
  commitWrites_(cfg, [
    updateWrite_(cfg, 'staff_roles/config', {
      roles: out, roleNames: names, updatedAt: new Date().toISOString(), updatedBy: String(session.name || ''),
    }),
    staffAuditWrite_(cfg, session, 'Changed role access', {}, [
      added.length ? 'added ' + added.join(', ') : '',
      removed.length ? 'removed ' + removed.join(', ') : '',
      Object.keys(out).map(function (r) { return r + ': ' + out[r].length + ' ticks'; }).join(', '),
    ].filter(Boolean).join(' · ')),
  ]);
  CacheService.getScriptCache().remove('roles_cfg_v2');
  return { ok: true, roles: out, roleNames: names };
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
    const html = fill(fillPersonTagsInLinks_(inlined.html, { 'first name': p.first, 'full name': p.name, today: today }), true);
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
    try { runScheduledTaskEmails_(cfg); } catch (e) { console.error('Scheduled emails: ' + (e && e.stack ? e.stack : e)); }
    try { runStaffSchedules_(cfg, now); } catch (e) { console.error('Staff schedules: ' + (e && e.stack ? e.stack : e)); }
    try { runEmailFlows_(cfg, now + 5 * 60000); } catch (e) { console.error('Email flows: ' + (e && e.stack ? e.stack : e)); }
  } finally {
    lock.releaseLock();
  }
}

// Scheduled staff tasks (Task Builder → Schedule)
function runStaffSchedules_(cfg, now) {
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

// ===================== Task Manager: emails scheduled for later =====================
// "Schedule" on the task screen saves the finished email in task_scheduled. runScheduledTasks (every 15 minutes)
// sends it when it's due, filling in {Upcoming appointments} and {Today} on the day, so the patient gets the
// schedule as it is then. Attachments wait in a Drive folder and are binned once sent or cancelled.

const SCHED_COL_ = 'task_scheduled';
const SCHED_MAX_DAYS_ = 90;
const SCHED_APPTS_RE_ = function () { return /\{\s*upcoming appointments\s*\}/gi; };
const SCHED_TODAY_RE_ = function () { return /\{\s*today\s*\}/gi; };

function handleScheduleTaskEmail_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'tasks.run')) return { ok: false, error: 'FORBIDDEN' };
  const op = String(body.op || '');
  try {
    if (op === 'create') return schedCreate_(body, session);
    const id = String(body.id || '');
    if (!/^sch_[A-Za-z0-9]{10,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
    if (op === 'cancel' || op === 'reschedule' || op === 'sendNow') return schedChange_(op, id, body, session);
  } catch (err) {
    console.error('Scheduled email ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

// At least 4 minutes from now, at most 90 days
function schedTimeOk_(raw) {
  const ms = Date.parse(String(raw || ''));
  const now = Date.now();
  if (!ms || ms < now + 4 * 60000) return { error: 'BAD_TIME' };
  if (ms > now + SCHED_MAX_DAYS_ * 86400000) return { error: 'TOO_FAR' };
  return { ms: ms };
}

// Where attachments wait until their email goes (made the first time it's needed)
function schedAttFolder_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('SCHEDULED_ATT_FOLDER_ID');
  if (id) {
    try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) { /* made again below */ }
  }
  const f = DriveApp.createFolder('Dermedica portal: scheduled email attachments');
  p.setProperty('SCHEDULED_ATT_FOLDER_ID', f.getId());
  return f;
}

// A task attachment from the browser as a PDF (the browser's PDF, or made here from the form)
function taskAttachmentBlob_(a) {
  a = a || {};
  const name = cleanFileName_(a.name, 'Attachment');
  const bytes = pdfBytes_(a.pdf);
  if (bytes) return Utilities.newBlob(bytes, MimeType.PDF, name);
  const html = sanitizePdfHtml_(a.html);
  if (!html || html.length > 4000000) return null;
  try { return Utilities.newBlob(html, 'text/html', 'form.html').getAs(MimeType.PDF).setName(name); }
  catch (err) { console.error('Scheduled attachment PDF failed: ' + err); return null; }
}

function schedCreate_(body, session) {
  const taskId = String(body.taskId || '').trim();
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(taskId)) return { ok: false, error: 'BAD_REQUEST' };
  const when = schedTimeOk_(body.sendAt);
  if (when.error) return { ok: false, error: when.error };

  const cfg = getConfig_();
  const task = fsGetDoc_(cfg, 'task_types/' + taskId);
  if (!task || task.status !== 'live') return { ok: false, error: 'TASK_NOT_LIVE' };
  if (task.channel !== 'email') return { ok: false, error: 'BAD_REQUEST' };
  if (!can_(session, task.category === 'patient' ? 'tasks.patient' : 'tasks.staff')) return { ok: false, error: 'FORBIDDEN' };

  const subject = String(body.subject || '').trim().slice(0, 200);
  const html = sanitizeEmailHtml_(body.html);
  if (!subject || !html || html.length > 200000) return { ok: false, error: 'BAD_REQUEST' };
  const cc = String(body.cc || '').trim();
  if (cc && !isEmail_(cc)) return { ok: false, error: 'BAD_EMAIL' };

  const patientId = String(body.patientId || '').trim();
  let patient = null;
  if (patientId) {
    if (!recDocIdOk_(patientId)) return { ok: false, error: 'BAD_REQUEST' };
    patient = fsGetDoc_(cfg, 'patient_list/' + encodeURIComponent(patientId));
    if (!patient) return { ok: false, error: 'NO_PATIENT' };
  }
  const patientName = patient
    ? String(patient['Patient Name'] || ((patient['First Name'] || '') + ' ' + (patient['Last Name'] || '')).trim())
    : '';

  const recips = task.recipients || {};
  let to = '';
  let staffIds = [];
  if (task.category === 'patient') {
    if (!patient) return { ok: false, error: 'NO_PATIENT' };
    to = String(body.to || '').trim();
    if (!isEmail_(to)) return { ok: false, error: 'BAD_EMAIL' };
  } else {
    if (recips.aboutPatient && !patient) return { ok: false, error: 'NO_PATIENT' };
    staffIds = (recips.mode === 'fixed' ? (recips.staffIds || []) : (Array.isArray(body.staffIds) ? body.staffIds : []))
      .map(String).filter(function (x) { return /^[A-Za-z0-9_-]{1,80}$/.test(x); }).slice(0, TASK_MAX_RECIPIENTS_);
    if (!staffIds.length) return { ok: false, error: 'NO_RECIPIENTS' };
  }

  // Attachments wait in Drive until the email goes
  const wanted = Array.isArray(body.attachments) ? body.attachments.slice(0, 3) : [];
  const atts = [];
  if (wanted.length) {
    const blobs = wanted.map(taskAttachmentBlob_);
    if (blobs.some(function (b) { return !b; })) return { ok: false, error: 'PDF_FAILED' };
    const folder = schedAttFolder_();
    blobs.forEach(function (b) {
      const f = folder.createFile(b);
      atts.push({ fileId: f.getId(), name: b.getName() });
    });
  }

  const a = body.appts || {};
  const id = 'sch_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  const now = new Date().toISOString();
  commitWrites_(cfg, [updateWrite_(cfg, SCHED_COL_ + '/' + id, {
    taskId: taskId, taskName: String(task.name || ''), category: String(task.category || ''),
    patientId: patientId, patientName: patientName, to: to, cc: cc, staffIds: staffIds,
    subject: subject, html: html, attachments: atts,
    todo: task.category === 'staff' ? staffTodoOpts_(body.todo) : { on: false, due: '' },
    appts: { months: [3, 6, 12].indexOf(Number(a.months)) !== -1 ? Number(a.months) : 6,
      services: a.services !== false, staff: a.staff !== false },
    fillsLater: SCHED_APPTS_RE_().test(html) || SCHED_TODAY_RE_().test(html) || SCHED_TODAY_RE_().test(subject),
    sendAt: new Date(when.ms).toISOString(), sendAtMs: when.ms,
    status: 'scheduled', attempts: 0, lastError: '',
    createdAt: now, createdBy: String(session.name || ''), createdByUid: String(session.uid || ''), updatedAt: now,
  })]);
  console.log('"' + task.name + '" scheduled for ' + new Date(when.ms).toISOString() + ' by ' + session.name);
  return { ok: true, id: id, sendAt: new Date(when.ms).toISOString() };
}

// Cancel, change the time, or send now: the person who scheduled it, or someone who builds task types
function schedChange_(op, id, body, session) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'BUSY' };
  try {
    const cfg = getConfig_();
    const rec = fsGetDoc_(cfg, SCHED_COL_ + '/' + id);
    if (!rec) return { ok: false, error: 'NOT_FOUND' };
    if (rec.createdByUid !== session.uid && !can_(session, 'tasks.build')) return { ok: false, error: 'FORBIDDEN' };
    if (['scheduled', 'failed'].indexOf(rec.status) === -1) return { ok: false, error: 'NOT_WAITING' };
    rec._id = id;
    const now = new Date().toISOString();
    const who = String(session.name || '');

    if (op === 'cancel') {
      fsPatch_(cfg, SCHED_COL_ + '/' + id, { status: 'cancelled', cancelledAt: now, cancelledBy: who, updatedAt: now });
      schedTrashAtts_(rec);
      return { ok: true };
    }
    if (op === 'reschedule') {
      const when = schedTimeOk_(body.sendAt);
      if (when.error) return { ok: false, error: when.error };
      fsPatch_(cfg, SCHED_COL_ + '/' + id, {
        sendAt: new Date(when.ms).toISOString(), sendAtMs: when.ms, status: 'scheduled',
        attempts: 0, lastError: '', updatedAt: now, updatedBy: who,
      });
      return { ok: true, sendAt: new Date(when.ms).toISOString() };
    }
    const r = schedSendOne_(cfg, rec, Date.now());
    return r.ok ? { ok: true, sent: r.sent } : { ok: false, error: 'SEND_FAILED', detail: r.error };
  } finally {
    lock.releaseLock();
  }
}

// The trigger (runScheduledTasks) calls this every 15 minutes
function runScheduledTaskEmails_(cfg) {
  const started = Date.now();
  // A send that crashed part-way is never sent twice automatically: it's marked for a person to check
  fsQuery_(cfg, SCHED_COL_, 'status', 'EQUAL', 'sending', 20).forEach(function (r) {
    if (r.sendingAt && started - Date.parse(r.sendingAt) > 30 * 60000) {
      fsPatch_(cfg, SCHED_COL_ + '/' + r._id, {
        status: 'failed', lastError: 'It may or may not have gone. Check Task history → Sent before sending it again.',
      });
    }
  });
  fsQuery_(cfg, SCHED_COL_, 'status', 'EQUAL', 'scheduled', 300)
    .filter(function (r) { return Number(r.sendAtMs || 0) <= started; })
    .sort(function (a, b) { return Number(a.sendAtMs) - Number(b.sendAtMs); })
    .slice(0, 40)
    .forEach(function (r) {
      if (Date.now() - started > 4 * 60000) return; // the rest go in the next run
      schedSendOne_(cfg, r, started);
    });
}

function schedSendOne_(cfg, rec, nowMs) {
  const path = SCHED_COL_ + '/' + rec._id;
  fsPatch_(cfg, path, { status: 'sending', sendingAt: new Date().toISOString() });
  try {
    const res = schedDeliver_(cfg, rec);
    fsPatch_(cfg, path, { status: 'sent', sentAt: new Date().toISOString(), runId: res.runId, sentTo: res.to, lastError: '' });
    schedTrashAtts_(rec);
    return { ok: true, sent: res.count };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).slice(0, 300);
    const attempts = Number(rec.attempts || 0) + 1;
    const final = e.final === true || attempts >= 3;
    fsPatch_(cfg, path, { status: final ? 'failed' : 'scheduled', attempts: attempts, lastError: msg,
      updatedAt: new Date().toISOString() });
    console.error('Scheduled email ' + rec._id + (final ? ' failed: ' : ' will retry: ') + msg);
    if (final) schedTellCreator_(rec, msg);
    return { ok: false, error: msg };
  }
}

// Builds and sends one scheduled email. Errors with .final = true aren't retried.
function schedDeliver_(cfg, rec) {
  const fail = function (m) { const e = new Error(m); e.final = true; throw e; };

  // The patient, following a merge to the record that was kept
  let pid = String(rec.patientId || '');
  let patient = null;
  for (let i = 0; pid && i < 4; i++) {
    patient = fsGetDoc_(cfg, 'patient_list/' + encodeURIComponent(pid));
    const next = patient ? String(patient.MergedInto || '') : '';
    if (!next || next === pid) break;
    pid = next;
  }
  if (rec.patientId && !patient) fail('The patient record is no longer there.');
  const pName = patient
    ? String(patient['Patient Name'] || ((patient['First Name'] || '') + ' ' + (patient['Last Name'] || '')).trim())
    : String(rec.patientName || '');

  const recipients = [];
  if (rec.category === 'patient') {
    let to = String(rec.to || '').trim();
    if (!isEmail_(to) && patient) to = String(patient.Email || '').trim();
    if (!isEmail_(to)) fail("There's no email address for " + (pName || 'the patient') + '.');
    recipients.push({ name: pName, first: String((patient && patient['First Name']) || pName.split(' ')[0] || ''), email: to });
  } else {
    const byId = {};
    getStaffDocs_().forEach(function (s) { byId[s.id] = s; });
    (rec.staffIds || []).forEach(function (sid) {
      const s = byId[String(sid)];
      if (s && s.active !== false && isEmail_(s.email)) recipients.push({ id: s.id, name: s.name, first: String(s.name || '').split(' ')[0], email: s.email });
    });
    if (!recipients.length) fail('None of the chosen staff have an email address.');
  }
  if (MailApp.getRemainingDailyQuota() < recipients.length) throw new Error("The clinic's daily email limit was reached. It will try again.");

  // Filled in now, so they're right on the day
  const todayText = Utilities.formatDate(new Date(), REC_TZ_, 'd MMMM yyyy');
  let html = String(rec.html || '');
  let subject = String(rec.subject || '');
  if (SCHED_APPTS_RE_().test(html) || SCHED_APPTS_RE_().test(subject)) {
    const appts = patient ? schedUpcomingHtml_(cfg, pid, patient, rec.appts || {}) : '';
    html = html.replace(SCHED_APPTS_RE_(), appts);
    subject = subject.replace(SCHED_APPTS_RE_(), '').replace(/\s{2,}/g, ' ').trim();
  }
  html = sanitizeEmailHtml_(html.replace(SCHED_TODAY_RE_(), todayText));
  subject = subject.replace(SCHED_TODAY_RE_(), todayText);
  if (!subject || !html) fail('The email is empty.');

  const attachments = (rec.attachments || []).map(function (a) {
    try { return DriveApp.getFileById(String(a.fileId)).getBlob().setName(String(a.name || 'Attachment.pdf')); }
    catch (e) { return null; }
  });
  if (attachments.some(function (b) { return !b; })) fail('An attachment saved with this email is missing.');

  const cc = isEmail_(String(rec.cc || '').trim()) ? String(rec.cc).trim() : '';
  const escH = function (s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  const inlined = inlineTaskImages_(cfg, html);
  const hasImages = Object.keys(inlined.images).length > 0;
  recipients.forEach(function (r) {
    const subj = subject.replace(/\{First name\}/gi, r.first).replace(/\{Full name\}/gi, r.name);
    const body = fillPersonTagsInLinks_(inlined.html, { 'first name': r.first, 'full name': r.name })
      .replace(/\{First name\}/gi, escH(r.first)).replace(/\{Full name\}/gi, escH(r.name));
    const mail = { to: r.email, subject: subj, htmlBody: body, body: emailHtmlToText_(body), name: 'Dermedica Clinic' };
    if (cc) mail.cc = cc;
    if (attachments.length) mail.attachments = attachments;
    if (hasImages) mail.inlineImages = inlined.images;
    MailApp.sendEmail(mail);
  });

  const runId = 'run_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20);
  try {
    commitWrites_(cfg, [updateWrite_(cfg, 'task_runs/' + runId, {
      taskId: String(rec.taskId || ''), taskName: String(rec.taskName || ''), category: String(rec.category || ''),
      patientId: pid, patientName: pName,
      recipients: recipients.map(function (r) { return { name: r.name, email: r.email }; }),
      cc: cc, subject: subject, html: html.slice(0, 100000),
      attachments: attachments.map(function (b) { return b.getName(); }),
      sentAt: new Date().toISOString(),
      sentBy: String(rec.createdBy || '') + ' (scheduled)', sentByUid: String(rec.createdByUid || ''),
      scheduled: true, scheduledId: String(rec._id || ''),
    })]);
  } catch (e) { console.warn('Scheduled email sent, but the history log failed: ' + e); }
  const todo = staffTodoOpts_(rec.todo);
  if (rec.category === 'staff' && todo.on) {
    staffTodoCreate_(cfg, {
      recipients: recipients, text: subject, due: todo.due, patientId: pid, patientName: pName,
      taskId: String(rec.taskId || ''), taskName: String(rec.taskName || ''), runId: runId,
      by: String(rec.createdBy || ''), byUid: String(rec.createdByUid || ''),
    });
  }
  return { runId: runId, count: recipients.length, to: recipients.map(function (r) { return r.email; }).join(', ') };
}

// The patient's bookings from the appointment book. The same rules as js/upcoming-appts.js.
const SCHED_CANCELLED_ = /cancel|no.?show|\bdna\b|did not attend/i;
const SCHED_NOT_PERSON_ = /^unassigned$|\broom\b|^dermedica clinician$/i;
function schedNorm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }

function schedUpcomingHtml_(cfg, pid, p, opts) {
  const none = 'There are no upcoming appointments booked at the moment.';
  const months = [3, 6, 12].indexOf(Number(opts.months)) !== -1 ? Number(opts.months) : 6;
  const today = Utilities.formatDate(new Date(), REC_TZ_, 'yyyy-MM-dd');
  const nowP = new Date(Date.now() + SCH_PERTH_);
  const nowMin = nowP.getUTCHours() * 60 + nowP.getUTCMinutes();
  const t = today.split('-').map(Number);
  const end = Utilities.formatDate(new Date(Date.UTC(t[0], t[1] - 1 + months, t[2], 12)), 'UTC', 'yyyy-MM-dd');

  // Match on the patient's ID; only fall back to the name when a booking has no ID
  const ids = {};
  [pid, p.PttID].concat(Array.isArray(p.MergedIds) ? p.MergedIds : []).forEach(function (x) {
    x = String(x == null ? '' : x).trim().toLowerCase();
    if (x) ids[x] = true;
  });
  const names = {};
  [p['Patient Name'], (p['First Name'] || '') + ' ' + (p['Last Name'] || '')]
    .concat(Array.isArray(p.MergedNames) ? p.MergedNames : [])
    .forEach(function (n) { n = schedNorm_(n); if (n) names[n] = true; });

  const days = schedApptDays_(cfg, today, end);
  if (!days.length) {
    // No future days uploaded yet: the pre-consultation sheet's list, like the task screen
    const key = docId_(p.PttID || pid);
    const pre = key ? fsGetDoc_(cfg, 'pcn_results/' + encodeURIComponent(key)) : null;
    const lines = String((pre && pre.futureVisits) || '').split(/\r?\n/)
      .map(function (s) { return s.trim(); }).filter(Boolean);
    return lines.length ? lines.map(function (l) { return '• ' + invEsc_(l); }).join('<br>') : none;
  }

  // One visit can be several lines (one per service or staff member): merged by date + time
  const byTime = {};
  days.forEach(function (d) {
    const key = String(d.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return;
    (d.appointments || []).forEach(function (a) {
      const aid = String(a.patientId || '').trim().toLowerCase();
      const mine = aid ? !!ids[aid] : !!names[schedNorm_(a.patientName)];
      if (!mine || SCHED_CANCELLED_.test(String(a.status || ''))) return;
      const mins = Number(a.sortMinutes);
      if (key === today && isFinite(mins) && mins < nowMin) return; // earlier today: already happened
      const time = String(a.time || '').trim();
      const k = key + '|' + time;
      const row = byTime[k] || (byTime[k] = { date: key, time: time, sort: isFinite(mins) ? mins : 0, services: [], staff: [] });
      (a.services || []).forEach(function (s) {
        s = String(s || '').trim();
        if (s && row.services.indexOf(s) === -1) row.services.push(s);
      });
      const who = String(a.staff || '').trim();
      if (who && !SCHED_NOT_PERSON_.test(who) && row.staff.indexOf(who) === -1) row.staff.push(who);
    });
  });

  const rows = Object.keys(byTime).map(function (k) { return byTime[k]; })
    .sort(function (x, y) { return x.date.localeCompare(y.date) || x.sort - y.sort; });
  if (!rows.length) return none;

  // One bullet per day. Visits that day are joined with "and"; "with …" goes once at the end
  // when every visit that day is with the same people.
  const joinNames = function (list) {
    return list.length < 3 ? list.join(' and ') : list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1];
  };
  const showSvc = opts.services !== false;
  const showStaff = opts.staff !== false;
  const byDay = [];
  rows.forEach(function (r) {
    const last = byDay[byDay.length - 1];
    if (last && last.date === r.date) last.visits.push(r);
    else byDay.push({ date: r.date, visits: [r] });
  });

  return byDay.map(function (d) {
    const m = d.date.split('-').map(Number);
    const dayText = Utilities.formatDate(new Date(Date.UTC(m[0], m[1] - 1, m[2], 12)), 'UTC', 'EEE d MMM yyyy');
    const who = function (v) { return v.staff.slice().sort().join('|'); };
    const sameStaff = d.visits.every(function (v) { return who(v) === who(d.visits[0]); });

    const parts = d.visits.map(function (v, i) {
      const when = i === 0 ? dayText + (v.time ? ', ' + v.time : '') : v.time;
      const bits = [];
      if (showSvc && v.services.length) bits.push(invEsc_(v.services.join(', ')));
      if (showStaff && !sameStaff && v.staff.length) bits.push('with ' + invEsc_(joinNames(v.staff)));
      const whenHtml = when ? '<strong>' + invEsc_(when) + '</strong>' : '';
      return whenHtml + (bits.length ? (whenHtml ? ': ' : '') + bits.join(' ') : '');
    });

    // Two visits: "A and B". Three or more: "A; B and C" (services already use commas)
    let line = parts.length < 3 ? parts.join(' and ') : parts.slice(0, -1).join('; ') + ' and ' + parts[parts.length - 1];
    if (showStaff && sameStaff && d.visits[0].staff.length) line += ' with ' + invEsc_(joinNames(d.visits[0].staff));
    return '• ' + line;
  }).join('<br>');
}

// appts_by_day documents from one date to another
function schedApptDays_(cfg, fromKey, toKey, max) {
  const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + ':runQuery', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: 'appts_by_day' }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: fromKey } } },
        { fieldFilter: { field: { fieldPath: 'date' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: toKey } } },
      ] } },
      orderBy: [{ field: { fieldPath: 'date' } }],
      limit: max || 400,
    } }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Appointment book not read (' + res.getResponseCode() + ')');
  return JSON.parse(res.getContentText())
    .filter(function (r) { return r.document; })
    .map(function (r) { return fromFields_(r.document.fields || {}); });
}

function schedTrashAtts_(rec) {
  (rec.attachments || []).forEach(function (a) {
    try { DriveApp.getFileById(String(a.fileId)).setTrashed(true); } catch (e) { /* already gone */ }
  });
}

// Tells the person who scheduled it that it couldn't be sent
function schedTellCreator_(rec, msg) {
  try {
    const who = getStaffDocs_().filter(function (s) { return s.id === rec.createdByUid; })[0];
    if (!who || !isEmail_(who.email) || MailApp.getRemainingDailyQuota() < 1) return;
    const due = Utilities.formatDate(new Date(Number(rec.sendAtMs)), REC_TZ_, 'EEE d MMM, h:mm a');
    const html = invEmailWrap_(
      '<h2 style="margin:0 0 6px;font-size:20px;color:#b91c1c">A scheduled email wasn\'t sent</h2>' +
      '<p style="margin:0 0 12px;color:#475569"><strong>' + invEsc_(rec.taskName) + '</strong>' +
        (rec.patientName ? ' for ' + invEsc_(rec.patientName) : '') + ', due ' + invEsc_(due) + '.</p>' +
      '<p style="margin:0;padding:10px 12px;border-radius:8px;background:#fef2f2;color:#991b1b">' + invEsc_(msg) + '</p>',
      'tasks/history/scheduled', 'Open scheduled emails');
    MailApp.sendEmail({
      to: who.email, name: 'Dermedica Portal',
      subject: 'Not sent: ' + rec.taskName + (rec.patientName ? ' for ' + rec.patientName : ''),
      htmlBody: html, body: emailHtmlToText_(html),
    });
  } catch (e) { console.warn('Creator not told about the failed email: ' + e); }
}
// ===================== Task Manager → To Print =====================
// Emails the PDF to the clinic printer once per copy, and logs it in Task history.
function handlePrintTask_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'tasks.run') || !can_(session, 'tasks.print')) return { ok: false, error: 'FORBIDDEN' };

  const cfg = getConfig_();
  const settings = fsGetDoc_(cfg, 'form_settings/printing') || {};
  const printer = String(settings.printerEmail || '').trim();
  if (!isEmail_(printer)) return { ok: false, error: 'NO_PRINTER' };

  const copies = Math.max(1, Math.min(10, parseInt(body.copies, 10) || 1));
  let fileName = String(body.fileName || 'Form.pdf').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 150);
  if (!/\.pdf$/i.test(fileName)) fileName += '.pdf';

  let blob;
  try {
    if (body.pdf) {
      const bytes = pdfBytes_(body.pdf);
      if (!bytes) return { ok: false, error: 'PDF_FAILED' };
      blob = Utilities.newBlob(bytes, MimeType.PDF, fileName);
    }
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



// ===================== Inventory: order request emails =====================

const PORTAL_URL_ = 'https://dermedicaclinicau-web.github.io/patient-dashboard/';

function handleInventory_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const op = String(body.op || '');
  const ordering = can_(session, 'inventory.order') || can_(session, 'inventory.manage');
  const okId = function (v) { return /^[A-Za-z0-9_-]{10,40}$/.test(String(v || '')); };
  try {
    if (op === 'notifyRequest') {
      if (!can_(session, 'inventory.request')) return { ok: false, error: 'FORBIDDEN' };
      if (!okId(body.requestId)) return { ok: false, error: 'BAD_REQUEST' };
      return invNotifyRequest_(String(body.requestId), session);
    }
    if (op === 'resendRequest') {
      if (!okId(body.requestId)) return { ok: false, error: 'BAD_REQUEST' };
      return invResendRequest_(String(body.requestId), session, ordering);
    }
    if (op === 'notifyUpdate') {
      if (!ordering) return { ok: false, error: 'FORBIDDEN' };
      if (!okId(body.requestId)) return { ok: false, error: 'BAD_REQUEST' };
      return invNotifyUpdate_(String(body.requestId));
    }
    if (op === 'notifyRelease') {
      if (!can_(session, 'inventory.kit')) return { ok: false, error: 'FORBIDDEN' };
      if (!okId(body.releaseId)) return { ok: false, error: 'BAD_REQUEST' };
      return invNotifyRelease_(String(body.releaseId), session);
    }
    if (op === 'notifyLoan') {
      if (!can_(session, 'inventory.kit')) return { ok: false, error: 'FORBIDDEN' };
      if (!okId(body.loanId)) return { ok: false, error: 'BAD_REQUEST' };
      return invNotifyLoan_(String(body.loanId), session);
    }
    if (op === 'notifyReleaseUpdate') {
      if (!okId(body.releaseId)) return { ok: false, error: 'BAD_REQUEST' };
      if (!can_(session, 'inventory.jt') && !can_(session, 'inventory.manage')) {
        // Approved by this person through the Delivery Docket Form (internal transfer)
        const rel = fsGetDoc_(getConfig_(), 'inv_releases/' + String(body.releaseId));
        if (!rel || !rel.scanId || rel.handledByUid !== session.uid) return { ok: false, error: 'FORBIDDEN' };
      }
      return invNotifyReleaseUpdate_(String(body.releaseId));
    }
    if (op === 'sendPo') {
      if (!ordering) return { ok: false, error: 'FORBIDDEN' };
      if (!okId(body.poId)) return { ok: false, error: 'BAD_REQUEST' };
      return invSendPo_(String(body.poId), body, session);
    }
    if (op === 'senders') {
      if (!ordering) return { ok: false, error: 'FORBIDDEN' };
      const s = mailSenders_();
      const def = poSenderDefault_();
      return { ok: true, primary: s.primary, aliases: s.aliases, defaultFrom: def && okSender_(def, s) ? def : s.primary };
    }
    if (op === 'findSentPo') {
      if (!ordering && !can_(session, 'menu.inventory')) return { ok: false, error: 'FORBIDDEN' };
      if (!okId(body.poId)) return { ok: false, error: 'BAD_REQUEST' };
      // The PO number and supplier come from the PO itself, not from the browser
      const po = fsGetDoc_(getConfig_(), 'inv_pos/' + String(body.poId));
      if (!po) return { ok: false, error: 'NOT_FOUND' };
      const sentTo = (String(po.sentTo || '').match(/[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+/) || [''])[0];
      const to = sentTo || String((po.supplier && po.supplier.email) || '');
      return Object.assign({ ok: true }, inventoryFindSentPo_({ poNumber: String(po.number || ''), to: to }));
    }
  } catch (err) {
    console.error('Inventory ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR' };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

function invReqNumber_(id) { return 'R-' + String(id).slice(0, 6).toUpperCase(); }
function invEsc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function invQty_(n, unit) {
  const u = String(unit || 'unit');
  return n + ' ' + (Number(n) === 1 ? u : (/(s|x|ch|sh)$/i.test(u) ? u + 'es' : u + 's'));
}
function invItemsHtml_(rec) {
  return '<ul style="margin:0 0 14px;padding-left:20px">' + (rec.items || []).map(function (it) {
    return '<li style="margin:0 0 4px"><strong>' + invEsc_(it.name) + '</strong> × ' + invEsc_(invQty_(it.qty, it.unit)) +
      (it.productId ? '' : ' <em style="color:#64748b">(not on the product list)</em>') + '</li>';
  }).join('') + '</ul>';
}

function invEmailWrap_(inner, hash, label) {
  hash = hash || 'inventory/requests';
  label = label || 'Open order requests';
  return '<div style="margin:0;padding:24px 12px;background:#f1f5f9"><div style="max-width:600px;margin:0 auto;padding:28px 30px;' +
    'background:#fff;border-radius:12px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1e293b">' +
    inner + '<p style="margin:18px 0 0"><a href="' + PORTAL_URL_ + '#/' + hash + '" style="display:inline-block;padding:10px 18px;' +
    'border-radius:8px;background:#0f766e;color:#fff;text-decoration:none;font-weight:bold">' + label + '</a></p></div></div>';
}
// A new request → whoever the "A new order request is sent" rules say (Inventory → Notifications)
function invNotifyRequest_(id, session) {
  const cfg = getConfig_();
  const rec = fsGetDoc_(cfg, 'inv_requests/' + id);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  if (rec.requestedByUid !== session.uid) return { ok: false, error: 'FORBIDDEN' };
  if (rec.notified === true) return { ok: true, sent: 0 };
  fsPatch_(cfg, 'inv_requests/' + id, { notified: true });
  return notifyProcessOne_(cfg, notifyEnqueue_(cfg, 'request.created', { requestId: id }, session.uid));
}

// "Email it again": an open request goes out to whoever the "new order request" rules say now.
// The ordering team can resend any request; staff can resend their own.
function invResendRequest_(id, session, ordering) {
  const cfg = getConfig_();
  const rec = fsGetDoc_(cfg, 'inv_requests/' + id);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  if (!ordering && rec.requestedByUid !== session.uid) return { ok: false, error: 'FORBIDDEN' };
  if (rec.status !== 'open') return { ok: true, sent: 0, reason: 'NOT_OPEN' };

  const rules = notifyRules_(cfg);
  if (!rules.some(function (r) { return r.enabled === true && r.kind !== 'digest' && r.event === 'request.created'; })) {
    return { ok: true, sent: 0, reason: 'RULE_OFF' };
  }
  const res = notifyProcessOne_(cfg, notifyEnqueue_(cfg, 'request.created', { requestId: id, resent: true }, session.uid), rules);

  // Noted on the request's history
  try {
    const now = new Date().toISOString();
    fsPatch_(cfg, 'inv_requests/' + id, {
      notified: true, lastEmailedAt: now, lastEmailedBy: String(session.name || ''),
      events: (Array.isArray(rec.events) ? rec.events : []).concat([{
        at: now, by: String(session.name || ''), action: 'Email sent again',
        note: res.queued ? 'Queued' : (res.sent || 0) + ' recipient' + (res.sent === 1 ? '' : 's'),
      }]).slice(-60),
    });
  } catch (e) { console.warn('Request ' + id + ' emailed again, but its history wasn\'t updated: ' + e); }

  return { ok: true, sent: res.sent || 0, queued: !!res.queued, reason: res.sent || res.queued ? '' : 'NO_MATCH' };
}

// Ordered or declined → whoever the "ordered or declined" rules say (by default, the person who asked)
function invNotifyUpdate_(id) {
  const cfg = getConfig_();
  const rec = fsGetDoc_(cfg, 'inv_requests/' + id);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  if (rec.status !== 'ordered' && rec.status !== 'declined') return { ok: true, sent: 0 };
  return notifyProcessOne_(cfg, notifyEnqueue_(cfg, 'request.updated', { requestId: id, status: rec.status }, ''));
}

// ===================== Sending from a Gmail alias =====================
// Aliases are the "Send mail as" addresses in Gmail → Settings → Accounts, on the account that runs this script.
function mailSenders_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('mail_senders_v1');
  if (hit) return JSON.parse(hit);
  const primary = String(Session.getEffectiveUser().getEmail() || '');
  let aliases = [];
  try { aliases = GmailApp.getAliases().map(String); }
  catch (e) { console.warn('Gmail aliases not read: ' + e); }
  const out = {
    primary: primary,
    aliases: uniq_(aliases.filter(function (a) { return isEmail_(a) && a.toLowerCase() !== primary.toLowerCase(); })),
  };
  try { cache.put('mail_senders_v1', JSON.stringify(out), 600); } catch (e) { /* not essential */ }
  return out;
}
function okSender_(from, s) {
  const f = String(from || '').toLowerCase();
  return !f || f === s.primary.toLowerCase() || s.aliases.some(function (a) { return a.toLowerCase() === f; });
}
function poSenderDefault_() {
  return String(PropertiesService.getScriptProperties().getProperty('PO_FROM_DEFAULT') || '');
}

// Run from the editor once: approves Gmail access and shows the addresses the portal will offer
function testMailSenders() {
  CacheService.getScriptCache().remove('mail_senders_v1');
  console.log(JSON.stringify(mailSenders_()));
}

// ===================== Inventory: purchase orders =====================

// Every item of the request is on a sent (or received) PO. sentPoId counts as sent.
function invRequestCovered_(cfg, req, rid, sentPoId) {
  const pos = (Array.isArray(req.poIds) ? req.poIds : []).map(function (pid) {
    try { const p = fsGetDoc_(cfg, 'inv_pos/' + pid); if (p) p._id = pid; return p; } catch (e) { return null; }
  }).filter(function (p) {
    return p && (p._id === sentPoId || ['sent', 'part', 'received'].indexOf(p.status) !== -1);
  });
  const items = Array.isArray(req.items) ? req.items : [];
  return items.length > 0 && items.every(function (_, i) {
    return pos.some(function (p) {
      return (p.lines || []).some(function (l) {
        return (l.sources || []).some(function (s) { return s.r === rid && Number(s.i) === i; });
      });
    });
  });
}

function invSendPo_(id, body, session) {
  const cfg = getConfig_();
  const po = fsGetDoc_(cfg, 'inv_pos/' + id);
  if (!po) return { ok: false, error: 'NOT_FOUND' };
  if (['draft', 'sent', 'part'].indexOf(po.status) === -1) return { ok: false, error: 'BAD_REQUEST' };

  const to = String(body.to || '').trim();
  const cc = String(body.cc || '').trim();
  if (!isEmail_(to) || (cc && !isEmail_(cc))) return { ok: false, error: 'BAD_EMAIL' };
  const bytes = body.pdf ? pdfBytes_(body.pdf) : null;   // POs: no attachment, the order is in the email
  if (body.pdf && !bytes) return { ok: false, error: 'PDF_FAILED' };
  const htmlRaw = sanitizeEmailHtml_(body.html);
  if (!htmlRaw || htmlRaw.length > 300000) return { ok: false, error: 'BAD_REQUEST' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'QUOTA' };

  const inlined = inlineTaskImages_(cfg, htmlRaw);
  const mail = {
    to: to, name: 'Dermedica Clinic',
    subject: String(body.subject || '').trim().slice(0, 200) || ('Purchase order ' + po.number),
    htmlBody: inlined.html, body: emailHtmlToText_(inlined.html),
  };
  if (bytes) mail.attachments = [Utilities.newBlob(bytes, MimeType.PDF, cleanFileName_(body.fileName, String(po.number || 'Purchase order')))];
  if (cc) mail.cc = cc;
  if (Object.keys(inlined.images).length) mail.inlineImages = inlined.images;
  // From: the main account (MailApp), or one of its Gmail "Send mail as" aliases (GmailApp)
  const senders = mailSenders_();
  const from = String(body.from || '').trim();
  if (from && !okSender_(from, senders)) return { ok: false, error: 'BAD_FROM' };
  const useAlias = !!from && from.toLowerCase() !== senders.primary.toLowerCase();
  if (useAlias) {
    const opts = { htmlBody: mail.htmlBody, name: mail.name, from: from };
    if (mail.attachments) opts.attachments = mail.attachments;
    if (cc) opts.cc = cc;
    if (mail.inlineImages) opts.inlineImages = mail.inlineImages;
    GmailApp.sendEmail(to, mail.subject, mail.body, opts);
  } else {
    MailApp.sendEmail(mail);
  }
  if (body.makeDefault === true) PropertiesService.getScriptProperties().setProperty('PO_FROM_DEFAULT', from || senders.primary);
  const sentFrom = from || senders.primary;

  const now = new Date().toISOString();
  const who = String(session.name || '');
  const first = po.status === 'draft';
  const patch = {
    sentTo: to + (cc ? ' (cc ' + cc + ')' : ''), sentFrom: sentFrom, lastEmailAt: now, updatedAt: now, updatedBy: who,
    events: (Array.isArray(po.events) ? po.events : []).concat([{
      at: now, by: who, action: first ? 'Sent to supplier' : 'Emailed again', note: 'To ' + to + ' · from ' + sentFrom,
    }]).slice(-60),
  };
  if (first) { patch.status = 'sent'; patch.sentAt = now; patch.sentBy = who; patch.sentVia = 'Email'; }
  fsPatch_(cfg, 'inv_pos/' + id, patch);

  // The requests this order completes become "Ordered", and their requesters are emailed
  if (first) {
    (Array.isArray(po.requestIds) ? po.requestIds : []).forEach(function (rid) {
      try {
        const r = fsGetDoc_(cfg, 'inv_requests/' + rid);
        if (!r || r.status !== 'open' || !invRequestCovered_(cfg, r, rid, id)) return;
        fsPatch_(cfg, 'inv_requests/' + rid, {
          status: 'ordered', response: 'On purchase order ' + po.number, handledBy: who, handledByUid: String(session.uid || ''),
          handledAt: now, updatedAt: now,
          events: (Array.isArray(r.events) ? r.events : []).concat([{ at: now, by: who, action: 'Ordered', note: 'Purchase order ' + po.number }]),
        });
        invNotifyUpdate_(rid);
      } catch (e) { console.warn('Request ' + rid + ' not updated: ' + e); }
    });
  }
  console.log(po.number + ' emailed to ' + to + ' by ' + who);
  return { ok: true, to: to };
}

// ===================== Inventory: JT storage releases =====================

// Staff given "Approves releases from JT storage". If nobody is, the Admins.
function invJtApprovers_() {
  const all = getStaffDocs_().filter(function (s) { return s.active !== false && isEmail_(s.email); });
  const named = all.filter(function (s) {
    return !/^admin$/i.test(String(s.role || '')) && effectivePerms_(s).indexOf('inventory.jt') !== -1;
  });
  return (named.length ? named : all.filter(function (s) { return /^admin$/i.test(String(s.role || '')); }))
    .map(function (s) { return s.email; });
}

function invNotifyRelease_(id, session) {
  const cfg = getConfig_();
  const rec = fsGetDoc_(cfg, 'inv_releases/' + id);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  if (rec.requestedByUid !== session.uid) return { ok: false, error: 'FORBIDDEN' };
  if (rec.notified === true) return { ok: true, sent: 0 };
  const to = invJtApprovers_();
  if (to.length && MailApp.getRemainingDailyQuota() >= 1) {
    const qty = invQty_(rec.qty, rec.unit);
    const html = invEmailWrap_(
      '<h2 style="margin:0 0 6px;font-size:20px;color:#0f766e">JT storage release requested</h2>' +
      '<p style="margin:0 0 12px;color:#475569"><strong>' + invEsc_(rec.requestedBy) + '</strong> has none left on the Shelf and is asking for:</p>' +
      '<p style="margin:0 0 12px;font-size:17px"><strong>' + invEsc_(qty) + ' of ' + invEsc_(rec.productName) + '</strong></p>' +
      (rec.note ? '<p style="margin:0 0 12px;padding:10px 12px;border-radius:8px;background:#f8fafc">“' + invEsc_(rec.note) + '”</p>' : '') +
      '<p style="margin:0;color:#475569">Approving moves it from JT storage to the Shelf.</p>',
      'inventory/kits', 'Open JT releases');
    MailApp.sendEmail({
      to: to.join(','), name: 'Dermedica Clinic',
      subject: 'JT storage release: ' + qty + ' of ' + rec.productName + ' for ' + rec.requestedBy,
      htmlBody: html, body: emailHtmlToText_(html),
    });
  }
  fsPatch_(cfg, 'inv_releases/' + id, { notified: true });
  return { ok: true, sent: to.length };
}

function invNotifyReleaseUpdate_(id) {
  const cfg = getConfig_();
  const rec = fsGetDoc_(cfg, 'inv_releases/' + id);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  if (rec.status !== 'approved' && rec.status !== 'declined') return { ok: true, sent: 0 };
  const who = getStaffDocs_().filter(function (s) { return s.id === rec.requestedByUid; })[0];
  if (!who || !isEmail_(who.email) || MailApp.getRemainingDailyQuota() < 1) return { ok: true, sent: 0 };
  const ok = rec.status === 'approved';
  const qty = invQty_(rec.qty, rec.unit);
  const html = invEmailWrap_(
    '<h2 style="margin:0 0 6px;font-size:20px;color:' + (ok ? '#0f766e' : '#b45309') + '">' +
      (ok ? invEsc_(qty) + ' of ' + invEsc_(rec.productName) + ' is on the Shelf' : 'Your JT storage request was declined') + '</h2>' +
    '<p style="margin:0 0 12px;color:#475569">By <strong>' + invEsc_(rec.handledBy || 'Dr Teh') + '</strong>' +
      (ok && rec.batch ? ' · batch ' + invEsc_(rec.batch) : '') + '</p>' +
    (ok ? '<p style="margin:0">Take it into your kit from Inventory → Kits.</p>'
        : (rec.response ? '<p style="margin:0;padding:10px 12px;border-radius:8px;background:#f8fafc">' + invEsc_(rec.response) + '</p>' : '')),
    'inventory/kits', 'Open my kit');
  MailApp.sendEmail({
    to: who.email, name: 'Dermedica Clinic',
    subject: ok ? rec.productName + ' released to the Shelf' : 'JT storage request declined',
    htmlBody: html, body: emailHtmlToText_(html),
  });
  return { ok: true, sent: 1 };
}

// Borrowed from a colleague's opened vial → the lender is asked to confirm
function invNotifyLoan_(id, session) {
  const cfg = getConfig_();
  const rec = fsGetDoc_(cfg, 'inv_loans/' + id);
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  if (rec.toUid !== session.uid) return { ok: false, error: 'FORBIDDEN' };
  if (rec.notified === true) return { ok: true, sent: 0 };
  const lender = getStaffDocs_().filter(function (s) { return s.id === rec.fromUid; })[0];
  if (lender && isEmail_(lender.email) && MailApp.getRemainingDailyQuota() >= 1) {
    const html = invEmailWrap_(
      '<h2 style="margin:0 0 6px;font-size:20px;color:#0f766e">Please confirm: ' + invEsc_(rec.units) + ' ' + invEsc_(rec.doseUnit) +
        ' of ' + invEsc_(rec.productName) + '</h2>' +
      '<p style="margin:0 0 12px;color:#475569"><strong>' + invEsc_(rec.toName) + '</strong> recorded taking them from your opened vial' +
        (rec.batch ? ' (batch ' + invEsc_(rec.batch) + ')' : '') + '. They\'ve already come off your kit.</p>' +
      '<p style="margin:0">Confirm it, or dispute it if the amount is wrong.</p>',
      'inventory/kits', 'Confirm on Kits');
    MailApp.sendEmail({
      to: lender.email, name: 'Dermedica Clinic',
      subject: rec.toName + ' borrowed ' + rec.units + ' ' + rec.doseUnit + ' of ' + rec.productName,
      htmlBody: html, body: emailHtmlToText_(html),
    });
  }
  fsPatch_(cfg, 'inv_loans/' + id, { notified: true });
  return { ok: true, sent: lender ? 1 : 0 };
}

// ===================== Notifications: rules, outbox and digests =====================
// Rules live in Firestore notify_rules (Inventory → Notifications). Things that happen are queued in
// notify_outbox (by the portal or by this script), matched against the rules and emailed.
// runNotifications (every 5 minutes) sends anything waiting, checks for newly-low stock (hourly)
// and sends digests when they're due. Every email sent is logged in notify_log.

function handleNotify_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const op = String(body.op || '');
  try {
    if (op === 'process') return { ok: true, processed: notifyProcessPending_(getConfig_(), 10, null, false) };
    if (op === 'test') {
      if (!can_(session, 'inventory.manage')) return { ok: false, error: 'FORBIDDEN' };
      return notifyTest_(String(body.ruleId || ''), session);
    }
  } catch (err) {
    console.error('Notify ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

// The trigger runs this every 5 minutes
function runNotifications() {
  const cfg = getConfig_();
  const now = Date.now();
  const rules = notifyRules_(cfg);
  try { staffTaskMailRun_(cfg); } catch (e) { console.error('Task emails: ' + (e && e.stack ? e.stack : e)); }
  try { notifyProcessPending_(cfg, 20, rules, true); } catch (e) { console.error('Outbox: ' + (e && e.stack ? e.stack : e)); }
  try { notifyLowScan_(cfg, rules); } catch (e) { console.error('Low stock scan: ' + (e && e.stack ? e.stack : e)); }
  try { notifyRunDigests_(cfg, rules, now); } catch (e) { console.error('Digests: ' + (e && e.stack ? e.stack : e)); }
  try { notifyCountCheck_(cfg, rules, now); } catch (e) { console.error('Count check: ' + (e && e.stack ? e.stack : e)); }
  try { chatHelpReminders_(cfg); } catch (e) { console.error('Chat reminders: ' + (e && e.stack ? e.stack : e)); }
  try { eodReminders_(cfg, now); } catch (e) { console.error('End of day reminders: ' + (e && e.stack ? e.stack : e)); }
  try { recallReplies_(cfg); } catch (e) { console.error('Recall replies: ' + (e && e.stack ? e.stack : e)); }
  try { scanJobsSweep_(cfg); } catch (e) { console.error('Scan jobs: ' + (e && e.stack ? e.stack : e)); }
}

// Run ONCE from the editor to start notifications
function installNotifications() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runNotifications'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runNotifications').timeBased().everyMinutes(5).create();
  runNotifications(); // creates the starter rules straight away
  console.log('Notifications installed (every 5 minutes).');
}

/* ---------- Helpers ---------- */

function uniq_(a) {
  const seen = {};
  return (a || []).filter(function (x) { return x && !seen[x] && (seen[x] = true); });
}

// Simple one-condition query. op: EQUAL, GREATER_THAN, IN
function fsQuery_(cfg, collectionId, field, op, value, max) {
  const v = Array.isArray(value) ? { arrayValue: { values: value.map(toValue_) } } : toValue_(value);
  const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + ':runQuery', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: collectionId }],
      where: { fieldFilter: { field: { fieldPath: field }, op: op, value: v } },
      limit: max || 300,
    } }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Query ' + collectionId + ' ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  return JSON.parse(res.getContentText()).filter(function (r) { return r.document; }).map(function (r) {
    const o = fromFields_(r.document.fields || {});
    o._id = r.document.name.split('/').pop();
    return o;
  });
}

/* ---------- Rules (the starter rules are made once, from the old Requests → Email settings) ---------- */

function notifyRules_(cfg) {
  notifySeed_(cfg);
  return fsListAll_(cfg, 'notify_rules').map(function (d) {
    const r = fromFields_(d.fields || {});
    r.id = d.name.split('/').pop();
    return r;
  });
}

function notifySeed_(cfg) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('NOTIFY_SEEDED') === '1') return;
  if (fsListAll_(cfg, 'notify_rules', ['name']).length) { props.setProperty('NOTIFY_SEEDED', '1'); return; }
  const set = fsGetDoc_(cfg, 'inv_settings/requests') || {};
  const now = new Date().toISOString();
  const rule = function (id, extra) {
    return updateWrite_(cfg, 'notify_rules/' + id, Object.assign({
      enabled: true, kind: 'event', message: '', conditions: { urgentOnly: false, loc: 'any', categories: [], statuses: [] },
      createdAt: now, createdBy: 'Set up automatically', updatedAt: now, updatedBy: 'Set up automatically',
    }, extra));
  };
  const rc = function (o) { return Object.assign({ involved: false, staffIds: [], roles: [], emails: [], skipActor: true }, o); };
  commitWrites_(cfg, [
    rule('starter_requests', { name: 'New order requests', event: 'request.created',
      conditions: { urgentOnly: set.urgentOnly === true, loc: 'any', categories: [], statuses: [] },
      recipients: rc({ staffIds: Array.isArray(set.notifyIds) ? set.notifyIds.map(String) : [] }) }),
    rule('starter_request_updates', { name: 'Tell the requester when it\'s ordered or declined', event: 'request.updated',
      recipients: rc({ involved: true }) }),
    rule('starter_arrived', { name: 'Tell the requester when their stock arrives', event: 'stock.arrived',
      recipients: rc({ involved: true }) }),
  ]);
  props.setProperty('NOTIFY_SEEDED', '1');
  console.log('Starter notification rules created.');
}

/* ---------- The outbox ---------- */

function notifyEnqueue_(cfg, event, data, byUid) {
  const id = 'n_' + Date.now() + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  commitWrites_(cfg, [updateWrite_(cfg, 'notify_outbox/' + id, {
    event: event, data: data || {}, status: 'new', createdAt: new Date().toISOString(), createdByUid: String(byUid || ''),
  })]);
  return id;
}

function notifyProcessPending_(cfg, max, rules, sweep) {
  if (sweep) { // a run that crashed mid-send is tried again after 15 minutes
    fsQuery_(cfg, 'notify_outbox', 'status', 'EQUAL', 'sending', 20).forEach(function (o) {
      if (o.processedAt && Date.now() - Date.parse(o.processedAt) > 15 * 60000) fsPatch_(cfg, 'notify_outbox/' + o._id, { status: 'new' });
    });
  }
  const waiting = fsQuery_(cfg, 'notify_outbox', 'status', 'EQUAL', 'new', max || 10);
  if (!waiting.length) return 0;
  const all = rules || notifyRules_(cfg);
  waiting.forEach(function (o) { notifyProcessOne_(cfg, o._id, all); });
  return waiting.length;
}

function notifyProcessOne_(cfg, id, rules) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: true, queued: true }; // the next run sends it
  let ev;
  try {
    ev = fsGetDoc_(cfg, 'notify_outbox/' + id);
    if (!ev || ev.status !== 'new') return { ok: true, sent: 0 };
    fsPatch_(cfg, 'notify_outbox/' + id, { status: 'sending', processedAt: new Date().toISOString() });
  } finally {
    lock.releaseLock();
  }
  let sent = 0;
  const errors = [];
  (rules || notifyRules_(cfg))
    .filter(function (r) { return r.enabled === true && r.kind !== 'digest' && r.event === ev.event; })
    .forEach(function (rule) {
      try {
        const ctx = notifyContext_(cfg, ev, rule);
        if (ctx && notifyMatches_(rule, ctx)) sent += notifySend_(cfg, rule, ctx, id, null);
      } catch (e) {
        errors.push(String(rule.name || rule.id) + ': ' + (e && e.message ? e.message : e));
        console.error('Rule ' + rule.id + ' on ' + id + ': ' + (e && e.stack ? e.stack : e));
      }
    });
  fsPatch_(cfg, 'notify_outbox/' + id, {
    status: errors.length ? 'failed' : 'done', sent: sent, error: errors.join(' | ').slice(0, 300),
  });
  return { ok: true, sent: sent };
}

/* ---------- What each event says (and who's involved) ---------- */

function notifyContext_(cfg, ev, rule) {
  const d = ev.data || {};
  const memo = ev._memo || (ev._memo = {});
  const get = function (path) { if (!(path in memo)) memo[path] = fsGetDoc_(cfg, path); return memo[path]; };
  const catsOf = function (ids) {
    return uniq_((ids || []).filter(Boolean).map(function (pid) { const p = get('inv_products/' + pid); return p ? String(p.category || '') : ''; }));
  };
  const h2 = function (t, color) { return '<h2 style="margin:0 0 6px;font-size:20px;color:' + (color || '#0f766e') + '">' + t + '</h2>'; };
  const sub = function (html) { return '<p style="margin:0 0 12px;color:#475569">' + html + '</p>'; };
  const box = function (t) { return t ? '<p style="margin:0 0 6px;padding:10px 12px;border-radius:8px;background:#f8fafc">' + invEsc_(t) + '</p>' : ''; };
  const ul = function (items) { return '<ul style="margin:0 0 14px;padding-left:20px">' + items.map(function (x) { return '<li style="margin:0 0 4px">' + x + '</li>'; }).join('') + '</ul>'; };
  const locName = function (l) { return l === 'jt' ? 'JT storage' : l === 'kit' ? 'kit' : 'the Shelf'; };

  switch (ev.event) {
    case 'request.created': {
      const rec = get('inv_requests/' + d.requestId);
      if (!rec) return null;
      const num = invReqNumber_(d.requestId);
      const urgent = rec.urgency === 'urgent';
      const loc = rec.loc === 'jt' ? 'jt' : 'shelf';
      return {
        subject: (urgent ? 'URGENT: ' : '') + 'Order request ' + num + ' from ' + String(rec.requestedBy || 'staff'),
        inner: h2((urgent ? 'Urgent order request ' : 'Order request ') + num, urgent ? '#b91c1c' : '') +
          sub('From <strong>' + invEsc_(rec.requestedBy) + '</strong> · for ' + locName(loc)) + invItemsHtml_(rec) +
          (rec.note ? box('“' + rec.note + '”') : ''),
        hash: 'inventory/requests', label: 'Open order requests',
        urgent: urgent, locs: [loc], categories: catsOf((rec.items || []).map(function (it) { return it.productId; })),
        involved: [rec.requestedByUid], actor: rec.requestedByUid,
      };
    }
    case 'request.updated': {
      const rec = get('inv_requests/' + d.requestId);
      if (!rec) return null;
      const status = String(d.status || rec.status);
      if (status !== 'ordered' && status !== 'declined') return null;
      const num = invReqNumber_(d.requestId);
      const ordered = status === 'ordered';
      return {
        subject: 'Order request ' + num + (ordered ? ' ordered' : ' declined'),
        inner: h2('Order request ' + num + ' was ' + (ordered ? 'ordered' : 'declined'), ordered ? '' : '#b45309') +
          sub('Requested by <strong>' + invEsc_(rec.requestedBy || '') + '</strong> · ' + (ordered ? 'ordered' : 'declined') +
            ' by <strong>' + invEsc_(rec.handledBy || 'the ordering team') + '</strong>') + invItemsHtml_(rec) + box(rec.response),
        hash: 'inventory/requests', label: 'Open order requests',
        status: status, locs: [rec.loc === 'jt' ? 'jt' : 'shelf'],
        categories: catsOf((rec.items || []).map(function (it) { return it.productId; })),
        involved: [rec.requestedByUid], actor: rec.handledByUid,
      };
    }
    case 'stock.arrived': {
      const r = get('inv_receipts/' + d.receiptId);
      if (!r) return null;
      const lines = (r.lines || []).filter(function (l) { return (l.splits || []).length; });
      if (!lines.length) return null;
      const po = d.poId ? get('inv_pos/' + d.poId) : null;
      const requesters = uniq_(((po && po.requestIds) || []).map(function (rid) {
        const q = get('inv_requests/' + rid);
        return q ? q.requestedByUid : '';
      }));
      return {
        subject: 'Stock has arrived: ' + (r.poNumber || 'delivery') + (r.supplierName ? ' from ' + r.supplierName : ''),
        inner: h2('Stock has arrived') +
          sub(invEsc_(r.poNumber || '') + (r.supplierName ? ' · ' + invEsc_(r.supplierName) : '') + ' · received by <strong>' + invEsc_(r.by || '') + '</strong>') +
          ul(lines.map(function (l) {
            return '<strong>' + invEsc_(l.name) + '</strong> × ' + invEsc_(invQty_(l.arrived, l.orderUnit)) + ': ' +
              (l.splits || []).map(function (s) {
                return invEsc_(invQty_(s.qty, l.stockUnit)) + ' to ' + locName(s.loc) + (s.batch ? ' (' + invEsc_(s.batch) + ')' : '');
              }).join('; ');
          })),
        hash: d.poId ? 'inventory/po/' + d.poId : 'inventory/orders', label: 'Open the purchase order',
        locs: uniq_([].concat.apply([], lines.map(function (l) { return (l.splits || []).map(function (s) { return s.loc; }); }))),
        categories: catsOf(lines.map(function (l) { return l.productId; })),
        involved: requesters, actor: r.byUid,
      };
    }
    case 'stock.low': {
      const c = rule.conditions || {};
      const cats = Array.isArray(c.categories) ? c.categories : [];
      const items = (d.items || []).filter(function (it) {
        return (!c.loc || c.loc === 'any' || it.loc === c.loc) && (!cats.length || cats.indexOf(it.category) !== -1);
      });
      if (!items.length) return null;
      return {
        subject: items.length === 1 ? items[0].name + ' is running low' : items.length + ' products are running low',
        inner: h2('Running low') + sub('These have dropped to their reorder level:') + ul(items.map(function (it) {
          return '<strong>' + invEsc_(it.name) + '</strong>: ' + invEsc_(invQty_(it.qty, it.unit)) + ' left in ' + locName(it.loc) +
            ' (reorder at ' + it.reorder + ')';
        })),
        hash: 'inventory/stock', label: 'Open stock',
        locs: uniq_(items.map(function (it) { return it.loc; })), categories: uniq_(items.map(function (it) { return it.category; })),
        involved: [], actor: '',
      };
    }
    case 'count.difference': {
      const cnt = get('inv_counts/' + d.countId);
      if (!cnt) return null;
      const open = (cnt.lines || []).filter(function (l) { return l.status === 'open'; });
      if (!open.length) return null;
      const where = function (l) { return l.loc === 'kit' ? (l.staffName || 'Injector') + '\'s kit' : l.loc === 'jt' ? 'JT storage' : 'Shelf'; };
      const kit = cnt.kind === 'kit';
      return {
        subject: (kit ? 'Kit check' : 'Opening count') + ': ' + open.length + ' difference' + (open.length === 1 ? '' : 's') + ' to review',
        inner: h2((kit ? 'Kit check' : 'Opening count') + ' differences', '#b45309') +
          sub('Counted by <strong>' + invEsc_(cnt.by || '') + '</strong>' + (cnt.dateKey ? ' · ' + invEsc_(cnt.dateKey) : '')) +
          ul(open.map(function (l) {
            const diff = Number(l.variance) || 0;
            return '<strong>' + invEsc_(l.productName) + '</strong> · ' + invEsc_(where(l)) + ': counted ' + l.counted + ', system ' + l.system +
              ' (<strong style="color:' + (diff < 0 ? '#b91c1c' : '#027a48') + '">' + (diff > 0 ? '+' : '') + diff + '</strong>)';
          })),
        hash: 'reports/variance', label: 'Review differences',
        locs: uniq_(open.map(function (l) { return l.loc; })), categories: catsOf(open.map(function (l) { return l.productId; })),
        involved: [cnt.byUid], actor: cnt.byUid,
      };
    }
    case 'usage.short': {
      const u = get('inv_usage/' + d.usageId);
      if (!u || u.short !== true) return null;
      const short = (u.lines || []).filter(function (l) { return Number(l.short) > 0; });
      return {
        subject: 'Saved short: ' + (u.patientName || 'treatment record'),
        inner: h2('A treatment was saved short', '#b45309') +
          sub('<strong>' + invEsc_(u.by || '') + '</strong> saved ' + invEsc_(u.formName || 'a treatment record') + ' for <strong>' +
            invEsc_(u.patientName || 'a patient') + '</strong>, but the system showed less stock than was used:') +
          ul(short.map(function (l) { return '<strong>' + invEsc_(l.name) + '</strong> short by ' + l.short + ' ' + invEsc_(l.unit || ''); })) +
          '<p style="margin:0">The patient\'s record is right. Count the product, accept the difference, then resolve it.</p>',
        hash: 'reports/short', label: 'Open Saved short',
        categories: catsOf(short.map(function (l) { return l.productId; })), involved: [u.byUid], actor: u.byUid,
      };
    }
    case 'investigation.opened': {
      // No numbers in this email, so the recount stays blind
      const list = (Array.isArray(d.ids) ? d.ids : []).map(function (iid) {
        const x = get('inv_investigations/' + iid);
        if (x) x._id = iid;
        return x;
      }).filter(function (x) { return x && x.status === 'recount'; });
      if (!list.length) return null;
      const where = function (x) { return x.loc === 'jt' ? 'JT storage' : 'Shelf'; };
      return {
        subject: 'Recount needed: ' + (list.length === 1 ? list[0].productName + ' (' + where(list[0]) + ')' : list.length + ' products'),
        inner: h2('A recount is needed', '#b45309') +
          sub('The opening count by <strong>' + invEsc_(list[0].openedBy || '') + '</strong> didn\'t match the digital count. ' +
            'Someone else needs to recount, without looking at the system first:') +
          ul(list.map(function (x) {
            return '<a href="' + PORTAL_URL_ + '#/inventory/investigations/' + x._id + '" style="color:#0f766e">' + invEsc_(x.productName) + '</a> · ' +
              where(x) + (x.batch ? ' · ' + invEsc_((x.batchLabel || 'Batch') + ' ' + x.batch) : '');
          })),
        hash: 'inventory/investigations', label: 'Open investigations',
        locs: uniq_(list.map(function (x) { return x.loc; })), categories: catsOf(list.map(function (x) { return x.productId; })),
        involved: [], actor: list[0].openedByUid,
      };
    }
    case 'investigation.confirmed': {
      const x = get('inv_investigations/' + d.id);
      if (!x || x.status !== 'review') return null;
      const rc = x.recount || {};
      const where = x.loc === 'jt' ? 'JT storage' : 'Shelf';
      const diff = Number(rc.variance) || 0;
      return {
        subject: 'Investigation: ' + x.productName + ' (' + where + ') ' + (diff > 0 ? '+' : '') + diff,
        inner: h2('A difference has been confirmed', '#b91c1c') +
          sub('<strong>' + invEsc_(x.productName) + '</strong> · ' + where + (x.batch ? ' · ' + invEsc_((x.batchLabel || 'Batch') + ' ' + x.batch) : '')) +
          ul([
            'First count by <strong>' + invEsc_(x.openedBy || '') + '</strong>: ' + x.counted + ' (digital ' + x.digital + ')',
            'Recount by <strong>' + invEsc_(rc.by || '') + '</strong>: ' + rc.counted + ' (digital ' + rc.digital + ')',
          ]) +
          '<p style="margin:0">Check the records and CCTV, then close it with what happened.</p>',
        hash: 'inventory/investigations/' + d.id, label: 'Review the investigation',
        locs: [x.loc], categories: catsOf([x.productId]), involved: [x.openedByUid, rc.byUid], actor: rc.byUid,
      };
    }
    case 'count.overdue': {
      const c = rule.conditions || {};
      const cats = Array.isArray(c.categories) ? c.categories : [];
      const items = (d.items || []).filter(function (it) {
        return (!c.loc || c.loc === 'any' || it.loc === c.loc) && (!cats.length || cats.indexOf(it.category) !== -1);
      });
      if (!items.length) return null;
      return {
        subject: 'Opening count not done: ' + d.missing + ' of ' + d.total + ' still to count',
        inner: h2('The opening count isn\'t finished', '#b45309') +
          sub('It was due by <strong>' + invEsc_(d.dueBy) + '</strong> today. Still to count:') +
          ul(items.slice(0, 30).map(function (it) {
            return '<strong>' + invEsc_(it.name) + '</strong> · ' + (it.loc === 'jt' ? 'JT storage' : 'Shelf');
          })) +
          (items.length > 30 ? '<p style="margin:0;color:#64748b">and ' + (items.length - 30) + ' more</p>' : ''),
        hash: 'tasks/count', label: 'Count now',
        locs: uniq_(items.map(function (it) { return it.loc; })), categories: uniq_(items.map(function (it) { return it.category; })),
        involved: [], actor: '',
      };
    }
    case 'loan.disputed': {
      const ln = get('inv_loans/' + d.loanId);
      if (!ln || ln.status !== 'disputed') return null;
      return {
        subject: 'Disputed borrow: ' + ln.units + ' ' + (ln.doseUnit || '') + ' of ' + (ln.productName || ''),
        inner: h2('A borrow was disputed', '#b45309') +
          sub('<strong>' + invEsc_(ln.fromName || '') + '</strong> disputed that <strong>' + invEsc_(ln.toName || '') + '</strong> took ' +
            invEsc_(ln.units + ' ' + (ln.doseUnit || '')) + ' of ' + invEsc_(ln.productName || '') + (ln.batch ? ' (batch ' + invEsc_(ln.batch) + ')' : '') + '.') +
          box(ln.response),
        hash: 'inventory/kits', label: 'Open Kits', involved: [ln.toUid, ln.fromUid], actor: '',
      };
    }
  }
  return null;
}

function notifyMatches_(rule, ctx) {
  const c = rule.conditions || {};
  if (c.urgentOnly === true && rule.event === 'request.created' && !ctx.urgent) return false;
  if (c.loc && c.loc !== 'any' && ctx.locs && ctx.locs.length && ctx.locs.indexOf(c.loc) === -1) return false;
  const cats = Array.isArray(c.categories) ? c.categories : [];
  if (cats.length && !(ctx.categories || []).some(function (x) { return cats.indexOf(x) !== -1; })) return false;
  const sts = Array.isArray(c.statuses) ? c.statuses : [];
  if (sts.length && ctx.status && sts.indexOf(ctx.status) === -1) return false;
  return true;
}

// Staff by name, everyone in a role, the people involved and extra addresses (no duplicates)
function notifyRecipients_(rule, ctx) {
  const r = rule.recipients || {};
  const ids = (Array.isArray(r.staffIds) ? r.staffIds : []).map(String);
  const roles = (Array.isArray(r.roles) ? r.roles : []).map(function (x) { return String(x).toLowerCase(); });
  const involved = r.involved === true ? (ctx.involved || []).filter(Boolean).map(String) : [];
  const actor = r.skipActor !== false ? String(ctx.actor || '') : '';
  const out = {};
  getStaffDocs_().forEach(function (s) {
    if (s.active === false || !isEmail_(s.email)) return;
    const listed = ids.indexOf(s.id) !== -1 || roles.indexOf(String(s.role || '').toLowerCase()) !== -1;
    if (involved.indexOf(s.id) !== -1 || (listed && s.id !== actor)) out[s.email.toLowerCase()] = s.email;
  });
  (Array.isArray(r.emails) ? r.emails : []).forEach(function (e) {
    e = String(e || '').trim();
    if (isEmail_(e)) out[e.toLowerCase()] = e;
  });
  return Object.keys(out).map(function (k) { return out[k]; }).slice(0, 40);
}

// onlyTo: send just to this address (a test), without logging
function notifySend_(cfg, rule, ctx, refId, onlyTo) {
  const to = onlyTo ? [onlyTo] : notifyRecipients_(rule, ctx);
  if (!to.length) return 0;
  if (MailApp.getRemainingDailyQuota() < 1) throw new Error('The clinic\'s daily email limit has been reached.');
  const msg = String(rule.message || '').trim();
  const inner = (msg ? '<p style="margin:0 0 14px;padding:10px 12px;border-radius:8px;background:#f0fdfa;color:#134e4a">' +
    invEsc_(msg).replace(/\n/g, '<br>') + '</p>' : '') + ctx.inner;
  const html = invEmailWrap_(inner, ctx.hash, ctx.label);
  MailApp.sendEmail({
    to: to.join(','), name: 'Dermedica Clinic', subject: (onlyTo ? '[Test] ' : '') + ctx.subject,
    htmlBody: html, body: emailHtmlToText_(html),
  });
  if (!onlyTo) {
    try {
      commitWrites_(cfg, [updateWrite_(cfg, 'notify_log/l_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
        ruleId: String(rule.id || ''), ruleName: String(rule.name || ''), event: rule.kind === 'digest' ? 'digest' : String(rule.event || ''),
        to: to, subject: ctx.subject, refId: String(refId || ''), at: new Date().toISOString(),
      })]);
    } catch (e) { console.warn('Sent, but the notification log failed: ' + e); }
  }
  return to.length;
}

/* ---------- Low stock: checked hourly, each product alerts once until it's restocked ---------- */

function notifyLowScan_(cfg, rules) {
  if (!rules.some(function (r) { return r.enabled === true && r.kind !== 'digest' && r.event === 'stock.low'; })) return;
  const props = PropertiesService.getScriptProperties();
  if (Date.now() - Number(props.getProperty('NOTIFY_LOW_SCAN') || 0) < 55 * 60000) return;
  props.setProperty('NOTIFY_LOW_SCAN', String(Date.now()));

  const state = fsGetDoc_(cfg, 'notify_state/low');
  const before = {};
  ((state && state.keys) || []).forEach(function (k) { before[k] = true; });
  const now = [];
  const fresh = [];
  fsListAll_(cfg, 'inv_products', ['name', 'category', 'stock', 'reorder', 'stockUnit', 'active']).forEach(function (d) {
    const p = fromFields_(d.fields || {});
    if (p.active === false) return;
    const id = d.name.split('/').pop();
    ['shelf', 'jt'].forEach(function (loc) {
      const re = p.reorder ? p.reorder[loc] : null;
      if (re === null || re === undefined || re === '') return;
      const qty = Number((p.stock || {})[loc] || 0);
      if (qty > Number(re)) return;
      const key = id + '|' + loc;
      now.push(key);
      if (!before[key]) fresh.push({ productId: id, name: String(p.name || ''), category: String(p.category || ''),
        loc: loc, qty: qty, reorder: Number(re), unit: String(p.stockUnit || 'item') });
    });
  });
  commitWrites_(cfg, [updateWrite_(cfg, 'notify_state/low', { keys: now, at: new Date().toISOString() })]);
  // The very first scan only remembers what's already low (no flood of alerts)
  if (fresh.length && state) {
    notifyProcessOne_(cfg, notifyEnqueue_(cfg, 'stock.low', { items: fresh.slice(0, 60) }, ''), rules);
  }
}

/* ---------- Digests ---------- */

// The most recent time this digest was due (Perth time)
function notifyDigestSlot_(rule, now) {
  const s = rule.schedule || {};
  const a = new Date(now + SCH_PERTH_);
  const today = schDayNum_(a.getUTCFullYear(), a.getUTCMonth() + 1, a.getUTCDate());
  for (let k = 0; k < 8; k++) {
    const p = schFromNum_(today - k);
    if (s.freq === 'weekly' && p.dow !== Number(s.day)) continue;
    if (s.freq === 'weekdays' && (p.dow === 0 || p.dow === 6)) continue;
    const ms = schSlotMs_(p, s.time || '08:00');
    if (ms <= now) return { ms: ms, key: schKey_(p) };
  }
  return null;
}

function notifyRunDigests_(cfg, rules, now) {
  rules.filter(function (r) { return r.enabled === true && r.kind === 'digest'; }).forEach(function (rule) {
    try {
      const slot = notifyDigestSlot_(rule, now);
      if (!slot) return;
      const path = 'notify_state/digest_' + rule.id;
      const st = fsGetDoc_(cfg, path);
      // A new digest starts from its next time (never sends the moment it's created)
      if (!st) { commitWrites_(cfg, [updateWrite_(cfg, path, { lastSlot: slot.ms })]); return; }
      if (Number(st.lastSlot || 0) >= slot.ms) return;
      commitWrites_(cfg, [updateWrite_(cfg, path, { lastSlot: slot.ms, lastRun: new Date().toISOString() })]);
      if (now - slot.ms > 12 * 3600000) return; // missed by a long way: wait for the next one
      const ctx = notifyDigestContext_(cfg, rule, slot);
      if (!ctx.total && rule.skipEmpty !== false) return;
      notifySend_(cfg, rule, ctx, slot.key, null);
    } catch (e) {
      console.error('Digest ' + rule.id + ': ' + (e && e.stack ? e.stack : e));
    }
  });
}

function notifyDigestContext_(cfg, rule, slot) {
  const sec = rule.sections || {};
  const cats = Array.isArray((rule.conditions || {}).categories) ? rule.conditions.categories : [];
  const catOk = function (c) { return !cats.length || cats.indexOf(c) !== -1; };
  const days = Math.min(180, Math.max(7, Number(rule.expiringDays) || 60));
  const locName = function (l) { return l === 'jt' ? 'JT storage' : 'the Shelf'; };
  const parts = [];
  const summary = [];
  let total = 0;

  const block = function (title, short, items, hash, label) {
    total += items.length;
    if (items.length) summary.push(items.length + ' ' + short);
    parts.push('<h3 style="margin:20px 0 6px;font-size:16px;color:#0f172a">' + invEsc_(title) +
      ' <span style="color:#64748b;font-weight:normal">(' + items.length + ')</span></h3>' +
      (items.length
        ? '<ul style="margin:0 0 6px;padding-left:20px">' + items.slice(0, 15).map(function (x) { return '<li style="margin:0 0 4px">' + x + '</li>'; }).join('') + '</ul>' +
          (items.length > 15 ? '<p style="margin:0;color:#64748b">and ' + (items.length - 15) + ' more</p>' : '')
        : '<p style="margin:0;color:#64748b">None. 👍</p>') +
      '<p style="margin:4px 0 0"><a href="' + PORTAL_URL_ + '#/' + hash + '" style="color:#0f766e">' + invEsc_(label) + ' →</a></p>');
  };

  let products = null;
  const prods = function () {
    if (!products) {
      products = fsListAll_(cfg, 'inv_products', ['name', 'category', 'stock', 'reorder', 'stockUnit', 'active']).map(function (d) {
        const f = fromFields_(d.fields || {});
        f._id = d.name.split('/').pop();
        return f;
      }).filter(function (p) { return p.active !== false; });
    }
    return products;
  };

  if (sec.low) {
    const items = [];
    prods().forEach(function (p) {
      if (!catOk(p.category)) return;
      ['shelf', 'jt'].forEach(function (loc) {
        const re = p.reorder ? p.reorder[loc] : null;
        if (re === null || re === undefined || re === '') return;
        const q = Number((p.stock || {})[loc] || 0);
        if (q <= Number(re)) items.push('<strong>' + invEsc_(p.name) + '</strong>: ' + invEsc_(invQty_(q, p.stockUnit)) + ' in ' + locName(loc) + ' (reorder at ' + re + ')');
      });
    });
    block('Low stock', 'low', items, 'inventory/stock', 'Open stock');
  }
  if (sec.expiring) {
    const byId = {};
    prods().forEach(function (p) { byId[p._id] = p; });
    const todayKey = Utilities.formatDate(new Date(), 'Australia/Perth', 'yyyy-MM-dd');
    const limitKey = Utilities.formatDate(new Date(Date.now() + days * 864e5), 'Australia/Perth', 'yyyy-MM-dd');
    const lots = fsListAll_(cfg, 'inv_lots', ['productId', 'loc', 'batch', 'expiry', 'qty']).map(function (d) { return fromFields_(d.fields || {}); })
      .filter(function (l) {
        return Number(l.qty) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(l.expiry || '')) && l.expiry <= limitKey &&
          byId[l.productId] && catOk(byId[l.productId].category);
      })
      .sort(function (a, b) { return String(a.expiry).localeCompare(String(b.expiry)); });
    block('Expiring within ' + days + ' days', 'expiring', lots.map(function (l) {
      const p = byId[l.productId];
      const gone = l.expiry < todayKey;
      return '<strong>' + invEsc_(p.name) + '</strong>' + (l.batch ? ' · ' + invEsc_(l.batch) : '') + ': ' + invEsc_(invQty_(l.qty, p.stockUnit)) +
        ' in ' + locName(l.loc) + ' · ' + (gone ? '<span style="color:#b91c1c">expired ' + l.expiry + '</span>' : 'expires ' + l.expiry);
    }), 'inventory/stock', 'Open stock');
  }
  if (sec.requests) {
    block('Open order requests', 'open requests', fsQuery_(cfg, 'inv_requests', 'status', 'EQUAL', 'open', 300).map(function (r) {
      return '<strong>' + invReqNumber_(r._id) + '</strong>' + (r.urgency === 'urgent' ? ' <span style="color:#b91c1c">urgent</span>' : '') +
        ' · ' + invEsc_(r.requestedBy || '') + ': ' + invEsc_((r.items || []).map(function (it) { return it.name; }).join(', '));
    }), 'inventory/requests', 'Open requests');
  }
  if (sec.deliveries) {
    block('Deliveries waiting', 'deliveries waiting', fsQuery_(cfg, 'inv_pos', 'status', 'IN', ['sent', 'part'], 300).map(function (p) {
      return '<strong>' + invEsc_(p.number || '') + '</strong> · ' + invEsc_((p.supplier || {}).name || '') +
        (p.status === 'part' ? ' · part received' : '') + (p.expectedDate ? ' · needed by ' + invEsc_(p.expectedDate) : '');
    }), 'inventory/orders', 'Open purchase orders');
  }
  if (sec.counts) {
    const items = [];
    fsQuery_(cfg, 'inv_counts', 'openCount', 'GREATER_THAN', 0, 300).forEach(function (cnt) {
      (cnt.lines || []).forEach(function (l) {
        if (l.status !== 'open') return;
        const where = l.loc === 'kit' ? (l.staffName || 'Injector') + '\'s kit' : l.loc === 'jt' ? 'JT storage' : 'Shelf';
        items.push('<strong>' + invEsc_(l.productName) + '</strong> · ' + invEsc_(where) + ': counted ' + l.counted + ', system ' + l.system +
          (cnt.dateKey ? ' · ' + invEsc_(cnt.dateKey) : ''));
      });
    });
    block('Count differences to review', 'differences', items, 'reports/variance', 'Review differences');
  }
  if (sec.short) {
    block('Saved short to resolve', 'saved short', fsQuery_(cfg, 'inv_usage', 'short', 'EQUAL', true, 300)
      .filter(function (u) { return u.resolved !== true; })
      .map(function (u) { return '<strong>' + invEsc_(u.patientName || '') + '</strong> · ' + invEsc_(u.formName || '') + ' · ' + invEsc_(u.by || ''); }),
      'reports/short', 'Open Saved short');
  }
  if (sec.loans) {
    block('Borrows to confirm or disputed', 'borrows', fsQuery_(cfg, 'inv_loans', 'status', 'IN', ['unconfirmed', 'disputed'], 300).map(function (l) {
      return invEsc_(l.toName || '') + ' took <strong>' + invEsc_(l.units + ' ' + (l.doseUnit || '')) + '</strong> of ' + invEsc_(l.productName || '') +
        ' from ' + invEsc_(l.fromName || '') + ' · ' + (l.status === 'disputed' ? '<span style="color:#b91c1c">disputed</span>' : 'waiting for confirmation');
    }), 'inventory/kits', 'Open Kits');
  }

  const dayText = Utilities.formatDate(new Date(slot ? slot.ms : Date.now()), 'Australia/Perth', 'EEEE d MMMM yyyy');
  return {
    subject: String(rule.name || 'Inventory digest') + ': ' + (total ? summary.join(', ') : 'all clear'),
    inner: '<h2 style="margin:0 0 4px;font-size:20px;color:#0f766e">' + invEsc_(rule.name || 'Inventory digest') + '</h2>' +
      '<p style="margin:0 0 6px;color:#475569">' + invEsc_(dayText) + (total ? '' : ' · nothing needs attention 👍') + '</p>' + parts.join(''),
    hash: 'home', label: 'Open the portal', total: total,
  };
}

/* ---------- "Send test to me" ---------- */

function notifyTest_(ruleId, session) {
  if (!/^[A-Za-z0-9_-]{3,60}$/.test(ruleId)) return { ok: false, error: 'BAD_REQUEST' };
  const cfg = getConfig_();
  const rule = fsGetDoc_(cfg, 'notify_rules/' + ruleId);
  if (!rule) return { ok: false, error: 'NOT_FOUND' };
  rule.id = ruleId;
  const me = getStaffDocs_().filter(function (x) { return x.id === session.uid; })[0];
  if (!me || !isEmail_(me.email)) return { ok: false, error: 'NO_EMAIL' };

  let ctx;
  if (rule.kind === 'digest') {
    ctx = notifyDigestContext_(cfg, rule, null); // the real digest, as it would look right now
  } else {
    const labels = {
      'request.created': 'a new order request is sent', 'request.updated': 'an order request is ordered or declined',
      'stock.arrived': 'stock arrives', 'stock.low': 'a product drops to its reorder level',
      'count.difference': 'a stock count finds differences', 'usage.short': 'a treatment is saved short',
      'loan.disputed': 'a borrow between injectors is disputed',
      'investigation.opened': 'a count doesn\'t match digital and a recount is needed',
      'investigation.confirmed': 'a recount confirms a difference and an admin review is needed',
      'count.overdue': 'the opening count isn\'t finished by its due time',
    };
    const r = rule.recipients || {};
    const byId = {};
    getStaffDocs_().forEach(function (s) { byId[s.id] = s; });
    const who = [].concat(
      r.involved === true ? ['the people involved'] : [],
      (r.staffIds || []).map(function (id) { return byId[id] ? byId[id].name + (isEmail_(byId[id].email) ? '' : ' (no email on file)') : 'unknown staff'; }),
      (r.roles || []).map(function (x) { return 'everyone in ' + x; }),
      r.emails || []);
    ctx = {
      subject: String(rule.name || 'Notification'),
      inner: '<h2 style="margin:0 0 6px;font-size:20px;color:#0f766e">Test: ' + invEsc_(rule.name || '') + '</h2>' +
        '<p style="margin:0 0 12px">When <strong>' + invEsc_(labels[rule.event] || rule.event) + '</strong>, an email goes to: ' +
        '<strong>' + invEsc_(who.join(', ') || 'nobody yet') + '</strong>.</p>' +
        '<p style="margin:0;color:#475569">This is only a test. Real emails show the details of what happened.</p>',
      hash: 'inventory/notifications', label: 'Open Notifications',
    };
  }
  notifySend_(cfg, rule, ctx, '', me.email);
  return { ok: true, to: me.email };
}

/* ---------- Opening count not done by its due time (checked once a day) ---------- */

// The same rules as the portal's countDue()
function countDueGs_(x, p) {
  if (x.active === false) return false;
  const f = String(x.countFreq || 'never');
  if (f === 'daily') return true;
  if (f === 'weekly') return p.dow === Number(x.countDay);
  if (f === 'monthly') {
    const last = schDaysIn_(p.y, p.m);
    return p.d === (x.countDay === 'last' ? last : Math.min(Number(x.countDay) || 1, last));
  }
  return false;
}

// A starter rule (to Reception) the first time, so the reminder works straight away. Editable in Notifications.
function notifyCountSeed_(cfg, rules) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('COUNT_RULE_SEEDED') === '1') return;
  props.setProperty('COUNT_RULE_SEEDED', '1');
  if (rules.some(function (r) { return r.event === 'count.overdue'; })) return;
  const now = new Date().toISOString();
  const rule = {
    name: 'Opening count not done by its due time', kind: 'event', event: 'count.overdue', enabled: true, message: '',
    conditions: { urgentOnly: false, loc: 'any', categories: [], statuses: [] },
    recipients: { involved: false, staffIds: [], roles: ['Reception'], emails: [], skipActor: true },
    createdAt: now, createdBy: 'Set up automatically', updatedAt: now, updatedBy: 'Set up automatically',
  };
  commitWrites_(cfg, [updateWrite_(cfg, 'notify_rules/starter_count_overdue', rule)]);
  rule.id = 'starter_count_overdue';
  rules.push(rule);
}

function notifyCountCheck_(cfg, rules, now) {
  notifyCountSeed_(cfg, rules);
  if (!rules.some(function (r) { return r.enabled === true && r.kind !== 'digest' && r.event === 'count.overdue'; })) return;
  const set = fsGetDoc_(cfg, 'inv_settings/counting') || {};
  const due = /^\d{2}:\d{2}$/.test(String(set.dueBy || '')) ? set.dueBy : '10:00';
  const a = new Date(now + SCH_PERTH_);
  const p = { y: a.getUTCFullYear(), m: a.getUTCMonth() + 1, d: a.getUTCDate(), dow: a.getUTCDay() };
  const key = schKey_(p);
  const dueMs = schSlotMs_(p, due);
  if (now < dueMs) return;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('COUNT_CHECK_DAY') === key) return;   // once a day
  props.setProperty('COUNT_CHECK_DAY', key);
  if (now - dueMs > 4 * 3600000) return;                      // the trigger was down: don't remind hours later

  let closed = [];
  try { const c = fsGetDoc_(cfg, 'task_settings/closed'); closed = (c && Array.isArray(c.dates)) ? c.dates : []; } catch (e) { /* send anyway */ }
  if (closed.indexOf(key) !== -1 || !hasAppointments_(cfg, key)) return;

  const dueKeys = [];
  const info = {};
  fsListAll_(cfg, 'inv_products', ['name', 'active', 'category', 'countFreq', 'countDay', 'countWhere']).forEach(function (doc) {
    const x = fromFields_(doc.fields || {});
    if (!countDueGs_(x, p)) return;
    const id = doc.name.split('/').pop();
    // JT storage is optional when the Shelf is counted too (only "JT storage only" products need their JT count)
    const locs = x.countWhere === 'jt' ? ['jt'] : ['shelf'];
    locs.forEach(function (loc) {
      dueKeys.push(id + '|' + loc);
      info[id + '|' + loc] = { name: String(x.name || ''), loc: loc, category: String(x.category || '') };
    });
  });
  if (!dueKeys.length) return;

  const done = {};
  fsQuery_(cfg, 'inv_counts', 'dateKey', 'EQUAL', key, 300).forEach(function (c) {
    if (c.kind !== 'opening') return;
    (c.lines || []).forEach(function (l) { if (l.loc !== 'kit') done[l.productId + '|' + l.loc] = true; });
  });
  const missing = dueKeys.filter(function (k) { return !done[k]; }).map(function (k) { return info[k]; });
  if (!missing.length) return;

  notifyProcessOne_(cfg, notifyEnqueue_(cfg, 'count.overdue', {
    dateKey: key, dueBy: due, total: dueKeys.length, missing: missing.length, items: missing.slice(0, 80),
  }, ''), rules);
}

// ===================== Treatment plans: suggest concerns + downtime for appointment services =====================

function handlePlan_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const op = String(body.op || '');

  if (op === 'deliver') {
    if (!can_(session, 'send.patients')) return { ok: false, error: 'FORBIDDEN' };
    try {
      return planDeliver_(body, session);
    } catch (err) {
      console.error('Plan deliver failed: ' + (err && err.stack ? err.stack : err));
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }
  if (op === 'refreshProgress') {
    const one = String(body.patientId || '').trim();
    if (!one && !can_(session, 'menu.reports')) return { ok: false, error: 'FORBIDDEN' };
    try {
      return { ok: true, count: planProgressRun_(one) };
    } catch (err) {
      console.error('Plan progress failed: ' + (err && err.stack ? err.stack : err));
      return { ok: false, error: 'SERVER_ERROR' };
    }
  }
  if (!/^admin$/i.test(String(session.role || ''))) return { ok: false, error: 'FORBIDDEN' };
  if (op !== 'suggestServices') return { ok: false, error: 'BAD_REQUEST' };

  const services = uniq_((Array.isArray(body.services) ? body.services : [])
    .map(function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 150); })
    .filter(Boolean)).slice(0, 120);
  if (!services.length) return { ok: true, items: [] };
  try {
    return { ok: true, items: geminiServiceConcerns_(services) };
  } catch (err) {
    console.error('Service suggestions failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'GEMINI_FAILED' };
  }
}

// The patient copy (a PDF made in the browser) → the clinic printer, or emailed to the patient. Logged on the plan.
function planDeliver_(body, session) {
  const pid = String(body.patientId || '').trim();
  if (!pid || pid.length > 150 || pid.indexOf('/') !== -1) return { ok: false, error: 'BAD_REQUEST' };
  const kind = body.kind === 'print' ? 'print' : 'email';
  const bytes = pdfBytes_(body.pdf);
  if (!bytes) return { ok: false, error: 'PDF_FAILED' };

  const cfg = getConfig_();
  const plan = fsGetDoc_(cfg, 'treatment_plans/' + encodeURIComponent(pid));
  if (!plan) return { ok: false, error: 'NOT_FOUND' };

  const cache = CacheService.getScriptCache();
  const rlKey = 'mail_' + session.uid;
  const sentThisHour = Number(cache.get(rlKey) || 0);
  if (sentThisHour >= MAIL_LIMIT_PER_HOUR_) return { ok: false, error: 'RATE_LIMITED' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'QUOTA' };

  const fileName = cleanFileName_(body.fileName, 'Treatment plan - ' + String(plan.patientName || 'Patient'));
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
    const subject = String(body.subject || '').trim().slice(0, 200) || 'Your treatment plan - Dermedica';
    const htmlRaw = sanitizeEmailHtml_(body.html);
    if (!htmlRaw || htmlRaw.length > 100000) return { ok: false, error: 'BAD_REQUEST' };
    const mail = { to: to, subject: subject, htmlBody: htmlRaw, body: emailHtmlToText_(htmlRaw),
      name: 'Dermedica Clinic', attachments: [pdf] };
    if (cc) mail.cc = cc;
    MailApp.sendEmail(mail);
  }
  cache.put(rlKey, String(sentThisHour + 1), 3600);

  const entry = {
    kind: kind, to: to, cc: cc, version: Number(plan.version) || 0,
    sentAt: new Date().toISOString(), sentBy: String(session.name || ''), sentByUid: String(session.uid || ''),
  };
  try {
    commitWrites_(cfg, [updateWrite_(cfg, 'treatment_plans/' + pid + '/sends/s_' + Date.now() + '_' +
      Utilities.getUuid().replace(/-/g, '').slice(0, 8), entry)]);
  } catch (e) { console.warn('Plan sent, but the send log failed: ' + e); }

  console.log('Treatment plan for ' + pid + (kind === 'print' ? ' sent to printer' : ' emailed to ' + to) + ' by ' + session.name);
  return { ok: true, entry: entry };
}

const SERVICE_CONCERNS_PROMPT_ = [
  'You set up an Australian cosmetic clinic\'s appointment SERVICES for treatment-plan tracking.',
  'For EACH service name you are given, return one item with:',
  '- "service": the service name copied EXACTLY as given.',
  '- "concerns": every patient concern from CONCERNS that this service is commonly used to treat (usually 1 to 3).',
  '  Copy concern names EXACTLY. Empty if it is not a treatment.',
  '- "not_a_treatment": true for consultations, reviews, follow-ups, checks, admin, fees, product pick-ups, packages',
  '  with no treatment named, and anything that does not treat the skin or body. Otherwise false.',
  '- "downtime_days": typical days of VISIBLE downtime a patient should plan around (redness, swelling, bruising,',
  '  peeling, scabbing). 0 if minimal or none. Whole number. Be realistic and conservative, not worst case.',
  '',
  'CONCERN GUIDE',
  '- Expression Lines & Wrinkles: Wrinkle Relaxer, anti-wrinkle injections, jaw muscle / masseter, lip flip.',
  '- Volume Loss: dermal filler, Radiesse (for volume), cheek / lip / chin / tear trough filler.',
  '- Skin Laxity: Ulthera, Skin Lifting / HIFU, Firm & Contour, Firm & Hydrate, eSkin Tight, threads for lifting.',
  '- Skin Texture & Quality: DermaGlow, RestoraGlow, peels, Genesis Glow, MediFacial, skin needling for texture, HydraRepair,',
  '  Skin Remodelling, Rejuran, LED, ReJuvaDerm, Laser Facial, skin boosters.',
  '- Pigmentation: pigment lasers, OPL / IPL for sun damage, Clear complexion lasers for pigment, peels for melasma.',
  '- Redness & Vascular Concerns: Vascular laser, OPL for redness, Genesis Glow for rosacea.',
  '- Collagen Replenishment: Collagen Activator / peptides, Sculptra, PRP, general collagen-building programs.',
  '- Body Contouring: CoolSculpting, fat freezing, TruSculpt, Vanquish, fat dissolving, body sculpting.',
  '- Acne & Acne Scarring: acne facials and lasers, Clear complexion lasers for acne, needling / microneedling for acne scars.',
  'A service that names an add-on or area (e.g. "[DG] Add on DermaGlow Neck") has the same concerns as its main treatment.',
  'Abbreviations: WR = Wrinkle Relaxer, DG = DermaGlow, prg/prk = room codes (ignore).',
].join('\n');

function geminiServiceConcerns_(services) {
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
            service: { type: 'STRING' },
            concerns: { type: 'ARRAY', items: { type: 'STRING' } },
            not_a_treatment: { type: 'BOOLEAN' },
            downtime_days: { type: 'INTEGER' },
          },
          required: ['service', 'concerns', 'not_a_treatment', 'downtime_days'],
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
        systemInstruction: { parts: [{ text: SERVICE_CONCERNS_PROMPT_ + '\n\nCONCERNS\n' + PLAN_CONCERNS.map(function (n) { return '- ' + n; }).join('\n') }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({ services: services }) }] }],
        generationConfig: {
          temperature: 0.1, responseMimeType: 'application/json', responseSchema: schema,
          thinkingConfig: { thinkingBudget: 1024 },
        },
      }),
    });
  if (res.getResponseCode() !== 200) throw new Error('Gemini ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));

  const data = JSON.parse(res.getContentText());
  const cand = (data.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).map(function (p) { return p.text || ''; }).join('');
  const parsed = JSON.parse(text || '{}');

  // Only names we asked about, only the 9 concerns, sensible downtime
  const wanted = {};
  services.forEach(function (s) { wanted[s.toLowerCase()] = s; });
  return (Array.isArray(parsed.items) ? parsed.items : []).map(function (it) {
    const name = wanted[String((it && it.service) || '').trim().toLowerCase()];
    if (!name) return null;
    const notT = it.not_a_treatment === true;
    const concerns = notT ? [] : uniq_((Array.isArray(it.concerns) ? it.concerns : [])
      .map(planConcernName_).filter(function (c) { return PLAN_CONCERNS.indexOf(c) !== -1; }));
    return {
      service: name, concerns: concerns, notTreatment: notT && !concerns.length,
      downtimeDays: Math.min(60, Math.max(0, Math.round(Number(it.downtime_days) || 0))),
    };
  }).filter(Boolean);
}

// ===================== Treatment plans: progress summaries for Reporting =====================
// The same rules as the portal's plan-track.js: the patient's visits → each treatment's sessions.
// Saved to plan_progress/{patientId} (read by Reporting). Runs daily, and for one patient when their plan is opened or changed.

const PLAN_TZ_ = 'Australia/Perth';
const PLAN_ACTIVE_ = ['active', 'maintenance'];
const PLAN_VISIT_FIELDS_ = ['other', 'wrinkleRelaxer', 'fillerRadiesse', 'restoraGlow', 'laserOplPeel', 'firmUlthera',
  'otherInjectables', 'bodySculpting', 'hydraRepair', 'collagenActivator', 'futureVisits'];
const PLAN_STOP_ = {};
['and', 'the', 'for', 'with', 'per', 'session', 'sessions', 'treatment', 'treatments', 'area', 'areas', 'full', 'face',
  'left', 'right', 'add', 'standard', 'series', 'course', 'one', 'two', 'three'].forEach(function (w) { PLAN_STOP_[w] = true; });
const PLAN_MONTHS_ = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function planSvcKey_(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function planNormTx_(s) { return String(s || '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim(); }
function planWords_(s) {
  return planNormTx_(String(s || '').replace(/\bWR\b/g, 'wrinkle relaxer')).split(' ')
    .filter(function (w) { return w.length > 2 && !PLAN_STOP_[w]; });
}
function planShares_(a, b) {
  const y = planWords_(b);
  return planWords_(a).some(function (w) { return y.indexOf(w) !== -1; });
}
// "March 2027", "Mar 2027" or "2027-03" → "2027-03"
function planMonthKey_(s) {
  const t = String(s || '').trim();
  let m = /^(\d{4})-(\d{2})/.exec(t);
  if (m) return m[1] + '-' + m[2];
  m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(t);
  const mo = m && PLAN_MONTHS_[m[1].toLowerCase()];
  return mo ? m[2] + '-' + pad2_(mo) : '';
}
function planAddWeeks_(key, w) {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(key || '');
  if (!m || !w) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 15) + w * 7 * 86400000);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1);
}
function planServiceNames_(text) {
  const parts = String(text || '').split(/\)\s*,\s*/);
  return parts.map(function (raw, i) { return (i < parts.length - 1 ? raw + ')' : raw).trim(); })
    .map(function (t) { return t.replace(/\s+\([^()]*\)$/, '').replace(/^\*+/, '').trim(); })
    .filter(Boolean);
}

// → [{ dateKey, services, future }] oldest first
function planVisits_(pre, todaySvcs, todayKey) {
  const days = {};
  const add = function (key, names, future) {
    const v = days[key] || (days[key] = { dateKey: key, services: [], future: false });
    v.future = v.future || future;
    names.forEach(function (n) {
      if (!v.services.some(function (s) { return planSvcKey_(s) === planSvcKey_(n); })) v.services.push(n);
    });
  };
  PLAN_VISIT_FIELDS_.forEach(function (f) {
    String((pre && pre[f]) || '').split(/\r?\n/).forEach(function (line) {
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(.+)$/.exec(line.trim());
      if (!m) return;
      const key = m[3] + '-' + pad2_(m[2]) + '-' + pad2_(m[1]);
      add(key, planServiceNames_(m[4]), key >= todayKey);
    });
  });
  if (todaySvcs && todaySvcs.length) add(todayKey, todaySvcs, true);
  return Object.keys(days).sort().map(function (k) { return days[k]; }).filter(function (v) { return v.services.length; });
}

// The plan workflow (System configuration → Plan workflow). Defaults until it's first saved.
function planWorkflow_(cfg) {
  let w = null;
  try { w = fsGetDoc_(cfg, 'plan_settings/workflow'); } catch (e) { console.warn('Plan workflow not read: ' + e); }
  let phases = (w && Array.isArray(w.phases) ? w.phases : []).filter(function (p) { return p && p.id; });
  if (!phases.length) {
    phases = [{ id: 'p1', name: 'Priority 1 · Now', tracked: true }, { id: 'p2', name: 'Priority 2 · Next', tracked: false },
      { id: 'p3', name: 'Priority 3 · Later', tracked: false }];
  }
  if (!phases.some(function (p) { return p.tracked === true; })) phases[0].tracked = true;
  return {
    phases: phases,
    moved: w && w.moved && typeof w.moved === 'object' ? w.moved : {},
    waitingKeepsOpen: !(w && w.waitingKeepsOpen === false),
  };
}
function planPhase_(wf, id) {
  let k = id;
  for (let i = 0; i < 6 && k && !wf.phases.some(function (p) { return p.id === k; }); i++) k = wf.moved[k];
  return wf.phases.filter(function (p) { return p.id === k; })[0] || wf.phases[0];
}

function planTrackLine_(line, past, future, cur, waiting) {
  const ov = line.overrides || {};
  const iv = Number(line.intervalWeeks) || 0;
  const pattern = String(line.pattern || 'unknown');
  const total = pattern === 'course' ? Math.max(1, Number(line.sessions) || 1) : pattern === 'once' ? 1 : 0;
  const P = past.slice();
  const F = future.slice();
  const start = line.startMonth || planMonthKey_(line.frequency);
  const slots = [];
  let prev = null;
  for (let n = 1; n <= 60 && (!total || n <= total); n++) {
    const o = ov[String(n)] || {};
    const expected = o.month || (n === 1 ? start : prev ? planAddWeeks_(prev.date || prev.month, iv) : '') || '';
    let s;
    if (o.status === 'done') s = { state: 'done', date: o.date || '' };
    else if (o.status === 'skipped') s = { state: 'skipped' };
    else if (P.length) s = { state: 'done', date: P.shift() };
    else if (F.length) s = { state: 'booked', date: F.shift() };
    else if (!total && pattern === 'unknown' && !iv && slots.some(function (x) { return x.state === 'done'; })) break;
    else s = { state: !expected ? 'unscheduled' : expected < cur ? 'overdue' : expected === cur ? 'due' : 'planned' };
    // A concern in a waiting priority: nothing is due until it's moved up
    if (waiting && ['done', 'booked', 'skipped'].indexOf(s.state) === -1) s = { state: 'waiting' };
    s.n = n;
    s.month = s.date ? s.date.slice(0, 7) : s.state === 'waiting' ? '' : expected;
    s.asked = o.asked || null;
    slots.push(s);
    prev = s;
    if (!total && ['done', 'booked', 'skipped'].indexOf(s.state) === -1) break;
  }
  const next = slots.filter(function (s) { return s.state !== 'done' && s.state !== 'skipped'; })[0] || null;
  return {
    slots: slots, total: total, next: next, complete: !!total && !next,
    done: slots.filter(function (s) { return s.state === 'done'; }).length,
  };
}

function planTrackConcern_(c, visits, svcMap, fromOf, cur, waiting) {
  const lines = Array.isArray(c.lines) ? c.lines : [];
  const hits = {};
  lines.forEach(function (l) { hits[l.id] = { past: {}, future: {} }; });
  visits.forEach(function (v) {
    const ids = {};
    v.services.forEach(function (s) {
      const k = planSvcKey_(s);
      let line = lines.filter(function (l) { return (l.services || []).some(function (x) { return planSvcKey_(x) === k; }); })[0];
      if (!line) {
        const set = svcMap[k];
        if (!set || set.notTreatment || (set.concerns || []).indexOf(c.key) === -1) return;
        line = lines.filter(function (l) { return planShares_(l.treatment, s); })[0] || (lines.length === 1 ? lines[0] : null);
        if (!line) return;
      }
      ids[line.id] = line;
    });
    Object.keys(ids).forEach(function (id) {
      if (v.dateKey >= (fromOf(ids[id]) || '')) hits[id][v.future ? 'future' : 'past'][v.dateKey] = true;
    });
  });
  const out = {};
  lines.forEach(function (l) {
    out[l.id] = planTrackLine_(l, Object.keys(hits[l.id].past).sort(), Object.keys(hits[l.id].future).sort(), cur);
  });
  return out;
}

function planSummary_(id, plan, pre, todaySvcs, svcMap, todayKey, wf) {
  const cur = todayKey.slice(0, 7);
  const createdKey = plan.createdAt ? Utilities.formatDate(new Date(plan.createdAt), PLAN_TZ_, 'yyyy-MM-dd') : '';
  const visits = planVisits_(pre, todaySvcs, todayKey);
  const concerns = Array.isArray(plan.concerns) ? plan.concerns : [];
  const lines = [];
  let lastVisit = '';
  let nextBooked = '';
  let started = false;
  const cSum = concerns.map(function (c) {
    const cs = String(c.status || 'active');
    const ph = planPhase_(wf, c.priority);
    const waiting = ph.tracked !== true;
    const tr = planTrackConcern_(c, visits, svcMap, function (l) { return l.countFrom || createdKey; }, cur, waiting);
    let cStarted = false;
    (c.lines || []).forEach(function (l) {
      const t = tr[l.id];
      t.slots.forEach(function (s) {
        if (s.state === 'done' && s.date > lastVisit) lastVisit = s.date;
        if (s.state === 'booked' && s.date >= todayKey && (!nextBooked || s.date < nextBooked)) nextBooked = s.date;
        if (s.state === 'done' || s.state === 'booked') cStarted = true;
      });
      const nx = t.next;
      lines.push({
        lineId: String(l.id || ''), concern: String(c.key || ''), concernStatus: cs, treatment: String(l.treatment || '').slice(0, 200),
        state: t.complete ? 'complete' : nx ? nx.state : 'none', n: nx ? nx.n : 0, total: t.total, done: t.done,
        month: nx ? nx.month || '' : '', date: nx ? nx.date || '' : '',
        askedAt: nx && nx.asked ? String(nx.asked.at || '') : '', askedBy: nx && nx.asked ? String(nx.asked.by || '') : '',
        phase: String(ph.id || ''), phaseName: String(ph.name || ''), waiting: waiting,
      });
    });
    if (PLAN_ACTIVE_.indexOf(cs) !== -1 && cStarted) started = true;
    return { key: String(c.key || ''), status: cs, started: cStarted, lines: (c.lines || []).length,
      phase: String(ph.id || ''), phaseName: String(ph.name || ''), waiting: waiting };
  });

  // The same automatic status as the plan screen
  const status = String(plan.status || 'proposed');
  let eff = status;
  if (status !== 'closed') {
    const live = concerns.filter(function (c) { return PLAN_ACTIVE_.indexOf(String(c.status || 'active')) !== -1; });
    const liveTracked = live.filter(function (c) { return planPhase_(wf, c.priority).tracked === true; });
    if (concerns.length && (!live.length || (!wf.waitingKeepsOpen && !liveTracked.length))) eff = 'completed';
    else if (['proposed', 'sent', 'accepted'].indexOf(status) !== -1 && started) eff = 'in_progress';
  }
  return {
    patientId: id, patientPttId: String(plan.patientPttId || ''), patientName: String(plan.patientName || ''),
    status: status, effStatus: eff, createdAt: String(plan.createdAt || ''), createdBy: String(plan.createdBy || ''),
    updatedAt: String(plan.updatedAt || ''), version: Number(plan.version) || 0,
    concerns: cSum, lines: lines.slice(0, 60), lastVisit: lastVisit, nextBooked: nextBooked,
    computedAt: new Date().toISOString(),
  };
}

// Reads many documents in one go (100 at a time). → { "collection/id": fields }
function fsBatchGet_(cfg, paths) {
  const out = {};
  for (let i = 0; i < paths.length; i += 100) {
    const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + ':batchGet', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
      payload: JSON.stringify({ documents: paths.slice(i, i + 100).map(function (p) { return fsBase_(cfg) + '/' + p; }) }),
    });
    if (res.getResponseCode() !== 200) throw new Error('Firestore batchGet ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
    JSON.parse(res.getContentText()).forEach(function (r) {
      if (r.found) out[r.found.name.split('/documents/')[1]] = fromFields_(r.found.fields || {});
    });
  }
  return out;
}

// onlyId: one patient's plan; empty: every plan. Returns how many were saved.
function planProgressRun_(onlyId) {
  const cfg = getConfig_();
  const todayKey = Utilities.formatDate(new Date(), PLAN_TZ_, 'yyyy-MM-dd');
  let plans;
  if (onlyId) {
    if (onlyId.length > 150 || onlyId.indexOf('/') !== -1) return 0;
    const p = fsGetDoc_(cfg, 'treatment_plans/' + encodeURIComponent(onlyId));
    plans = p ? [{ id: onlyId, d: p }] : [];
  } else {
    plans = fsListAll_(cfg, 'treatment_plans').map(function (d) { return { id: d.name.split('/').pop(), d: fromFields_(d.fields || {}) }; });
  }
  if (!plans.length) return 0;

  const svcMap = {};
  const set = fsGetDoc_(cfg, 'plan_settings/services');
  ((set && set.services) || []).forEach(function (r) { if (r && r.service) svcMap[planSvcKey_(r.service)] = r; });

  const todayById = {};
  try {
    const day = fsGetDoc_(cfg, 'appts_by_day/' + todayKey);
    ((day && day.appointments) || []).forEach(function (a) {
      const k = String(a.patientId || '').toLowerCase();
      if (k) todayById[k] = (todayById[k] || []).concat(a.services || []);
    });
  } catch (e) { console.warn('Today\'s appointments not read: ' + e); }

  const ptt = function (p) { return docId_(p.d.patientPttId || p.d.patientId || p.id); };
  const pres = fsBatchGet_(cfg, uniq_(plans.map(function (p) { return ptt(p) ? 'pcn_results/' + ptt(p) : ''; }).filter(Boolean)));
  const wf = planWorkflow_(cfg);
  const writes = plans.map(function (p) {
    const key = ptt(p);
    return updateWrite_(cfg, 'plan_progress/' + p.id,
      planSummary_(p.id, p.d, pres['pcn_results/' + key] || null, todayById[String(key).toLowerCase()] || [], svcMap, todayKey, wf));
  });
  commitWrites_(cfg, writes, 100);
  return writes.length;
}

// The daily trigger runs this
function runPlanProgress() {
  console.log('Plan progress updated for ' + planProgressRun_('') + ' plan(s).');
}

// Run ONCE from the editor: every morning about 9am, after the 8:30 sheet sync
function installPlanProgress() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runPlanProgress'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runPlanProgress').timeBased().everyDays(1).atHour(9).nearMinute(0).create();
  runPlanProgress();
  console.log('Plan progress installed (daily, about 9am).');
}

// ===================== Chat: email the admins about unread Help messages =====================
// runNotifications (every 5 minutes) checks the Help chats. When a staff member's message has waited
// CHAT_REMIND_MINUTES_ without an admin opening it, every active Admin with an email is emailed,
// once for that message. Nothing is sent while "away" is on (see CHAT_REMIND_WHEN_AWAY_).

const CHAT_REMIND_MINUTES_ = 10;
const CHAT_REMIND_WHEN_AWAY_ = false;   // true: still email while "Back tomorrow" / away is switched on

function chatHelpReminders_(cfg) {
  const now = Date.now();

  if (!CHAT_REMIND_WHEN_AWAY_) {
    try {
      const s = fsGetDoc_(cfg, 'app_settings/chat');
      const a = s && s.away;
      const today = Utilities.formatDate(new Date(), 'Australia/Perth', 'yyyy-MM-dd');
      if (a && a.on === true && (!a.back || String(a.back) > today)) return;
    } catch (e) { /* not sure: carry on and remind */ }
  }

  const admins = getStaffDocs_().filter(function (s) { return s.active !== false && /^admin$/i.test(String(s.role || '')); });
  const to = uniq_(admins.map(function (s) { return isEmail_(s.email) ? s.email : ''; }));
  if (!to.length) return;
  const adminIds = admins.map(function (s) { return s.id; });

  fsQuery_(cfg, 'chats', 'kind', 'EQUAL', 'help', 300).forEach(function (c) {
    try {
      const staffUid = String((c.members || [])[0] || '');
      const lastAt = Date.parse(String(c.lastAt || ''));
      if (!staffUid || !lastAt) return;
      if (String(c.lastBy || '') !== staffUid) return;                       // an admin has the last word
      if (c.status === 'sorted') return;
      const age = now - lastAt;
      if (age < CHAT_REMIND_MINUTES_ * 60000 || age > 24 * 3600000) return;  // too soon, or too old to nag about
      if (String(c.emailedFor || '') === String(c.lastAt)) return;            // already emailed for this message
      const readAt = c.readAt || {};
      if (adminIds.some(function (id) { const r = Date.parse(String(readAt[id] || '')); return r && r >= lastAt; })) return;
      if (MailApp.getRemainingDailyQuota() < 1) return;

      const who = String(c.lastByName || (c.names && c.names[staffUid]) || 'A staff member');
      const text = String(c.lastText || '');
      const mins = Math.round(age / 60000);
      const html = invEmailWrap_(
        '<h2 style="margin:0 0 6px;font-size:20px;color:#0f766e">' + invEsc_(who) + ' needs help</h2>' +
        '<p style="margin:0 0 12px;color:#475569">Sent ' + mins + ' minutes ago in the portal\'s Help chat, and not read yet.</p>' +
        '<p style="margin:0 0 6px;padding:12px 14px;border-radius:10px;background:#f0fdfa;color:#134e4a;white-space:pre-wrap">' +
          invEsc_(text) + (text.length >= 200 ? '…' : '') + '</p>',
        'home/chat/' + c._id, 'Reply in the portal');
      MailApp.sendEmail({
        to: to.join(','), name: 'Dermedica Portal',
        subject: 'Help request from ' + who + ': ' + text.replace(/\s+/g, ' ').slice(0, 60) + (text.length > 60 ? '…' : ''),
        htmlBody: html, body: emailHtmlToText_(html),
      });

      fsPatch_(cfg, 'chats/' + c._id, { emailedFor: String(c.lastAt), emailedAt: new Date().toISOString() });
      try {
        commitWrites_(cfg, [updateWrite_(cfg, 'notify_log/l_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
          ruleId: 'chat_help', ruleName: 'Unread Help message', event: 'chat.help', to: to,
          subject: 'Help request from ' + who, refId: String(c._id), at: new Date().toISOString(),
        })]);
      } catch (e) { console.warn('Chat reminder sent, but the log failed: ' + e); }
      console.log('Chat reminder sent for ' + c._id);
    } catch (e) {
      console.error('Chat reminder ' + c._id + ': ' + (e && e.stack ? e.stack : e));
    }
  });
}

// ===================== End of day: an email if someone started their day but didn't end it =====================
// An hour after their rostered finish (Staff → Edit → Work schedule), once a day. Only staff with a schedule.

function eodReminders_(cfg, now) {
  const today = Utilities.formatDate(new Date(now), REC_TZ_, 'yyyy-MM-dd');
  const dk = SCHED_DAY_KEYS_[Number(Utilities.formatDate(new Date(now), REC_TZ_, 'u')) - 1];   // u: 1 = Monday
  const p = new Date(now + SCH_PERTH_);
  const nowMin = p.getUTCHours() * 60 + p.getUTCMinutes();
  const cache = CacheService.getScriptCache();
  const sentKey = function (s) { return 'eod_rem_' + s.id + '_' + today; };

  const due = getStaffDocs_().filter(function (s) {
    const sc = s.schedule;
    if (s.active === false || !isEmail_(s.email) || !sc || !sc.week) return false;
    const d = sc.week[dk];
    if (!d || d.on !== true) return false;
    if ((sc.leave || []).some(function (l) { return l.from <= today && today <= l.to; })) return false;
    const end = hmMin_(d.end);
    return end !== null && nowMin >= end + 60 && nowMin < end + 240 && !cache.get(sentKey(s));
  });
  if (!due.length) return;

  const days = fsBatchGet_(cfg, due.map(function (s) { return 'inv_kitdays/' + s.id + '__' + today; }));
  due.forEach(function (s) {
    const d = days['inv_kitdays/' + s.id + '__' + today];
    if (!d || !d.start || d.end) return;            // didn't start today, or already ended
    if (MailApp.getRemainingDailyQuota() < 1) return;
    cache.put(sentKey(s), '1', 21600);
    const html = invEmailWrap_(
      '<h2 style="margin:0 0 6px;font-size:20px;color:#0f766e">You didn\'t end your day</h2>' +
      '<p style="margin:0 0 12px;color:#475569">You started your day in the portal today, but End of day wasn\'t done.' +
        (s.injector ? ' Tomorrow\'s kit count is checked against tonight\'s, so please do it whenever you can.' : '') + '</p>' +
      '<p style="margin:0;color:#475569">Still at the clinic? Open the portal and press <strong>End my day</strong>.</p>',
      'home', 'Open the portal');
    MailApp.sendEmail({ to: s.email, name: 'Dermedica Portal', subject: 'Reminder: End of day not done',
      htmlBody: html, body: emailHtmlToText_(html) });
    console.log('End of day reminder sent to ' + s.name);
  });
}

// Run from the editor to try it straight away (still only emails for messages waiting 10+ minutes)
function testChatReminders() {
  chatHelpReminders_(getConfig_());
}
// Picks Gemini or Claude for this request, logs how long each step took, and keeps the answer in
// scan_jobs (so "Finish later" can pick it up, and the timings can be reviewed with scanTimingReport)
function scannerAction_(body) {
  const op = String((body && body.op) || '');
  if (SCAN_JOB_OPS_.indexOf(op) !== -1) return scanJobAction_(body);
  SCAN_AI_ = scanProvider_(body);
  SCAN_TIMES_ = [];
  SCAN_SESSION_ = getSession_(String(body.session || ''));   // scannerActionInner_ still does the login check
  const t0 = Date.now();
  const res = scannerActionInner_(body);
  const total = Date.now() - t0;
  if (SCAN_TIMES_.length) {
    console.log('Scanner timing: ' + SCAN_TIMES_.map(function (t) {
      return t.step + ' ' + t.ms + ' ms (' + t.ai + ', ' + t.model + ')';
    }).join(' + ') + ' = ' + total + ' ms total');
    if (res && typeof res === 'object') res.timing = { ai: SCAN_AI_, steps: SCAN_TIMES_, ms: total };
  }
  if (res && res.ok && SCAN_SESSION_) scanJobSave_(body, res, total);
  return res;
}


/* ===================== Scanner: photos read by Gemini ===================== */
// body: { op: "billing" | "docket" | "rx" | "auto", image: base64 JPEG, mime, … }
// "auto": works out which of the three it is (from a small copy, body.thumb), then reads it as that, in one request.
// Always answers ok: true (after the login check), so callApi doesn't replace the message.
// Problems come back in "problem".
function scannerActionInner_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const op = String(body.op || '');
  const allowed = SCAN_KINDS_.filter(function (k) { return can_(session, 'scanner.' + k); });
  const kind = op === 'auto' ? 'auto' : op === 'docket' ? 'docket' : op === 'rx' ? 'rx' : 'billing';
  if (!can_(session, 'menu.scanner') || (kind === 'auto' ? !allowed.length : allowed.indexOf(kind) === -1)) {
    return { ok: false, error: 'FORBIDDEN' };
  }

  const cache = CacheService.getScriptCache();
  const rlKey = 'scan_' + session.uid;
  const n = Number(cache.get(rlKey) || 0);
  if (n >= 60) return { ok: true, problem: "You've scanned a lot in the last hour. Wait a few minutes, then try again." };
  cache.put(rlKey, String(n + 1), 3600);

  try {
    if (kind === 'auto') return Object.assign({ ok: true }, scanAuto_(body, allowed));
    const result = kind === 'docket' ? scanDocket_(body) : kind === 'rx' ? scanRx_(body) : scanBilling_(body);
    return { ok: true, result: result };
  } catch (err) {
    console.error('Scanner failed for ' + session.name + ': ' + (err && err.stack || err));
    return { ok: true, problem: String((err && err.message) || "The scanner couldn't read that photo. Try again.") };
  }
}

/* ---------- Scanner: Auto (which of the three is it?) ---------- */

const SCAN_KINDS_ = ['billing', 'docket', 'rx'];
const SCAN_AUTO_MIN_ = 0.6;   // below this it asks instead of guessing

const SCAN_CLASSIFY_PROMPT_ = [
  'You sort photos taken at Dermedica, a skin clinic in Perth, Australia. Say which ONE of these the photo shows.',
  'Judge the PRINTED layout of the paper (titles, headings, boxes), not the handwriting.',
  'Several pages may be joined top to bottom: judge them together.',
  '',
  '"billing": a Dermedica patient BILLING SHEET. Printed patient name top left, appointment date and time top right, the provider',
  '  (e.g. "Dr Teh") far top right, and column headings such as "APPT NOTES", "SERVICES DONE TODAY", "PKG #", "PROV", "FEE",',
  '  "Purchase Status", "BUYING PKG TODAY", "GRAND TOTAL", "TOTAL AMOUNT TO PAY" and a "NEXT APPT" box. Skincare bottles, tubes',
  '  or boxes are often placed on or beside it: that is still "billing". With no products in the photo it is still "billing".',
  '"docket": goods DELIVERED to the clinic. Either a supplier\'s delivery docket, packing slip, delivery note or tax invoice',
  '  (supplier letterhead or logo, product codes, quantities ordered or supplied, often batch and expiry, Dermedica as the customer),',
  '  OR Dermedica\'s own printed "Delivery Docket Form" (title "Delivery Docket Form", a table headed "Product name" and',
  '  "Quantity delivered", tick boxes "New delivery from Supplier" and "Internal transfer from JT store"). That form has no',
  '  supplier letterhead and is still "docket".',
  '"rx": a doctor\'s PRESCRIPTION pad slip. Printed doctor name and qualifications at the top (e.g. "Dr Joanna Teh, MBBS"),',
  '  a script number at the top right, printed fields such as "Patient\'s full name", "Medicare no.", "Entitlement no.",',
  '  tick boxes for "PBS", "RPBS" and "Brand substitution not permitted", a handwritten medicine in the middle, a signature and date.',
  '"other": clearly none of these. For example an Injectable Treatment Record (face diagram, consumables table, product stickers),',
  '  a To-Book note, a consent or medical form, a Return Product Form, a receipt or EFTPOS slip, a shelf of boxes, products with',
  '  no paperwork, or anything unrelated. Put what it is in looksLike, starting with "a" or "an", e.g. "an injectable treatment record".',
  '"unsure": you can\'t tell, e.g. the photo is too blurry, dark or cut off to see the printed headings.',
  '',
  'confidence: 0 to 1, how sure you are. Below 0.6 means you are guessing. Never guess between billing, docket and rx: use "unsure".',
].join('\n');

const SCAN_CLASSIFY_SCHEMA_ = {
  type: 'OBJECT',
  properties: {
    kind: { type: 'STRING', enum: ['billing', 'docket', 'rx', 'other', 'unsure'] },
    confidence: { type: 'NUMBER' },
    looksLike: { type: 'STRING', description: 'For "other": what it is, e.g. "an injectable treatment record". Otherwise empty.' },
  },
  required: ['kind', 'confidence'],
};

// The fast model first (Claude Haiku, or Gemini's SCAN_CLASSIFY_MODEL), then the main one
function scanClassify_(image, mime) {
  try { return scanAiJson_(SCAN_CLASSIFY_PROMPT_, image, mime, SCAN_CLASSIFY_SCHEMA_, true); }
  catch (e) {
    console.warn("Scanner: the fast model couldn't sort the photo, trying the main model: " + e);
    return scanAiJson_(SCAN_CLASSIFY_PROMPT_, image, mime, SCAN_CLASSIFY_SCHEMA_, false);
  }
}

// → { auto: { kind, guess, confidence, looksLike, ms, notAllowed? }, result?, problem? }
// auto.kind: billing | docket | rx (read, result attached) · other · unsure (the phone asks which it is)
function scanAuto_(body, allowed) {
  const image = String(body.image || '');
  if (!image) throw new Error('The photo is missing. Take it again.');
  if (image.length > 12 * 1024 * 1024) throw new Error('The photo is too big. Take it again.');
  const thumb = String(body.thumb || '');
  const mime = String(body.mime || 'image/jpeg');

  const t0 = Date.now();
  let d = null;
  try { d = scanClassify_(thumb && thumb.length < 3 * 1024 * 1024 ? thumb : image, mime); }
  catch (e) { console.warn('Scanner: the photo could not be sorted: ' + e); }
  d = d || {};
  const guess = SCAN_KINDS_.indexOf(d.kind) !== -1 ? d.kind : '';
  const conf = Math.max(0, Math.min(1, Number(d.confidence) || 0));
  const sure = conf >= SCAN_AUTO_MIN_;
  const auto = {
    kind: guess && sure ? guess : d.kind === 'other' && sure ? 'other' : 'unsure',
    guess: guess, confidence: Math.round(conf * 100) / 100,
    looksLike: String(d.looksLike || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    ms: Date.now() - t0,
  };
  console.log('Scanner: sorted as ' + auto.kind + ' (said ' + (d.kind || 'nothing') + ', ' + auto.confidence + ') in ' + auto.ms + ' ms');

  if (SCAN_KINDS_.indexOf(auto.kind) === -1) return { auto: auto };
  if (allowed.indexOf(auto.kind) === -1) { auto.notAllowed = true; return { auto: auto }; }

  const sub = Object.assign({}, body, { op: auto.kind });
  if (auto.kind === 'billing') {   // only what can be handed to a patient (the same rule as the phone's)
    const all = Array.isArray(body.products) ? body.products : [];
    const sell = all.filter(function (p) { return p && p.sell === true; });
    sub.products = sell.length ? sell : all;
  }
  try {
    const result = auto.kind === 'docket' ? scanDocket_(sub) : auto.kind === 'rx' ? scanRx_(sub) : scanBilling_(sub);
    return { auto: auto, result: result };
  } catch (err) {
    console.error('Scanner (auto, ' + auto.kind + ') failed: ' + (err && err.stack || err));
    return { auto: auto, problem: String((err && err.message) || "The scanner couldn't read that photo. Try again.") };
  }
}

// ===== Scanner AI switch (Gemini / Claude) =====
// Per execution: which AI this request uses, and how long each call took.
var SCAN_AI_ = 'claude';
var SCAN_TIMES_ = [];

function scanProvider_(body) {
  const p = PropertiesService.getScriptProperties();
  const want = String((body && body.ai) || p.getProperty('SCAN_AI') || 'claude').toLowerCase();
  if (want === 'gemini') return 'gemini';
  return p.getProperty('ClaudeApi') ? 'claude' : 'gemini';   // no key: straight to Gemini
}

/* ===================== Scanner: Finish later (scan_jobs) ===================== */
// Every read is saved in scan_jobs/{id}: its timing, and the answer. "Finish later" adds the photo
// (Storage: scan_jobs/{id}.jpg) and parked: true, so the scan shows under Ready to check.
// Only Apps Script reads and writes scan_jobs. Kept 7 days (parked and unchecked: 30 days).

var SCAN_SESSION_ = null;
const SCAN_JOBS_ = 'scan_jobs';
const SCAN_JOB_RE_ = /^sj_[A-Za-z0-9]{16,40}$/;
const SCAN_JOB_OPS_ = ['jobPark', 'jobList', 'jobOpen', 'jobDone'];
const SCAN_JOB_NAMES_ = { billing: 'Billing sheet', docket: 'Delivery docket', rx: 'Prescription' };

// Never stops the scan if it can't be saved (about 0.2 s)
function scanJobSave_(body, res, total) {
  try {
    const want = String(body.jobId || '');
    const id = SCAN_JOB_RE_.test(want) ? want : 'sj_' + Utilities.getUuid().replace(/-/g, '');
    const op = String(body.op || '');
    const auto = res.auto || null;
    const s = SCAN_SESSION_;
    fsPatch_(getConfig_(), SCAN_JOBS_ + '/' + id, {
      kind: op, readAs: auto ? String(auto.kind || '') : op,
      status: res.problem ? 'failed' : 'ready', problem: String(res.problem || '').slice(0, 300),
      resultJson: res.result ? JSON.stringify(res.result) : '', autoJson: auto ? JSON.stringify(auto) : '',
      ai: String(SCAN_AI_ || ''), steps: SCAN_TIMES_, ms: total,
      byUid: String(s.uid || ''), by: String(s.name || ''), at: new Date().toISOString(),
    });
  } catch (e) { console.warn('Scan job not saved: ' + e); }
}

function scanJobStatus_(j, now) {
  if (j.status === 'ready' || j.status === 'failed') return j.status;
  // Apps Script stops at 6 minutes: a read that hasn't finished by then never will
  return now - (Date.parse(j.parkedAt || '') || 0) > 7 * 60000 ? 'failed' : 'reading';
}

function scanJobLabel_(j) {
  let r = null;
  try { r = JSON.parse(j.resultJson || 'null'); } catch (e) { /* no label */ }
  if (!r) return '';
  if ((j.readAs || j.phoneReadAs) === 'docket') {
    return r.transferType === 'transfer' ? 'Internal transfer' : String(r.supplier || 'Delivery docket');
  }
  return String(r.patientName || '');
}

function scanJobAction_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'menu.scanner')) return { ok: false, error: 'FORBIDDEN' };
  const op = String(body.op || '');
  const cfg = getConfig_();
  const now = Date.now();
  try {
    if (op === 'jobList') return { ok: true, jobs: scanJobList_(cfg, session, now) };
    const id = String(body.jobId || '');
    if (!SCAN_JOB_RE_.test(id)) return { ok: false, error: 'BAD_REQUEST' };
    const path = SCAN_JOBS_ + '/' + id;
    const job = fsGetDoc_(cfg, path);
    if (job && job.byUid && job.byUid !== session.uid) return { ok: false, error: 'FORBIDDEN' };

    if (op === 'jobPark') {
      if (job && job.parked === true) return { ok: true };
      const image = String(body.image || '');
      if (!image || image.length > 10 * 1024 * 1024) return { ok: true, problem: "The photo couldn't be kept. Wait for it instead." };
      const photoPath = scanJobPutPhoto_(cfg, id, image, String(body.mime || 'image/jpeg'));
      // Its own fields only, so a read that finishes at the same moment isn't overwritten
      fsPatch_(cfg, path, {
        parked: true, parkedAt: new Date().toISOString(), photoPath: photoPath, done: false, reminded: false,
        phoneKind: String(body.kind || '').slice(0, 20), phoneReadAs: String(body.readAs || '').slice(0, 20),
        byUid: String(session.uid || ''), by: String(session.name || ''),
      });
      return { ok: true };
    }
    if (op === 'jobDone') {
      if (!job) return { ok: true };
      if (job.photoPath) scanJobDelPhoto_(cfg, job.photoPath);
      fsPatch_(cfg, path, { done: true, doneAt: new Date().toISOString(), photoPath: '' });
      return { ok: true };
    }
    if (op === 'jobOpen') {
      if (!job || job.done === true) return { ok: true, problem: "That scan isn't there any more." };
      const status = scanJobStatus_(job, now);
      const out = {
        ok: true, status: status, kind: String(job.kind || job.phoneKind || ''),
        readAs: String(job.readAs || job.phoneReadAs || ''),
        problem: status === 'failed' ? String(job.problem || "The read didn't finish. Tap Try again.") : '',
        result: null, auto: null, image: '',
      };
      try { out.result = JSON.parse(job.resultJson || 'null'); } catch (e) { /* none */ }
      try { out.auto = JSON.parse(job.autoJson || 'null'); } catch (e) { /* none */ }
      if (status !== 'reading' && job.photoPath) out.image = Utilities.base64Encode(scanJobGetPhoto_(cfg, job.photoPath).getBytes());
      return out;
    }
  } catch (err) {
    console.error('Scan job ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: true, problem: 'Something went wrong. Try again.' };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

// This person's parked scans from the last 3 days that haven't been finished
function scanJobList_(cfg, session, now) {
  return fsQuery_(cfg, SCAN_JOBS_, 'parked', 'EQUAL', true, 300)
    .filter(function (j) {
      return j.byUid === session.uid && j.done !== true && now - (Date.parse(j.parkedAt || '') || 0) < 3 * 864e5;
    })
    .map(function (j) {
      return { id: j._id, status: scanJobStatus_(j, now), kind: String(j.kind || j.phoneKind || ''),
        readAs: String(j.readAs || j.phoneReadAs || ''), label: scanJobLabel_(j), parkedAt: String(j.parkedAt || '') };
    })
    .sort(function (a, b) { return b.parkedAt.localeCompare(a.parkedAt); });
}

/* ---------- The photo (Firebase Storage, through the service account) ---------- */

function scanJobBucket_() {
  const b = String(PropertiesService.getScriptProperties().getProperty('STORAGE_BUCKET') || '')
    .trim().replace(/^gs:\/\//i, '').split('/')[0];
  if (!b) throw new Error('Missing STORAGE_BUCKET script property.');
  return b;
}
function scanJobPutPhoto_(cfg, id, b64, mime) {
  const name = 'scan_jobs/' + id + '.jpg';
  const res = UrlFetchApp.fetch('https://storage.googleapis.com/upload/storage/v1/b/' + encodeURIComponent(scanJobBucket_()) +
    '/o?uploadType=media&name=' + encodeURIComponent(name), {
    method: 'post', contentType: /^image\/(jpeg|png|webp)$/.test(mime) ? mime : 'image/jpeg',
    payload: Utilities.base64Decode(b64), muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
  });
  if (res.getResponseCode() !== 200) throw new Error('Photo not kept (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  return name;
}
function scanJobGetPhoto_(cfg, path) {
  if (!/^scan_jobs\/sj_[A-Za-z0-9]{16,40}\.jpg$/.test(String(path))) throw new Error('Unexpected photo path');
  const res = UrlFetchApp.fetch('https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(scanJobBucket_()) +
    '/o/' + encodeURIComponent(path) + '?alt=media', {
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) }, muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) throw new Error('Photo not read (' + res.getResponseCode() + ')');
  return res.getBlob();
}
function scanJobDelPhoto_(cfg, path) {
  if (!/^scan_jobs\/sj_[A-Za-z0-9]{16,40}\.jpg$/.test(String(path))) return;
  try {
    UrlFetchApp.fetch('https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(scanJobBucket_()) +
      '/o/' + encodeURIComponent(path), {
      method: 'delete', headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) }, muteHttpExceptions: true,
    });
  } catch (e) { console.warn('Scan photo not deleted: ' + e); }
}

/* ---------- Every 5 minutes (runNotifications): the backup email, and tidying up ---------- */

function scanJobsSweep_(cfg) {
  const now = Date.now();
  const staff = {};
  getStaffDocs_().forEach(function (s) { staff[s.id] = s; });
  const gone = [];

  fsQuery_(cfg, SCAN_JOBS_, 'parked', 'EQUAL', true, 300).forEach(function (j) {
    const parked = Date.parse(j.parkedAt || '') || 0;
    if (now - parked > 30 * 864e5 || j.done === true && now - parked > 7 * 864e5) {
      if (j.photoPath) scanJobDelPhoto_(cfg, j.photoPath);
      gone.push(deleteWrite_(cfg, SCAN_JOBS_ + '/' + j._id));
      return;
    }
    if (j.done === true || j.reminded === true) return;
    const status = scanJobStatus_(j, now);
    if (status === 'reading') return;
    const readyAt = Date.parse(j.at || '') || parked;
    if (status === 'ready' && now - readyAt < 30 * 60000) return;   // give them half an hour first
    const s = staff[j.byUid];
    if (s && s.active !== false && isEmail_(s.email) && MailApp.getRemainingDailyQuota() > 0) {
      const what = SCAN_JOB_NAMES_[j.readAs || j.phoneReadAs] || 'Scan';
      const label = scanJobLabel_(j);
      const failed = status === 'failed';
      const html = invEmailWrap_(
        '<h2 style="margin:0 0 6px;font-size:20px;color:' + (failed ? '#b45309' : '#0f766e') + '">' +
          (failed ? "A scan couldn't be read" : 'A scan is waiting to be checked') + '</h2>' +
        '<p style="margin:0 0 12px;color:#475569"><strong>' + invEsc_(what) + '</strong>' + (label ? ' · ' + invEsc_(label) : '') +
          ', put aside with Finish later at ' + invEsc_(Utilities.formatDate(new Date(parked), REC_TZ_, 'h:mm a')) + '.</p>' +
        '<p style="margin:0">' + (failed ? 'Open it from Ready to check on the Scanner and tap Try again.'
          : "It isn't saved yet. Open it from Ready to check on the Scanner, check it and save it.") + '</p>',
        'scanner', 'Open the Scanner');
      MailApp.sendEmail({ to: s.email, name: 'Dermedica Portal', htmlBody: html, body: emailHtmlToText_(html),
        subject: (failed ? "Couldn't read: " : 'Waiting to be checked: ') + what + (label ? ' · ' + label : '') });
    }
    fsPatch_(cfg, SCAN_JOBS_ + '/' + j._id, { reminded: true });
  });

  // Scans that were never parked are only timing logs: kept 7 days
  const cut = new Date(now - 7 * 864e5).toISOString();
  fsQuery_(cfg, SCAN_JOBS_, 'at', 'LESS_THAN', cut, 200).forEach(function (j) {
    if (j.parked === true) return;   // handled above
    gone.push(deleteWrite_(cfg, SCAN_JOBS_ + '/' + j._id));
  });
  if (gone.length) commitWrites_(cfg, gone, 200);
}

/* ---------- Run from the editor: how long scans took over the last 7 days ---------- */

function scanTimingReport() {
  const cfg = getConfig_();
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + ':runQuery', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
    payload: JSON.stringify({ structuredQuery: {
      from: [{ collectionId: SCAN_JOBS_ }],
      select: { fields: ['ms', 'kind', 'readAs', 'ai', 'status', 'parked'].map(function (f) { return { fieldPath: f }; }) },
      where: { fieldFilter: { field: { fieldPath: 'at' }, op: 'GREATER_THAN', value: { stringValue: since } } },
      limit: 5000,
    } }),
  });
  if (res.getResponseCode() !== 200) throw new Error('Scan jobs not read (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  const rows = JSON.parse(res.getContentText()).filter(function (r) { return r.document; })
    .map(function (r) { return fromFields_(r.document.fields || {}); })
    .filter(function (j) { return Number(j.ms) > 0; });
  if (!rows.length) { console.log('No scans logged in the last 7 days yet.'); return; }

  const line = function (label, list) {
    const ms = list.map(function (j) { return Number(j.ms); }).sort(function (a, b) { return a - b; });
    const at = function (p) { return ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] / 1000; };
    const over = ms.filter(function (x) { return x > 10000; }).length;
    console.log(label + ': ' + ms.length + ' scans · median ' + at(0.5).toFixed(1) + ' s · 90% under ' + at(0.9).toFixed(1) +
      ' s · slowest ' + at(1).toFixed(1) + ' s · over 10 s: ' + over + ' (' + Math.round(over * 100 / ms.length) + '%)');
  };
  const by = function (key) {
    const g = {};
    rows.forEach(function (j) { const k = String(j[key] || '?'); (g[k] = g[k] || []).push(j); });
    Object.keys(g).sort().forEach(function (k) { line('  ' + key + ' ' + k, g[k]); });
  };
  line('All', rows);
  by('readAs');
  by('ai');
  console.log('Failed: ' + rows.filter(function (j) { return j.status === 'failed'; }).length +
    ' · Finish later used: ' + rows.filter(function (j) { return j.parked === true; }).length);
  console.log('(Apps Script time only. The phone adds preparing the photo and the network, usually 1 to 2 s.)');
}
/** One AI call for the scanner. fast = the sorting step (small model). */
function scanAiJson_(prompt, image, mime, schema, fast) {
  const p = PropertiesService.getScriptProperties();
  const t0 = Date.now();
  let ai = SCAN_AI_, model, out;

  if (ai === 'claude') {
    model = fast
      ? (p.getProperty('CLAUDE_FAST_MODEL') || 'claude-haiku-5-5')
      : (p.getProperty('CLAUDE_MODEL') || 'claude-sonnet-5-5');
    try {
      out = claudeJson_(prompt, image, mime, schema, model, fast ? 1024 : 8192);
    } catch (e) {
      console.warn('Scanner: Claude failed (' + e.message + '), falling back to Gemini');
      ai = 'gemini (fallback)';
      model = fast ? (p.getProperty('SCAN_CLASSIFY_MODEL') || 'gemini-2.5-flash-lite') : undefined;
      out = geminiJson_(prompt, image, mime, schema, model);
    }
  } else {
    model = fast ? (p.getProperty('SCAN_CLASSIFY_MODEL') || 'gemini-2.5-flash-lite') : undefined;
    out = geminiJson_(prompt, image, mime, schema, model);
  }

  SCAN_TIMES_.push({ step: fast ? 'sort' : 'read', ai: ai, model: model || 'GEMINI_MODEL', ms: Date.now() - t0 });
  return out;
}

function claudeJson_(prompt, image, mime, schema, model, maxTokens) {
  const key = PropertiesService.getScriptProperties().getProperty('ClaudeApi');
  if (!key) throw new Error('Script Property "ClaudeApi" is missing');

  const body = {
    model: model,
    max_tokens: maxTokens || 8192,
    // The long, unchanging prompt (with the product list) is cached between scans.
    system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime || 'image/jpeg', data: image } },
        { type: 'text', text: 'Read this photo and return the JSON.' }
      ]
    }],
    output_config: {
      format: { type: 'json_schema', schema: scanToJsonSchema_(schema) }
    }
  };
  if (!/haiku-4/.test(model)) body.output_config.effort = 'low';
  const thinking = claudeThinking_(model);
  if (thinking) body.thinking = thinking;

  const opts = {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21' },
    payload: JSON.stringify(body)
  };

  const t0 = Date.now();
  let data;
  for (let attempt = 0; ; attempt++) {
    const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', opts);
    const code = r.getResponseCode();
    if (code === 200) { data = JSON.parse(r.getContentText()); break; }
    if ((code === 429 || code === 529 || code >= 500) && attempt < 2) {
      Utilities.sleep(800 * (attempt + 1));
      continue;
    }
    throw new Error('HTTP ' + code + ': ' + r.getContentText().slice(0, 300));
  }

  const u = data.usage || {};
  console.log('Scanner: Claude ' + model + ' ' + (Date.now() - t0) + ' ms · in ' + (u.input_tokens || 0) +
    ' (+' + (u.cache_read_input_tokens || 0) + ' cached, ' + (u.cache_creation_input_tokens || 0) +
    ' cache-write) · out ' + (u.output_tokens || 0) + ' · stop ' + data.stop_reason);

  if (data.stop_reason === 'refusal') throw new Error('Claude declined to read this photo');
  if (data.stop_reason === 'max_tokens') throw new Error('Claude ran out of room (max_tokens)');

  const text = (data.content || []).filter(function (b) { return b.type === 'text'; })
    .map(function (b) { return b.text; }).join('');
  return JSON.parse(text);
}

function claudeThinking_(model) {
  if (/haiku-5/.test(model)) return { type: 'disabled' };       // fastest: no thinking
  if (/sonnet-5-5/.test(model)) return { type: 'between_tools' }; // Sonnet 5.5's lowest setting
  return null;                                                     // other models: their default
}

/** Converts the Gemini-style schemas (type: 'OBJECT', nullable) to JSON Schema for Claude. */
function scanToJsonSchema_(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  const type = s.type ? String(s.type).toLowerCase() : null;
  if (type) out.type = s.nullable ? [type, 'null'] : type;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.nullable ? s.enum.concat([null]) : s.enum.slice();
  if (type === 'object') {
    out.properties = {};
    Object.keys(s.properties || {}).forEach(function (k) {
      out.properties[k] = scanToJsonSchema_(s.properties[k]);
    });
    // All fields required keeps the grammar small and fast; Claude sends "" or null when blank.
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (type === 'array' && s.items) out.items = scanToJsonSchema_(s.items);
  return out;
}

function scanBilling_(body) {
  if (body.op !== 'billing') throw new Error('Unknown scanner action.');
  const image = String(body.image || '');
  if (!image) throw new Error('The photo is missing. Take it again.');
  if (image.length > 12 * 1024 * 1024) throw new Error('The photo is too big. Take it again.');
  const products = (Array.isArray(body.products) ? body.products : []).slice(0, 800)
    .map((p) => ({ id: String(p.id || '').slice(0, 60), name: String(p.name || '').slice(0, 150), brand: String(p.brand || '').slice(0, 80) }))
    .filter((p) => p.id && p.name);
  if (!products.length) throw new Error('The product list is empty.');
  return scanAiJson_(scanBillingPrompt_(products), image, String(body.mime || 'image/jpeg'), SCAN_BILLING_SCHEMA_, false);
}

function scanBillingPrompt_(products) {
  return [
    'You are checking a photo taken at a skin clinic. It shows a printed billing sheet with handwriting,',
    'and usually the actual products being given to the patient placed on or next to it.',
    'Only the PRODUCTS matter. Ignore services, treatments, consultations, packages and all totals.',
    '',
    'Read:',
    '1. The header: patient name, appointment date (as YYYY-MM-DD), time and provider (e.g. "Dr Teh").',
    '2. The products section only (the rows with a "Purchase Status" and "Fee" column): each product line exactly as written,',
    '   its quantity (1 unless written like "x2" or "2x") and its fee. Ignore crossed-out lines. Ticks and marks are not products.',
    '3. Every physical product visible in the photo (bottles, tubes, boxes), read from its label, and how many of each.',
    '',
    'Match every written product line and every product seen to ONE id from the product list below.',
    'The products in the photo are usually the SAME products written on the sheet. When a handwritten line is short or',
    'abbreviated (e.g. "Derm Pro B", "Derm SPF"), read the matching product\'s label in the photo and give the written line',
    'and the product seen the SAME id. The printed label is more reliable than the handwriting.',
    'Common abbreviations: "D." or "Derm" = Dermedica, "ZO" = ZO Skin Health, "DPD" = Daily Power Defense, "SPF" = a sunscreen.',
    'Use the brand, the product name and the size to choose. If nothing fits, use "". Never make up an id.',
    'Give each match a confidence from 0 to 1.',
    '',
    'Products (id | brand | name):',
    products.map((p) => p.id + ' | ' + p.brand + ' | ' + p.name).join('\n'),
  ].join('\n');
}

const SCAN_BILLING_SCHEMA_ = {
  type: 'OBJECT',
  properties: {
    patientName: { type: 'STRING' },
    date: { type: 'STRING', description: 'Appointment date as YYYY-MM-DD, or empty' },
    time: { type: 'STRING' },
    provider: { type: 'STRING' },
    written: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      text: { type: 'STRING', description: 'The product line exactly as handwritten' },
      qty: { type: 'INTEGER' },
      fee: { type: 'NUMBER', nullable: true },
      productId: { type: 'STRING', description: 'An id from the product list, or empty' },
      confidence: { type: 'NUMBER' },
    }, required: ['text', 'qty', 'productId', 'confidence'] } },
    seen: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      description: { type: 'STRING', description: 'What the label says' },
      count: { type: 'INTEGER' },
      productId: { type: 'STRING', description: 'An id from the product list, or empty' },
      confidence: { type: 'NUMBER' },
    }, required: ['description', 'count', 'productId', 'confidence'] } },
  },
  required: ['patientName', 'date', 'provider', 'written', 'seen'],
};

// One photo + instructions in, JSON (matching the schema) out. Retries when Gemini is busy.
// Thinking makes Gemini slower and reading a sheet doesn't need it. Models differ in what they accept,
// so the fastest setting is tried first, and whichever one works is remembered for 6 hours.
function geminiJson_(prompt, imageB64, mime, schema, modelOverride) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) throw new Error("The scanner isn't set up yet. Add GEMINI_API_KEY in Script Properties.");
  const model = modelOverride || props.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const budget = Math.max(0, parseInt(props.getProperty('SCAN_THINKING') || '0', 10) || 0);
  const tries = [{ thinkingBudget: budget }, { thinkingLevel: 'low' }, null];   // fastest first; null = model default

  const cache = CacheService.getScriptCache();
  const memoKey = 'scan_think_' + model + '_' + budget;
  let t = Math.min(tries.length - 1, Math.max(0, parseInt(cache.get(memoKey) || '0', 10) || 0));
  const payloadFor = function () {
    const gc = { temperature: 0, responseMimeType: 'application/json', responseSchema: schema };
    if (tries[t]) gc.thinkingConfig = tries[t];
    return JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: imageB64 } }] }],
      generationConfig: gc,
    });
  };

  const started = Date.now();
  let code = 0, text = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
      payload: payloadFor(), muteHttpExceptions: true,
    });
    code = res.getResponseCode();
    text = res.getContentText();
    if (code === 400 && t < tries.length - 1 && /thinking/i.test(text)) {
      console.warn('Scanner: ' + model + ' refused ' + JSON.stringify(tries[t]) + '. Trying the next setting. ' + text.slice(0, 200));
      t++;
      continue;
    }
    if (code !== 429 && code < 500) break;
    Utilities.sleep(1500 * (attempt + 1));
  }
  if (code !== 200) {
    console.error('Gemini ' + code + ' (model ' + model + '): ' + text.slice(0, 1500));
    throw new Error(code === 429 ? 'The scanner is busy. Try again in a minute.' : "The scanner couldn't read that photo. Try again.");
  }
  try { cache.put(memoKey, String(t), 21600); } catch (e) { /* not essential */ }

  const json = JSON.parse(text);
  const cand = json.candidates && json.candidates[0];
  const out = cand && cand.content && cand.content.parts ? cand.content.parts.map((p) => p.text || '').join('') : '';
  if (!out) {
    console.error('Gemini gave no answer (finish: ' + (cand && cand.finishReason) + ')');
    throw new Error("The scanner didn't find anything. Try a clearer photo.");
  }
  console.log('Scanner: Gemini took ' + (Date.now() - started) + ' ms (model ' + model +
    ', thinking ' + (tries[t] ? JSON.stringify(tries[t]) : 'model default') + ')');
  return JSON.parse(out);
}


/* ---------- Scanner: supplier delivery dockets ---------- */
function scanDocket_(body) {
  const image = String(body.image || '');
  if (!image) throw new Error('The photo is missing. Take it again.');
  if (image.length > 12 * 1024 * 1024) throw new Error('The photo is too big. Take it again.');
  const products = (Array.isArray(body.products) ? body.products : []).slice(0, 1500)
    .map((p) => ({ id: String(p.id || '').slice(0, 60), name: String(p.name || '').slice(0, 150), brand: String(p.brand || '').slice(0, 80) }))
    .filter((p) => p.id && p.name);
  if (!products.length) throw new Error('The product list is empty.');
  return scanAiJson_(scanDocketPrompt_(products), image, String(body.mime || 'image/jpeg'), SCAN_DOCKET_SCHEMA_, false);
}

function scanDocketPrompt_(products) {
  return [
    'You are reading a photo of a delivery docket for Dermedica, a skin clinic. Dermedica is always the CUSTOMER, never the supplier.',
    'It is either a SUPPLIER\'s docket (packing slip, delivery note or tax invoice, with their letterhead) or Dermedica\'s own',
    'printed "Delivery Docket Form" (title "Delivery Docket Form", tick boxes "New delivery from Supplier" and',
    '"Internal transfer from JT store").',
    '',
    'Read:',
    '1. formType: "dermedica" for Dermedica\'s own Delivery Docket Form, otherwise "supplier".',
    '2. transferType (Dermedica form only): "transfer" if "Internal transfer from JT store" is ticked, "delivery" if',
    '   "New delivery from Supplier" is ticked, "" if neither or it\'s a supplier docket. A tick, cross or scribble in or',
    '   over the box counts as ticked.',
    '3. supplier: the company that sent the goods (letterhead or logo, or the name written next to "New delivery from Supplier").',
    '   "" for an internal transfer.',
    '4. docketNumber: the docket, delivery note or invoice number. docketDate: its date as YYYY-MM-DD.',
    '5. poNumber: the clinic\'s purchase order number if printed (often labelled "PO", "Your ref", "Customer order", "Order no").',
    '6. Every product line: the description as written (text), the product code, the quantity SUPPLIED (not ordered;',
    '   back-ordered or not supplied = 0), the unit, the batch or lot number and the expiry date (YYYY-MM-DD, or YYYY-MM',
    '   if only the month is written). Ignore freight, GST, discounts and totals.',
    '   BATCHES: if one product row lists several batch numbers (one under another in the batch column), give one line per',
    '   batch number written, with qty 1 each, even if the same batch is written more than once. If only one batch is',
    '   written, use the row\'s quantity. formQty: the number in the row\'s Qty column (the same on every line of that row).',
    '   toShelf / toJt (Dermedica form only): the numbers written in the "To Store Rm" and "To JT" columns for that row,',
    '   or null if empty.',
    '7. Who received it: receivedBy (the name), receivedDate (YYYY-MM-DD, Australian day first: 16/10/26 = 2026-10-16)',
    '   and receivedTime (24-hour HH:MM). Otherwise "".',
    '',
    'Match every product line to ONE id from the product list below, using the brand, name, strength and size.',
    'Short names are common: "Balance" = Belotero Balance, "Radiesse" = Radiesse. If nothing fits, use "". Never make up an id.',
    'Give each match a confidence from 0 to 1.',
    '',
    'Products (id | brand | name):',
    products.map((p) => p.id + ' | ' + p.brand + ' | ' + p.name).join('\n'),
  ].join('\n');
}

const SCAN_DOCKET_SCHEMA_ = {
  type: 'OBJECT',
  properties: {
    formType: { type: 'STRING', enum: ['supplier', 'dermedica'] },
    transferType: { type: 'STRING', description: 'Dermedica form only: "transfer", "delivery", or "" if neither box is ticked' },
    supplier: { type: 'STRING' },
    docketNumber: { type: 'STRING' },
    docketDate: { type: 'STRING', description: 'YYYY-MM-DD, or empty' },
    poNumber: { type: 'STRING', description: "The clinic's purchase order number, or empty" },
    receivedBy: { type: 'STRING', description: 'Handwritten or stamped name of who received it, or empty' },
    receivedDate: { type: 'STRING', description: 'YYYY-MM-DD, or empty' },
    receivedTime: { type: 'STRING', description: '24-hour HH:MM, or empty' },
    lines: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      text: { type: 'STRING', description: 'The line as written' },
      code: { type: 'STRING' },
      qty: { type: 'INTEGER', description: 'Quantity supplied (for this batch)' },
      formQty: { type: 'INTEGER', nullable: true, description: "The row's Qty column" },
      toShelf: { type: 'INTEGER', nullable: true },
      toJt: { type: 'INTEGER', nullable: true },
      unit: { type: 'STRING' },
      batch: { type: 'STRING' },
      expiry: { type: 'STRING', description: 'YYYY-MM-DD or YYYY-MM, or empty' },
      productId: { type: 'STRING', description: 'An id from the product list, or empty' },
      confidence: { type: 'NUMBER' },
    }, required: ['text', 'qty', 'productId', 'confidence'] } },
  },
  required: ['supplier', 'docketNumber', 'lines'],
};


/* ---------- Scanner: product prescriptions ---------- */
// body: { op: "rx", image, mime, rxProducts: ["Epiduo", "Fading Cream", …] }   (the clinic's prescription product names)
const FADING_CREAM_ = 'Fading Cream';
const FADING_RE_ = /\b(hq|hydroquinone|kojic|ascorbic|dexameth\w*|dexa)\b/i;

function scanRx_(body) {
  const image = String(body.image || '');
  if (!image) throw new Error('The photo is missing. Take it again.');
  if (image.length > 12 * 1024 * 1024) throw new Error('The photo is too big. Take it again.');
  const products = uniq_((Array.isArray(body.rxProducts) ? body.rxProducts : [])
    .map(function (s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120); })
    .filter(Boolean)).slice(0, 400);
  if (!products.length) throw new Error('The prescription product list is empty.');

  const out = scanAiJson_(scanRxPrompt_(products), image, String(body.mime || 'image/jpeg'), SCAN_RX_SCHEMA_, false);

  // Only exact names from the list are kept. Fading Cream is decided here too, not left to Gemini alone.
  const byLower = {};
  products.forEach(function (p) { byLower[p.toLowerCase()] = p; });
  const fading = byLower[FADING_CREAM_.toLowerCase()] || '';
  out.items = (Array.isArray(out.items) ? out.items : []).map(function (it) {
    it = it || {};
    const text = String(it.text || '');
    let product = byLower[String(it.product || '').trim().toLowerCase()] || '';
    if (fading && FADING_RE_.test(text)) { product = fading; it.confidence = Math.max(Number(it.confidence) || 0, 0.95); }
    return {
      text: text.slice(0, 500), medicine: String(it.medicine || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      product: product, strengths: String(it.strengths || '').slice(0, 300),
      quantity: String(it.quantity || '').slice(0, 60), directions: String(it.directions || '').slice(0, 300),
      repeats: String(it.repeats || '').slice(0, 20), confidence: Math.max(0, Math.min(1, Number(it.confidence) || 0)),
    };
  }).filter(function (it) { return it.text || it.product; });
  // Two Fading Cream ingredient lines are one prescription
  if (fading) {
    const fc = out.items.filter(function (it) { return it.product === fading; });
    if (fc.length > 1) {
      const merged = Object.assign({}, fc[0], {
        text: fc.map(function (x) { return x.text; }).join('\n'),
        strengths: fc.map(function (x) { return x.strengths; }).filter(Boolean).join(', '),
        quantity: fc.map(function (x) { return x.quantity; }).filter(Boolean)[0] || '',
      });
      out.items = [merged].concat(out.items.filter(function (it) { return it.product !== fading; }));
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(out.date || ''))) out.date = '';
  return out;
}

function scanRxPrompt_(products) {
  return [
    'You are reading a photo of a handwritten prescription from Dermedica, an Australian skin clinic.',
    'The doctor\'s details are printed at the top; the patient and the medicines are handwritten.',
    '',
    'Read:',
    '1. patientName: the patient\'s full name as written. address and postcode: the patient\'s address (helps find the right patient).',
    '2. date: the date written next to the doctor\'s signature, as YYYY-MM-DD. It is Australian: DAY/MONTH/YEAR,',
    '   and a 2-digit year is 20YY (28/4/26 = 2026-04-28). Use "" if you can\'t read it.',
    '3. scriptNumber: the printed number at the top right (e.g. AC22102718). prescriber: the doctor\'s name printed at the top.',
    '4. items: one per medicine or compound. text = exactly as written (spelling and abbreviations as on the script).',
    '   medicine = the medicine\'s correct name, properly spelled, the way a pharmacist would write it: the brand name with',
    '   the generic name in brackets, then the strength, e.g. "Minomycin (minocycline) 50 mg", "Epiduo (adapalene 0.1% /',
    '   benzoyl peroxide 2.5%) gel". Add the form (tablets, capsules, cream, gel) only if it is written. If only the generic',
    '   is written, use just the generic. Correct the spelling, but NEVER change the medicine, strength or amount from what',
    '   is written. If you can\'t read the medicine, copy text.',
    '   strengths = any percentages or doses (e.g. "4% HQ, 2% kojic acid").',
    '   quantity = the amount to supply (often circled, e.g. "100", "20", "50g"). directions = how to use it, in plain English',
    '   ("bd" = twice a day, "tds" = three times a day, "QID" = four times a day, "nocte" = at night, "ii" = two).',
    '   repeats = number of repeats if written ("+ 5 rpt" = 5), else "".',
    '',
    'RULES',
    '- A compound with ANY of hydroquinone (HQ), kojic acid, ascorbic acid or dexamethasone is ONE item, product "' + FADING_CREAM_ + '".',
    '  Put all its ingredients in strengths, and the total amount (e.g. 50g) in quantity.',
    '- product must be copied EXACTLY from the list below. Match on the brand OR the generic name (e.g. a script for',
    '  "Minomycin" matches a list entry "Minocycline"). If none fits, use "": staff will type it in. Never make up a product name.',
    '',
    'Prescription products:',
    products.join('\n'),
  ].join('\n');
}

const SCAN_RX_SCHEMA_ = {
  type: 'OBJECT',
  properties: {
    patientName: { type: 'STRING' },
    address: { type: 'STRING' },
    postcode: { type: 'STRING' },
    date: { type: 'STRING', description: 'YYYY-MM-DD, or empty' },
    scriptNumber: { type: 'STRING' },
    prescriber: { type: 'STRING' },
    items: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
      text: { type: 'STRING', description: 'The medicine exactly as written' },
      medicine: { type: 'STRING', description: 'The correct full name: brand (generic) strength form' },
      product: { type: 'STRING', description: 'An exact name from the product list, or empty' },
      strengths: { type: 'STRING' },
      quantity: { type: 'STRING' },
      directions: { type: 'STRING' },
      repeats: { type: 'STRING' },
      confidence: { type: 'NUMBER' },
    }, required: ['text', 'medicine', 'product', 'confidence'] } },
  },
  required: ['patientName', 'date', 'items'],
};

// ===================== Records: move a saved form to another patient =====================
// The record keeps its id (links and consent checks keep working). Patient details on the form are refilled,
// products used move with it, and the move is kept on the record (moves) and in record_moves.

const MOVE_REASONS_ = { wrong: 'Saved to the wrong patient', duplicate: 'Duplicate patient record', other: 'Other' };
// Answers that only hold a patient detail because they were filled in automatically
const REC_FILLS_ = { 'patient.name': 'name', 'patient.firstName': 'first', 'patient.lastName': 'last', 'patient.dob': 'dobKey',
  'patient.email': 'email', 'patient.mobile': 'mobile', 'patient.address': 'address',
  'patient.medicare': 'medicare', 'patient.medicareIrn': 'medicareIrn', 'patient.medicareExp': 'medicareExp' };
const recNorm_ = function (s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); };
const recSame_ = function (a, b) { return String(a || '').toLowerCase().replace(/\s+/g, '') === String(b || '').toLowerCase().replace(/\s+/g, ''); };

// Older records imported from the sheets: a row in Firestore + a finished PDF in Google Drive
const REC_LEGACY_ = {
  treatment: { col: 'treatment_records', title: 'Treatment Record Type', link: 'File PDF Link' },
  consent: { col: 'consent_records', title: 'Consent Type', link: 'PDF Link' },
};

function handleRecords_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'records.move')) return { ok: false, error: 'FORBIDDEN' };
  const op = String(body.op || '');
  try {
    if (op === 'legacyCheck' || op === 'moveLegacy') {
      const kind = String(body.kind || '');
      const def = REC_LEGACY_[kind];
      const rid = String(body.recordId || '').trim();
      if (!def || !recDocIdOk_(rid)) return { ok: false, error: 'BAD_REQUEST' };
      return op === 'legacyCheck' ? recLegacyCheck_(def, rid) : recMoveLegacy_(def, kind, rid, body, session);
    }
    const id = String(body.submissionId || '').trim();
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
    if (op === 'moveCheck') return recMoveCheck_(id);
    if (op === 'moveSubmission') return recMoveSubmission_(id, body, session);
  } catch (err) {
    console.error('Records ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}
// "2028-03" -> "03/2028"
function recMedicareExp_(k) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(k || ''));
  return m ? m[2] + '/' + m[1] : '';
}

function recPatient_(cfg, id) {
  if (!id || id.length > 150 || id.indexOf('/') !== -1) return null;
  const p = fsGetDoc_(cfg, 'patient_list/' + encodeURIComponent(id));
  if (!p) return null;
  const name = String(p['Patient Name'] || ((p['First Name'] || '') + ' ' + (p['Last Name'] || '')).trim());
  return {
    id: id, pttId: String(p.PttID || id), name: name,
    first: String(p['First Name'] || name.split(' ')[0] || ''), last: String(p['Last Name'] || ''),
    dobKey: String(p.DobKey || ''), dob: String(p.DOB || ''), email: String(p.Email || ''),
    mobile: String(p.Mobile || ''), address: String(p.Address || ''),
    medicare: recMedicare_(p['Medicare Number']), medicareIrn: String(p['Medicare IRN'] || ''), mergedInto: String(p.MergedInto || ''),
    medicareExp: recMedicareExp_(p['Medicare Expiry']),
  };
}

function recLongDate_(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  return m ? Utilities.formatDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)), 'UTC', 'd MMMM yyyy') : '';
}
function recMobile_(s) {
  const d = String(s || '').replace(/\D/g, '');
  if (/^04\d{8}$/.test(d)) return d.slice(0, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7);
  if (/^614\d{8}$/.test(d)) return recMobile_('0' + d.slice(2));
  return String(s || '');
}

function recMedicare_(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length === 10 ? d.slice(0, 4) + ' ' + d.slice(4, 9) + ' ' + d.slice(9) : String(s || '');
}

function recFieldsOf_(cfg, sub) {
  const tid = String(sub.templateId || '');
  if (!/^[A-Za-z0-9_-]{1,60}$/.test(tid)) return [];
  const v = fsGetDoc_(cfg, 'form_templates/' + tid + '/versions/' + String(Number(sub.version) || 0));
  return v && Array.isArray(v.fields) ? v.fields : [];
}

// The old patient's name in answers staff typed (not the patient details, signatures or auto-fills)
function recTextMentions_(answers, fields, oldName) {
  const n = recNorm_(oldName);
  if (n.length < 3) return false;
  const skip = {};
  fields.forEach(function (f) {
    if (f && (f.type === 'patient' || f.type === 'signature' || (f.fill && REC_FILLS_[f.fill]))) skip[f.id] = true;
  });
  return Object.keys(answers || {}).some(function (k) {
    return k !== '__tags' && !skip[k.replace(/__x$/, '')] && recNorm_(JSON.stringify(answers[k])).indexOf(n) !== -1;
  });
}

// Consent / prescription checks on this form that found a record (they belong to the old patient)
function recConsentChecks_(answers) {
  return Object.keys(answers || {}).filter(function (k) {
    const v = answers[k];
    return v && typeof v === 'object' && !Array.isArray(v) && v.found === true && typeof v.submissionId === 'string' && v.submissionId;
  }).length;
}

function recPhotoCount_(answers) {
  let n = 0;
  Object.keys(answers || {}).forEach(function (k) {
    const v = answers[k];
    if (v && typeof v === 'object' && Array.isArray(v.photos)) n += v.photos.length;
  });
  return n;
}

// The old patient's other forms whose consent check found this one
function recDependents_(cfg, fromId, subId) {
  if (!fromId) return [];
  return fsQuery_(cfg, 'form_submissions', 'patientId', 'EQUAL', fromId, 300)
    .filter(function (s) {
      return s._id !== subId && Object.keys(s.answers || {}).some(function (k) {
        const v = s.answers[k];
        return v && typeof v === 'object' && v.found === true && v.submissionId === subId;
      });
    })
    .map(function (s) { return { id: s._id, name: String(s.templateName || ''), date: String(s.recordDate || '') }; })
    .slice(0, 20);
}

// Age in whole years on a day ("YYYY-MM-DD" both), or ""
function recAge_(dobKey, onKey) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dobKey || ''));
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(onKey || ''));
  if (!a || !b) return '';
  let y = +b[1] - +a[1];
  if (+b[2] < +a[2] || (+b[2] === +a[2] && +b[3] < +a[3])) y--;
  return y >= 0 && y < 130 ? String(y) : '';
}

// The answers with the new patient's details in place of the old one's
function recRewrite_(answersIn, fields, from, to, recordDate) {
  const answers = JSON.parse(JSON.stringify(answersIn || {}));
  const toVals = { name: to.name, first: to.first, last: to.last, dobKey: to.dobKey, email: to.email, mobile: to.mobile,
    address: to.address, medicare: to.medicare, medicareIrn: to.medicareIrn, medicareExp: to.medicareExp };
  const fromVals = { name: from.name, first: from.first, last: from.last, dobKey: from.dobKey, email: from.email, mobile: from.mobile,
    address: from.address, medicare: from.medicare || '', medicareIrn: from.medicareIrn || '', medicareExp: from.medicareExp || '' };
  const dobLong = recLongDate_(to.dobKey) || to.dob;
  fields.forEach(function (f) {
    if (!f || !f.id || !(f.id in answers)) return;
    const v = answers[f.id];
    if (f.type === 'patient' && v && typeof v === 'object' && !Array.isArray(v)) {
      const part = { name: to.name, dob: dobLong, mobile: recMobile_(to.mobile), email: to.email, address: to.address, pttId: to.pttId,
        medicare: to.medicare, medicareIrn: to.medicareIrn, medicareExp: to.medicareExp };
      Object.keys(v).forEach(function (k) { if (k in part) v[k] = part[k]; });
    } else if (f.type === 'signature' && (f.signer || 'patient') === 'patient' && v && typeof v === 'object' && v.name && recSame_(v.name, from.name)) {
      v.name = to.name;
    } else if (f.fill && REC_FILLS_[f.fill] && typeof v === 'string') {
      const k = REC_FILLS_[f.fill];
      if (!fromVals[k] || recSame_(v, fromVals[k])) answers[f.id] = toVals[k] || ''; // never overwrites something typed over it
    }
  });
  if (answers.__tags && typeof answers.__tags === 'object') {
    const t = answers.__tags;
    t['patient name'] = to.name;
    t['first name'] = to.first;
    t['last name'] = to.last;
    t['date of birth'] = dobLong;
    t['patient id'] = to.pttId;
    t['medicare number'] = to.medicare;
    t['medicare reference number'] = to.medicareIrn;
    t['medicare expiry'] = to.medicareExp;
    t['patient address'] = to.address;
    t['patient mobile'] = recMobile_(to.mobile);
    t['patient email'] = to.email;
    t['patient age'] = recAge_(to.dobKey, recordDate || Utilities.formatDate(new Date(), REC_TZ_, 'yyyy-MM-dd'));  }
  return answers;
}

// Before moving: what's linked to the record
function recMoveCheck_(id) {
  const cfg = getConfig_();
  const sub = fsGetDoc_(cfg, 'form_submissions/' + id);
  if (!sub) return { ok: false, error: 'NOT_FOUND' };
  const fields = recFieldsOf_(cfg, sub);
  return {
    ok: true,
    dependents: recDependents_(cfg, String(sub.patientId || ''), id),
    consentChecks: recConsentChecks_(sub.answers),
    textMention: recTextMentions_(sub.answers, fields, sub.patientName),
    photos: recPhotoCount_(sub.answers),
    usage: fsQuery_(cfg, 'inv_usage', 'submissionId', 'EQUAL', id, 5).length,
  };
}

function recMoveSubmission_(id, body, session) {
  const toId = String(body.toPatientId || '').trim();
  const reason = MOVE_REASONS_[body.reason] ? String(body.reason) : '';
  const note = String(body.note || '').trim().slice(0, 500);
  if (!reason) return { ok: false, error: 'NO_REASON' };
  if (reason === 'other' && !note) return { ok: false, error: 'NO_NOTE' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'BUSY' };
  try {
    const cfg = getConfig_();
    const sub = fsGetDoc_(cfg, 'form_submissions/' + id);
    if (!sub) return { ok: false, error: 'NOT_FOUND' };
    const fromId = String(sub.patientId || '');
    if (toId === fromId) return { ok: false, error: 'SAME_PATIENT' };
    const to = recPatient_(cfg, toId);
    if (!to) return { ok: false, error: 'NO_PATIENT' };
    if (to.mergedInto) return { ok: false, error: 'MERGED' };
    const from = recPatient_(cfg, fromId) || { id: fromId, pttId: String(sub.patientPttId || ''), name: '',
      first: '', last: '', dobKey: '', dob: '', email: '', mobile: '', address: '' };
    if (!from.name) from.name = String(sub.patientName || '');

    const fields = recFieldsOf_(cfg, sub);
    const answers = recRewrite_(sub.answers || {}, fields, from, to, String(sub.recordDate || ''));
    const now = new Date().toISOString();
    const move = {
      at: now, by: String(session.name || ''), byUid: String(session.uid || ''),
      fromId: fromId, fromPttId: String(sub.patientPttId || ''), fromName: String(sub.patientName || ''),
      toId: toId, toPttId: to.pttId, toName: to.name,
      reason: reason, reasonText: MOVE_REASONS_[reason], note: note,
    };
    const dependents = recDependents_(cfg, fromId, id);

    fsPatch_(cfg, 'form_submissions/' + id, {
      patientId: toId, patientPttId: to.pttId, patientName: to.name, answers: answers,
      moves: (Array.isArray(sub.moves) ? sub.moves : []).concat([move]).slice(-20), movedAt: now,
    });

    // Products used move with the record
    let usage = 0;
    fsQuery_(cfg, 'inv_usage', 'submissionId', 'EQUAL', id, 5).forEach(function (u) {
      try {
        fsPatch_(cfg, 'inv_usage/' + u._id, {
          patientId: toId, patientName: to.name,
          movedFrom: { patientId: fromId, patientName: String(sub.patientName || ''), at: now, by: move.by },
        });
        usage++;
      } catch (e) { console.warn('Usage ' + u._id + ' not moved: ' + e); }
    });

    const deliveries = Array.isArray(sub.deliveries) ? sub.deliveries.length : 0;
    try {
      commitWrites_(cfg, [updateWrite_(cfg, 'record_moves/m_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), Object.assign({
        kind: 'form', submissionId: id, templateName: String(sub.templateName || ''), category: String(sub.category || ''),
        recordDate: String(sub.recordDate || ''), deliveries: deliveries, dependents: dependents.length, usage: usage,
      }, move))]);
    } catch (e) { console.warn('Record moved, but the move log failed: ' + e); }

    console.log('Form ' + id + ' moved from ' + move.fromName + ' to ' + to.name + ' by ' + move.by);
    return {
      ok: true, move: move, dependents: dependents, deliveries: deliveries, usage: usage,
      consentChecks: recConsentChecks_(answers), textMention: recTextMentions_(answers, fields, sub.patientName),
    };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Older records (treatment_records / consent_records) ---------- */

function recDocIdOk_(id) {
  return !!id && id.length <= 150 && id.indexOf('/') === -1 && id !== '.' && id !== '..';
}

// A patient by doc ID, or by PttID (older rows store the PttID)
function recPatientAny_(cfg, id) {
  if (!recDocIdOk_(id)) return null;
  const p = recPatient_(cfg, id);
  if (p) return p;
  const hit = fsQuery_(cfg, 'patient_list', 'PttID', 'EQUAL', id, 1)[0];
  return hit ? recPatient_(cfg, hit._id) : null;
}

// "https://drive.google.com/file/d/<id>/view" or "...?id=<id>" -> "<id>"
function recDriveId_(link) {
  const s = String(link || '');
  const m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{20,})/.exec(s);
  return m ? m[1] : '';
}

// Can the account running this script rename the file?
function recCanEdit_(f) {
  try {
    const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
    if (!me) return true; // can't tell: it will be tried
    const owner = f.getOwner();
    if (!owner) return true; // shared drive: tried on move
    if (String(owner.getEmail()).toLowerCase() === me) return true;
    return f.getEditors().some(function (u) { return String(u.getEmail()).toLowerCase() === me; });
  } catch (e) { return false; }
}

// The old patient's name swapped for the new one; if it isn't in the name, the new name is added on the end
function recNewFileName_(oldName, fromName, toName) {
  const ext = (String(oldName).match(/\.[A-Za-z0-9]{2,5}$/) || [''])[0];
  let base = ext ? oldName.slice(0, -ext.length) : String(oldName);
  const from = String(fromName || '').trim();
  const src = from.length >= 3 ? from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') : '';
  if (src && new RegExp(src, 'i').test(base)) base = base.replace(new RegExp(src, 'gi'), toName);
  else base = base + ' - ' + toName;
  return bankCleanName_(base, 180) + ext;
}

function recLegacyCheck_(def, rid) {
  const cfg = getConfig_();
  const rec = fsGetDoc_(cfg, def.col + '/' + encodeURIComponent(rid));
  if (!rec) return { ok: false, error: 'NOT_FOUND' };
  const link = String(rec[def.link] || '').trim();
  const fid = recDriveId_(link);
  let fileName = '';
  let canRename = false;
  if (fid) {
    try {
      const f = DriveApp.getFileById(fid);
      fileName = f.getName();
      canRename = recCanEdit_(f);
    } catch (e) { console.warn('Record PDF not reachable (' + fid + '): ' + e); }
  }
  return {
    ok: true, hasLink: !!link, fileFound: !!fileName, fileName: fileName, canRename: canRename,
    moves: Array.isArray(rec.moves) ? rec.moves.length : 0,
  };
}

function recMoveLegacy_(def, kind, rid, body, session) {
  const toId = String(body.toPatientId || '').trim();
  const fromHint = String(body.fromPatientId || '').trim();
  const reason = MOVE_REASONS_[body.reason] ? String(body.reason) : '';
  const note = String(body.note || '').trim().slice(0, 500);
  if (!reason) return { ok: false, error: 'NO_REASON' };
  if (reason === 'other' && !note) return { ok: false, error: 'NO_NOTE' };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'BUSY' };
  try {
    const cfg = getConfig_();
    const path = def.col + '/' + encodeURIComponent(rid);
    const rec = fsGetDoc_(cfg, path);
    if (!rec) return { ok: false, error: 'NOT_FOUND' };
    const to = recPatient_(cfg, toId);
    if (!to) return { ok: false, error: 'NO_PATIENT' };
    if (to.mergedInto) return { ok: false, error: 'MERGED' };

    // Rows matched by name only have no Patient ID: the patient page it was moved from is used instead
    const curPid = String(rec['Patient ID'] || '').trim();
    const fromPid = curPid || fromHint;
    if (fromPid && (fromPid === to.id || fromPid === to.pttId)) return { ok: false, error: 'SAME_PATIENT' };
    const from = fromPid ? recPatientAny_(cfg, fromPid) : null;
    const fromName = String(rec['Patient Name'] || (from && from.name) || '');

    const now = new Date().toISOString();
    const move = {
      at: now, by: String(session.name || ''), byUid: String(session.uid || ''),
      fromId: from ? from.id : fromPid, fromPttId: from ? from.pttId : curPid, fromName: fromName,
      toId: to.id, toPttId: to.pttId, toName: to.name,
      reason: reason, reasonText: MOVE_REASONS_[reason], note: note,
    };

    fsPatch_(cfg, path, {
      'Patient ID': to.pttId,
      'Patient Name': to.name,
      moves: (Array.isArray(rec.moves) ? rec.moves : []).concat([move]).slice(-20),
      movedAt: now,
    });

    // The PDF can't be changed, only renamed. The record has already moved if this fails.
    let file = 'none';
    let fileName = '';
    let oldFileName = '';
    const fid = recDriveId_(rec[def.link]);
    if (fid) {
      try {
        const f = DriveApp.getFileById(fid);
        oldFileName = f.getName();
        fileName = recNewFileName_(oldFileName, fromName, to.name);
        if (fileName !== oldFileName) { f.setName(fileName); file = 'renamed'; }
        else file = 'unchanged';
      } catch (e) {
        console.warn('Record ' + rid + ' moved, but its PDF was not renamed: ' + e);
        file = 'failed';
        fileName = '';
      }
    }

    try {
      commitWrites_(cfg, [updateWrite_(cfg, 'record_moves/m_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), Object.assign({
        kind: 'legacy-' + kind, collection: def.col, recordId: rid, recordRef: String(rec['Record ID'] || ''),
        templateName: String(rec[def.title] || ''), recordDate: String(rec['Record Date'] || ''),
        fileId: fid, file: file, oldFileName: oldFileName, fileName: fileName,
      }, move))]);
    } catch (e) { console.warn('Record moved, but the move log failed: ' + e); }

    console.log(def.col + '/' + rid + ' moved from ' + fromName + ' to ' + to.name + ' by ' + move.by + ' (PDF: ' + file + ')');
    return { ok: true, move: move, file: file, fileName: fileName };
  } finally {
    lock.releaseLock();
  }
}

// ===================== Patient list: a fast-loading index =====================
// The Patient List reads these few documents instead of every patient, then asks Firestore only for
// patients added or edited since (UpdatedAt / CreatedAt). Rebuilt every morning. The portal falls back
// to reading every patient if the index is missing or more than 3 days old.

const PATIENT_INDEX_FIELDS_ = ['PttID', 'First Name', 'Last Name', 'Patient Name', 'NameKey', 'Email', 'Mobile',
  'Address', 'DobKey', 'DOB', 'Medicare Number', 'Medicare IRN', 'Medicare Expiry', 'MergedIds', 'MergedNames', 'MergedInto',
  'Marketing OK'];
const PATIENT_INDEX_PART_ = 400000; // characters per document (Firestore's limit is 1 MiB)

function buildPatientIndex() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { console.log('Another job is running. Patient index skipped.'); return; }
  try {
    const cfg = getConfig_();
    const builtAt = new Date().toISOString(); // taken BEFORE reading, so nothing saved meanwhile is missed
    const rows = fsListAll_(cfg, 'patient_list', PATIENT_INDEX_FIELDS_).map(function (d) {
      const f = fromFields_(d.fields || {});
      const out = {};
      PATIENT_INDEX_FIELDS_.forEach(function (k) {
        const v = f[k];
        if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return;
        out[k] = v;
      });
      return JSON.stringify([d.name.split('/').pop(), out]);
    });
    if (!rows.length) throw new Error('patient_list came back empty. Index not changed.');

    const parts = [];
    let cur = [];
    let size = 2;
    rows.forEach(function (r) {
      if (cur.length && size + r.length + 1 > PATIENT_INDEX_PART_) { parts.push('[' + cur.join(',') + ']'); cur = []; size = 2; }
      cur.push(r);
      size += r.length + 1;
    });
    if (cur.length) parts.push('[' + cur.join(',') + ']');

    const build = Utilities.getUuid();
    const old = fsGetDoc_(cfg, 'patient_index/meta');
    const writes = parts.map(function (data, i) {
      return updateWrite_(cfg, 'patient_index/p' + i, { build: build, data: data });
    });
    for (let i = parts.length; i < Number((old && old.parts) || 0); i++) writes.push(deleteWrite_(cfg, 'patient_index/p' + i));
    writes.push(updateWrite_(cfg, 'patient_index/meta', {
      build: build, parts: parts.length, count: rows.length, builtAt: builtAt,
    }));
    commitWrites_(cfg, writes, 500); // one commit, so the portal never sees half a build
    console.log('Patient index: ' + rows.length + ' patients in ' + parts.length + ' part(s).');
  } finally {
    lock.releaseLock();
  }
}

// Run ONCE from the editor: builds the index now, then every morning around 5am
function installPatientIndex() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'buildPatientIndex'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('buildPatientIndex').timeBased().everyDays(1).atHour(5).create();
  buildPatientIndex();
  console.log('Patient index installed (daily, about 5am).');
}

// ===================== Email flows: the runner =====================
// runScheduledTasks (every 15 minutes) calls runEmailFlows_. Three triggers start live flows:
//  · purchase: new purchases from the invoice sync (one run per patient, product and invoice)
//  · visit: each morning after 9 am, the day before's visits from the appointment book (one run per visit)
//  · daily: each morning after 9 am, every patient on the pre-consult list is checked against the flow's rules
// Runs are saved in email_flow_runs with fixed IDs, so nothing starts twice. Each run moves through its cards:
// patient emails go out between 9 am and 6 pm Perth; waits set the next time.
// While a flow is testing, every email goes to the person who turned it on, marked [Test].
// Rules use the fields in FLOW_FIELD_TYPE_, the same keys as js/flow-rules.js.

const FLOW_RUNS_ = 'email_flow_runs';
const FLOW_STATE_ = 'email_flow_state';
const FLOW_LOOKBACK_DAYS_ = 3;
const FLOW_HOURS_ = [9, 18];
const FLOW_STEPS_PER_RUN_ = 12;
const FLOW_CONDS_ = {
  in_ssp: 'The product is in their Skin Script', has_ssp: 'They have an active Skin Script',
  marketing: 'They agreed to marketing emails', first_buy: "It's the first time they've bought this product",
  booked: 'They have an upcoming appointment', rules: 'Your own rules',
};
const FLOW_TOKEN_RE_ = /\{\s*([A-Za-z][A-Za-z ]{0,40}?)\s*\}/g;
const FLOW_FIELD_TYPE_ = {
  'buy.product': 'products', 'buy.first': 'bool', 'buy.in_ssp': 'bool', 'buy.sold_by': 'text',
  'visit.service': 'text', 'visit.staff': 'text',
  'hist.bought': 'products', 'hist.times': 'number', 'hist.days_since': 'number',
  'appt.has_future': 'bool', 'appt.next_days': 'number', 'appt.last_days': 'number', 'appt.visits': 'number',
  'appt.future_service': 'text', 'appt.past_service': 'text',
  'appt.visit_between': 'range', 'appt.last_between': 'range',
  'ssp.active': 'bool', 'ssp.age_days': 'number', 'ssp.expiry_days': 'number',
  'plan.status': 'choice', 'plan.due': 'bool', 'plan.overdue': 'bool',
  'form.saved': 'form',
  'pt.age': 'number', 'pt.email': 'bool', 'pt.mobile': 'bool', 'pt.marketing': 'bool',
};
// How much reading a rule needs (cheapest checked first, so most patients are ruled out quickly)
const FLOW_RULE_COST_ = {
  'buy.product': 0, 'buy.sold_by': 0, 'visit.service': 0, 'visit.staff': 0,
  'appt.has_future': 0, 'appt.next_days': 0, 'appt.last_days': 0, 'appt.visits': 0, 'appt.future_service': 0, 'appt.past_service': 0,
  'appt.last_between': 0, 'appt.visit_between': 1,
  'pt.age': 1, 'pt.email': 1, 'pt.mobile': 1, 'pt.marketing': 1,
  'buy.first': 2, 'hist.bought': 2, 'hist.times': 2, 'hist.days_since': 2, 'plan.status': 2, 'plan.due': 2, 'plan.overdue': 2, 'form.saved': 2,
  'buy.in_ssp': 3, 'ssp.active': 3, 'ssp.age_days': 3, 'ssp.expiry_days': 3,
};

/* ---------- Small helpers ---------- */

function flowNorm_(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
// "Hydrating Serum" matches "Hydrating Serum 30ml", but "Serum" doesn't match "Serum Booster"
function flowSameProduct_(a, b) {
  a = flowNorm_(a); b = flowNorm_(b);
  if (!a || !b) return false;
  if (a === b) return true;
  const s = a.length < b.length ? a : b;
  const l = a.length < b.length ? b : a;
  return s.length >= 4 && l.indexOf(s + ' ') === 0;
}
// A visit matches if any of its services contains one of the words (no words: any visit)
function flowVisitServicesOk_(words, services) {
  const w = (Array.isArray(words) ? words : []).map(flowNorm_).filter(Boolean);
  if (!w.length) return true;
  return (Array.isArray(services) ? services : []).some(function (s) {
    const n = flowNorm_(s);
    return w.some(function (x) { return n.indexOf(x) !== -1; });
  });
}
function flowKey_(ms) { return Utilities.formatDate(new Date(ms), REC_TZ_, 'yyyy-MM-dd'); }
function flowPerthMin_() { const p = new Date(Date.now() + SCH_PERTH_); return p.getUTCHours() * 60 + p.getUTCMinutes(); }
function flowPart_(s) { return String(s || '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'x'; }
function flowHash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(s), Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('').slice(0, 16);
}
// Whole days from one "yyyy-MM-dd" to another (negative if b is earlier), or null
function flowDays_(a, b) {
  const pa = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(a || ''));
  const pb = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(b || ''));
  if (!pa || !pb) return null;
  return Math.round((Date.UTC(+pb[1], +pb[2] - 1, +pb[3]) - Date.UTC(+pa[1], +pa[2] - 1, +pa[3])) / 86400000);
}
function flowAddMonthsKey_(key, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
  return m ? Utilities.formatDate(new Date(Date.UTC(+m[1], +m[2] - 1 + n, +m[3], 12)), 'UTC', 'yyyy-MM-dd') : '';
}
function flowAddDaysKey_(key, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(key || ''));
  return m ? Utilities.formatDate(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n, 12)), 'UTC', 'yyyy-MM-dd') : '';
}
function flowWaitText_(c) {
  const n = Math.max(1, Math.floor(Number(c.num) || 1));
  const u = String(c.unit || 'days');
  return n + ' ' + (n === 1 ? u.replace(/s$/, '') : u);
}
// Now if it's between 9 am and 6 pm Perth, otherwise the next 9 am
function flowSendWindow_(ms) {
  const p = new Date(ms + SCH_PERTH_);
  const h = p.getUTCHours();
  if (h >= FLOW_HOURS_[0] && h < FLOW_HOURS_[1]) return ms;
  let day = schDayNum_(p.getUTCFullYear(), p.getUTCMonth() + 1, p.getUTCDate());
  if (h >= FLOW_HOURS_[1]) day++;
  return schSlotMs_(schFromNum_(day), pad2_(FLOW_HOURS_[0]) + ':00');
}
function flowAddWait_(ms, c) {
  const n = Math.max(1, Math.floor(Number(c.num) || 1));
  if (c.unit === 'months') {
    const d = new Date(ms + SCH_PERTH_);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.getTime() - SCH_PERTH_;
  }
  return ms + n * (c.unit === 'weeks' ? 7 : 1) * 86400000;
}

/* ---------- Finding cards (If / else paths join again after the If / else) ---------- */

function flowFind_(list, id, parents) {
  parents = parents || [];
  list = Array.isArray(list) ? list : [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!s) continue;
    if (s.id === id) return { list: list, i: i, parents: parents };
    if (s.type === 'branch') {
      const c = s.cfg || {};
      const up = parents.concat([{ list: list, i: i }]);
      const r = flowFind_(c.yes, id, up) || flowFind_(c.no, id, up);
      if (r) return r;
    }
  }
  return null;
}
function flowAfter_(loc) {
  if (loc.i + 1 < loc.list.length) return loc.list[loc.i + 1];
  for (let k = loc.parents.length - 1; k >= 0; k--) {
    const p = loc.parents[k];
    if (p.i + 1 < p.list.length) return p.list[p.i + 1];
  }
  return null;
}

/* ---------- The patient, their Skin Script, their bookings ---------- */

// A patient by doc ID or PttID, following a merge to the record that was kept
function flowPatient_(cfg, id) {
  id = String(id || '').trim();
  if (!recDocIdOk_(id)) return null;
  let pid = id;
  let doc = fsGetDoc_(cfg, 'patient_list/' + encodeURIComponent(id));
  if (!doc) {
    const hit = fsQuery_(cfg, 'patient_list', 'PttID', 'EQUAL', id, 1)[0];
    if (!hit) return null;
    pid = hit._id;
    doc = hit;
  }
  for (let i = 0; i < 4 && doc.MergedInto && String(doc.MergedInto) !== pid; i++) {
    const next = String(doc.MergedInto);
    const d = fsGetDoc_(cfg, 'patient_list/' + encodeURIComponent(next));
    if (!d) break;
    pid = next;
    doc = d;
  }
  doc._id = pid;
  return doc;
}
function flowWho_(doc) {
  const name = String(doc['Patient Name'] || ((doc['First Name'] || '') + ' ' + (doc['Last Name'] || '')).trim());
  return { name: name, first: String(doc['First Name'] || name.split(' ')[0] || ''),
    email: String(doc.Email || '').trim(), mobile: recMobile_(doc.Mobile) };
}

// Upcoming bookings (same matching as js/upcoming-appts.js), one per date + time: [{ date, time, services }]
function flowFuture_(cfg, doc, memo) {
  if (!memo.appt) {
    const today = flowKey_(Date.now());
    const t = today.split('-').map(Number);
    const end = Utilities.formatDate(new Date(Date.UTC(t[0], t[1] - 1 + 12, t[2], 12)), 'UTC', 'yyyy-MM-dd');
    const p = new Date(Date.now() + SCH_PERTH_);
    memo.appt = { today: today, nowMin: p.getUTCHours() * 60 + p.getUTCMinutes(), days: schedApptDays_(cfg, today, end) };
  }
  const ids = {};
  [doc._id, doc.PttID].concat(Array.isArray(doc.MergedIds) ? doc.MergedIds : []).forEach(function (x) {
    x = String(x == null ? '' : x).trim().toLowerCase();
    if (x) ids[x] = true;
  });
  const names = {};
  [doc['Patient Name'], (doc['First Name'] || '') + ' ' + (doc['Last Name'] || '')]
    .concat(Array.isArray(doc.MergedNames) ? doc.MergedNames : [])
    .forEach(function (n) { n = schedNorm_(n); if (n) names[n] = true; });
  const byKey = {};
  memo.appt.days.forEach(function (d) {
    const key = String(d.date || '');
    (d.appointments || []).forEach(function (a) {
      const aid = String(a.patientId || '').trim().toLowerCase();
      const mine = aid ? !!ids[aid] : !!names[schedNorm_(a.patientName)];
      if (!mine || SCHED_CANCELLED_.test(String(a.status || ''))) return;
      const mins = Number(a.sortMinutes);
      if (key === memo.appt.today && isFinite(mins) && mins < memo.appt.nowMin) return;
      const time = String(a.time || '').trim();
      const k = key + '|' + time;
      const row = byKey[k] || (byKey[k] = { date: key, time: time, sort: isFinite(mins) ? mins : 0, services: [] });
      (a.services || []).forEach(function (s) {
        s = String(s || '').trim();
        if (s && row.services.indexOf(s) === -1) row.services.push(s);
      });
    });
  });
  return Object.keys(byKey).map(function (k) { return byKey[k]; })
    .sort(function (x, y) { return x.date.localeCompare(y.date) || x.sort - y.sort; });
}
// The same bookings as "date|time" keys (for the "They book an appointment" stop rule)
function flowUpcoming_(cfg, doc, memo) {
  return flowFuture_(cfg, doc, memo).map(function (a) { return a.date + '|' + a.time; });
}

// Their newest Skin Script: portal protocols (they say who made them) or older ones from the SSP sheet
function flowSsp_(cfg, doc, memo) {
  const none = { active: false, date: '', expires: '', clinician: '', clinicianUid: '', items: [] };
  if (!doc || !doc._id) return none;
  const today = flowKey_(Date.now());
  if (memo.sspMonths === undefined) {
    memo.sspMonths = 12;
    try { const s = fsGetDoc_(cfg, 'form_settings/ssp'); if (s && Number(s.validMonths) > 0) memo.sspMonths = Number(s.validMonths); }
    catch (e) { /* 12 months */ }
  }
  const t = today.split('-').map(Number);
  const cutoff = Utilities.formatDate(new Date(Date.UTC(t[0], t[1] - 1 - memo.sspMonths, t[2], 12)), 'UTC', 'yyyy-MM-dd');

  let best = null;
  uniq_([String(doc._id)].concat(Array.isArray(doc.MergedIds) ? doc.MergedIds.map(String) : [])).slice(0, 6).forEach(function (id) {
    fsQuery_(cfg, 'ssp_records', 'patientId', 'EQUAL', id, 50).forEach(function (r) {
      if (!best || String(r.recordDate || '') > String(best.recordDate || '')) best = r;
    });
  });
  const key = docId_(doc.PttID || doc._id);
  const sk = key ? fsGetDoc_(cfg, 'skincare/' + encodeURIComponent(key)) : null;
  const old = ((sk && Array.isArray(sk.protocols)) ? sk.protocols : [])
    .filter(function (p) { return /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')); })
    .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })[0] || null;

  if (best && (!old || String(best.recordDate || '') >= String(old.date))) {
    const vu = String(best.validUntil || '').slice(0, 10);
    const hasVu = /^\d{4}-\d{2}-\d{2}$/.test(vu);
    const rd = String(best.recordDate || '');
    return {
      active: hasVu ? vu >= today : rd >= cutoff,
      date: rd, expires: hasVu ? vu : flowAddMonthsKey_(rd, memo.sspMonths),
      clinician: String(best.createdBy || ''), clinicianUid: String(best.createdByUid || ''),
      items: (Array.isArray(best.items) ? best.items : []).map(function (it) {
        return {
          name: String(it.name || ''), key: String(it.step || ''), step: SSP_STEP_LABEL_[it.step] || String(it.step || ''),
          am: it.am ? String(it.amText || '') : '', pm: it.pm ? String(it.pmText || '') : '',
          proto: it.am && it.pm ? 'AM & PM' : it.am ? 'AM' : it.pm ? 'PM' : '',
          when: [Array.isArray(it.days) ? it.days.join(', ') : '', String(it.notes || '')].filter(Boolean).join(' · '),
        };
      }),
    };
  }
  if (old) {
    return {
      active: old.date >= cutoff, date: old.date, expires: flowAddMonthsKey_(old.date, memo.sspMonths),
      clinician: '', clinicianUid: '',
      items: (old.items || []).map(function (it) {
        return {
          name: String(it.product || ''), key: sspParseSteps_(it.step)[0] || '', step: String(it.step || ''),
          am: String(it.am || ''), pm: String(it.pm || ''), proto: String(it.protocol || ''), when: String(it.whenToUse || ''),
        };
      }),
    };
  }
  return none;
}

// A published Skin Script catalogue product matching the name (for "How to use", shop links and the catalogue-only trigger)
function flowProduct_(cfg, memo, name) {
  if (!memo.products) {
    memo.products = fsListAll_(cfg, 'ssp_products', ['name', 'defaultInstruction', 'published', 'shopLink'])
      .map(function (d) { return fromFields_(d.fields || {}); })
      .filter(function (p) { return p.name && p.published !== false; });
  }
  return memo.products.filter(function (p) { return flowSameProduct_(p.name, name); })[0] || null;
}

// Everything the cards and rules need to know about one patient. Each part is only read when it's needed.
function flowCtx_(cfg, run, memo) {
  memo.pts = memo.pts || {};
  if (!(run.patientId in memo.pts)) memo.pts[run.patientId] = flowPatient_(cfg, run.patientId);
  const doc = memo.pts[run.patientId];
  if (!doc) return null;
  const once = {};
  const lazy = function (k, fn) { return function () { if (!(k in once)) once[k] = fn(); return once[k]; }; };
  const ctx = { doc: doc, pid: doc._id, who: flowWho_(doc), memo: memo, _f: {} };
  ctx.ssp = lazy('ssp', function () { return flowSsp_(cfg, doc, memo); });
  ctx.future = lazy('future', function () { return flowFuture_(cfg, doc, memo); });
  ctx.upcoming = lazy('up', function () { return ctx.future().map(function (a) { return a.date + '|' + a.time; }); });
  ctx.visits = lazy('visits', function () {
    const key = docId_(doc.PttID || doc._id);
    const pre = key ? fsGetDoc_(cfg, 'pcn_results/' + encodeURIComponent(key)) : null;
    return pre ? planVisits_(pre, [], flowKey_(Date.now())).filter(function (v) { return !v.future; }) : [];
  });
  ctx.plan = lazy('plan', function () { return fsGetDoc_(cfg, 'plan_progress/' + encodeURIComponent(doc._id)); });
  ctx.forms = lazy('forms', function () { return fsQuery_(cfg, 'form_submissions', 'patientId', 'EQUAL', doc._id, 300); });
  return ctx;
}

// For the daily check: the visits come straight from the pre-consult row, and the patient record is only
// read if a rule needs it (or they match). Same shape as flowCtx_.
function flowLazyCtx_(cfg, pre, memo) {
  memo.pts = memo.pts || {};
  const sid = String(pre.patientId || '').trim();
  const today = flowKey_(Date.now());
  const once = {};
  const lazy = function (k, fn) { return function () { if (!(k in once)) once[k] = fn(); return once[k]; }; };
  const blankDoc = { _id: '' };
  const loadDoc = lazy('doc', function () {
    if (!(sid in memo.pts)) memo.pts[sid] = flowPatient_(cfg, sid);
    return memo.pts[sid] || blankDoc;
  });
  const ctx = { memo: memo, _f: {} };
  Object.defineProperty(ctx, 'doc', { get: loadDoc });
  Object.defineProperty(ctx, 'pid', { get: function () { return loadDoc()._id; } });
  Object.defineProperty(ctx, 'who', { get: lazy('who', function () { return flowWho_(loadDoc()); }) });
  const all = lazy('all', function () { return planVisits_(pre, [], today); });
  ctx.visits = lazy('visits', function () { return all().filter(function (v) { return !v.future; }); });
  ctx.future = lazy('future', function () {
    return all().filter(function (v) { return v.future; }).map(function (v) { return { date: v.dateKey, time: '', services: v.services }; });
  });
  ctx.upcoming = lazy('up', function () { return ctx.future().map(function (a) { return a.date + '|'; }); });
  ctx.ssp = lazy('ssp', function () { return flowSsp_(cfg, loadDoc(), memo); });
  ctx.plan = lazy('plan', function () { const d = loadDoc(); return d._id ? fsGetDoc_(cfg, 'plan_progress/' + encodeURIComponent(d._id)) : null; });
  ctx.forms = lazy('forms', function () { const d = loadDoc(); return d._id ? fsQuery_(cfg, 'form_submissions', 'patientId', 'EQUAL', d._id, 300) : []; });
  return ctx;
}

// Their invoice purchases (skincare/{key}.purchases)
function flowPurchases_(cfg, run, ctx) {
  if (ctx._buys) return ctx._buys;
  const key = run.sourceKey || docId_(ctx.doc.PttID || ctx.doc._id);
  const sk = key ? fsGetDoc_(cfg, 'skincare/' + encodeURIComponent(key)) : null;
  ctx._buys = (sk && Array.isArray(sk.purchases)) ? sk.purchases : [];
  return ctx._buys;
}

/* ---------- Rules ---------- */

// One fact about the patient (or this purchase / visit), worked out once per run
function flowFact_(cfg, key, run, ctx) {
  if (key in ctx._f) return ctx._f[key];
  if (String(key).indexOf('rc.') === 0) { ctx._f[key] = recallFact_(cfg, key, run, ctx); return ctx._f[key]; }
  const today = flowKey_(Date.now());
  let v = null;
  switch (key) {
    case 'buy.product': v = String(run.product || ''); break;
    case 'buy.sold_by': v = String(run.soldBy || ''); break;
    case 'buy.first':
      v = !!run.product && !flowPurchases_(cfg, run, ctx).some(function (p) {
        return flowSameProduct_(p.product, run.product) && String(p.date || '') < String(run.purchaseDate || '');
      });
      break;
    case 'buy.in_ssp': {
      const s = ctx.ssp();
      v = !!run.product && s.active && s.items.some(function (it) { return flowSameProduct_(it.name, run.product); });
      break;
    }
    case 'visit.service': {
      // Daily checks and campaigns have no "this visit": their most recent visit is used
      if (Array.isArray(run.visitServices) && run.visitServices.length) v = run.visitServices;
      else if (run.kind === 'daily' || run.kind === 'campaign') { const p = ctx.visits(); v = p.length ? p[p.length - 1].services : []; }
      else v = [];
      break;
    }
    case 'visit.staff': v = Array.isArray(run.visitStaff) ? run.visitStaff : []; break;
    case 'hist.bought': v = flowPurchases_(cfg, run, ctx).map(function (p) { return String(p.product || ''); }); break;
    case 'hist.times': v = run.product ? flowPurchases_(cfg, run, ctx).filter(function (p) { return flowSameProduct_(p.product, run.product); }).length : 0; break;
    case 'hist.days_since': {
      const when = String(run.purchaseDate || today);
      const prev = flowPurchases_(cfg, run, ctx).map(function (p) { return String(p.date || ''); })
        .filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && d < when; }).sort().pop();
      v = prev ? flowDays_(prev, when) : Infinity;
      break;
    }
    case 'appt.has_future': v = ctx.future().length > 0; break;
    case 'appt.next_days': { const n = ctx.future()[0]; v = n ? flowDays_(today, n.date) : Infinity; break; }
    case 'appt.future_service': v = [].concat.apply([], ctx.future().map(function (a) { return a.services; })); break;
    case 'appt.last_days': { const p = ctx.visits(); v = p.length ? flowDays_(p[p.length - 1].dateKey, today) : Infinity; break; }
    case 'appt.visits': v = ctx.visits().length; break;
    case 'appt.past_service': v = [].concat.apply([], ctx.visits().map(function (x) { return x.services; })); break;
    case 'ssp.active': v = ctx.ssp().active; break;
    case 'ssp.age_days': { const s = ctx.ssp(); v = s.date ? flowDays_(s.date, today) : null; break; }
    case 'ssp.expiry_days': { const s = ctx.ssp(); v = s.expires ? flowDays_(today, s.expires) : null; break; }
    case 'plan.status': { const p = ctx.plan(); v = p ? String(p.effStatus || p.status || 'none') : 'none'; break; }
    case 'plan.due':
    case 'plan.overdue': {
      const p = ctx.plan();
      const states = key === 'plan.due' ? ['due', 'overdue'] : ['overdue'];
      v = !!(p && Array.isArray(p.lines) && p.lines.some(function (l) {
        return states.indexOf(String(l.state || '')) !== -1 && ['active', 'maintenance'].indexOf(String(l.concernStatus || 'active')) !== -1;
      }));
      break;
    }
    case 'pt.age': { const a = recAge_(ctx.doc.DobKey, today); v = a === '' ? null : Number(a); break; }
    case 'pt.email': v = isEmail_(ctx.who.email); break;
    case 'pt.mobile': v = String(ctx.doc.Mobile || '').replace(/\D/g, '').length >= 8; break;
    case 'pt.marketing': v = mktCanEmail_(cfg, ctx.doc, ctx.who.email); break;
  }
  ctx._f[key] = v;
  return v;
}

function flowRuleOk_(cfg, r, run, ctx) {
  const type = FLOW_FIELD_TYPE_[r && r.field];
  if (!type) return false;
  if (type === 'names' || r.field === 'rc.due_between') return recallRuleOk_(cfg, r, run, ctx);
  if (type === 'birthday') return flowBirthdayOk_(cfg, r, run, ctx);
  if (type === 'year') return flowBirthYearOk_(cfg, r, run, ctx);
  if (type === 'prange') return flowBoughtBetweenOk_(cfg, r, run, ctx);
  if (type === 'form') {
    const want = flowNorm_(r.value);
    if (!want) return false;
    const days = Number(r.days) || 0;
    const today = flowKey_(Date.now());
    const has = ctx.forms().some(function (s) {
      if (flowNorm_(s.templateName).indexOf(want) === -1) return false;
      if (!days) return true;
      const d = flowDays_(String(s.recordDate || ''), today);
      return d !== null && d <= days;
    });
    return r.op === 'none' ? !has : has;
  }
  if (type === 'range') {
    const from = String(r.from || '');
    const to = String(r.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return false;
    let has;
    if (r.field === 'appt.last_between') {
      const p = ctx.visits();
      const last = p.length ? p[p.length - 1].dateKey : '';
      has = !!last && last >= from && last <= to;
    } else {
      has = flowVisitedIn_(cfg, ctx, from, to);
    }
    return r.op === 'no' ? !has : has;
  }
  const v = flowFact_(cfg, r.field, run, ctx);
  if (type === 'bool') return r.op === 'no' ? v !== true : v === true;
  if (type === 'number') {
    const n = Number(r.value);
    if (v === null || v === undefined || r.value === '' || !isFinite(n)) return false;
    return r.op === 'lt' ? v < n : r.op === 'eq' ? v === n : v > n;
  }
  if (type === 'text') {
    const want = flowNorm_(r.value);
    if (!want) return false;
    const has = (Array.isArray(v) ? v : [v]).some(function (x) { return flowNorm_(x).indexOf(want) !== -1; });
    return r.op === 'not_contains' ? !has : has;
  }
  if (type === 'products') {
    const wanted = Array.isArray(r.value) ? r.value : [];
    if (!wanted.length) return false;
    const has = (Array.isArray(v) ? v : [v]).some(function (x) {
      return wanted.some(function (w) { return flowSameProduct_(x, w); });
    });
    return r.op === 'none' ? !has : has;
  }
  if (type === 'choice') return r.op === 'not' ? v !== String(r.value) : v === String(r.value);
  return false;
}

// Did this patient have a visit between two dates? From the appointment book (every visit, not only recent ones).
// The visits in that range are read once per run and remembered. Cancelled and no-shows don't count.
function flowVisitedIn_(cfg, ctx, from, to) {
  const today = flowKey_(Date.now());
  if (to > today) to = today;
  if (from > to) return false;
  const memo = ctx.memo;
  memo.vset = memo.vset || {};
  const key = from + '|' + to;
  let set = memo.vset[key];
  if (!set) {
    set = { ids: {}, names: {} };
    let start = from;
    for (let page = 0; page < 30 && start <= to; page++) {
      const days = schedApptDays_(cfg, start, to, 150);
      days.forEach(function (d) {
        (d.appointments || []).forEach(function (a) {
          if (SCHED_CANCELLED_.test(String(a.status || ''))) return;
          const id = String(a.patientId || '').trim().toLowerCase();
          if (id) set.ids[id] = true;
          else { const n = schedNorm_(a.patientName); if (n) set.names[n] = true; }
        });
      });
      if (days.length < 150) break;
      start = flowAddDaysKey_(String(days[days.length - 1].date), 1);
    }
    memo.vset[key] = set;
  }
  const doc = ctx.doc;
  if (!doc || !doc._id) return false;
  const ids = [doc._id, doc.PttID].concat(Array.isArray(doc.MergedIds) ? doc.MergedIds : []);
  if (ids.some(function (x) { x = String(x == null ? '' : x).trim().toLowerCase(); return x && set.ids[x]; })) return true;
  const names = [doc['Patient Name'], (doc['First Name'] || '') + ' ' + (doc['Last Name'] || '')]
    .concat(Array.isArray(doc.MergedNames) ? doc.MergedNames : []);
  return names.some(function (n) { n = schedNorm_(n); return n && set.names[n]; });
}

// A set of rules: all (or any) of them. No rules at all counts as a match. Cheapest rules are checked first.
// An item with its own "rules" is a group (one level), checked with its own all / any. Empty groups are ignored.
function flowGroupOk_(cfg, g, run, ctx) {
  const isGroup = function (x) { return !!x && Array.isArray(x.rules); };
  const rules = (g && Array.isArray(g.rules) ? g.rules : []).filter(function (x) { return x && (!isGroup(x) || x.rules.length); });
  if (!rules.length) return true;
  const cost = function (x) { return isGroup(x) ? 4 : (FLOW_RULE_COST_[x.field] || 3); };
  rules.sort(function (a, b) { return cost(a) - cost(b); });
  const ok = function (x) { return isGroup(x) ? flowGroupOk_(cfg, x, run, ctx) : flowRuleOk_(cfg, x, run, ctx); };
  return g.match === 'any' ? rules.some(ok) : rules.every(ok);
}

function flowHasRules_(g) { return !!(g && Array.isArray(g.rules) && g.rules.length); }

// If / else. c is the card's settings (or an older card's condition name).
function flowCond_(cfg, c, run, ctx) {
  const cond = typeof c === 'string' ? c : String((c && c.cond) || '');
  if (cond === 'rules') return flowGroupOk_(cfg, c && c.rules, run, ctx);
  if (cond === 'has_ssp') return flowFact_(cfg, 'ssp.active', run, ctx) === true;
  if (cond === 'in_ssp') return flowFact_(cfg, 'buy.in_ssp', run, ctx) === true;
  if (cond === 'booked') return flowFact_(cfg, 'appt.has_future', run, ctx) === true;
  if (cond === 'first_buy') return flowFact_(cfg, 'buy.first', run, ctx) === true;
  if (cond === 'marketing') return flowFact_(cfg, 'pt.marketing', run, ctx) === true;
  return false;
}
function flowCondLabel_(c) { return FLOW_CONDS_[(c && c.cond) || ''] || String((c && c.cond) || ''); }

// Why the trigger wouldn't start this flow for this purchase / visit / patient, or ''
function flowTriggerWhyNot_(cfg, flow, run, ctx, memo) {
  const t = flow.trigger || {};
  const ev = t.event || 'purchase';
  if (ev === 'purchase') {
    if (t.scope === 'catalogue' && !flowProduct_(cfg, memo, run.product)) return "it isn't a Skin Script catalogue product";
    if (t.scope === 'list' && !(Array.isArray(t.products) ? t.products : []).some(function (n) { return flowSameProduct_(n, run.product); })) {
      return "it isn't one of the flow's chosen products";
    }
  }
  if (ev === 'visit' && t.serviceScope === 'some' && !flowVisitServicesOk_(t.services, run.visitServices)) {
    return "the visit wasn't for one of the flow's chosen services";
  }
  if (ev === 'daily' && !flowHasRules_(t.rules)) return 'the daily check has no rules yet';
  if (flowHasRules_(t.rules) && !flowGroupOk_(cfg, t.rules, run, ctx)) {
    return ev === 'daily' ? "the patient doesn't match the daily check today" : "the patient doesn't match the start rules";
  }
  return '';
}

/* ---------- Filling in the blanks ---------- */

function flowVals_(cfg, run, ctx, memo, forStaff) {
  const w = ctx.who;
  const s = ctx.ssp();
  const item = s.active && run.product ? s.items.filter(function (it) { return flowSameProduct_(it.name, run.product); })[0] : null;
  const prod = run.product ? flowProduct_(cfg, memo, run.product) : null;
  const how = String((prod && prod.defaultInstruction) || '').trim() ||
    (item ? [item.am && 'Morning: ' + item.am, item.pm && 'Evening: ' + item.pm].filter(Boolean).join('\n') : '');
  return {
    'first name': w.first, 'full name': w.name, 'patient name': w.name, 'patient mobile': w.mobile, 'patient email': w.email,
    'product name': String(run.product || ''), 'purchase date': recLongDate_(run.purchaseDate) || String(run.purchaseDate || ''),
    'sold by': String(run.soldBy || ''), 'how to use': how,
    'visit date': run.visitDate ? (recLongDate_(run.visitDate) || run.visitDate) : '',
    'visit services': (Array.isArray(run.visitServices) ? run.visitServices : []).join(', '),
    'visit staff': (Array.isArray(run.visitStaff) ? run.visitStaff : []).join(' and '),
    'ssp step': item ? item.step : '', 'am instructions': item ? item.am : '', 'pm instructions': item ? item.pm : '',
    'when to use': item ? item.when : '',
    'ssp clinician': s.clinician || (forStaff ? 'Not recorded' : 'our team'),
    'ssp date': s.date ? (recLongDate_(s.date) || s.date) : '',
    'ssp expiry date': s.expires ? (recLongDate_(s.expires) || s.expires) : '',
  };
}
function flowFillBase_(text, vals, html) {
  return String(text || '').replace(FLOW_TOKEN_RE_, function (m, k) {
    const key = k.toLowerCase().replace(/\s+/g, ' ');
    if (!(key in vals)) return m;
    const v = String(vals[key] == null ? '' : vals[key]);
    return html ? invEsc_(v).replace(/\n/g, '<br>') : v;
  });
}
// Blanks inside links are made URL-safe; everywhere else they're filled as text
function flowFillHtmlBase_(html, vals) {
  const links = String(html || '').replace(/(\shref\s*=\s*")([^"]*)(")/gi, function (m, a, url, c) {
    return a + url.replace(FLOW_TOKEN_RE_, function (t, k) {
      const key = k.toLowerCase().replace(/\s+/g, ' ');
      return key in vals ? encodeURIComponent(String(vals[key] || '')) : t;
    }) + c;
  });
  return flowFill_(links, vals, true);
}

/* ---------- Sending ---------- */

function flowTester_(uid) {
  const s = getStaffDocs_().filter(function (x) { return x.id === uid; })[0];
  return s && isEmail_(s.email) ? { name: String(s.name || ''), email: s.email } : null;
}
function flowTestBanner_(flowName, text) {
  return '<div style="margin:0 0 12px;padding:10px 14px;border:1px dashed #f59e0b;border-radius:10px;background:#fffbeb;' +
    'color:#92400e;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5"><strong>Test from the email flow “' +
    invEsc_(flowName) + '”.</strong> ' + invEsc_(text) + '</div>';
}
function flowLog_(cfg, flow, run, ctx, category, recips, subject, html) {
  try {
    commitWrites_(cfg, [updateWrite_(cfg, 'task_runs/run_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20), {
      taskId: String(flow._id || ''), taskName: 'Email flow: ' + String(flow.name || ''), category: category,
      patientId: ctx.pid, patientName: ctx.who.name, recipients: recips, cc: '', subject: subject,
      html: String(html || '').slice(0, 100000), attachments: [],
      sentAt: new Date().toISOString(), sentBy: 'Email flow', sentByUid: '', flow: true, flowRunId: String(run._id || ''),
    })]);
  } catch (e) { console.warn('Flow email sent, but the history log failed: ' + e); }
}

// The patient email (finished in the portal; only the patient's blanks are filled here)
function flowSendPatient_(cfg, flow, step, run, ctx, memo, tester) {
  const c = step.cfg || {};
  if (!String(c.html || '').trim()) {
    const e = new Error('Open this flow in Email flows so it saves once, then it can send.');
    e.final = true;
    throw e;
  }
  const vals = flowVals_(cfg, run, ctx, memo, false);
  let body = String(c.html);
  if (FLOW_SSP_TABLE_RE_().test(body)) body = flowInsertSspTable_(body, flowSspTableHtml_(cfg, ctx, memo, (flow.style || {}).accent));
  let html = sanitizeEmailHtml_(flowFillHtml_(body, vals), c.mode === 'html');
  if (c.promo) html += mktFooterHtml_(tester ? '' : ctx.pid, tester ? tester.email : ctx.who.email, tester ? 'test' : 'flow_' + flow._id);
  let subject = flowFill_(String(c.subject || '').replace(FLOW_SSP_TABLE_RE_(), ''), vals, false)
    .replace(/\s+/g, ' ').trim().slice(0, 200) || 'A message from Dermedica';
  let to = ctx.who.email;
  if (tester) {
    html = flowTestBanner_(flow.name, 'This would have gone to ' + ctx.who.name +
      (isEmail_(to) ? ' <' + to + '>' : ' (no email on their record)') + '.' +
      (c.promo ? " It's promotional, so it isn't sent to anyone on the do-not-contact list." : '')) + html;
    subject = '[Test] ' + subject;
    to = tester.email;
  }
  if (!isEmail_(to)) { const e = new Error("There's no email address for " + (ctx.who.name || 'the patient') + '.'); e.final = true; throw e; }
  const inlined = inlineTaskImages_(cfg, html);
  const mail = { to: to, subject: subject, htmlBody: inlined.html, body: emailHtmlToText_(inlined.html), name: 'Dermedica Clinic' };
  if (Object.keys(inlined.images).length) mail.inlineImages = inlined.images;
  MailApp.sendEmail(mail);
  if (!tester) flowLog_(cfg, flow, run, ctx, 'patient', [{ name: ctx.who.name, email: to }], subject, html);
  return to;
}

/* ---------- {Skin Script table}: the patient's most recent Skin Script ---------- */

const FLOW_SSP_TABLE_RE_ = function () { return /\{\s*skin script table\s*\}/gi; };
const FLOW_SSP_SUB_ = { A: 'Preparing your skin', B: 'Prevent & Correct', C: 'Hydrating', E: 'Sunscreen' };

// A blank on its own line: the whole paragraph becomes the table (a table can't sit inside a paragraph)
function flowInsertSspTable_(html, table) {
  const wrap = '(?:\\s|&nbsp;|<br\\s*\\/?>|<\\/?(?:span|strong|b|em|i|mark|u)\\b[^>]*>)*';
  const block = new RegExp('<p\\b[^>]*>' + wrap + '\\{\\s*skin script table\\s*\\}' + wrap + '<\\/p>', 'gi');
  return String(html || '').replace(block, function () { return table; })
    .replace(FLOW_SSP_TABLE_RE_(), function () { return table; });
}

function flowSspTableHtml_(cfg, ctx, memo, accent) {
  const s = ctx.ssp();
  const items = (s.items || []).filter(function (it) { return it.name; });
  if (!items.length) {
    return '<p style="margin:0 0 14px">We don\'t have a Skin Script on file for you yet. Reply to this email and we\'ll help you put one together.</p>';
  }
  const acc = /^#[0-9a-f]{3,8}$/i.test(String(accent || '')) ? accent : '#5fae96';

  // Grouped by step, in step order (A, Boost, B, C, D, E, F)
  const groups = [];
  const byKey = {};
  items.forEach(function (it) {
    const k = String(it.key || '').toUpperCase() || ('?' + it.step);
    if (!byKey[k]) { byKey[k] = { key: k, label: it.step || SSP_STEP_LABEL_[k] || '', items: [] }; groups.push(byKey[k]); }
    byKey[k].items.push(it);
  });
  const order = function (k) { const i = SSP_STEP_KEYS_.indexOf(k); return i === -1 ? 99 : i; };
  groups.sort(function (a, b) { return order(a.key) - order(b.key); });

  const cell = 'padding:14px 16px;border-top:1px solid #e5e7eb;vertical-align:top;';
  const rows = groups.map(function (g) {
    return g.items.map(function (it, j) {
      const prod = flowProduct_(cfg, memo, it.name);
      const link = prod && /^https:\/\/[^\s"'<>]+$/i.test(String(prod.shopLink || '')) ? String(prod.shopLink) : '';
      const name = link
        ? '<a href="' + invEsc_(link) + '" style="color:#1e293b;text-decoration:underline">' + invEsc_(it.name) + '</a>'
        : invEsc_(it.name);
      const sub = FLOW_SSP_SUB_[g.key] || '';
      return '<tr>' +
        (j === 0 ? '<td rowspan="' + g.items.length + '" style="' + cell + 'width:30%">' +
          '<strong style="font-size:14px;color:#0f172a">' + invEsc_(g.label || 'Other') + '</strong>' +
          (sub ? '<div style="margin-top:3px;font-size:12px;color:#64748b">' + invEsc_(sub) + '</div>' : '') + '</td>' : '') +
        '<td style="' + cell + '"><span style="color:' + acc + '">&#8226;</span>&nbsp;&nbsp;' + name + '</td>' +
        '<td style="' + cell + 'white-space:nowrap;width:22%">' + invEsc_(it.proto || '') + '</td>' +
        '</tr>';
    }).join('');
  }).join('');

  return '<div style="margin:18px 0;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
      'style="width:100%;border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#1e293b">' +
    '<tr style="background:' + acc + '">' +
      '<th align="left" style="padding:12px 16px;color:#fff;font-size:13px;font-weight:700">Step</th>' +
      '<th align="left" style="padding:12px 16px;color:#fff;font-size:13px;font-weight:700">Product Name</th>' +
      '<th align="left" style="padding:12px 16px;color:#fff;font-size:13px;font-weight:700">Protocol</th></tr>' +
    rows + '</table></div>';
}

// Who a Notify staff card goes to. No Skin Script clinician (or seller) found: the Admins.
function flowStaffTo_(step, run, ctx) {
  const c = step.cfg || {};
  const all = getStaffDocs_().filter(function (s) { return s.active !== false && isEmail_(s.email); });
  let list = [];
  if (c.to === 'ssp_creator') {
    const uid = ctx.ssp().clinicianUid;
    list = all.filter(function (s) { return uid && s.id === uid; });
  } else if (c.to === 'sold_by') {
    const n = flowNorm_(run.soldBy || (Array.isArray(run.visitStaff) ? run.visitStaff[0] : ''));
    list = all.filter(function (s) { return n && flowNorm_(s.name) === n; });
  } else if (c.to === 'roles') {
    const roles = (c.roles || []).map(function (r) { return String(r).toLowerCase(); });
    list = all.filter(function (s) { return roles.indexOf(String(s.role || '').toLowerCase()) !== -1; });
  } else if (c.to === 'staff') {
    const ids = (c.staffIds || []).map(String);
    list = all.filter(function (s) { return ids.indexOf(s.id) !== -1; });
  }
  if (!list.length && (c.to === 'ssp_creator' || c.to === 'sold_by')) {
    list = all.filter(function (s) { return /^admin$/i.test(String(s.role || '')); });
  }
  return list.slice(0, 20).map(function (s) { return { name: String(s.name || ''), email: s.email }; });
}
function flowSendStaff_(cfg, flow, step, run, ctx, memo, tester) {
  const c = step.cfg || {};
  const vals = flowVals_(cfg, run, ctx, memo, true);
  const intended = flowStaffTo_(step, run, ctx);
  const subject0 = flowFill_(c.subject, vals, false).replace(/\s+/g, ' ').trim().slice(0, 200) || 'Email flow: ' + flow.name;
  let inner = '<h2 style="margin:0 0 10px;font-size:19px;color:#0f766e">' + invEsc_(subject0) + '</h2>' +
    '<p style="margin:0">' + invEsc_(flowFill_(c.message, vals, false)).replace(/\n/g, '<br>') + '</p>' +
    '<p style="margin:14px 0 0;font-size:13px;color:#64748b">From the email flow “' + invEsc_(flow.name) + '”.</p>';
  let subject = subject0;
  let to = intended;
  if (tester) {
    inner = flowTestBanner_(flow.name, 'This would have gone to ' +
      (intended.map(function (x) { return x.name; }).join(', ') || 'nobody (no staff match)') + '.') + inner;
    subject = '[Test] ' + subject;
    to = [tester];
  }
  if (!to.length) return [];
  const html = invEmailWrap_(inner, 'patient/' + encodeURIComponent(ctx.pid), "Open the patient's page");
  MailApp.sendEmail({ to: to.map(function (x) { return x.email; }).join(','), name: 'Dermedica Portal',
    subject: subject, htmlBody: html, body: emailHtmlToText_(html) });
  if (!tester) flowLog_(cfg, flow, run, ctx, 'staff', to, subject, html);
  return intended;
}

/* ---------- Stop rules ---------- */

function flowStopWhy_(cfg, flow, run, ctx, testing) {
  if (!testing && !isEmail_(ctx.who.email)) return "There's no email address on their record.";
  const st = flow.stop || {};
  if (st.booking === true) {
    const before = {};
    (run.apptKeys || []).forEach(function (k) { before[k] = true; });
    if (ctx.upcoming().some(function (k) { return !before[k]; })) return 'They booked an appointment.';
  }
  if (flowHasRules_(st.rules) && flowGroupOk_(cfg, st.rules, run, ctx)) return "One of the flow's stop rules matched.";
  return '';
}
// At most one automatic email to a patient every X days, across all flows (test emails don't count)
function flowGapUntil_(cfg, flow, ctx) {
  const days = Number((flow.stop || {}).gapDays) || 0;
  if (days <= 0) return 0;
  let last = 0;
  fsQuery_(cfg, FLOW_RUNS_, 'patientId', 'EQUAL', ctx.pid, 200).forEach(function (r) {
    if (r.mode === 'test') return;
    const t = Date.parse(String(r.lastEmailAt || ''));
    if (t > last) last = t;
  });
  return last ? last + days * 86400000 : 0;
}

/* ---------- Held patients: never start this flow (and stop it if they're in it) ---------- */

const FLOW_HOLDS_ = 'email_flow_holds';   // Apps Script only; the portal reads it through op "holds"
function flowHoldId_(flowId, pid) { return flowPart_(flowId) + '__' + flowPart_(pid); }
function flowHoldSet_(cfg, flowId) {
  const s = {};
  fsQuery_(cfg, FLOW_HOLDS_, 'flowId', 'EQUAL', flowId, 2000).forEach(function (h) { if (h.patientId) s[h.patientId] = true; });
  return s;
}
// Remembered for the rest of this run
function flowHeld_(cfg, memo, flowId, pid) {
  memo.holds = memo.holds || {};
  if (!(flowId in memo.holds)) {
    try { memo.holds[flowId] = flowHoldSet_(cfg, flowId); }
    catch (e) { console.warn('Holds not read for ' + flowId + ': ' + e); memo.holds[flowId] = {}; }
  }
  return !!(pid && memo.holds[flowId][pid]);
}

/* ---------- The 15-minute run ---------- */

function runEmailFlows_(cfg, deadline) {
  const flows = fsQuery_(cfg, 'email_flows', 'status', 'EQUAL', 'live', 50);
  const byId = {};
  flows.forEach(function (f) { byId[f._id] = f; });
  const memo = {};
  if (flows.length) {
    try { flowEnrol_(cfg, flows, memo); } catch (e) { console.error('Email flows, purchases: ' + (e && e.stack ? e.stack : e)); }
    try { flowEnrolVisits_(cfg, flows, memo); } catch (e) { console.error('Email flows, visits: ' + (e && e.stack ? e.stack : e)); }
    // The daily check leaves at least 90 seconds for sending
    try { flowDailyChecks_(cfg, flows, memo, deadline - 90000); } catch (e) { console.error('Email flows, daily check: ' + (e && e.stack ? e.stack : e)); }
  }
  const gone = {};
  fsQuery_(cfg, FLOW_RUNS_, 'status', 'EQUAL', 'active', 500)
    .filter(function (r) { return Number(r.dueAt || 0) <= Date.now(); })
    .sort(function (a, b) { return Number(a.dueAt || 0) - Number(b.dueAt || 0); })
    .slice(0, 80)
    .forEach(function (r) {
      if (Date.now() > deadline) return; // the rest go next time
      const f = byId[r.flowId];
      if (!f) {
        // Turned off: the run waits until it's turned on again. Deleted: the run stops.
        if (!(r.flowId in gone)) {
          const d = fsGetDoc_(cfg, 'email_flows/' + r.flowId);
          gone[r.flowId] = !d || d.status === 'archived';
        }
        if (gone[r.flowId]) {
          fsPatch_(cfg, FLOW_RUNS_ + '/' + r._id, { status: 'stopped', reason: 'The flow was deleted.', next: '', updatedAt: new Date().toISOString() });
        }
        return;
      }
      try { flowStep_(cfg, f, r, memo, deadline); }
      catch (e) { flowFail_(cfg, f, r, e); }
    });
}

// A new run's fields (shared by the three triggers)
function flowNewRun_(f, doc, extra) {
  const now = new Date().toISOString();
  return Object.assign({
    flowId: f._id, flowName: String(f.name || ''), kind: 'purchase', product: '', purchaseDate: '', invoiceId: '', soldBy: '',
    visitDate: '', visitServices: [], visitStaff: [], sourceKey: '', sourceId: '',
    patientId: doc._id, patientName: flowWho_(doc).name, status: 'active', reason: '',
    next: String(f.steps[0].id || ''), dueAt: Date.now(),
    mode: f.sendMode === 'real' ? 'real' : 'test', testUid: String(f.testUid || f.updatedByUid || ''),
    apptKeys: [], events: [], startedAt: now, updatedAt: now, attempts: 0, sent: 0, lastError: '',
  }, extra);
}

// New purchases from the invoice sync → new runs. Only checked when the sync has brought in new data.
function flowEnrol_(cfg, flows, memo) {
  const list = flows.filter(function (f) {
    return ((f.trigger || {}).event || 'purchase') === 'purchase' && Array.isArray(f.steps) && f.steps.length;
  });
  if (!list.length) return;
  const props = PropertiesService.getScriptProperties();
  const sig = String(props.getProperty('LAST_SYNCED_SSP_UPDATE') || '') + '|' +
    list.map(function (f) { return f._id + ':' + (f.liveAt || ''); }).sort().join(',');
  if (props.getProperty('FLOW_ENROL_SIG') === sig) return;

  const today = flowKey_(Date.now());
  const from = flowKey_(Date.now() - FLOW_LOOKBACK_DAYS_ * 86400000);
  const cand = [];
  fsListAll_(cfg, 'skincare', ['patientId', 'patientName', 'purchases']).forEach(function (d) {
    const sk = fromFields_(d.fields || {});
    sk._key = d.name.split('/').pop();
    if (!String(sk.patientId || '').trim()) return; // matched by name only: we can't be sure who it is
    (Array.isArray(sk.purchases) ? sk.purchases : []).forEach(function (p) {
      const date = String(p.date || '');
      const product = String(p.product || '').trim();
      if (!product || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > today) return;
      list.forEach(function (f) {
        const t = f.trigger || {};
        const liveMs = Date.parse(String(f.liveAt || ''));
        if (date < (liveMs ? flowKey_(liveMs) : today)) return; // bought before the flow was turned on
        // The cheap product checks first; the patient rules are checked once we know who they are
        if (t.scope === 'catalogue' && !flowProduct_(cfg, memo, product)) return;
        if (t.scope === 'list' && !(Array.isArray(t.products) ? t.products : []).some(function (n) { return flowSameProduct_(n, product); })) return;
        cand.push({
          id: flowPart_(f._id) + '__' + flowPart_(sk.patientId) + '__' + flowHash_([p.invoiceId, product, date].join('|')),
          dup: f._id + '|' + String(sk.patientId) + '|' + flowNorm_(product),
          f: f, sk: sk, p: p, date: date, product: product,
        });
      });
    });
  });
  if (!cand.length) { props.setProperty('FLOW_ENROL_SIG', sig); return; }

  // The same product bought twice in a few days: only the newest purchase starts the flow
  cand.sort(function (a, b) { return b.date.localeCompare(a.date); });
  const taken = {};
  const fresh = cand.filter(function (c) { if (taken[c.dup]) return false; taken[c.dup] = true; return true; });
  const have = fsBatchGet_(cfg, fresh.map(function (c) { return FLOW_RUNS_ + '/' + c.id; }));
  const writes = [];
  memo.pts = memo.pts || {};
  fresh.forEach(function (c) {
    if (have[FLOW_RUNS_ + '/' + c.id]) return; // already started
    const f = c.f;
    const now = new Date().toISOString();
    const sid = String(c.sk.patientId);
    if (!(sid in memo.pts)) memo.pts[sid] = flowPatient_(cfg, sid);
    const doc = memo.pts[sid];
    const base = {
      kind: 'purchase', product: c.product, purchaseDate: c.date,
      invoiceId: String(c.p.invoiceId || ''), soldBy: String(c.p.staff || ''), sourceKey: c.sk._key, sourceId: sid,
    };
    if (!doc) {
      writes.push(updateWrite_(cfg, FLOW_RUNS_ + '/' + c.id, Object.assign({
        flowId: f._id, flowName: String(f.name || ''), patientId: '', patientName: String(c.sk.patientName || ''),
        status: 'skipped', reason: 'No matching patient in the Patient List.', next: '', dueAt: 0, mode: '', events: [],
        startedAt: now, updatedAt: now, attempts: 0, sent: 0, lastError: '',
      }, base)));
      return;
    }
    memo.pts[doc._id] = doc;
    if (flowHeld_(cfg, memo, f._id, doc._id)) return;
    // "Only start for patients who…": not a match means no run at all
    const trun = Object.assign({ patientId: doc._id }, base);
    if (flowHasRules_((f.trigger || {}).rules)) {
      const tctx = flowCtx_(cfg, trun, memo);
      if (!tctx || !flowGroupOk_(cfg, f.trigger.rules, trun, tctx)) return;
    }
    const earlier = fsQuery_(cfg, FLOW_RUNS_, 'patientId', 'EQUAL', doc._id, 100).filter(function (r) {
      return r.flowId === f._id && r.status === 'active' && flowSameProduct_(r.product, c.product);
    });
    if (earlier.length && (f.stop || {}).rebuy === false) {
      writes.push(updateWrite_(cfg, FLOW_RUNS_ + '/' + c.id, flowNewRun_(f, doc, Object.assign({}, base, {
        status: 'skipped', reason: 'Already in this flow for this product.', next: '', dueAt: 0, mode: '',
      }))));
      return;
    }
    // Bought it again: the earlier run stops, and this one starts from the top
    earlier.forEach(function (r) {
      writes.push(patchWrite_(cfg, FLOW_RUNS_ + '/' + r._id, {
        status: 'stopped', reason: 'Bought it again, so the flow started over.', next: '', updatedAt: now,
      }));
    });
    writes.push(updateWrite_(cfg, FLOW_RUNS_ + '/' + c.id, flowNewRun_(f, doc, Object.assign({}, base, {
      apptKeys: (f.stop || {}).booking === true ? flowUpcoming_(cfg, doc, memo) : [],
      events: [{ at: now, what: 'Started: bought ' + c.product + ' on ' + (recLongDate_(c.date) || c.date) }],
    }))));
  });
  if (writes.length) commitWrites_(cfg, writes, 100);
  props.setProperty('FLOW_ENROL_SIG', sig); // only after the runs are saved, so a failure is tried again
  console.log('Email flows: ' + writes.length + ' purchase run(s) started or updated.');
}

// Yesterday's (and any missed) visits → new runs. Each morning after 9 am, each day looked at once per flow.
function flowEnrolVisits_(cfg, flows, memo) {
  const list = flows.filter(function (f) {
    return (f.trigger || {}).event === 'visit' && Array.isArray(f.steps) && f.steps.length;
  });
  if (!list.length || flowPerthMin_() < 9 * 60) return;
  const props = PropertiesService.getScriptProperties();
  const today = flowKey_(Date.now());
  const yest = flowAddDaysKey_(today, -1);
  const floor = flowAddDaysKey_(today, -FLOW_LOOKBACK_DAYS_);
  memo.pts = memo.pts || {};

  list.forEach(function (f) {
    const pk = 'FLOW_VISITS_' + f._id;
    const liveAt = String(f.liveAt || '');
    let st = {};
    try { st = JSON.parse(props.getProperty(pk) || '{}'); } catch (e) { st = {}; }
    if (st.liveAt !== liveAt) st = { liveAt: liveAt, done: '' };
    const liveMs = Date.parse(liveAt);
    let from = liveMs ? flowKey_(liveMs) : today;  // visits from the day it was turned on
    if (from < floor) from = floor;
    if (st.done && st.done >= from) from = flowAddDaysKey_(st.done, 1);
    if (from > yest) return;

    const t = f.trigger || {};
    // Visits (one per patient per day): services and staff merged, cancelled and DNA left out
    const visits = {};
    schedApptDays_(cfg, from, yest).forEach(function (d) {
      const key = String(d.date || '');
      (d.appointments || []).forEach(function (a) {
        if (SCHED_CANCELLED_.test(String(a.status || ''))) return;
        const pid = String(a.patientId || '').trim();
        if (!pid) return; // no Patient ID: we can't be sure who it is
        const k = key + '|' + pid;
        const v = visits[k] || (visits[k] = { date: key, pid: pid, services: [], staff: [] });
        (a.services || []).forEach(function (s) { s = String(s || '').trim(); if (s && v.services.indexOf(s) === -1) v.services.push(s); });
        const who = String(a.staff || '').trim();
        if (who && !SCHED_NOT_PERSON_.test(who) && v.staff.indexOf(who) === -1) v.staff.push(who);
      });
    });
    const cand = Object.keys(visits).map(function (k) { return visits[k]; }).filter(function (v) {
      return t.serviceScope !== 'some' || flowVisitServicesOk_(t.services, v.services);
    });
    if (cand.length) {
      const ids = cand.map(function (v) { return flowPart_(f._id) + '__' + flowPart_(v.pid) + '__v' + v.date.replace(/-/g, ''); });
      const have = fsBatchGet_(cfg, ids.map(function (id) { return FLOW_RUNS_ + '/' + id; }));
      const writes = [];
      cand.forEach(function (v, i) {
        if (have[FLOW_RUNS_ + '/' + ids[i]]) return;
        if (!(v.pid in memo.pts)) memo.pts[v.pid] = flowPatient_(cfg, v.pid);
        const doc = memo.pts[v.pid];
        if (!doc) return;
        memo.pts[doc._id] = doc;
        if (flowHeld_(cfg, memo, f._id, doc._id)) return;
        const base = {
          kind: 'visit', purchaseDate: v.date, visitDate: v.date, visitServices: v.services, visitStaff: v.staff,
          sourceKey: docId_(doc.PttID || doc._id), sourceId: v.pid,
        };
        const trun = Object.assign({ patientId: doc._id }, base);
        if (flowHasRules_(t.rules)) {
          const tctx = flowCtx_(cfg, trun, memo);
          if (!tctx || !flowGroupOk_(cfg, t.rules, trun, tctx)) return;
        }
        const now = new Date().toISOString();
        const earlier = fsQuery_(cfg, FLOW_RUNS_, 'patientId', 'EQUAL', doc._id, 100)
          .filter(function (r) { return r.flowId === f._id && r.status === 'active'; });
        if (earlier.length && (f.stop || {}).rebuy === false) return; // already in it, and "come in again" is off
        earlier.forEach(function (r) {
          writes.push(patchWrite_(cfg, FLOW_RUNS_ + '/' + r._id, {
            status: 'stopped', reason: 'Came in again, so the flow started over.', next: '', updatedAt: now,
          }));
        });
        writes.push(updateWrite_(cfg, FLOW_RUNS_ + '/' + ids[i], flowNewRun_(f, doc, Object.assign({}, base, {
          apptKeys: (f.stop || {}).booking === true ? flowUpcoming_(cfg, doc, memo) : [],
          events: [{ at: now, what: 'Started: visit on ' + (recLongDate_(v.date) || v.date) +
            (v.services.length ? ' (' + v.services.join(', ') + ')' : '') }],
        }))));
      });
      if (writes.length) commitWrites_(cfg, writes, 100);
      console.log('Email flows: ' + writes.length + ' visit run(s) for "' + f.name + '".');
    }
    st.done = yest;
    props.setProperty(pk, JSON.stringify(st));
  });
}

// Every patient on the pre-consult list, with their visit history, in ID order
function flowDailyPool_(cfg) {
  return fsListAll_(cfg, 'pcn_results', ['patientId', 'patientName'].concat(PLAN_VISIT_FIELDS_))
    .map(function (d) { const o = fromFields_(d.fields || {}); o._key = d.name.split('/').pop(); return o; })
    .filter(function (o) { return String(o.patientId || '').trim(); })
    .sort(function (a, b) { return a._key < b._key ? -1 : a._key > b._key ? 1 : 0; });
}

// The daily check. Each morning after 9 am, every patient is checked once; a big list carries on over the next runs.
// Patients who already matched when the flow was turned on are only noted (unless "Also start…" is ticked), so it
// starts people as they newly match. State per flow: email_flow_state/{flowId} (Apps Script only).
function flowDailyChecks_(cfg, flows, memo, budgetEnd) {
  const list = flows.filter(function (f) {
    return (f.trigger || {}).event === 'daily' && Array.isArray(f.steps) && f.steps.length && flowHasRules_(f.trigger.rules);
  });
  if (!list.length || flowPerthMin_() < 9 * 60) return;
  const today = flowKey_(Date.now());
  let pool = null;

  list.forEach(function (f) {
    if (Date.now() > budgetEnd) return;
    const t = f.trigger;
    const path = FLOW_STATE_ + '/' + f._id;
    let st = fsGetDoc_(cfg, path) || {};
    const liveAt = String(f.liveAt || '');
    if (st.liveAt !== liveAt) {
      st = { liveAt: liveAt, day: '', after: '', done: false, matched: [], baseline: [], ready: t.existing === true, started: 0 };
    }
    if (st.day !== today) {
      // A new day: anyone who stopped matching yesterday leaves the "already matched" list, so they can start later
      if (st.day && st.done && st.ready) {
        const m = {};
        (st.matched || []).forEach(function (k) { m[k] = true; });
        st.baseline = (st.baseline || []).filter(function (k) { return m[k]; });
      }
      st.day = today; st.after = ''; st.done = false; st.matched = []; st.started = 0;
    }
    if (st.done) return;

    if (!pool) pool = flowDailyPool_(cfg);
    const cap = Math.min(200, Math.max(1, Number(t.dailyMax) || 25));
    const base = {};
    (st.baseline || []).forEach(function (k) { base[k] = true; });
    const matched = (st.matched || []).slice();
    let started = Number(st.started || 0);
    let i = 0;
    while (i < pool.length && st.after && pool[i]._key <= st.after) i++;
    for (; i < pool.length; i++) {
      if (Date.now() > budgetEnd) break;
      const pre = pool[i];
      const ctx = flowLazyCtx_(cfg, pre, memo);
      const run = { patientId: '', kind: 'daily', product: '', purchaseDate: today, sourceKey: pre._key };
      let ok = false;
      try { ok = flowGroupOk_(cfg, t.rules, run, ctx); }
      catch (e) { console.warn('Daily check ' + f._id + ', ' + pre._key + ': ' + e); }
      st.after = pre._key;
      if (!ok) continue;
      matched.push(pre._key);
      if (!st.ready || base[pre._key] || started >= cap) continue;
      try { if (flowStartDaily_(cfg, f, pre, ctx, memo, today)) started++; }
      catch (e) { console.warn('Daily start ' + f._id + ', ' + pre._key + ': ' + e); }
    }
    const finished = i >= pool.length;
    st.matched = matched;
    st.started = started;
    st.done = finished;
    if (finished && !st.ready) { st.ready = true; st.baseline = matched.slice(); }
    st.updatedAt = new Date().toISOString();
    commitWrites_(cfg, [updateWrite_(cfg, path, st)]);
    console.log('Daily check "' + f.name + '": ' + (finished ? 'finished' : 'checked up to ' + st.after) +
      ', ' + matched.length + ' match so far, ' + started + ' started today.');
  });
}

// Starts a daily-check run for one patient, unless they're already in it (or were recently)
function flowStartDaily_(cfg, f, pre, ctx, memo, today) {
  const doc = ctx.doc;
  if (!doc || !doc._id) return false;
  if (flowHeld_(cfg, memo, f._id, doc._id)) return false;
  const t = f.trigger || {};
  const repeat = Math.max(0, Math.floor(Number(t.repeatDays) || 0));
  const mine = fsQuery_(cfg, FLOW_RUNS_, 'patientId', 'EQUAL', doc._id, 100)
    .filter(function (r) { return r.flowId === f._id && r.status !== 'skipped'; });
  if (mine.some(function (r) { return r.status === 'active'; })) return false;
  if (mine.length) {
    if (!repeat) return false;
    const last = Math.max.apply(null, mine.map(function (r) { return Date.parse(String(r.startedAt || '')) || 0; }));
    if (Date.now() - last < repeat * 86400000) return false;
  }
  const id = flowPart_(f._id) + '__' + flowPart_(pre._key) + '__d' + today.replace(/-/g, '');
  if (fsGetDoc_(cfg, FLOW_RUNS_ + '/' + id)) return false;
  const now = new Date().toISOString();
  commitWrites_(cfg, [updateWrite_(cfg, FLOW_RUNS_ + '/' + id, flowNewRun_(f, doc, {
    kind: 'daily', purchaseDate: today, sourceKey: pre._key, sourceId: String(pre.patientId || ''),
    apptKeys: (f.stop || {}).booking === true ? flowUpcoming_(cfg, doc, memo) : [],
    events: [{ at: now, what: 'Started: the daily check found them.' }],
  }))]);
  return true;
}

// Moves one run along. Progress is saved after every email, so a crash never sends one twice.
function flowStep_(cfg, flow, run, memo, deadline) {
  const path = FLOW_RUNS_ + '/' + run._id;
  const events = (Array.isArray(run.events) ? run.events : []).slice(-40);
  const note = function (what) { events.push({ at: new Date().toISOString(), what: String(what).slice(0, 240) }); };
  const save = function (extra) {
    fsPatch_(cfg, path, Object.assign({ events: events.slice(-40), attempts: 0, lastError: '', updatedAt: new Date().toISOString() }, extra));
  };

  const ctx = flowCtx_(cfg, run, memo);
  if (!ctx) { note('Stopped: the patient record is no longer there.'); save({ status: 'stopped', reason: 'The patient record is no longer there.', next: '' }); return; }
  if (flowHeld_(cfg, memo, flow._id, ctx.pid)) { note('Stopped: held for this flow.'); save({ status: 'stopped', reason: 'Held by staff.', next: '' }); return; }
  let tester = null;
  if (run.mode === 'test') {
    tester = flowTester_(run.testUid);
    if (!tester) {
      save({ status: 'failed', reason: 'Testing, but the person who turned the flow on has no email address in Staff.', next: '' });
      return;
    }
  }

  let next = String(run.next || '');
  let sent = Number(run.sent || 0);
  for (let n = 0; n < FLOW_STEPS_PER_RUN_; n++) {
    if (!next) { note('Finished.'); save({ status: 'done', reason: 'Finished.', next: '' }); return; }
    if (Date.now() > deadline) { save({ next: next, dueAt: Date.now() }); return; }
    const loc = flowFind_(flow.steps, next);
    if (!loc) {
      note('Stopped: the flow was changed and its next card was removed.');
      save({ status: 'stopped', reason: 'The flow was changed and its next card was removed.', next: '' });
      return;
    }
    const s = loc.list[loc.i];
    const c = s.cfg || {};
    const after = flowAfter_(loc);
    const afterId = after ? String(after.id || '') : '';

    if (s.type === 'stop') { note('Reached End flow.'); save({ status: 'done', reason: 'Reached End flow.', next: '' }); return; }

    if (s.type === 'wait') {
      if (!afterId) { note('Finished.'); save({ status: 'done', reason: 'Finished.', next: '' }); return; }
      const due = flowAddWait_(Date.now(), c);
      note('Waiting ' + flowWaitText_(c) + ' (until ' + Utilities.formatDate(new Date(due), REC_TZ_, 'd MMM yyyy') + ')');
      save({ next: afterId, dueAt: due });
      return;
    }

    if (s.type === 'branch') {
      const yes = flowCond_(cfg, c, run, ctx);
      note((yes ? 'Yes: ' : 'No: ') + flowCondLabel_(c));
      const pathList = (yes ? c.yes : c.no) || [];
      next = pathList.length ? String(pathList[0].id || '') : afterId;
      continue;
    }

    if (s.type === 'staff') {
      const to = flowSendStaff_(cfg, flow, s, run, ctx, memo, tester);
      note(to.length ? 'Staff emailed: ' + to.map(function (x) { return x.name; }).join(', ') + (tester ? ' (sent to you while testing)' : '')
        : 'Notify staff: nobody to email.');
      if (to.length) sent++;
      next = afterId;
      save({ next: next, sent: sent, dueAt: Date.now() });
      continue;
    }

    if (s.type === 'email') {
      const why = flowStopWhy_(cfg, flow, run, ctx, !!tester);
      if (why) { note('Stopped: ' + why); save({ status: 'stopped', reason: why, next: '' }); return; }
      if (c.promo && !tester && !mktCanEmail_(cfg, ctx.doc, ctx.who.email)) {
        note("Skipped a promotional email: they're on the do-not-contact list.");
        next = afterId;
        continue;
      }
      const skipDays = Math.max(0, Math.floor(Number(c.skipDays) || 0));
      if (skipDays) {
        const had = flowRecentSend_(cfg, flow, s, ctx.pid, run.mode === 'test' ? 'test' : 'real', skipDays);
        if (had) {
          note('Skipped “' + String(c.subject || '').slice(0, 120) + '”: they had it on ' + Utilities.formatDate(new Date(had), REC_TZ_, 'd MMM yyyy'));
          next = afterId;
          continue;
        }
      }
      if (!tester) {
        const gap = flowGapUntil_(cfg, flow, ctx);        
        if (gap > Date.now()) {
          note('Waiting: another automatic email went to them recently.');
          save({ next: next, dueAt: gap });
          return;
        }
      }
      const win = flowSendWindow_(Date.now());
      if (win > Date.now()) { save({ next: next, dueAt: win }); return; }
      if (MailApp.getRemainingDailyQuota() < 2) {
        note("The clinic's daily email limit was reached. Trying again later.");
        save({ next: next, dueAt: Date.now() + 3600000 });
        return;
      }
      const to = flowSendPatient_(cfg, flow, s, run, ctx, memo, tester);
      sent++;
      next = afterId;
      note('Emailed “' + String(c.subject || '').slice(0, 120) + '”' + (tester ? ' to ' + to + ' (testing)' : ''));
      run.sentCards = Object.assign({}, run.sentCards || {});
      run.sentCards[s.id] = new Date().toISOString();   // for "Don't send if they've had this email in the last…"
      save(Object.assign({ next: next, sent: sent, dueAt: Date.now(), sentCards: run.sentCards },
        tester ? {} : { lastEmailAt: new Date().toISOString() }));
      continue;
    }
    next = afterId; // a card type this version doesn't know
  }
  save({ next: next, dueAt: Date.now() }); // carries on next time
}

function flowFail_(cfg, flow, run, e) {
  const msg = String(e && e.message ? e.message : e).slice(0, 300);
  const attempts = Number(run.attempts || 0) + 1;
  const final = (e && e.final === true) || attempts >= 3;
  console.error('Email flow run ' + run._id + (final ? ' failed: ' : ' will retry: ') + msg);
  try {
    fsPatch_(cfg, FLOW_RUNS_ + '/' + run._id, final
      ? { status: 'failed', reason: msg, attempts: attempts, lastError: msg, updatedAt: new Date().toISOString() }
      : { attempts: attempts, lastError: msg, dueAt: Date.now() + 15 * 60000, updatedAt: new Date().toISOString() });
  } catch (e2) { console.error('Run not updated: ' + e2); }
  if (final) flowTellBuilder_(flow, run, msg);
}

function flowTellBuilder_(flow, run, msg) {
  try {
    const ids = uniq_([String(flow.testUid || ''), String(flow.createdByUid || '')]);
    const to = uniq_(getStaffDocs_().filter(function (s) { return ids.indexOf(s.id) !== -1 && isEmail_(s.email); })
      .map(function (s) { return s.email; }));
    if (!to.length || MailApp.getRemainingDailyQuota() < 1) return;
    const what = run.product ? ' (' + invEsc_(run.product) + ')' : run.visitDate ? ' (visit on ' + invEsc_(run.visitDate) + ')' : '';
    const html = invEmailWrap_(
      '<h2 style="margin:0 0 6px;font-size:20px;color:#b91c1c">An email flow couldn\'t send</h2>' +
      '<p style="margin:0 0 12px;color:#475569"><strong>' + invEsc_(flow.name) + '</strong> for ' +
        invEsc_(run.patientName || 'a patient') + what + '.</p>' +
      '<p style="margin:0;padding:10px 12px;border-radius:8px;background:#fef2f2;color:#991b1b">' + invEsc_(msg) + '</p>',
      'settings/flows/' + encodeURIComponent(flow._id), 'Open the flow');
    MailApp.sendEmail({ to: to.join(','), name: 'Dermedica Portal', subject: 'Email flow not sent: ' + flow.name,
      htmlBody: html, body: emailHtmlToText_(html) });
  } catch (e) { console.warn('Flow builder not told: ' + e); }
}

/* ---------- From the portal: test with a patient, who matches today, stop a run ---------- */

function handleEmailFlow_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'flows.build')) return { ok: false, error: 'FORBIDDEN' };
  const op = String(body.op || '');
  try {
    if (op === 'test') return flowTestRun_(body, session);
    if (op === 'preview') return flowPreview_(body, session);
    if (op === 'stopRun') return flowStopRun_(String(body.id || ''), session);
    if (op === 'hold') return flowHold_(body, session);
    if (op === 'release') return flowRelease_(body, session);
    if (op === 'holds') return flowHolds_(body);
    if (op === 'startNow') return flowStartNow_(body, session);
    if (op === 'restart') return flowRestart_(body, session);
    if (op === 'purchasePreview') return flowPurchasePreview_(body, session);
    if (op === 'startPurchase') return flowStartPurchase_(body, session);
  } catch (err) {
    console.error('Email flow ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

// The whole flow, now, for one patient. Waits are skipped; every email comes to the person testing.
function flowTestRun_(body, session) {
  const flowId = String(body.flowId || '');
  if (!/^[A-Za-z0-9_-]{5,60}$/.test(flowId)) return { ok: false, error: 'BAD_REQUEST' };
  const cfg = getConfig_();
  const flow = fsGetDoc_(cfg, 'email_flows/' + flowId);
  if (!flow || flow.status === 'archived') return { ok: false, error: 'NOT_FOUND' };
  flow._id = flowId;
  const ev = (flow.trigger || {}).event || 'purchase';
  const product = String(body.product || '').trim().slice(0, 150);
  if (ev === 'purchase' && !product) return { ok: false, error: 'NO_PRODUCT' };
  const services = String(body.services || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 10);
  const doc = flowPatient_(cfg, String(body.patientId || ''));
  if (!doc) return { ok: false, error: 'NO_PATIENT' };
  const me = flowTester_(session.uid);
  if (!me) return { ok: false, error: 'NO_EMAIL' };

  const cache = CacheService.getScriptCache();
  const rlKey = 'flowtest_' + session.uid;
  const used = Number(cache.get(rlKey) || 0);
  if (used >= 15) return { ok: false, error: 'RATE_LIMITED' };
  if (MailApp.getRemainingDailyQuota() < 10) return { ok: false, error: 'QUOTA' };
  cache.put(rlKey, String(used + 1), 3600);

  const memo = { pts: {} };
  memo.pts[doc._id] = doc;
  const today = flowKey_(Date.now());
  const run = {
    _id: 'test', flowId: flowId, kind: ev, product: ev === 'purchase' ? product : '', purchaseDate: today, invoiceId: 'test',
    soldBy: ev === 'purchase' ? String(session.name || '') : '',
    visitDate: ev === 'visit' ? today : '', visitServices: ev === 'visit' ? services : [],
    visitStaff: ev === 'visit' ? [String(session.name || '')] : [],
    sourceKey: docId_(doc.PttID || doc._id), patientId: doc._id, mode: 'test',
  };
  const ctx = flowCtx_(cfg, run, memo);
  run.apptKeys = ctx.upcoming();

  const steps = [];
  const whyNot = flowTriggerWhyNot_(cfg, flow, run, ctx, memo);
  steps.push(whyNot
    ? "Heads up: the real flow wouldn't start for them (" + whyNot + '). The test carries on so you can see the emails.'
    : 'The real flow would start for them.');
  let sent = 0;
  let ended = false;
  let next = Array.isArray(flow.steps) && flow.steps[0] ? String(flow.steps[0].id || '') : '';
  for (let n = 0; n < 60 && next; n++) {
    const loc = flowFind_(flow.steps, next);
    if (!loc) break;
    const s = loc.list[loc.i];
    const c = s.cfg || {};
    const after = flowAfter_(loc);
    const afterId = after ? String(after.id || '') : '';
    if (s.type === 'stop') { steps.push('End flow.'); ended = true; break; }
    if (s.type === 'wait') { steps.push('Wait ' + flowWaitText_(c) + ' (skipped in a test).'); next = afterId; continue; }
    if (s.type === 'branch') {
      const yes = flowCond_(cfg, c, run, ctx);
      steps.push('If / else: ' + flowCondLabel_(c) + ' → ' + (yes ? 'Yes' : 'No'));
      const pathList = (yes ? c.yes : c.no) || [];
      next = pathList.length ? String(pathList[0].id || '') : afterId;
      continue;
    }
    if (s.type === 'staff') {
      const to = flowSendStaff_(cfg, flow, s, run, ctx, memo, me);
      sent++;
      steps.push('Notify staff: would go to ' + (to.map(function (x) { return x.name; }).join(', ') || 'nobody') + '. Sent to you.');
      next = afterId;
      continue;
    }
    if (s.type === 'email') {
      const why = flowStopWhy_(cfg, flow, run, ctx, false);
      if (why) { steps.push('Stop rule: ' + why + ' The real flow would stop here.'); ended = true; break; }
      const sd = Math.max(0, Math.floor(Number(c.skipDays) || 0));
      const had = sd ? flowRecentSend_(cfg, flow, s, ctx.pid, 'real', sd) : 0;
      if (had) steps.push('Heads up: they had this email on ' + Utilities.formatDate(new Date(had), REC_TZ_, 'd MMM yyyy') +
        ', so the real flow would skip it. Sent to you anyway so you can see it.');

      flowSendPatient_(cfg, flow, s, run, ctx, memo, me);
      sent++;
      steps.push('Email “' + flowFill_(String(c.subject || '').replace(FLOW_SSP_TABLE_RE_(), ''), flowVals_(cfg, run, ctx, memo, false), false) + '”' +
        (c.promo ? ' (promotional: not sent to anyone on the do-not-contact list)' : '') + '. Sent to you.');
      next = afterId;
      continue;
    }
    next = afterId;
  }
  if (!ended) steps.push('Finished.');
  return { ok: true, to: me.email, sent: sent, steps: steps };
}

// "See who's next" for a daily check: everyone who matches today, and what happens to each of them (up to about 4 minutes)
function flowPreview_(body, session) {
  const flowId = String(body.flowId || '');
  if (!/^[A-Za-z0-9_-]{5,60}$/.test(flowId)) return { ok: false, error: 'BAD_REQUEST' };
  const cfg = getConfig_();
  const flow = fsGetDoc_(cfg, 'email_flows/' + flowId);
  if (!flow || flow.status === 'archived') return { ok: false, error: 'NOT_FOUND' };
  const t = flow.trigger || {};
  if (!flowHasRules_(t.rules)) return { ok: false, error: 'NO_RULES', detail: 'Add at least one rule first.' };

  const cache = CacheService.getScriptCache();
  const rlKey = 'flowpreview_' + session.uid;
  const used = Number(cache.get(rlKey) || 0);
  if (used >= 10) return { ok: false, error: 'RATE_LIMITED' };
  cache.put(rlKey, String(used + 1), 3600);

  const started = Date.now();
  const today = flowKey_(Date.now());
  const pool = flowDailyPool_(cfg);
  const memo = {};

  // Where each patient stands
  const live = flow.status === 'live';
  const st = fsGetDoc_(cfg, FLOW_STATE_ + '/' + flowId) || {};
  const sameRun = live && st.liveAt === String(flow.liveAt || '');
  const allBaseline = t.existing !== true && !(sameRun && st.ready);   // the first check would only note them
  const baseline = {};
  if (sameRun && st.ready) (st.baseline || []).forEach(function (k) { baseline[k] = true; });
  const repeat = Math.max(0, Math.floor(Number(t.repeatDays) || 0));
  const cap = Math.min(200, Math.max(1, Number(t.dailyMax) || 25));
  const runsBy = {};
  fsQuery_(cfg, FLOW_RUNS_, 'flowId', 'EQUAL', flowId, 3000).forEach(function (r) {
    if (r.status === 'skipped' || !r.patientId) return;
    const x = runsBy[r.patientId] || (runsBy[r.patientId] = { active: false, last: 0 });
    if (r.status === 'active') x.active = true;
    x.last = Math.max(x.last, Date.parse(String(r.startedAt || '')) || 0);
  });
  const held = flowHoldSet_(cfg, flowId);

  let checked = 0, count = 0, will = 0;
  const rows = [];
  for (let i = 0; i < pool.length; i++) {
    if (Date.now() - started > 240000) break;
    const pre = pool[i];
    const ctx = flowLazyCtx_(cfg, pre, memo);
    const run = { patientId: '', kind: 'daily', product: '', purchaseDate: today, sourceKey: pre._key };
    let ok = false;
    try { ok = flowGroupOk_(cfg, t.rules, run, ctx); } catch (e) { ok = false; }
    checked++;
    if (!ok) continue;
    count++;
    const d = ctx.doc;
    const pid = String(d._id || '');
    const name = (pid ? ctx.who.name : '') || String(pre.patientName || '');
    const x = runsBy[pid];
    let state, note = '';
    if (!pid) state = 'nopatient';
    else if (held[pid]) state = 'held';
    else if (x && x.active) state = 'active';
    else if (x && x.last && (!repeat || Date.now() - x.last < repeat * 86400000)) {
      state = 'done';
      note = repeat ? 'Can start again from ' + recLongDate_(flowKey_(x.last + repeat * 86400000)) + '.' : 'Each patient goes through it once.';
    } else if (allBaseline || baseline[pre._key]) {
      state = 'baseline';
      note = '"Also start patients who already match" is off, so they were only noted.';
    } else if (!isEmail_(ctx.who.email)) {
      state = 'noemail';
      note = 'While testing, their emails still come to you. Sending to patients, they are skipped.';
    } else { state = will < cap ? 'will' : 'later'; will++; }
    if (rows.length < 400) rows.push({ id: pid, name: name, state: state, note: note });
  }
  const order = ['will', 'later', 'baseline', 'active', 'done', 'noemail', 'held', 'nopatient'];
  rows.sort(function (a, b) { return order.indexOf(a.state) - order.indexOf(b.state) || String(a.name).localeCompare(String(b.name)); });
  return { ok: true, total: pool.length, checked: checked, count: count, partial: checked < pool.length,
    rows: rows, more: Math.max(0, count - rows.length), live: live, mode: flow.sendMode === 'real' ? 'real' : 'test' };
}

// Hold a patient: they never start this flow, and it stops for them now if they're in it
function flowHold_(body, session) {
  const flowId = String(body.flowId || '');
  if (!/^[A-Za-z0-9_-]{5,60}$/.test(flowId)) return { ok: false, error: 'BAD_REQUEST' };
  const cfg = getConfig_();
  const doc = flowPatient_(cfg, String(body.patientId || ''));
  if (!doc) return { ok: false, error: 'NO_PATIENT' };
  const now = new Date().toISOString();
  const who = String(session.name || 'staff');
  const writes = [updateWrite_(cfg, FLOW_HOLDS_ + '/' + flowHoldId_(flowId, doc._id), {
    flowId: flowId, patientId: doc._id, patientName: flowWho_(doc).name, note: String(body.note || '').slice(0, 200),
    by: who, byUid: String(session.uid || ''), at: now,
  })];
  let stopped = 0;
  fsQuery_(cfg, FLOW_RUNS_, 'patientId', 'EQUAL', doc._id, 200).forEach(function (r) {
    if (r.flowId !== flowId || r.status !== 'active') return;
    writes.push(patchWrite_(cfg, FLOW_RUNS_ + '/' + r._id, { status: 'stopped', reason: 'Held by ' + who + '.', next: '', updatedAt: now }));
    stopped++;
  });
  commitWrites_(cfg, writes);
  console.log('Flow ' + flowId + ': ' + flowWho_(doc).name + ' held by ' + who);
  return { ok: true, patientId: doc._id, stopped: stopped };
}

function flowRelease_(body, session) {
  const flowId = String(body.flowId || '');
  const pid = String(body.patientId || '');
  if (!/^[A-Za-z0-9_-]{5,60}$/.test(flowId) || !recDocIdOk_(pid)) return { ok: false, error: 'BAD_REQUEST' };
  const cfg = getConfig_();
  commitWrites_(cfg, [deleteWrite_(cfg, FLOW_HOLDS_ + '/' + flowHoldId_(flowId, pid))]);
  console.log('Flow ' + flowId + ': ' + pid + ' released by ' + session.name);
  return { ok: true };
}

function flowHolds_(body) {
  const flowId = String(body.flowId || '');
  if (!/^[A-Za-z0-9_-]{5,60}$/.test(flowId)) return { ok: false, error: 'BAD_REQUEST' };
  const list = fsQuery_(getConfig_(), FLOW_HOLDS_, 'flowId', 'EQUAL', flowId, 2000).map(function (h) {
    return { patientId: String(h.patientId || ''), patientName: String(h.patientName || ''), by: String(h.by || ''),
      at: String(h.at || ''), note: String(h.note || '') };
  }).sort(function (a, b) { return b.at.localeCompare(a.at); });
  return { ok: true, holds: list };
}

// Runs a new run's first cards straight away (emails still wait for 9 am to 6 pm)
function flowKick_(cfg, flow, ids, memo) {
  const deadline = Date.now() + 90000;
  ids.forEach(function (rid) {
    if (Date.now() > deadline) return;   // the 15-minute run picks up the rest
    const r = fsGetDoc_(cfg, FLOW_RUNS_ + '/' + rid);
    if (!r) return;
    r._id = rid;
    try { flowStep_(cfg, flow, r, memo, deadline); } catch (e) { flowFail_(cfg, flow, r, e); }
  });
}

// "Start now" from See who's next: daily-check flows only. The rules are checked again first.
function flowStartNow_(body, session) {
  const flowId = String(body.flowId || '');
  if (!/^[A-Za-z0-9_-]{5,60}$/.test(flowId)) return { ok: false, error: 'BAD_REQUEST' };
  const ids = uniq_((Array.isArray(body.patientIds) ? body.patientIds : []).map(String)).slice(0, 50);
  if (!ids.length) return { ok: false, error: 'BAD_REQUEST' };
  const cfg = getConfig_();
  const flow = fsGetDoc_(cfg, 'email_flows/' + flowId);
  if (!flow || flow.status !== 'live') return { ok: false, error: 'NOT_LIVE' };
  flow._id = flowId;
  if (((flow.trigger || {}).event || 'purchase') !== 'daily') return { ok: false, error: 'BAD_REQUEST' };
  if (!Array.isArray(flow.steps) || !flow.steps.length) return { ok: false, error: 'NOT_LIVE' };

  const lock = LockService.getScriptLock();   // so the 15-minute run can't step the same patients at the same time
  if (!lock.tryLock(30000)) return { ok: false, error: 'BUSY' };
  try {
    const memo = { pts: {} };
    const today = flowKey_(Date.now());
    const made = [];
    const skipped = [];
    ids.forEach(function (raw) {
      const doc = flowPatient_(cfg, raw);
      if (!doc) { skipped.push({ id: raw, name: '', why: 'not found' }); return; }
      memo.pts[doc._id] = doc;
      const name = flowWho_(doc).name;
      if (flowHeld_(cfg, memo, flowId, doc._id)) { skipped.push({ id: doc._id, name: name, why: 'held' }); return; }
      if (fsQuery_(cfg, FLOW_RUNS_, 'patientId', 'EQUAL', doc._id, 100).some(function (r) { return r.flowId === flowId && r.status === 'active'; })) {
        skipped.push({ id: doc._id, name: name, why: 'already in the flow' });
        return;
      }
      const run = { patientId: doc._id, kind: 'daily', product: '', purchaseDate: today, sourceKey: docId_(doc.PttID || doc._id) };
      const ctx = flowCtx_(cfg, run, memo);
      if (!ctx || !flowGroupOk_(cfg, flow.trigger.rules, run, ctx)) { skipped.push({ id: doc._id, name: name, why: "doesn't match the rules now" }); return; }
      const rid = flowPart_(flowId) + '__' + flowPart_(doc._id) + '__m' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
      commitWrites_(cfg, [updateWrite_(cfg, FLOW_RUNS_ + '/' + rid, flowNewRun_(flow, doc, {
        kind: 'daily', purchaseDate: today, sourceKey: run.sourceKey, sourceId: String(doc.PttID || doc._id),
        apptKeys: (flow.stop || {}).booking === true ? flowUpcoming_(cfg, doc, memo) : [],
        events: [{ at: new Date().toISOString(), what: 'Started now by ' + String(session.name || 'staff') + '.' }],
      }))]);
      made.push(rid);
    });
    flowKick_(cfg, flow, made, memo);
    console.log('Flow ' + flowId + ': ' + made.length + ' started now by ' + session.name);
    return { ok: true, started: made.length, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

// "Start again" on a finished, stopped or failed run: the same purchase, visit or daily check, from the first card
function flowRestart_(body, session) {
  const rid = String(body.runId || '');
  if (!/^[A-Za-z0-9_-]{5,200}$/.test(rid)) return { ok: false, error: 'BAD_REQUEST' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { ok: false, error: 'BUSY' };
  try {
    const cfg = getConfig_();
    const old = fsGetDoc_(cfg, FLOW_RUNS_ + '/' + rid);
    if (!old) return { ok: false, error: 'NOT_FOUND' };
    if (old.status === 'active') return { ok: false, error: 'NOT_FINISHED' };
    if (!old.patientId || !/^[A-Za-z0-9_-]{5,60}$/.test(String(old.flowId || ''))) return { ok: false, error: 'NO_PATIENT' };
    const flow = fsGetDoc_(cfg, 'email_flows/' + old.flowId);
    if (!flow || flow.status !== 'live' || !Array.isArray(flow.steps) || !flow.steps.length) return { ok: false, error: 'NOT_LIVE' };
    flow._id = String(old.flowId);
    const memo = { pts: {} };
    const doc = flowPatient_(cfg, String(old.patientId));
    if (!doc) return { ok: false, error: 'NO_PATIENT' };
    memo.pts[doc._id] = doc;
    if (flowHeld_(cfg, memo, flow._id, doc._id)) return { ok: false, error: 'HELD' };
    if (fsQuery_(cfg, FLOW_RUNS_, 'patientId', 'EQUAL', doc._id, 100).some(function (r) { return r.flowId === flow._id && r.status === 'active'; })) {
      return { ok: false, error: 'ALREADY' };
    }
    const nid = rid.replace(/__r[a-z0-9]+$/, '') + '__r' + Date.now().toString(36);
    commitWrites_(cfg, [updateWrite_(cfg, FLOW_RUNS_ + '/' + nid, flowNewRun_(flow, doc, {
      kind: String(old.kind || 'purchase'), product: String(old.product || ''), purchaseDate: String(old.purchaseDate || flowKey_(Date.now())),
      invoiceId: String(old.invoiceId || ''), soldBy: String(old.soldBy || ''), visitDate: String(old.visitDate || ''),
      visitServices: Array.isArray(old.visitServices) ? old.visitServices : [], visitStaff: Array.isArray(old.visitStaff) ? old.visitStaff : [],
      sourceKey: String(old.sourceKey || ''), sourceId: String(old.sourceId || ''),
      apptKeys: (flow.stop || {}).booking === true ? flowUpcoming_(cfg, doc, memo) : [],
      events: [{ at: new Date().toISOString(), what: 'Started again by ' + String(session.name || 'staff') + '.' }],
    }))]);
    flowKick_(cfg, flow, [nid], memo);
    return { ok: true, id: nid };
  } finally {
    lock.releaseLock();
  }
}

function flowStopRun_(id, session) {
  if (!/^[A-Za-z0-9_-]{5,200}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, error: 'BUSY' };
  try {
    const cfg = getConfig_();
    const r = fsGetDoc_(cfg, FLOW_RUNS_ + '/' + id);
    if (!r) return { ok: false, error: 'NOT_FOUND' };
    if (r.status !== 'active') return { ok: false, error: 'NOT_ACTIVE' };
    fsPatch_(cfg, FLOW_RUNS_ + '/' + id, {
      status: 'stopped', reason: 'Stopped by ' + String(session.name || 'staff') + '.', next: '', updatedAt: new Date().toISOString(),
    });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ===================== Staff tasks: to-dos from Task Manager =====================
// A staff task sent with "Add it to their task list" gives each person an open task in staff-task-list
// (the same list as patient-page reminders and My dashboard → Tasks). Done, notes, passing on and reopening
// go through here, so the person who assigned it is told, and only the right people can change it.

function staffTodoOpts_(t) {
  t = t || {};
  const due = String(t.due || '');
  return { on: t.on === true, due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : '' };
}

// One open task per person. Never stops the email from sending.
function staffTodoCreate_(cfg, o) {
  try {
    const now = new Date();
    const writes = (o.recipients || []).filter(function (r) { return r && r.id; }).map(function (r) {
      return updateWrite_(cfg, 'staff-task-list/t_' + Utilities.getUuid().replace(/-/g, '').slice(0, 20), {
        patientId: String(o.patientId || ''), patientName: String(o.patientName || ''),
        taskText: String(o.text || o.taskName || 'Task').replace(/\s+/g, ' ').trim().slice(0, 500) || 'Task',
        dueDate: String(o.due || ''), status: 'Open',
        assignedToId: String(r.id), assignedToName: String(r.name || ''),
        createdAt: now, createdBy: String(o.by || ''), createdByUid: String(o.byUid || ''),
        source: 'task', taskId: String(o.taskId || ''), taskName: String(o.taskName || ''), runId: String(o.runId || ''),
        notes: [], history: [{ at: now.toISOString(), by: String(o.by || ''), what: 'Assigned to ' + String(r.name || '') }],
      });
    });
    if (writes.length) commitWrites_(cfg, writes);
    return writes.length;
  } catch (e) {
    console.warn('Task sent, but the task list entries failed: ' + e);
    return 0;
  }
}

function staffTodoTell_(toUid, subject, heading, extraHtml, t) {
  try {
    const s = getStaffDocs_().filter(function (x) { return x.id === toUid; })[0];
    if (!s || s.active === false || !isEmail_(s.email) || MailApp.getRemainingDailyQuota() < 1) return;
    const html = invEmailWrap_(
      '<h2 style="margin:0 0 6px;font-size:20px;color:#0f766e">' + invEsc_(heading) + '</h2>' +
      '<p style="margin:0 0 12px;color:#475569"><strong>' + invEsc_(t.taskText || 'Task') + '</strong>' +
        (t.patientName ? ' · ' + invEsc_(t.patientName) : '') + '</p>' + (extraHtml || ''),
      'home', 'Open my dashboard');
    MailApp.sendEmail({ to: s.email, name: 'Dermedica Portal', subject: subject, htmlBody: html, body: emailHtmlToText_(html) });
  } catch (e) { console.warn('Task email not sent: ' + e); }
}

const TASK_STATUSES_ = ['Open', 'In progress', 'On hold', 'Completed'];

const STAFF_TASK_MAIL_ = 'staff_task_mail';   // task emails waiting to go (sent by runNotifications)

// A short lock for this one task. Not the script lock, so the background jobs never make staff wait.
function staffTaskLock_(id) {
  const cache = CacheService.getScriptCache();
  const k = 'stl_' + id;
  for (let i = 0; i < 10; i++) {
    if (!cache.get(k)) { cache.put(k, '1', 15); return function () { cache.remove(k); }; }
    Utilities.sleep(300);
  }
  return null;
}

function handleStaffTask_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  let op = String(body.op || '');
  // The older buttons, as the new actions
  if (op === 'done') { op = 'status'; body.status = 'Completed'; }
  if (op === 'reopen') { op = 'status'; body.status = 'Open'; }
  if (op === 'note') op = 'comment';
  if (op === 'passOn') op = 'assign';
  const id = String(body.id || '');
  if (!/^[A-Za-z0-9_-]{5,80}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  const note = String(body.note || '').replace(/\r/g, '').trim().slice(0, 1000);

  const unlock = staffTaskLock_(id);
  if (!unlock) return { ok: false, error: 'BUSY' };
  try {
    const cfg = getConfig_();
    const path = 'staff-task-list/' + id;
    const t = fsGetDoc_(cfg, path);
    if (!t) return { ok: false, error: 'NOT_FOUND' };
    const admin = /^admin$/i.test(String(session.role || ''));
    const isAssignee = !!t.assignedToId && t.assignedToId === session.uid;
    const isCreator = !!t.createdByUid && t.createdByUid === session.uid;
    const canEdit = admin || isAssignee || isCreator || !t.assignedToId;
    if (op !== 'comment' && op !== 'status' && !canEdit) return { ok: false, error: 'FORBIDDEN' };

    const now = new Date();
    const at = now.toISOString();
    const who = String(session.name || 'Staff');
    const cur = TASK_STATUSES_.indexOf(t.status) !== -1 ? t.status : 'Open';
    const history = (Array.isArray(t.history) ? t.history : []).slice(-60);
    const notes = (Array.isArray(t.notes) ? t.notes : []).slice(-100);
    const addNote = function () { if (note) notes.push({ at: at, by: who, byUid: String(session.uid || ''), text: note }); };
    const noteHtml = note ? '<p style="margin:0;padding:10px 12px;border-radius:8px;background:#f0fdfa;color:#134e4a">“' +
      invEsc_(note).replace(/\n/g, '<br>') + '”</p>' : '';
    const short = String(t.taskText || 'Task').slice(0, 80);

    // Emails are queued (sent within 5 minutes), so nobody waits for them
    const mails = [];
    const tell = function (uids, subject, heading, extra) {
      uniq_(uids.filter(Boolean).map(String).filter(function (u) { return u !== session.uid; })).forEach(function (u) {
        mails.push(updateWrite_(cfg, STAFF_TASK_MAIL_ + '/m_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
          toUid: u, subject: subject, heading: heading, extra: extra || '',
          taskText: String(t.taskText || ''), patientName: String(t.patientName || ''), at: at,
        }));
      });
    };
    // The change and its emails in one write
    const save = function (patch) { commitWrites_(cfg, [patchWrite_(cfg, path, patch)].concat(mails)); };

    if (op === 'status') {
      const next = String(body.status || '');
      if (TASK_STATUSES_.indexOf(next) === -1) return { ok: false, error: 'BAD_STATUS' };
      if (next === cur) return { ok: true, already: true };
      addNote();
      history.push({ at: at, by: who, what: 'Status: ' + cur + ' → ' + next });
      const patch = { status: next, notes: notes, history: history, updatedAt: now };
      if (next === 'Completed') { patch.completedAt = now; patch.completedBy = who; patch.completedByUid = String(session.uid || ''); }
      else if (cur === 'Completed') { patch.completedAt = null; patch.completedBy = ''; patch.completedByUid = ''; }
      if (next === 'Completed') tell([t.createdByUid], 'Done: ' + short, who + ' has done a task you assigned', noteHtml);
      else if (cur === 'Completed') tell([t.assignedToId], 'Reopened: ' + short, who + ' reopened a task for you', noteHtml);
      else if (next === 'On hold') tell([t.createdByUid, t.assignedToId], 'On hold: ' + short, who + ' put a task on hold', noteHtml);
      save(patch);
      return { ok: true, status: next };
    }

    if (op === 'assign') {
      if (cur === 'Completed') return { ok: false, error: 'DONE' };
      const toId = String(body.toId || '');
      let to = null;
      if (toId) {
        to = getStaffDocs_().filter(function (s) { return s.id === toId && s.active !== false; })[0];
        if (!to) return { ok: false, error: 'NO_STAFF' };
      }
      if ((to ? to.id : '') === String(t.assignedToId || '')) return { ok: true, already: true };
      addNote();
      history.push({ at: at, by: who, what: to
        ? (t.assignedToName ? 'Passed on from ' + t.assignedToName + ' to ' + to.name : 'Assigned to ' + to.name)
        : 'Made it a task for anyone' });
      if (to) {
        tell([to.id], 'Task for you: ' + short, who + ' passed a task on to you',
          noteHtml + (t.dueDate ? '<p style="margin:10px 0 0;color:#475569">Due ' + invEsc_(recLongDate_(t.dueDate) || t.dueDate) + '</p>' : ''));
      }
      if (t.createdByUid && t.createdByUid !== (to && to.id)) {
        tell([t.createdByUid], 'Passed on: ' + short, who + ' passed your task on to ' + (to ? String(to.name || '') : 'anyone'), noteHtml);
      }
      save({ assignedToId: to ? to.id : '', assignedToName: to ? String(to.name || '') : '',
        notes: notes, history: history, updatedAt: now });
      return { ok: true, assignedToName: to ? String(to.name || '') : '' };
    }

    if (op === 'due') {
      const due = String(body.due || '');
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return { ok: false, error: 'BAD_REQUEST' };
      if (due === String(t.dueDate || '')) return { ok: true, already: true };
      history.push({ at: at, by: who, what: 'Due date: ' + (due ? recLongDate_(due) : 'none') });
      save({ dueDate: due, history: history, updatedAt: now });
      return { ok: true };
    }

    if (op === 'comment') {
      if (!note) return { ok: false, error: 'NO_NOTE' };
      addNote();
      tell([t.assignedToId, t.createdByUid], 'Comment: ' + short, who + ' commented on a task', noteHtml);
      save({ notes: notes, updatedAt: now });
      return { ok: true };
    }
    return { ok: false, error: 'BAD_REQUEST' };
  } catch (err) {
    console.error('Staff task ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  } finally {
    unlock();
  }
}

// runNotifications sends the queued task emails (up to 40 a run)
function staffTaskMailRun_(cfg) {
  const docs = fsListAll_(cfg, STAFF_TASK_MAIL_).slice(0, 40);
  if (!docs.length) return;
  const gone = [];
  docs.forEach(function (d) {
    const m = fromFields_(d.fields || {});
    staffTodoTell_(String(m.toUid || ''), String(m.subject || 'Task'), String(m.heading || ''), String(m.extra || ''),
      { taskText: m.taskText, patientName: m.patientName });
    gone.push(deleteWrite_(cfg, d.name.split('/documents/')[1]));
  });
  commitWrites_(cfg, gone);
}

// ===================== Daily uploads (Task Manager → Daily uploads) =====================
// Timely CSVs uploaded in the portal go straight into the PCN spreadsheet. The file itself is never saved.
// 1) Day Sheet → alltimeappts: A–M from the CSV (its column N is dropped), then N = PCN category and
//    O = Patient ID, using the same rules as the spreadsheet's runPrerequisite.

const UPLOAD_TABS_ = { daysheet: 'alltimeappts', patients: 'patientlist' };
const UPLOAD_CHUNK_ = 5000;

function handleUpload_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'data.upload')) return { ok: false, error: 'FORBIDDEN' };
  const op = String(body.op || '');
  try {
    if (op === 'daysheetStart') return upDsStart_(body, session);
    if (op === 'daysheetChunk') return upDsChunk_(body, session);
    if (op === 'daysheetFinish') return upDsFinish_(body, session);
    if (op === 'invoices') return upInvoices_(body, session);
    if (op === 'invoicesSync') return upInvSync_();
    if (op === 'packages') return upPackages_(body, session);
    if (op === 'pcnStep') return upPcnStep_(body, session);
    if (op === 'ptSearch') return upPtSearch_(body);
    if (op === 'ptLink') return upPtLink_(body, session);
    if (op === 'refill') return upRefill_(body, session);
    if (op === 'pcnStop') return upPcnStop_(body, session);
    if (op === 'pcnSync') return upPcnSync_(session);
  } catch (err) {
    console.error('Upload ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: true, problem: 'Something went wrong: ' + String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

/* ---------- 1) Day Sheet → alltimeappts, in batches (start, then batches, then finish) ---------- */

const UP_DS_MAX_ROWS_ = 500000;   // 18 columns × 500k rows stays under Google Sheets' 10 million cells
const UP_DS_CACHE_ = 'up_ds_';

function upDsSheet_() {
  const ss = SpreadsheetApp.openById(APPTS_SHEET_ID);
  const sheet = ss.getSheetByName(UPLOAD_TABS_.daysheet);
  if (!sheet) throw new Error('Sheet tab not found: ' + UPLOAD_TABS_.daysheet);
  return { ss: ss, sheet: sheet };
}

// One CSV row (A–M) → the 15 columns of alltimeappts, with the same rules as runPrerequisite
function upDsRow_(r, tz, match, stats) {
  const cell = function (k) { return String(r[k] == null ? '' : r[k]); };
  const rawDate = cell(0).trim();
  const key = upDateKey_(rawDate);
  if (rawDate && !key) stats.badDates++;
  const name = pcnCleanPatientName_(cell(1));
  const m = name ? match(name) : { id: '', how: 'blank' };
  if (name && !m.id) {
    if (m.how === 'skip') stats.skipped++;
    else {
      const bucket = m.how === 'ambiguous' ? stats.ambiguous : stats.unmatched;
      bucket[name] = (bucket[name] || 0) + 1;
    }
  }
  return [
    key ? (stats.dates[key] || (stats.dates[key] = Utilities.parseDate(key, tz, 'yyyy-MM-dd'))) : rawDate, // A (a real date)
    name,                                                       // B Patient Name
    upMoney_(cell(2)),                                          // C Outstanding Balance
    cell(3), cell(4), cell(5), cell(6), cell(7),                // D Contact # · E Resources · F Symbol2 · G StartTime · H Status
    pcnCleanStaff_(cell(8)),                                    // I StaffName
    cell(9), cell(10), cell(11),                                // J ServiceName · K ResourceName · L LocationName
    upMoney_(cell(12)),                                         // M Price
    pcnCategory_(rawDate, cell(9)),                             // N PCN Categories
    m.id || '',                                                 // O Patient ID (blank when not sure)
  ];
}

// Checks the size, clears A2:R and gets the rows and formats ready
function upDsStart_(body, session) {
  const total = Math.floor(Number(body.total) || 0);
  if (total < 1) return { ok: true, problem: 'The file has no appointments in it.' };
  if (total > UP_DS_MAX_ROWS_) {
    return { ok: true, problem: 'The file has ' + total + ' rows, more than one Google Sheets tab can hold. Talk to Bethany before uploading.' };
  }
  // One upload at a time (a flag, not the script lock, so the 15-minute jobs never block an upload)
  const cache = CacheService.getScriptCache();
  const busy = cache.get('up_ds_active');
  if (busy && !body.force && Date.now() - Number(busy) < 3 * 60000) {
    return { ok: true, problem: 'Another Day Sheet upload is still running. Try again in a few minutes.' };
  }
  try {
    const sheet = upDsSheet_().sheet;
    const before = Math.max(0, sheet.getLastRow() - 1);
    if (!body.force && before > 1000 && total < before * 0.7) {
      return { ok: true, needsForce: true, before: before,
        problem: 'This file has ' + total + ' rows, but alltimeappts has ' + before + ' now. ' +
          'Check it is the "All time" export. Replace it anyway?' };
    }
    if (sheet.getMaxColumns() < 15) sheet.insertColumnsAfter(sheet.getMaxColumns(), 15 - sheet.getMaxColumns());
    const maxCols = Math.min(18, sheet.getMaxColumns());
    if (sheet.getLastRow() >= 2) sheet.getRange(2, 1, sheet.getLastRow() - 1, maxCols).clearContent(); // A2:R, header kept
    if (sheet.getMaxRows() < total + 1) sheet.insertRowsAfter(sheet.getMaxRows(), total + 1 - sheet.getMaxRows());
    sheet.getRange(2, 2, total, 11).setNumberFormat('@');           // B:L as text (mobiles keep their 0)
    sheet.getRange(2, 14, total, 2).setNumberFormat('@');           // N:O as text
    sheet.getRange(2, 1, total, 1).setNumberFormat('d/m/yyyy');     // A
    sheet.getRange(2, 3, total, 1).setNumberFormat('$#,##0.00');    // C
    sheet.getRange(2, 13, total, 1).setNumberFormat('$#,##0.00');   // M
    SpreadsheetApp.flush();

    try { ptFsEntries_(); } catch (e) { console.warn('Portal patient list not read yet: ' + e); }
    const token = Utilities.getUuid().replace(/-/g, '');
    cache.put('up_ds_active', String(Date.now()), 1800);
    cache.put(UP_DS_CACHE_ + token, JSON.stringify({
      total: total, before: before, done: {}, started: Date.now(),
      fileName: String(body.fileName || '').slice(0, 150),
    }), 21600);
    try {
      fsPatch_(getConfig_(), 'data_uploads/daysheet', {
        status: 'running', startedAt: new Date().toISOString(), startedBy: String(session.name || ''),
      });
    } catch (e) { console.warn('Upload log not saved: ' + e); }
    return { ok: true, token: token, before: before };
  } catch (err) {
    cache.remove('up_ds_active');
    throw err;
  }
}

// One batch of rows, written at its place in the sheet (sending the same batch again is safe)
function upDsChunk_(body, session) {
  const token = String(body.token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) return { ok: false, error: 'BAD_REQUEST' };
  const cache = CacheService.getScriptCache();
  const raw = cache.get(UP_DS_CACHE_ + token);
  if (!raw) return { ok: true, problem: 'This upload ran out of time. Upload the file again.' };
  const st = JSON.parse(raw);
  const offset = Math.floor(Number(body.offset));
  let rows;
  try { rows = JSON.parse(uploadText_(body)); }
  catch (e) { return { ok: true, problem: "Part of the file didn't arrive properly. Upload it again." }; }
  if (!Array.isArray(rows) || !rows.length || !(offset >= 0) || offset + rows.length > st.total) {
    return { ok: false, error: 'BAD_REQUEST' };
  }

  const s = upDsSheet_();
  const tz = s.ss.getSpreadsheetTimeZone();
  const match = ptMatcher_(s.ss, UPLOAD_TABS_.patients);
  const stats = { unmatched: {}, ambiguous: {}, skipped: 0, badDates: 0, dates: {} };
  const out = rows.map(function (r) { return upDsRow_(Array.isArray(r) ? r : [], tz, match, stats); });
  s.sheet.getRange(2 + offset, 1, out.length, 15).setValues(out);
  SpreadsheetApp.flush();
  st.done[offset] = out.length;
  cache.put(UP_DS_CACHE_ + token, JSON.stringify(st), 21600);
  cache.put('up_ds_active', String(Date.now()), 1800); // still going
  return { ok: true, written: out.length, unmatched: stats.unmatched, ambiguous: stats.ambiguous,
    skipped: stats.skipped, badDates: stats.badDates };
}

// Every row arrived: save the summary
function upDsFinish_(body, session) {
  const token = String(body.token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) return { ok: false, error: 'BAD_REQUEST' };
  const cache = CacheService.getScriptCache();
  const raw = cache.get(UP_DS_CACHE_ + token);
  if (!raw) return { ok: true, problem: 'This upload ran out of time. Upload the file again.' };
  const st = JSON.parse(raw);
  const got = Object.keys(st.done).reduce(function (a, k) { return a + Number(st.done[k] || 0); }, 0);
  if (got !== st.total) return { ok: true, problem: 'Only ' + got + ' of ' + st.total + ' rows arrived. Upload the file again.' };

  const sm = body.summary || {};
  const n = function (v) { v = Math.floor(Number(v) || 0); return v < 0 ? 0 : v; };
  const res = { rows: st.total, before: st.before, ms: Date.now() - st.started, at: new Date().toISOString() };
  try {
    fsPatch_(getConfig_(), 'data_uploads/daysheet', {
      status: 'done', kind: 'daysheet', fileName: st.fileName, rows: res.rows, before: res.before,
      badDates: n(sm.badDates), unmatchedNames: n(sm.unmatchedNames), unmatchedRows: n(sm.unmatchedRows),
      ms: res.ms, at: res.at, by: String(session.name || ''), byUid: String(session.uid || ''),
    });
  } catch (e) { console.warn('Day sheet uploaded, but the upload log failed: ' + e); }
  cache.remove(UP_DS_CACHE_ + token);
  cache.remove('up_ds_active');
  console.log('Day sheet: ' + res.rows + ' rows into alltimeappts in ' + res.ms + ' ms by ' + session.name);
  return Object.assign({ ok: true }, res);
}

/* ---------- 2) Invoice Record → INVOICE RECORD (added to the bottom, new invoices only) ---------- */

const UP_INV_TAB_ = 'INVOICE RECORD';
const UP_INV_PTT_TAB_ = 'PTT LIST';
const UP_INV_MAX_ROWS_ = 20000;

// Timely product names → the names the clinic uses (matched ignoring capitals and extra spaces)
const UP_INV_PRODUCT_FIX_ = {
  'Dermedica Sunscreen SPF 50+': 'Dermedica Sunscreen',
  'Dermedica Handsfree Sunscreen SPF 50+': 'Dermedica Sunscreen',
  'XXX Dermedica Handsfree Sunscreen SPF 50+': 'Dermedica Sunscreen',
  'ZO Wrinkle + Texture Repair': 'ZO Wrinkle and Texture Serum',
  'ZO Wrinkle + Texture Repair 0.5% Retinol 50ml': 'ZO Wrinkle and Texture Serum',
  'Dermedica Ultra Moist': 'Dermedica UltraMoist',
  'K-Ceutic Post Treatment cream': 'K Ceutic Post Treatment cream',
  'Dermedica Pro B Hydrate': 'Dermedica Pro B Plus',
  'XxDermedica Pro B Hydrate': 'Dermedica Pro B Plus',
  'Dermedica Moisture Plus': 'Dermedica Moisture Plus',
  'Dermedica Moisture Plus 30ml': 'Dermedica Moisture Plus',
  'ZO Exfoliating Polish': 'ZO Exfoliating Polish',
  'ZO Exfoliating Polish 16.2g': 'ZO Exfoliating Polish',
  'Zo Gentle Cleanser': 'Zo Gentle Cleanser',
  'Zo Gentle Cleanser 200ml': 'Zo Gentle Cleanser',
  'Zo Gentle Cleanser 60ml': 'Zo Gentle Cleanser',
  'ZO Hydrating Crème': 'ZO Hydrating Creme',
  'ZO Hydrating Crème 113g': 'ZO Hydrating Creme',
  'ZO Hydrating Creme 58g': 'ZO Hydrating Creme',
  'ZO Skin Primer Broad Spectrum SPF30': 'ZO Oclipse Sunscreen',
  'ZO Retinol Skin Brightener  1% 50ml': 'ZO Retinol Skin Brightener 1%',
  'ZO Retinol Skin Brightener .25%': 'ZO Retinol Skin Brightener .25%',
  'ZO Retinol Skin Brightener .25% 50mL': 'ZO Retinol Skin Brightener .25%',
  'ZO Illuminating AOX Serum': 'ZO Illuminating AOX Serum',
  'ZO Illuminating AOX Serum 30mL': 'ZO Illuminating AOX Serum',
  'ZO Illuminating AOX Serum 50mL': 'ZO Illuminating AOX Serum',
  'ZO Vitamin C Self-Activating 50ml': 'ZO Vitamin C',
  'ZO Vitamin C 50mL': 'ZO Vitamin C',
  'ZO Oclipse Sunscreen & Primer SPF 30 15ml': 'ZO Oclipse Sunscreen',
  'ZO Oclipse Sunscreen & Primer SPF 30': 'ZO Oclipse Sunscreen',
  'ZO Sunscreen Primer 15ml': 'ZO Oclipse Sunscreen',
  'Daily Power Defense 15ml': 'ZO Daily Power Defence',
  'ZO Daily Power Defence 15mL': 'ZO Daily Power Defence',
  'ZO Daily Power Defense 50ml': 'ZO Daily Power Defence',
  '/Dermedica Hyaluronic Serum': 'Dermedica Hyaluronic Serum',
  'Dermedica A Plus serum 30ml': 'Dermedica Vitamin A Plus serum',
  'Vitamin A serum 30ml Dermedica': 'Dermedica Vitamin A Plus serum',
  'Dermedica Vitamin A Plus serum 30ml': 'Dermedica Vitamin A Plus serum',
  'Dermedica Vitamin A+ 30ml': 'Dermedica Vitamin A Plus serum',
  'Dermedica Barrier Balance 30mL': 'Dermedica Barrier Balance',
  'Dermedica BRIGHT C 30ml': 'Dermedica Bright C',
  'Dermedica UltraMoist 50mL $': 'Dermedica UltraMoist',
  'ZO Intense Eye + EYE MASK promo': 'ZO Intense Eye Cream',
  'Zo Intense Eye Creme 8g': 'ZO Intense Eye Cream',
  'ZO Rozatrol 50mL': 'ZO Rozatrol',
  'ZO Firming Serum 28ml': 'ZO Firming Serum',
  'ZO Exfoliating Cleanser 60mL': 'ZO Exfoliating Cleanser',
  'ZO Complex A+ 27mL': 'ZO Complex A+',
  'ZO COMPLEXION  Renewal Pads': 'ZO Complexion Renewal Pads',
  'ZO Exfoliation Accelerator 50ml': 'ZO Exfoliation Accelerator',
  'ZO Brightalive Skin Brightener REMASTERED 50ml': 'ZO BrightAlive Skin Brightener',
  'ZO BrightAlive Skin Brightener REMASTERED 50ml': 'ZO BrightAlive Skin Brightener',
  'ZO Balancing Cleansing Emulsion 200ml': 'ZO Balancing Cleansing Emulsion',
  'ZO Balancing Cleansing Emulsion 60ml': 'ZO Balancing Cleansing Emulsion',
  'ZO Body Smoothing Cream 70g': 'ZO Body Smoothing Cream',
  'ZO Body Smoothing Creme 70g': 'ZO Body Smoothing Cream',
};
let upInvFix_ = null;
function upInvFixKey_(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

// The same clean-up as PI_cleanProductNames: size + bracket on the end, then the replacement list
function upInvCleanProduct_(raw) {
  let t = String(raw == null ? '' : raw).replace(/\u00A0/g, ' ').trim();
  if (!t) return '';
  t = t.replace(/\s*\d+\s*(mL|ML|ml|g|mg|oz)?\s*\([^)]*\)$/i, '').replace(/\s*\([^)]*\)$/i, '').trim();
  if (!upInvFix_) {
    upInvFix_ = {};
    Object.keys(UP_INV_PRODUCT_FIX_).forEach(function (k) { upInvFix_[upInvFixKey_(k)] = UP_INV_PRODUCT_FIX_[k]; });
  }
  return upInvFix_[upInvFixKey_(t)] || t;
}

// PI_fillPatientIDColumnD's cleanText
function upInvCleanName_(t) {
  return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\(.*?\)/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
function upInvWords_(full) { return uniq_(full.split(' ').filter(function (w) { return w.length > 1; })); }

// Invoice Record: the shared name matching, then the most shared words (portal first, then PTT LIST)
function upInvPatientMatcher_(ss) {
  return ptMatcher_(ss, UP_INV_PTT_TAB_, { words: true });
}
// rows from the portal: [Invoice ID, InvoiceDate, CustomerName, StaffName, Product Name] (CSV columns A, B, C, E, G)
function upInvoices_(body, session) {
  let rows;
  try { rows = JSON.parse(uploadText_(body)); }
  catch (e) { return { ok: true, problem: "The file didn't arrive properly. Upload it again." }; }
  if (!Array.isArray(rows) || !rows.length) return { ok: true, problem: 'The file has no invoices in it.' };
  if (rows.length > UP_INV_MAX_ROWS_) {
    return { ok: true, problem: 'The file has ' + rows.length + ' lines. This upload is for one day of invoices.' };
  }

  const cache = CacheService.getScriptCache();
  const busy = cache.get('up_inv_active');
  if (busy && Date.now() - Number(busy) < 3 * 60000) {
    return { ok: true, problem: 'Another Invoice Record upload is running. Try again in a minute.' };
  }
  cache.put('up_inv_active', String(Date.now()), 600);
  try {
    const started = Date.now();
    const ss = SpreadsheetApp.openById(SSP_SHEET_ID);
    const sheet = ss.getSheetByName(UP_INV_TAB_);
    if (!sheet) throw new Error('Sheet tab not found: ' + UP_INV_TAB_);
    const tz = ss.getSpreadsheetTimeZone();
    const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    const txt = function (v) { return String(v == null ? '' : v).replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim(); };

    let noProduct = 0;
    let badDates = 0;
    const lines = [];
    rows.forEach(function (r) {
      if (!Array.isArray(r)) return;
      const id = txt(r[0]), rawDate = txt(r[1]), name = txt(r[2]), staff = txt(r[3]);
      const product = upInvCleanProduct_(r[4]);
      if (!id && !name && !product) return;
      if (!product) { noProduct++; return; }   // services and the like
      const key = upDateKey_(rawDate);
      if (rawDate && !key) badDates++;
      lines.push({ id: id, rawDate: rawDate, key: key, name: name, staff: staff, product: product });
    });
    if (!lines.length) return { ok: true, problem: 'The file has no product lines in it.', noProduct: noProduct };

    // Should be yesterday's: check before adding a big range
    const keys = lines.map(function (l) { return l.key; }).filter(Boolean).sort();
    const from = keys[0] || '';
    const to = keys[keys.length - 1] || '';
    if (!body.force && from && (flowDays_(from, to) > 7 || flowDays_(from, today) > 14)) {
      return { ok: true, needsForce: true,
        problem: 'This file has invoices from ' + recLongDate_(from) + ' to ' + recLongDate_(to) + ". It should only be yesterday's. " +
          'Invoices already in INVOICE RECORD will still be skipped. Add the rest anyway?' };
    }

    // Invoices already in the sheet are skipped (all their lines), and the new rows go after the last Invoice ID
    const last = sheet.getLastRow();
    const have = {};
    let lastA = 1;
    if (last >= 2) {
      sheet.getRange(2, 1, last - 1, 1).getDisplayValues().forEach(function (r, i) {
        const v = txt(r[0]);
        if (v) { have[v] = true; lastA = i + 2; }
      });
    }
    const fresh = lines.filter(function (l) { return !l.id || !have[l.id]; });
    const base = {
      ok: true, from: from, to: to, noProduct: noProduct, badDates: badDates,
      skippedInvoices: uniq_(lines.filter(function (l) { return l.id && have[l.id]; }).map(function (l) { return l.id; })).length,
    };
    if (!fresh.length) return Object.assign(base, { rows: 0 });

    const match = upInvPatientMatcher_(ss);
    const memo = {};
    const unmatched = {};
    const ambiguous = {};
    let matched = 0;
    const out = fresh.map(function (l) {
      const m = memo[l.name] || (memo[l.name] = match(l.name));
      if (m.id) matched++;
      else if (m.how === 'ambiguous') ambiguous[l.name] = (ambiguous[l.name] || 0) + 1;
      else if (l.name && m.how !== 'skip') unmatched[l.name] = (unmatched[l.name] || 0) + 1;
      return [
        l.id,                                                       // A Invoice ID
        l.key ? Utilities.parseDate(l.key, tz, 'yyyy-MM-dd') : l.rawDate, // B InvoiceDate (a real date)
        l.name,                                                     // C CustomerName
        m.id,                                                       // D Patient ID (blank when not sure)
        l.staff,                                                    // E StaffName
        l.product,                                                  // F Product Name (cleaned)
      ];
    });

    const start = lastA + 1;
    const end = start + out.length - 1;
    if (sheet.getMaxRows() < end) sheet.insertRowsAfter(sheet.getMaxRows(), end - sheet.getMaxRows());
    sheet.getRange(start, 1, out.length, 1).setNumberFormat('@');        // A as text
    sheet.getRange(start, 2, out.length, 1).setNumberFormat('d/m/yyyy'); // B
    sheet.getRange(start, 3, out.length, 4).setNumberFormat('@');        // C:F as text
    sheet.getRange(start, 1, out.length, 6).setValues(out);
    SpreadsheetApp.flush();

    const top = function (o) {
      return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, 20)
        .map(function (n) { return { name: n, rows: o[n] }; });
    };
    const res = Object.assign(base, {
      rows: out.length, startRow: start, endRow: end, matched: matched,
      unmatched: { names: Object.keys(unmatched).length, sample: top(unmatched) },
      ambiguous: { names: Object.keys(ambiguous).length, sample: top(ambiguous) },
      ms: Date.now() - started, at: new Date().toISOString(),
    });
    try {
      fsPatch_(getConfig_(), 'data_uploads/invoices', {
        status: 'done', kind: 'invoices', fileName: String(body.fileName || '').slice(0, 150),
        rows: res.rows, startRow: start, from: from, to: to, skippedInvoices: res.skippedInvoices,
        unmatchedNames: res.unmatched.names + res.ambiguous.names, ms: res.ms, at: res.at,
        by: String(session.name || ''), byUid: String(session.uid || ''),
      });
    } catch (e) { console.warn('Invoices added, but the upload log failed: ' + e); }
    console.log('Invoice Record: ' + out.length + ' line(s) added at row ' + start + ' by ' + session.name);
    return res;
  } finally {
    cache.remove('up_inv_active');
  }
}

// After an upload: the portal's skincare records (purchases → Email Flows) updated straight away
function upInvSync_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { ok: true, later: true };  // a scheduled job is running; the next sync picks it up
  try {
    const n = syncSkincare_(getConfig_());
    try {
      PropertiesService.getScriptProperties().setProperty('LAST_SYNCED_SSP_UPDATE',
        DriveApp.getFileById(SSP_SHEET_ID).getLastUpdated().toISOString());
    } catch (e) { /* the next sync just runs again */ }
    return { ok: true, patients: n };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 3) Customer Packages → customer_packages (A2:M replaced) ---------- */

const UP_PKG_TAB_ = 'customer_packages';
const UP_PKG_MAX_ROWS_ = 50000;

// fillCustomerPackagesColumnM: exact name (ignoring capitals), then letters only without " NEW".
// Two different patients with the same name: left blank.
// Customer Packages: exact name (ignoring capitals), then letters only without " NEW". Portal first, then patientlist.
// Customer Packages: the shared name matching (portal first, then patientlist)
function upPkgMatcher_(ss) {
  return ptMatcher_(ss, UPLOAD_TABS_.patients);
}

// rows from the portal: CSV columns A–L, in order
function upPackages_(body, session) {
  let rows;
  try { rows = JSON.parse(uploadText_(body)); }
  catch (e) { return { ok: true, problem: "The file didn't arrive properly. Upload it again." }; }
  if (!Array.isArray(rows)) return { ok: false, error: 'BAD_REQUEST' };
  const t = function (v) { return String(v == null ? '' : v).replace(/\u00A0/g, ' ').trim(); };
  const data = rows.filter(function (r) { return Array.isArray(r) && r.some(function (c) { return t(c); }); });
  if (!data.length) return { ok: true, problem: 'The file has no packages in it.' };
  if (data.length > UP_PKG_MAX_ROWS_) return { ok: true, problem: 'The file has ' + data.length + ' lines, which is far more than expected.' };

  const cache = CacheService.getScriptCache();
  const busy = cache.get('up_pkg_active');
  if (busy && Date.now() - Number(busy) < 3 * 60000) {
    return { ok: true, problem: 'Another Customer Packages upload is running. Try again in a minute.' };
  }
  cache.put('up_pkg_active', String(Date.now()), 600);
  try {
    const started = Date.now();
    const ss = SpreadsheetApp.openById(APPTS_SHEET_ID);
    const sheet = ss.getSheetByName(UP_PKG_TAB_);
    if (!sheet) throw new Error('Sheet tab not found: ' + UP_PKG_TAB_);
    const tz = ss.getSpreadsheetTimeZone();

    const before = Math.max(0, sheet.getLastRow() - 1);
    if (!body.force && before > 50 && data.length < before * 0.5) {
      return { ok: true, needsForce: true, before: before,
        problem: 'This file has ' + data.length + ' lines, but customer_packages has ' + before + ' now. ' +
          "Check it's the full Customer Packages export. Replace it anyway?" };
    }

    const match = upPkgMatcher_(ss);
    const memo = {};
    const unmatched = {};
    const ambiguous = {};
    let matched = 0;
    let badDates = 0;
    const count = function (v) { const s = t(v); return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s; };
    const out = data.map(function (r) {
      const name = t(r[0]);
      const rawExp = t(r[3]);
      const key = upDateKey_(rawExp);
      if (rawExp && !key) badDates++;
      const m = name ? (memo[name] || (memo[name] = match(name))) : { id: '', how: 'blank' };
      if (m.id) matched++;
      else if (m.how === 'ambiguous') ambiguous[name] = (ambiguous[name] || 0) + 1;
      else if (name && m.how !== 'skip') unmatched[name] = (unmatched[name] || 0) + 1;
      return [
        name,                                                      // A CustomerName
        t(r[1]),                                                   // B PackageName
        t(r[2]),                                                   // C Status
        key ? Utilities.parseDate(key, tz, 'yyyy-MM-dd') : rawExp, // D DateExpires2 (a real date)
        upMoney_(r[4]),                                            // E Paid
        upMoney_(r[5]),                                            // F Price
        t(r[6]),                                                   // G Service Name
        count(r[7]),                                               // H Remaining
        count(r[8]),                                               // I Used
        upMoney_(r[9]),                                            // J ServicePrice
        upMoney_(r[10]),                                           // K InvoiceAmount
        upMoney_(r[11]),                                           // L ServicePrice1
        m.id,                                                      // M Patient ID (blank when not sure)
      ];
    });

    // Clear A2:M (the header and anything right of M stay), then write
    if (sheet.getMaxColumns() < 13) sheet.insertColumnsAfter(sheet.getMaxColumns(), 13 - sheet.getMaxColumns());
    const last = sheet.getLastRow();
    if (last >= 2) sheet.getRange(2, 1, last - 1, 13).clearContent();
    if (sheet.getMaxRows() < out.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), out.length + 1 - sheet.getMaxRows());
    const len = out.length;
    sheet.getRange(2, 1, len, 3).setNumberFormat('@');           // A:C text
    sheet.getRange(2, 4, len, 1).setNumberFormat('d/m/yyyy');    // D
    sheet.getRange(2, 5, len, 2).setNumberFormat('$#,##0.00');   // E:F
    sheet.getRange(2, 7, len, 1).setNumberFormat('@');           // G text
    sheet.getRange(2, 10, len, 3).setNumberFormat('$#,##0.00');  // J:L
    sheet.getRange(2, 13, len, 1).setNumberFormat('@');          // M text
    sheet.getRange(2, 1, len, 13).setValues(out);
    SpreadsheetApp.flush();

    const top = function (o) {
      return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, 20)
        .map(function (n) { return { name: n, rows: o[n] }; });
    };
    const res = {
      ok: true, rows: len, before: before, matched: matched, badDates: badDates,
      unmatched: { names: Object.keys(unmatched).length, sample: top(unmatched) },
      ambiguous: { names: Object.keys(ambiguous).length, sample: top(ambiguous) },
      ms: Date.now() - started, at: new Date().toISOString(),
    };
    try {
      fsPatch_(getConfig_(), 'data_uploads/packages', {
        status: 'done', kind: 'packages', fileName: String(body.fileName || '').slice(0, 150),
        rows: len, before: before, unmatchedNames: res.unmatched.names + res.ambiguous.names,
        ms: res.ms, at: res.at, by: String(session.name || ''), byUid: String(session.uid || ''),
      });
    } catch (e) { console.warn('Packages uploaded, but the upload log failed: ' + e); }
    console.log('Customer packages: ' + len + ' line(s) by ' + session.name);
    return res;
  } finally {
    cache.remove('up_pkg_active');
  }
}

/* ---------- 4) Run PCN update: the PCN spreadsheet's runPCN steps, one request each ---------- */
// visits   → pcn_appts_today, past_visits, future-visits
// overdue  → overduecategory (Patient ID in E), cancelled_appointments
// results1 → pcn_results C, J, K, L, M    results2 → D–H    results3 → I, N–Q
// sync     → pcn_results + appointments to the portal
// pcn_results is never cleared first: each column is overwritten whole, so a failed step leaves the last values
// (not blanks), and the portal is only updated once every step has worked.

const PCN_STEPS_ = ['visits', 'overdue', 'results1', 'results2', 'results3', 'sync'];
const PCN_STEP_NAME_ = {
  visits: "Today's, past and future visits", overdue: 'Overdue list and cancelled appointments',
  results1: 'pcn_results C, J, K, L and M', results2: 'pcn_results D to H', results3: 'pcn_results I and N to Q',
  sync: 'Sending it to the portal',
};
const PCN_OVERDUE_MONTHS_ = {
  'Wrinkle Relaxer': 4, 'Filler/Radiesse': 9, 'Firm/Ulthera/eST': 9, 'Laser/OPL/Peel': 6,
  'RestoraGlow/RF/DermaGlow/Skin Needling': 6, 'Body Sculpting': 10, 'Other Injectables': 9,
};

function upPcnStep_(body, session) {
  const step = String(body.step || '');
  const i = PCN_STEPS_.indexOf(step);
  if (i < 0) return { ok: false, error: 'BAD_REQUEST' };
  const cache = CacheService.getScriptCache();
  let token = String(body.token || '');
  let st;
  if (i === 0) {
    const busyRaw = cache.get('pcn_run_active');
    if (busyRaw) {
      const b = JSON.parse(busyRaw);
      if (Date.now() - Number(b.at || 0) < 8 * 60000) {
        return { ok: true, problem: 'A PCN update' + (b.by ? ' started by ' + b.by : '') + ' is still running. Try again in a few minutes.' };
      }
    }
    token = Utilities.getUuid().replace(/-/g, '');
    st = { next: 0, started: Date.now(), times: {}, info: {} };
    try {
      fsPatch_(getConfig_(), 'data_uploads/pcn', {
        status: 'running', startedAt: new Date().toISOString(), startedBy: String(session.name || ''), error: '',
      });
    } catch (e) { console.warn('PCN log not saved: ' + e); }
  } else {
    if (!/^[a-f0-9]{32}$/.test(token)) return { ok: false, error: 'BAD_REQUEST' };
    const raw = cache.get('pcn_run_' + token);
    if (!raw) return { ok: true, problem: 'This update ran out of time. Start it again.' };
    st = JSON.parse(raw);
    if (st.next !== i) return { ok: true, problem: 'The steps got out of order. Start the update again.' };
  }
  cache.put('pcn_run_active', JSON.stringify({ at: Date.now(), by: String(session.name || '') }), 1800);

  const t0 = Date.now();
  let info;
  try {
    const ctx = pcnCtx_();
    if (step === 'visits') info = pcnStepVisits_(ctx);
    else if (step === 'overdue') info = pcnStepOverdue_(ctx);
    else if (step === 'results1') info = pcnStepResults1_(ctx);
    else if (step === 'results2') info = pcnStepResults2_(ctx);
    else if (step === 'results3') info = pcnStepResults3_(ctx);
    else info = pcnStepSync_(ctx);
  } catch (err) {
    console.error('PCN step ' + step + ' failed: ' + (err && err.stack ? err.stack : err));
    const msg = String(err && err.message ? err.message : err).slice(0, 300);
    cache.remove('pcn_run_active');
    cache.remove('pcn_run_' + token);
    try {
      fsPatch_(getConfig_(), 'data_uploads/pcn', { status: 'failed', failedStep: step, error: msg, failedAt: new Date().toISOString() });
    } catch (e) { /* not essential */ }
    return { ok: true, problem: PCN_STEP_NAME_[step] + ' failed: ' + msg +
      (step === 'sync' ? ' The sheets are updated. Press "Send to the portal again" to finish.'
        : ' Nothing was sent to the portal. Run the update again.') };
  }

  const ms = Date.now() - t0;
  st.times[step] = ms;
  st.info[step] = info;
  st.next = i + 1;
  const done = st.next >= PCN_STEPS_.length;
  if (done) {
    cache.remove('pcn_run_active');
    cache.remove('pcn_run_' + token);
    try {
      fsPatch_(getConfig_(), 'data_uploads/pcn', {
        status: 'done', at: new Date().toISOString(), by: String(session.name || ''), byUid: String(session.uid || ''),
        ms: Date.now() - st.started, times: st.times, info: st.info, error: '',
      });
    } catch (e) { console.warn('PCN log not saved: ' + e); }
    console.log('PCN update done in ' + (Date.now() - st.started) + ' ms by ' + session.name);
  } else {
    cache.put('pcn_run_' + token, JSON.stringify(st), 3600);
  }
  return { ok: true, token: token, step: step, ms: ms, info: info, done: done, totalMs: Date.now() - st.started };
}

// Stop: called by the portal once the step that was running has finished. Ends the run so a new one can start.
function upPcnStop_(body, session) {
  const token = String(body.token || '');
  if (!/^[a-f0-9]{32}$/.test(token)) return { ok: false, error: 'BAD_REQUEST' };
  const cache = CacheService.getScriptCache();
  const raw = cache.get('pcn_run_' + token);
  cache.remove('pcn_run_' + token);
  cache.remove('pcn_run_active');
  const st = raw ? JSON.parse(raw) : null;
  const last = st && st.next > 0 ? PCN_STEPS_[st.next - 1] : '';
  try {
    fsPatch_(getConfig_(), 'data_uploads/pcn', {
      status: 'stopped', stoppedAt: new Date().toISOString(), stoppedBy: String(session.name || ''),
      stoppedAfter: last ? PCN_STEP_NAME_[last] : '', error: '',
    });
  } catch (e) { console.warn('PCN log not saved: ' + e); }
  console.log('PCN update stopped by ' + session.name + (last ? ' after ' + last : ''));
  return { ok: true };
}

/* ---- Shared ---- */

// Midnight today and tomorrow in the spreadsheet's own time zone (not the script's)
function pcnCtx_() {
  const ss = SpreadsheetApp.openById(APPTS_SHEET_ID);
  const tz = ss.getSpreadsheetTimeZone();
  const todayKey = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  return {
    ss: ss, tz: tz, todayKey: todayKey,
    today: Utilities.parseDate(todayKey, tz, 'yyyy-MM-dd').getTime(),
    tomorrow: Utilities.parseDate(flowAddDaysKey_(todayKey, 1), tz, 'yyyy-MM-dd').getTime(),
  };
}
function pcnSheet_(ctx, name) {
  const s = ctx.ss.getSheetByName(name);
  if (!s) throw new Error('Sheet tab not found: ' + name);
  return s;
}
function pcnReadAppts_(ctx) {
  const sh = pcnSheet_(ctx, UPLOAD_TABS_.daysheet);
  const last = sh.getLastRow();
  return last < 2 ? [] : sh.getRange(2, 1, last - 1, 15).getValues(); // A:O
}
function pcnKey_(v) { return String(v == null ? '' : v).toLowerCase().trim(); }
function pcnIsDate_(v) { return v instanceof Date && !isNaN(v); }
function pcnFmt_(ctx, t) { return Utilities.formatDate(new Date(t), ctx.tz, 'd/M/yyyy'); }

// 'exact': only "Cancelled" left out · 'dns': cancelled / did not show · 'full': also no show / DNA
function pcnStatusOk_(raw, mode) {
  if (mode === 'exact') return String(raw == null ? '' : raw).trim() !== 'Cancelled';
  const s = String(raw || '').toLowerCase();
  if (s.indexOf('cancelled') !== -1 || s.indexOf('did not show') !== -1) return false;
  return mode !== 'full' || (s.indexOf('no show') === -1 && s.indexOf('dna') === -1);
}

// Clears A2:<cols> to the bottom of the tab, then writes the rows
function pcnWrite_(sheet, cols, rows) {
  const max = sheet.getMaxRows();
  if (max >= 2) sheet.getRange(2, 1, max - 1, cols).clearContent();
  if (!rows.length) return;
  if (sheet.getMaxRows() < rows.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  sheet.getRange(2, 1, rows.length, cols).setValues(rows);
}

// pcn_results column B down to the last patient (rows below are handled in results1)
function pcnKeys_(ctx) {
  const sheet = pcnSheet_(ctx, RESULTS_SHEET_NAME);
  const last = sheet.getLastRow();
  const all = last >= 2 ? sheet.getRange(2, 2, last - 1, 1).getValues().map(function (r) { return r[0]; }) : [];
  let n = all.length;
  while (n && pcnKey_(all[n - 1]) === '') n--;
  return { sheet: sheet, last: last, keys: all.slice(0, n) };
}
function pcnPut_(sheet, col, vals) {
  if (vals.length) sheet.getRange(2, col, vals.length, 1).setValues(vals.map(function (v) { return [v]; }));
}

// The history engine for D–I and N–Q. opt: { cat (null = every category except LED), mode, limit, dropEmpty }
function pcnHistory_(ctx, appts, keys, opt) {
  const want = opt.cat == null ? null : pcnKey_(opt.cat);
  const lookup = {};
  for (let r = 0; r < appts.length; r++) {
    const row = appts[r];
    if (!pcnIsDate_(row[0])) continue;
    const t = row[0].getTime();
    if (t >= ctx.today) continue;
    const key = pcnKey_(row[14]);
    if (!key || !pcnStatusOk_(row[7], opt.mode)) continue;
    const cat = pcnKey_(row[13]);
    if (want === null ? cat === 'led' : cat !== want) continue;
    const byDay = lookup[key] || (lookup[key] = {});
    (byDay[t] || (byDay[t] = [])).push(row);
  }
  return keys.map(function (k) {
    const key = pcnKey_(k);
    const byDay = key ? lookup[key] : null;
    if (!byDay) return '';
    return Object.keys(byDay).map(Number).sort(function (a, b) { return b - a; }).slice(0, opt.limit)
      .map(function (t) {
        const vals = byDay[t].filter(function (rw) { return rw[9] !== '' && rw[9] != null; })
          .map(function (rw) { return rw[8] ? rw[9] + ' (' + rw[8] + ')' : String(rw[9]); });
        if (opt.dropEmpty && !vals.length) return '';
        return pcnFmt_(ctx, t) + ' - ' + vals.join(', ');
      })
      .filter(function (l) { return l !== ''; })
      .join('\n');
  });
}

/* ---- Step: visits (updateTodayVisits + getpttidcolk, updatePastVisits, updateFutureVisits) ---- */

function pcnStepVisits_(ctx) {
  const data = pcnReadAppts_(ctx);
  const past = [];
  const future = [];
  const todays = [];
  data.forEach(function (r) {
    if (!pcnIsDate_(r[0])) return;
    const t = r[0].getTime();
    const status = String(r[7] == null ? '' : r[7]).trim();
    // Today: A–J, then K = the Patient ID from column O. Only "Cancelled" left out (as before).
    if (t >= ctx.today && t < ctx.tomorrow && status !== 'Cancelled') {
      todays.push([r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[14]]);
    }
    if (status === 'Cancelled' || status === 'Did not show') return;
    // Past / future: A–J, K = O (Patient ID), L = N (category)
    (t < ctx.today ? past : future).push([r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[14], r[13]]);
  });
  past.sort(function (a, b) { return a[0] - b[0]; });
  future.sort(function (a, b) { return a[0] - b[0]; });
  todays.sort(function (a, b) { return toMinutes_(String(a[6] || '')) - toMinutes_(String(b[6] || '')); }); // by start time

  pcnWrite_(pcnSheet_(ctx, APPTS_SHEET_NAME), 11, todays);
  pcnWrite_(pcnSheet_(ctx, PAST_VISITS_SHEET_NAME), 12, past);
  pcnWrite_(pcnSheet_(ctx, FUTURE_VISITS_SHEET_NAME), 12, future);
  SpreadsheetApp.flush();
  return { today: todays.length, past: past.length, future: future.length };
}

/* ---- Step: overdue (generateOverdueList + fillOverdueCategoryColumnE) and cancelledAppointmentsReport ---- */

function pcnStepOverdue_(ctx) {
  const data = pcnReadAppts_(ctx);
  const months = recallMonthsMap_(getConfig_());   // Recall settings (the same intervals as Recall)

  // Overdue: per patient (Patient ID, or the name when there isn't one) and category
  const latest = {};
  const booked = {};
  const cancelled = [];
  data.forEach(function (r) {
    if (!pcnIsDate_(r[0])) return;
    const t = r[0].getTime();
    const s = String(r[7] || '').toLowerCase();

    if ((s.indexOf('cancelled') !== -1 || s.indexOf('did not') !== -1) && t < ctx.tomorrow) {
      cancelled.push([r[0], r[1], r[8], r[9], r[13], r[14]]); // A, B, I, J, N, O
    }

    const name = String(r[1] == null ? '' : r[1]).trim();
    const cat = String(r[13] == null ? '' : r[13]).trim();
    if (!name || !(cat in months)) return;
    if (s.indexOf('cancelled') !== -1 || s.indexOf('did not show') !== -1) return; // a no-show isn't a visit
    const id = String(r[14] == null ? '' : r[14]).trim();
    const key = (id ? 'id:' + id : 'nm:' + name.toLowerCase()) + '|' + cat;
    if (!latest[key] || t > latest[key].t) latest[key] = { t: t, d: r[0], name: name, id: id, cat: cat };
    if (t >= ctx.today) booked[key] = true;
  });

  const tp = ctx.todayKey.split('-').map(Number);
  const rows = [];
  Object.keys(latest).forEach(function (k) {
    if (booked[k]) return;
    const x = latest[k];
    const limit = months[x.cat];
    const lastKey = Utilities.formatDate(x.d, ctx.tz, 'yyyy-MM-dd');
    if (lastKey >= flowAddMonthsKey_(ctx.todayKey, -limit)) return;
    const lp = lastKey.split('-').map(Number);
    const over = (tp[0] - lp[0]) * 12 + (tp[1] - lp[1]) - limit;
    let text;
    if (over >= 12) {
      const yrs = Math.round((over / 12) * 10) / 10;
      text = yrs + ' year' + (yrs !== 1 ? 's' : '') + ' overdue';
    } else {
      text = over + ' month' + (over !== 1 ? 's' : '') + ' overdue';
    }
    rows.push([x.name, x.d, x.cat, Utilities.formatDate(x.d, ctx.tz, 'MMMM d, yyyy') + ' - ' + x.cat + ' (' + text + ')', x.id]);
  });

  let od = ctx.ss.getSheetByName('overduecategory');
  if (!od) od = ctx.ss.insertSheet('overduecategory');
  const max = od.getMaxRows();
  od.getRange(1, 1, max, 5).clearContent(); // values only: the tab's formatting stays
  const out = [['Name', 'Last Visit', 'Category', 'Summary', 'Patient ID']].concat(rows);
  if (od.getMaxRows() < out.length) od.insertRowsAfter(od.getMaxRows(), out.length - od.getMaxRows());
  od.getRange(1, 1, out.length, 5).setValues(out);
  if (rows.length) od.getRange(2, 2, rows.length, 1).setNumberFormat('mmmm d, yyyy');

  cancelled.sort(function (a, b) { return b[0] - a[0]; });
  pcnWrite_(pcnSheet_(ctx, 'cancelled_appointments'), 6, cancelled);
  SpreadsheetApp.flush();
  return { overdue: rows.length, cancelled: cancelled.length };
}

/* ---- Step: results1 — pcn_results C, J, K, L, M ---- */

function pcnStepResults1_(ctx) {
  const k = pcnKeys_(ctx);
  const n = k.keys.length;
  if (k.last > n + 1) k.sheet.getRange(n + 2, 3, k.last - n - 1, 15).clearContent(); // C:Q below the patient list
  if (!n) return { patients: 0 };

  // C: today's appointments (from pcn_appts_today G:K)
  const todaySh = pcnSheet_(ctx, APPTS_SHEET_NAME);
  const tl = todaySh.getLastRow();
  const todays = {};
  if (tl >= 2) {
    todaySh.getRange(2, 7, tl - 1, 5).getValues().forEach(function (r) {
      const key = pcnKey_(r[4]);
      if (!key) return;
      const g = r[0], i = r[2], j = r[3];
      const s = g && j && i ? g + ' - ' + j + ' (' + i + ')' : g && j ? g + ' - ' + j : g ? String(g) : j ? String(j) : '';
      if (s) (todays[key] = todays[key] || []).push(s);
    });
  }
  pcnPut_(k.sheet, 3, k.keys.map(function (v) {
    const l = todays[pcnKey_(v)];
    return l && l.length ? l.join('\n') : 'No Scheduled Appointments today';
  }));

  // J: future visits from tomorrow (from future-visits), soonest 6
  const fv = pcnSheet_(ctx, FUTURE_VISITS_SHEET_NAME);
  const fl = fv.getLastRow();
  const fut = {};
  if (fl >= 2) {
    fv.getRange(2, 1, fl - 1, 11).getValues().forEach(function (r) {
      if (!pcnIsDate_(r[0])) return;
      const t = r[0].getTime();
      const key = pcnKey_(r[10]);
      if (t < ctx.tomorrow || !key || !pcnStatusOk_(r[7], 'full')) return;
      const byDay = fut[key] || (fut[key] = {});
      (byDay[t] || (byDay[t] = [])).push(r);
    });
  }
  pcnPut_(k.sheet, 10, k.keys.map(function (v) {
    const byDay = fut[pcnKey_(v)];
    if (!pcnKey_(v) || !byDay) return '';
    return Object.keys(byDay).map(Number).sort(function (a, b) { return a - b; }).slice(0, 6).map(function (t) {
      return pcnFmt_(ctx, t) + ' - ' + byDay[t]
        .filter(function (r) { return r[9] !== '' && r[9] != null; })
        .map(function (r) { return r[9] + (r[8] !== '' && r[8] != null ? ' (' + r[8] + ')' : ''); })
        .join(', ');
    }).join('\n');
  }));

  // K: overdue summaries (overduecategory D, matched on E)
  const od = pcnSheet_(ctx, 'overduecategory');
  const ol = od.getLastRow();
  const over = {};
  if (ol >= 2) {
    od.getRange(2, 4, ol - 1, 2).getValues().forEach(function (r) {
      const key = pcnKey_(r[1]);
      if (key && r[0] !== '') (over[key] = over[key] || []).push(r[0]);
    });
  }
  pcnPut_(k.sheet, 11, k.keys.map(function (v) { const l = over[pcnKey_(v)]; return l ? l.join('\n') : ''; }));

  // L: Skin Script date (skin_script B, matched on D, first one found)
  const sk = pcnSheet_(ctx, 'skin_script');
  const sl = sk.getLastRow();
  const ssp = {};
  if (sl >= 1) {
    sk.getRange(1, 2, sl, 3).getValues().forEach(function (r) {
      const key = pcnKey_(r[2]);
      if (key && r[0] !== '' && !(key in ssp)) ssp[key] = r[0];
    });
  }
  pcnPut_(k.sheet, 12, k.keys.map(function (v) { const key = pcnKey_(v); return key && key in ssp ? ssp[key] : ''; }));

  // M: packages (customer_packages G and H, matched on M)
  const pk = pcnSheet_(ctx, UP_PKG_TAB_);
  const pl = pk.getLastRow();
  const pkgs = {};
  if (pl >= 2) {
    pk.getRange(2, 7, pl - 1, 7).getValues().forEach(function (r) {
      const key = pcnKey_(r[6]);
      if (key && r[0] !== '' && r[0] != null) (pkgs[key] = pkgs[key] || []).push(r[0] + ' - Remaining (' + r[1] + ')');
    });
  }
  pcnPut_(k.sheet, 13, k.keys.map(function (v) { const l = pkgs[pcnKey_(v)]; return l ? l.join('\n') : ''; }));

  SpreadsheetApp.flush();
  return { patients: n };
}

/* ---- Step: results2 — D Wrinkle Relaxer, E Filler, F RestoraGlow, G Laser, H Firm ---- */

function pcnStepResults2_(ctx) {
  const k = pcnKeys_(ctx);
  if (!k.keys.length) return { patients: 0 };
  const appts = pcnReadAppts_(ctx);
  const head = k.sheet.getRange(1, 4, 1, 14).getValues()[0]; // D1:Q1 hold the category names
  [[4, 'exact'], [5, 'exact'], [6, 'dns'], [7, 'dns'], [8, 'dns']].forEach(function (c) {
    pcnPut_(k.sheet, c[0], pcnHistory_(ctx, appts, k.keys, { cat: head[c[0] - 4], mode: c[1], limit: 10 }));
  });
  SpreadsheetApp.flush();
  return { patients: k.keys.length };
}

/* ---- Step: results3 — I all past visits, N Other Injectables, O Body, P Hydra, Q Collagen ---- */

function pcnStepResults3_(ctx) {
  const k = pcnKeys_(ctx);
  if (!k.keys.length) return { patients: 0 };
  const appts = pcnReadAppts_(ctx);
  const head = k.sheet.getRange(1, 4, 1, 14).getValues()[0];
  pcnPut_(k.sheet, 9, pcnHistory_(ctx, appts, k.keys, { cat: null, mode: 'dns', limit: 20, dropEmpty: true }));
  [[14, 'full'], [15, 'dns'], [16, 'dns'], [17, 'dns']].forEach(function (c) {
    pcnPut_(k.sheet, c[0], pcnHistory_(ctx, appts, k.keys, { cat: head[c[0] - 4], mode: c[1], limit: 10 }));
  });
  SpreadsheetApp.flush();
  return { patients: k.keys.length };
}

/* ---- Step: sync — the main part of syncSheetsToFirestore, straight away ---- */

function pcnStepSync_(ctx) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { later: true }; // a scheduled job is running; the next sync sends it
  try {
    const cfg = getConfig_();
    const deadline = Date.now() + 4.5 * 60000;
    const patients = syncResults_(ctx.ss, cfg, deadline);
    const days = syncAppointments_(ctx.ss, cfg, deadline);
    let updated = '';
    try { updated = DriveApp.getFileById(APPTS_SHEET_ID).getLastUpdated().toISOString(); } catch (e) { /* not essential */ }
    commitWrites_(cfg, [updateWrite_(cfg, 'sync_meta/pcn', {
      sheetUpdatedAt: updated, syncedAt: new Date().toISOString(), patients: patients, days: days,
    })]);
    if (updated) PropertiesService.getScriptProperties().setProperty('LAST_SYNCED_SHEET_UPDATE', updated);
    return { patients: patients, days: days };
  } finally {
    lock.releaseLock();
  }
}

// "Send to the portal again" after the last step failed or ran out of time
function upPcnSync_(session) {
  const cache = CacheService.getScriptCache();
  const busyRaw = cache.get('pcn_run_active');
  if (busyRaw && Date.now() - Number(JSON.parse(busyRaw).at || 0) < 8 * 60000) {
    return { ok: true, problem: 'A PCN update is still running. Try again in a few minutes.' };
  }
  cache.put('pcn_run_active', JSON.stringify({ at: Date.now(), by: String(session.name || '') }), 1800);
  const t0 = Date.now();
  try {
    const info = pcnStepSync_(pcnCtx_());
    try {
      fsPatch_(getConfig_(), 'data_uploads/pcn', {
        status: 'done', at: new Date().toISOString(), by: String(session.name || ''), byUid: String(session.uid || ''), error: '',
      });
    } catch (e) { console.warn('PCN log not saved: ' + e); }
    return { ok: true, info: info, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: true, problem: String(err && err.message ? err.message : err).slice(0, 300) };
  } finally {
    cache.remove('pcn_run_active');
  }
}
// The uploaded file as text (sent compressed by the portal when the browser can)
function uploadText_(body) {
  const b64 = String(body.data || '');
  if (!b64) throw new Error('The file is missing. Choose it again.');
  if (b64.length > 45 * 1024 * 1024) throw new Error('The file is too big to upload in one go.');
  let blob = Utilities.newBlob(Utilities.base64Decode(b64), body.gzip ? 'application/x-gzip' : 'text/csv', 'upload');
  if (body.gzip) blob = Utilities.ungzip(blob);
  return blob.getDataAsString('UTF-8').replace(/^\uFEFF/, '');
}

// "18/10/2026", "2026-10-18", "18 Oct 2026", "Sat 18 Oct 2026", "October 18, 2026" → "2026-10-18" (Australian day first)
function upDateKey_(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const ok = function (y, mo, d) {
    y = Number(y); mo = Number(mo); d = Number(d);
    if (y < 100) y += 2000;
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? y + '-' + pad2_(mo) + '-' + pad2_(d) : '';
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return ok(m[1], m[2], m[3]);
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/.exec(s);
  if (m) return ok(m[3], m[2], m[1]);
  m = /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s);
  if (m && MONTHS_[m[2].slice(0, 3).toLowerCase()]) return ok(m[3], MONTHS_[m[2].slice(0, 3).toLowerCase()], m[1]);
  m = /^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m && MONTHS_[m[1].slice(0, 3).toLowerCase()]) return ok(m[3], MONTHS_[m[1].slice(0, 3).toLowerCase()], m[2]);
  return '';
}

// "$1,234.50" → 1234.5 (as pasting the CSV would); anything else stays as Timely wrote it
function upMoney_(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const m = /^(-)?\$?\s*(-)?([\d,]+(?:\.\d+)?)$/.exec(s);
  return m ? (m[1] || m[2] ? -1 : 1) * Number(m[3].replace(/,/g, '')) : s;
}

/* ---------- Patient IDs: the portal's Patient List (Firestore) first, the sheet as a fallback ---------- */

const PT_CACHE_ = 'pt_fs_names_v2';

// Every portal patient: { list: [[PttID, [names…], mobile, DobKey]], all: { PttID: 1 } } (all includes merged-away records).
// Merged-away records aren't matched; the record they were merged into carries their old names (MergedNames).
// Remembered for 10 minutes, in parts (one cache value holds 100 KB at most).
function ptFsEntries_() {
  const cache = CacheService.getScriptCache();
  const head = cache.get(PT_CACHE_);
  if (head) {
    const keys = [];
    for (let i = 0; i < Number(head); i++) keys.push(PT_CACHE_ + '_' + i);
    const got = cache.getAll(keys);
    if (keys.length && keys.every(function (k) { return got[k]; })) {
      try { return JSON.parse(keys.map(function (k) { return got[k]; }).join('')); } catch (e) { /* read again below */ }
    }
  }
  const list = [];
  const all = {};
  fsListAll_(getConfig_(), 'patient_list',
    ['PttID', 'Patient Name', 'First Name', 'Last Name', 'MergedInto', 'MergedNames', 'Mobile', 'DobKey'])
    .forEach(function (d) {
      const f = fromFields_(d.fields || {});
      const id = String(f.PttID == null ? '' : f.PttID).trim();
      if (!id) return;
      all[id] = 1;
      if (f.MergedInto) return;
      const names = uniq_([f['Patient Name'], ((f['First Name'] || '') + ' ' + (f['Last Name'] || '')).trim()]
        .concat(Array.isArray(f.MergedNames) ? f.MergedNames : [])
        .map(function (n) { return String(n == null ? '' : n).replace(/\s+/g, ' ').trim(); })
        .filter(Boolean));
      if (names.length) list.push([id, names, String(f.Mobile == null ? '' : f.Mobile).trim(), String(f.DobKey || '')]);
    });
  const out = { list: list, all: all };
  try {
    const json = JSON.stringify(out);
    const parts = {};
    let n = 0;
    for (let i = 0; i < json.length; i += 45000) parts[PT_CACHE_ + '_' + (n++)] = json.slice(i, i + 45000);
    cache.putAll(parts, 600);
    cache.put(PT_CACHE_, String(n), 600);
  } catch (e) { console.warn('Patient names not remembered: ' + e); }
  return out;
}

// { fs: [[id, name]…], sheet: [[id, name]…] }. Sheet rows only for Patient IDs Firestore doesn't have.
// If Firestore can't be read, the sheet is used on its own (as before).
function ptEntries_(ss, tab) {
  let fs = { list: [], all: {} };
  try { fs = ptFsEntries_(); }
  catch (e) { console.warn('Portal patient list not read, using the sheet only: ' + e); }
  const fsPairs = [];
  fs.list.forEach(function (p) { p[1].forEach(function (n) { fsPairs.push([p[0], n]); }); });
  const sheetPairs = [];
  const sh = ss.getSheetByName(tab);
  if (sh && sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().forEach(function (r) {
      const id = String(r[7] == null ? '' : r[7]).trim();
      const name = String(r[0] == null ? '' : r[0]).trim();
      if (id && name && !fs.all[id]) sheetPairs.push([id, name]);
    });
  }
  return { fs: fsPairs, sheet: sheetPairs };
}

// name key → Patient ID, or null when two different patients share it. Firestore wins for any key it has.
function ptMap_(entries, keyFn) {
  const map = {};
  const fromFs = {};
  const put = function (k, id, isFs) {
    if (!k || (!isFs && fromFs[k])) return;
    if (isFs) fromFs[k] = true;
    map[k] = (k in map && map[k] !== id) ? null : id;
  };
  entries.fs.forEach(function (e) { put(keyFn(e[1]), e[0], true); });
  entries.sheet.forEach(function (e) { put(keyFn(e[1]), e[0], false); });
  return map;
}

/* ---------- The same rules as the PCN spreadsheet's runPrerequisite ---------- */

// fillCategoriesColN: first match wins, in this order
const PCN_CATEGORY_RULES_ = [
  [/(Dr Consult \[in-clinic\] NP|Consultation with Dr-New Patient|Consultation with Dr-New Patient \[in-clinic\]|Consult with Nurse-New Patient|Consult with Dr-New Patient|Consult with Dr for new patient-Online booking)/i, 'Consultation New Patient'],
  [/(vibro|Vibro LED)/i, 'Vibro'],
  [/(wr|wrinkle)/i, 'Wrinkle Relaxer'],
  [/(filler|dermal filler|radiesse)/i, 'Filler/Radiesse'],
  [/(trusculpt|vanquish|fat|fat freezing|flex)/i, 'Body Sculpting'],
  [/(restoraglow|refresh|dermaglow|skin needling)/i, 'RestoraGlow/RF/DermaGlow/Skin Needling'],
  [/(laser|opl|peel|bbl|clear complexion|genesis)/i, 'Laser/OPL/Peel'],
  [/(ulthera|firm|eskin tight|skintight|skin lifting)/i, 'Firm/Ulthera/eST'],
  [/(hydrarepair|skin needling|collagen growth)/i, 'Hydrarepair/SkinRemod/CG'],
  [/(Collagen activator|Add on Collagen activator)/i, 'Collagen activator'],
  [/(prophilo|rejuran)/i, 'Other Injectables'],
  [/(led)/i, 'LED'],
];
function pcnCategory_(dateRaw, service) {
  if (!String(dateRaw == null ? '' : dateRaw)) return '';
  const text = String(service == null ? '' : service);
  if (!text) return 'Add Ons';
  for (let i = 0; i < PCN_CATEGORY_RULES_.length; i++) {
    if (PCN_CATEGORY_RULES_[i][0].test(text)) return PCN_CATEGORY_RULES_[i][1];
  }
  return 'Other';
}

// cleanPatientNames (display name: the " NEW" marker removed, casing kept)
function pcnCleanPatientName_(value) {
  if (!value) return '';
  return String(value)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+NEW$/, '')
    .trim();
}

// populatePatientId's normalizeName (for matching only)
function pcnNormalizeName_(name) {
  if (!name) return '';
  let s = String(name)
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[Xx]+(?=\s|[A-Z])\s*/, ''); // "X Jane Smith" / "XJane" (archived in Timely), but not "Xavier"
  s = s.replace(/\s+NEW$/i, '');
  s = s.replace(/[^A-Za-z ]+$/, '');
  return s.trim().toLowerCase();
}

// cleanStaff (order matters)
function pcnCleanStaff_(value) {
  if (!value) return '';
  const text = String(value).replace(/[\*\^]/g, '').replace(/\s+/g, ' ').trim();
  if (/Dr\s*Teh/i.test(text)) return 'Dr Teh';
  if (/Archived/i.test(text)) return 'Nurse';
  if (/Jacquie/i.test(text)) return 'Jacquie';
  if (/Joshna/i.test(text)) return 'Joshna';
  if (/Allie/i.test(text)) return 'Allie';
  if (/Eva/i.test(text)) return 'Eva';
  if (/Brooke/i.test(text)) return 'Brooke';
  if (/Jess/i.test(text)) return 'Jess';
  if (/Rebekah/i.test(text)) return 'Rebekah';
  if (/Jody/i.test(text)) return 'Jody';
  if (/Dermedica Pk/i.test(text)) return 'Park Room';
  if (/Tahlya/i.test(text)) return 'Tahlya';
  return text;
}

/* ---------- Matching Timely names to patients ---------- */
// Tried in order. The first step that knows the name decides; two different patients at that step → left blank.
//  1 link       a name someone linked in Daily uploads (patient_name_links), or marked "Not a patient"
//  2 exact      capitals, extra spaces, " NEW" and an "X" in front ignored (as before)
//  3 clean      notes in brackets or quotes, "}}", "**", "!!" and punctuation removed; a nickname or maiden name
//               in brackets is also tried ("Theodosia (Sia) Florias" → "Sia Florias", "Debora Orme (Waller)" → "Debora Waller")
//  4 order      the same words in any order
//  5 first+last middle names ignored
//  6 words      invoices only: the most shared words (2 or more)
// Staff bookings aren't patients and are left out of the not-found list.
// A numbered name ("Sharon White #2") means there are two people with that name: only an exact match or a link.

const PT_LINKS_ = 'patient_name_links';
const PT_NOT_PATIENT_RE_ = /\bstaff\b|clinic\s*co-?ordinator/i;
const PT_NUMBERED_RE_ = /#\s*\d/;

function ptBase_(s) {
  return String(s == null ? '' : s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\u00A0\s]+/g, ' ')
    .replace(/[\u2018\u2019\u02BC`\u00B4]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .toLowerCase().trim();
}

// The key a link is saved under: the name as Timely writes it (so "Sharon White #1" and "#2" stay separate)
function ptLinkKey_(s) { return ptBase_(s).replace(/\s+new$/, '').trim(); }

function ptClean_(s) {
  return ptBase_(String(s == null ? '' : s).replace(/^[\s*!#]*[Xx]+(?=\s|[A-Z])/, ''))
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|"[^"]*"/g, ' ')  // notes in brackets or quotes
    .replace(/[(){}\[\]"].*$/, ' ')                           // a stray bracket: the rest is a note ("Gleeson } BF")
    .replace(/#\s*\d+/g, ' ')
    .replace(/'/g, '')                                         // O'Donoghue = ODonoghue
    .replace(/[^a-z]+/g, ' ')                                  // hyphens, "!!", "**", digits
    .replace(/\s+/g, ' ').trim()
    .replace(/ new$/, '');
}

// A single word in brackets or quotes, tried as the first name and as the surname
function ptAlts_(raw, clean) {
  const toks = clean ? clean.split(' ') : [];
  if (toks.length < 2) return [];
  const out = [];
  const re = /\(([^)]*)\)|"([^"]*)"|\u201C([^\u201D]*)\u201D/g;
  const s = String(raw == null ? '' : raw);
  let m;
  while ((m = re.exec(s))) {
    const w = ptClean_(m[1] || m[2] || m[3] || '');
    if (w.length < 2 || w.indexOf(' ') !== -1) continue;
    out.push([w].concat(toks.slice(1)).join(' '), toks.slice(0, -1).concat([w]).join(' '));
  }
  return out;
}
function ptSorted_(c) { return c ? c.split(' ').sort().join(' ') : ''; }
function ptFirstLast_(c) { const t = c ? c.split(' ') : []; return t.length >= 2 ? t[0] + ' ' + t[t.length - 1] : ''; }

function ptTop_(o, n) {
  return Object.keys(o).sort(function (a, b) { return o[b] - o[a]; }).slice(0, n || 30)
    .map(function (k) { return { name: k, rows: o[k] }; });
}

// key → Patient ID, or null when two different patients share it. Firestore wins for any key it has.
function ptMapMulti_(entries, keysFn) {
  const map = Object.create(null);
  const fromFs = Object.create(null);
  const add = function (e, isFs) {
    uniq_(keysFn(e[1]).filter(Boolean)).forEach(function (k) {
      if (!isFs && fromFs[k]) return;
      if (isFs) fromFs[k] = true;
      map[k] = (k in map && map[k] !== e[0]) ? null : e[0];
    });
  };
  entries.fs.forEach(function (e) { add(e, true); });
  entries.sheet.forEach(function (e) { add(e, false); });
  return map;
}

function ptWordMatcher_(entries) {
  const ids = [];
  const byWord = Object.create(null);
  const wordsOf = function (n) { return uniq_(ptClean_(n).split(' ').filter(function (w) { return w.length > 1; })); };
  entries.fs.concat(entries.sheet).forEach(function (e) {
    const w = wordsOf(e[1]);
    if (!w.length) return;
    const i = ids.push(e[0]) - 1;
    w.forEach(function (x) { (byWord[x] = byWord[x] || []).push(i); });
  });
  return function (name) {
    const score = {};
    wordsOf(name).forEach(function (w) { (byWord[w] || []).forEach(function (i) { score[i] = (score[i] || 0) + 1; }); });
    let best = 0;
    let top = {};
    Object.keys(score).forEach(function (i) {
      if (score[i] > best) { best = score[i]; top = {}; }
      if (score[i] === best) top[ids[i]] = true;
    });
    if (best < 2) return null;
    const list = Object.keys(top);
    return list.length === 1 ? { id: list[0], how: 'words' } : { id: '', how: 'ambiguous' };
  };
}

// Names linked in Daily uploads: { key: PttID or "-" (not a patient) }. Remembered 10 minutes.
function ptLinks_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('pt_links_v1');
  if (hit) return JSON.parse(hit);
  const out = {};
  try {
    fsListAll_(getConfig_(), PT_LINKS_, ['key', 'pttId']).forEach(function (d) {
      const f = fromFields_(d.fields || {});
      if (f.key && f.pttId) out[String(f.key)] = String(f.pttId);
    });
  } catch (e) { console.warn('Name links not read: ' + e); return out; }
  try { cache.put('pt_links_v1', JSON.stringify(out), 600); } catch (e) { /* not essential */ }
  return out;
}

// name → { id, how }   how: link · exact · clean · order · firstlast · words · ambiguous · skip · none · blank
function ptMatcher_(ss, tab, opts) {
  opts = opts || {};
  const entries = ptEntries_(ss, tab);
  const links = ptLinks_();
  const tiers = [
    ['exact', function (n) { return [pcnNormalizeName_(n)]; }],
    ['clean', function (n) { const c = ptClean_(n); return [c].concat(ptAlts_(n, c)); }],
    ['order', function (n) { return [ptSorted_(ptClean_(n))]; }],
    ['firstlast', function (n) { return [ptFirstLast_(ptClean_(n))]; }],
  ];
  const maps = tiers.map(function (t) { return ptMapMulti_(entries, t[1]); });
  const words = opts.words ? ptWordMatcher_(entries) : null;
  const memo = Object.create(null);
  return function (name) {
    const raw = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
    if (!raw) return { id: '', how: 'blank' };
    if (memo[raw]) return memo[raw];
    let res = null;
    const lk = ptLinkKey_(raw);
    const link = Object.prototype.hasOwnProperty.call(links, lk) ? links[lk] : '';
    if (link) res = link === '-' ? { id: '', how: 'skip' } : { id: link, how: 'link' };
    else if (PT_NOT_PATIENT_RE_.test(raw)) res = { id: '', how: 'skip' };
    else {
      const upto = PT_NUMBERED_RE_.test(raw) ? 1 : tiers.length;
      for (let i = 0; i < upto && !res; i++) {
        const found = {};
        let seen = false;
        tiers[i][1](raw).forEach(function (k) {
          if (!k || !(k in maps[i])) return;
          seen = true;
          found[maps[i][k] || '?'] = true;
        });
        if (!seen) continue;
        const ids = Object.keys(found);
        res = ids.length === 1 && ids[0] !== '?' ? { id: ids[0], how: tiers[i][0] } : { id: '', how: 'ambiguous' };
      }
      if (!res && words && upto > 1) res = words(raw);
    }
    return (memo[raw] = res || { id: '', how: 'none' });
  };
}

/* ---------- Daily uploads: link a name, then fill in the missing Patient IDs ---------- */

function upPtSearch_(body) {
  const words = uniq_(ptClean_(String(body.q || '').slice(0, 120)).split(' ').filter(function (w) { return w.length > 1; }));
  if (!words.length) return { ok: true, results: [] };
  const need = words.length >= 3 ? 2 : 1;
  const out = [];
  ptFsEntries_().list.forEach(function (p) {
    let best = 0;
    p[1].forEach(function (n) {
      const toks = ptClean_(n).split(' ');
      const hit = words.filter(function (w) { return toks.some(function (t) { return t.indexOf(w) === 0; }); }).length;
      if (hit > best) best = hit;
    });
    if (best >= need) out.push({ id: p[0], name: p[1][0], also: p[1].slice(1, 3), mobile: p[2] || '', dob: p[3] || '', score: best });
  });
  out.sort(function (a, b) { return b.score - a.score || a.name.localeCompare(b.name); });
  return { ok: true, results: out.slice(0, 12) };
}

function upPtLink_(body, session) {
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const key = ptLinkKey_(name);
  if (!key) return { ok: false, error: 'BAD_REQUEST' };
  const cfg = getConfig_();
  const path = PT_LINKS_ + '/n_' + flowHash_(key);
  if (body.remove === true) {
    commitWrites_(cfg, [deleteWrite_(cfg, path)]);
  } else {
    let id = '-';
    if (body.notPatient !== true) {
      id = String(body.pttId || '').trim();
      if (!ptFsEntries_().list.some(function (p) { return p[0] === id; })) {
        return { ok: true, problem: "That patient isn't in the Patient List (or was merged into another record)." };
      }
    }
    commitWrites_(cfg, [updateWrite_(cfg, path, {
      key: key, name: name, pttId: id, by: String(session.name || ''), byUid: String(session.uid || ''),
      at: new Date().toISOString(),
    })]);
  }
  CacheService.getScriptCache().remove('pt_links_v1');
  return { ok: true };
}

function upRefillDef_(kind) {
  if (kind === 'daysheet') return { file: APPTS_SHEET_ID, tab: UPLOAD_TABS_.daysheet, nameCol: 2, idCol: 15, pt: UPLOAD_TABS_.patients, busy: 'up_ds_active' };
  if (kind === 'packages') return { file: APPTS_SHEET_ID, tab: UP_PKG_TAB_, nameCol: 1, idCol: 13, pt: UPLOAD_TABS_.patients, busy: 'up_pkg_active' };
  if (kind === 'invoices') return { file: SSP_SHEET_ID, tab: UP_INV_TAB_, nameCol: 3, idCol: 4, pt: UP_INV_PTT_TAB_, busy: 'up_inv_active', words: true };
  return null;
}

// Fills in only the blank Patient IDs (IDs already there are never changed)
function upRefill_(body, session) {
  const kind = String(body.kind || '');
  const def = upRefillDef_(kind);
  if (!def) return { ok: false, error: 'BAD_REQUEST' };
  const cache = CacheService.getScriptCache();
  const busy = cache.get(def.busy);
  if (busy && Date.now() - Number(busy) < 3 * 60000) {
    return { ok: true, problem: 'An upload is running. Try again when it has finished.' };
  }
  cache.put(def.busy, String(Date.now()), 600);
  try {
    const started = Date.now();
    const ss = SpreadsheetApp.openById(def.file);
    const sh = ss.getSheetByName(def.tab);
    if (!sh) throw new Error('Sheet tab not found: ' + def.tab);
    const last = sh.getLastRow();
    const res = { ok: true, kind: kind, rows: Math.max(0, last - 1), filled: 0, skipped: 0 };
    const unmatched = {};
    const ambiguous = {};
    if (last >= 2) {
      const names = sh.getRange(2, def.nameCol, last - 1, 1).getDisplayValues();
      const idRange = sh.getRange(2, def.idCol, last - 1, 1);
      const ids = idRange.getValues();
      const match = ptMatcher_(ss, def.pt, { words: def.words });
      ids.forEach(function (r, i) {
        if (String(r[0] == null ? '' : r[0]).trim()) return;
        const name = String(names[i][0] || '').trim();
        if (!name) return;
        const m = match(name);
        if (m.id) { r[0] = m.id; res.filled++; }
        else if (m.how === 'skip') res.skipped++;
        else {
          const b = m.how === 'ambiguous' ? ambiguous : unmatched;
          b[name] = (b[name] || 0) + 1;
        }
      });
      if (res.filled) { idRange.setValues(ids); SpreadsheetApp.flush(); }
    }
    res.unmatched = { names: Object.keys(unmatched).length, sample: ptTop_(unmatched, 40) };
    res.ambiguous = { names: Object.keys(ambiguous).length, sample: ptTop_(ambiguous, 40) };
    res.ms = Date.now() - started;
    try {
      fsPatch_(getConfig_(), 'data_uploads/' + kind, {
        unmatchedNames: res.unmatched.names + res.ambiguous.names,
        refilledAt: new Date().toISOString(), refilledBy: String(session.name || ''),
      });
    } catch (e) { console.warn('Refill log not saved: ' + e); }
    console.log(def.tab + ': ' + res.filled + ' Patient ID(s) filled in by ' + session.name);
    return res;
  } finally {
    cache.remove(def.busy);
  }
}

// ===================== Marketing: consent, unsubscribe and the do-not-email list =====================
// Every patient can receive marketing emails unless they're on the do-not-contact list:
//   · patient_list/{id}: 'Marketing OK' false (missing = yes) and 'Marketing Consent' { status, at, by, source, note }
//   · email_suppress/{hash of the email}: unsubscribed (email link), dnc (added by staff) or bounced addresses.
//     Kept per address, so it also covers duplicate patient records that share an email.
//   · marketing_consent_log: every change, kept as the record (Spam Act 2003).
// Unsubscribe links are signed per patient + email, so a link can't be changed to unsubscribe someone else.

const MKT_SUPPRESS_ = 'email_suppress';
const MKT_LOG_ = 'marketing_consent_log';
const MKT_PAGE_ = PORTAL_URL_ + 'unsubscribe.html';
const MKT_SOURCES_ = ['Told staff', 'Do not contact list', 'New patient form', 'Update details form', 'Replied by email',
  'Imported', 'Unsubscribe link', 'Resubscribed', 'Replied STOP to a text'];
const MKT_DNC_REASONS_ = ['Asked not to be contacted', 'Opted out', 'Complained', 'Other'];

/* ---------- Signed unsubscribe links ---------- */

// Secret for unsubscribe links. Lives only in Script Properties. Changing it breaks every link already sent.
function mktKey_() {
  const p = PropertiesService.getScriptProperties();
  let v = p.getProperty('MARKETING_KEY');
  if (!v) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      v = p.getProperty('MARKETING_KEY');
      if (!v) { v = Utilities.getUuid() + Utilities.getUuid(); p.setProperty('MARKETING_KEY', v); }
    } finally { lock.releaseLock(); }
  }
  return v;
}

function mktEmail_(e) { return String(e || '').trim().toLowerCase(); }
function mktEmailKey_(e) { return 'e_' + flowHash_(mktEmail_(e)); }
function mktSig_(payload) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payload, mktKey_())).replace(/=+$/, '').slice(0, 32);
}

// "u1.<patient, email, campaign>.<signature>"
function mktToken_(pid, email, campaignId) {
  const payload = 'u1.' + b64url_(JSON.stringify([String(pid || ''), mktEmail_(email), String(campaignId || '')]));
  return payload + '.' + mktSig_(payload);
}

function mktReadToken_(t) {
  const m = /^u1\.([A-Za-z0-9_-]{4,800})\.([A-Za-z0-9_-]{32})$/.exec(String(t || ''));
  if (!m) return null;
  if (mktSig_('u1.' + m[1]) !== m[2]) return null;
  try {
    const s = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const a = JSON.parse(Utilities.newBlob(Utilities.base64Decode(s + '==='.slice((s.length + 3) % 4))).getDataAsString());
    return Array.isArray(a) && isEmail_(a[1]) ? { pid: String(a[0] || ''), email: a[1], cid: String(a[2] || '') } : null;
  } catch (e) { return null; }
}

// The link that goes in the footer of every marketing email
function mktUnsubUrl_(pid, email, campaignId) {
  return MKT_PAGE_ + '?t=' + encodeURIComponent(mktToken_(pid, email, campaignId));
}

function mktMask_(email) {
  const m = /^([^@]{1,2})[^@]*(@.+)$/.exec(mktEmail_(email));
  return m ? m[1] + '•••' + m[2] : '';
}

/* ---------- Who can be emailed ---------- */

// Is this address on the do-not-contact list? { reason, at, … } or null
function mktSuppressed_(cfg, email) {
  if (!isEmail_(mktEmail_(email))) return null;
  try { return fsGetDoc_(cfg, MKT_SUPPRESS_ + '/' + mktEmailKey_(email)); }
  catch (e) { return { reason: 'unknown', at: '' }; }   // unsure: treat as suppressed, never risk it
}

// Every patient can be sent marketing unless they're turned off ('Marketing OK' false) or their address
// is on the do-not-contact list (unsubscribed, added by staff, or bounced).
function mktCanEmail_(cfg, patientDoc, email) {
  const to = mktEmail_(email || (patientDoc && patientDoc.Email));
  if (!patientDoc || patientDoc['Marketing OK'] === false || !isEmail_(to)) return false;
  return !mktSuppressed_(cfg, to);
}

// The footer every marketing email ends with: who it's from and a working unsubscribe link (Spam Act 2003)
function mktFooterHtml_(pid, email, campaignId) {
  if (!isEmail_(mktEmail_(email))) return '';
  const addr = String(PropertiesService.getScriptProperties().getProperty('MKT_FOOTER_ADDRESS') || '').trim();
  return '<div style="margin:24px 0 0;padding:14px 0 0;border-top:1px solid #e5e7eb;font-family:Arial,Helvetica,sans-serif;' +
    'font-size:12px;line-height:1.5;color:#94a3b8;text-align:center">' +
    'Sent by Dermedica' + (addr ? ' · ' + invEsc_(addr) : '') + '. You\'re receiving this because you\'re a Dermedica patient.<br>' +
    '<a href="' + invEsc_(mktUnsubUrl_(pid, email, campaignId)) + '" style="color:#64748b;text-decoration:underline">Unsubscribe</a>' +
    ' from news and offers. You\'ll still get emails about your appointments.</div>';
}

/* ---------- Changing consent ---------- */

// Sets consent on the patient (following a merge), updates the do-not-contact list and logs it, in one commit.
// meta: { by, byUid, source, note, email, campaignId, dnc (added by staff), why }
function mktSetConsent_(cfg, pid, yes, meta) {
  meta = meta || {};
  const now = new Date().toISOString();
  const pdoc = pid ? flowPatient_(cfg, pid) : null;
  const email = mktEmail_(meta.email || (pdoc && pdoc.Email));
  const source = MKT_SOURCES_.indexOf(meta.source) !== -1 ? meta.source : 'Told staff';
  const patientId = pdoc ? pdoc._id : String(pid || '');
  const writes = [];

  if (pdoc) {
    writes.push(patchWrite_(cfg, 'patient_list/' + pdoc._id, {
      'Marketing OK': yes,
      'Marketing Consent': {
        status: yes ? 'yes' : 'no', at: now, by: String(meta.by || ''), byUid: String(meta.byUid || ''),
        source: source, note: String(meta.note || '').slice(0, 300),
      },
    }));
  }
  if (isEmail_(email)) {
    const path = MKT_SUPPRESS_ + '/' + mktEmailKey_(email);
    if (!yes) {
      writes.push(updateWrite_(cfg, path, {
        email: email, reason: meta.dnc ? 'dnc' : 'unsubscribed', why: String(meta.why || '').slice(0, 80),
        note: String(meta.note || '').slice(0, 300), at: now, by: String(meta.by || ''),
        patientId: patientId, source: source, campaignId: String(meta.campaignId || ''),
      }));
    } else {
      // Saying yes lifts an unsubscribe or a staff entry, but never a bounce (that address doesn't work)
      const cur = mktSuppressed_(cfg, email);
      if (cur && cur.reason !== 'bounced') writes.push(deleteWrite_(cfg, path));
    }
  }
  writes.push(updateWrite_(cfg, MKT_LOG_ + '/c_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
    patientId: patientId, patientName: pdoc ? flowWho_(pdoc).name : '',
    email: email, status: yes ? 'yes' : 'no', source: source, why: String(meta.why || '').slice(0, 80),
    note: String(meta.note || '').slice(0, 300), by: String(meta.by || ''), byUid: String(meta.byUid || ''),
    campaignId: String(meta.campaignId || ''), at: now,
  }));
  commitWrites_(cfg, writes);

  // Their open recall cards show the change straight away (the daily check also keeps them right)
  if (patientId) {
    try {
      const dn = yes ? { dnc: false, dncWhy: '' }
        : { dnc: true, dncWhy: [source, recLongDate_(now.slice(0, 10))].filter(Boolean).join(' · ') };
      const cw = fsQuery_(cfg, RECALL_COL_, 'patientId', 'EQUAL', patientId, 50)
        .filter(function (c) { return c.status !== 'closed'; })
        .map(function (c) { return patchWrite_(cfg, RECALL_COL_ + '/' + c._id, dn); });
      if (cw.length) commitWrites_(cfg, cw);
    } catch (e) { console.warn('Recall cards not updated for do not contact: ' + e); }
  }
  return { patientId: pdoc ? pdoc._id : '', email: email };
}

/* ---------- Staff: Task Manager → Marketing, and the patient page ---------- */

function handleMarketing_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const op = String(body.op || '');
  const manage = can_(session, 'marketing.manage');
  try {
    const cfg = getConfig_();
    if (op === 'setConsent') {   // the patient page
      if (!can_(session, 'patients.edit') && !manage) return { ok: false, error: 'FORBIDDEN' };
      const pid = String(body.patientId || '').trim();
      if (!recDocIdOk_(pid)) return { ok: false, error: 'BAD_REQUEST' };
      const r = mktSetConsent_(cfg, pid, body.yes === true, {
        by: session.name, byUid: session.uid, source: String(body.source || 'Told staff'), note: String(body.note || ''),
        dnc: body.yes !== true,
      });
      return r.patientId ? { ok: true, patientId: r.patientId } : { ok: false, error: 'NO_PATIENT' };
    }
    if (!manage) return { ok: false, error: 'FORBIDDEN' };
    if (op === 'list') return { ok: true, rows: mktList_(cfg) };
    if (op === 'search') return upPtSearch_(body);
    if (op === 'block') return mktBlock_(cfg, body, session);
    if (op === 'blockMany') return mktBlockMany_(cfg, body, session);
    if (op === 'unblock') return mktUnblock_(cfg, body, session);
    if (op === 'testTemplate') return mktTestTemplate_(cfg, body, session);
    if (op === 'campaignCount') return mktCount_(cfg, body, session);
    if (op === 'campaignSchedule') return mktSchedule_(cfg, body, session);
    if (op === 'campaignControl') return mktControl_(cfg, body, session);
    if (op === 'link') {   // a test unsubscribe link for a patient
      const p = flowPatient_(cfg, String(body.patientId || ''));
      if (!p || !isEmail_(p.Email)) return { ok: false, error: 'NO_EMAIL' };
      return { ok: true, url: mktUnsubUrl_(p._id, p.Email, 'test') };
    }
  } catch (err) {
    console.error('Marketing ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

// Everyone on the do-not-contact list: suppressed addresses, plus patients turned off who have no address on it
function mktList_(cfg) {
  const out = Object.create(null);
  fsListAll_(cfg, MKT_SUPPRESS_).forEach(function (d) {
    const f = fromFields_(d.fields || {});
    const k = d.name.split('/').pop();
    out[k] = {
      key: k, email: String(f.email || ''), reason: String(f.reason || 'unsubscribed'), why: String(f.why || ''),
      note: String(f.note || ''), source: String(f.source || ''), at: String(f.at || ''), by: String(f.by || ''),
      patientId: String(f.patientId || ''), name: '',
    };
  });
  fsQuery_(cfg, 'patient_list', quoteField_('Marketing OK'), 'EQUAL', false, 3000).forEach(function (p) {
    if (p.MergedInto) return;
    const email = mktEmail_(p.Email);
    const k = isEmail_(email) ? mktEmailKey_(email) : 'p_' + p._id;
    if (out[k]) { out[k].patientId = out[k].patientId || p._id; out[k].name = flowWho_(p).name; return; }
    const c = p['Marketing Consent'] || {};
    out[k] = {
      key: k, email: email, reason: 'dnc', why: '', note: String(c.note || ''), source: String(c.source || ''),
      at: String(c.at || ''), by: String(c.by || ''), patientId: p._id, name: flowWho_(p).name,
    };
  });
  const rows = Object.keys(out).map(function (k) { return out[k]; });
  const need = rows.filter(function (r) { return r.patientId && !r.name; });
  if (need.length) {
    const got = fsBatchGet_(cfg, uniq_(need.map(function (r) { return 'patient_list/' + r.patientId; })));
    need.forEach(function (r) { const p = got['patient_list/' + r.patientId]; if (p) r.name = flowWho_(p).name; });
  }
  return rows.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
}

function mktBlock_(cfg, body, session) {
  const pid = String(body.patientId || '').trim();
  const email = mktEmail_(body.email);
  if (!pid && !isEmail_(email)) return { ok: false, error: 'BAD_REQUEST' };
  if (pid && !recDocIdOk_(pid)) return { ok: false, error: 'BAD_REQUEST' };
  const why = MKT_DNC_REASONS_.indexOf(body.why) !== -1 ? body.why : 'Other';
  const r = mktSetConsent_(cfg, pid, false, {
    by: session.name, byUid: session.uid, source: 'Do not contact list', note: String(body.note || ''),
    email: email, dnc: true, why: why,
  });
  if (pid && !r.patientId) return { ok: false, error: 'NO_PATIENT' };
  return { ok: true, noEmail: !isEmail_(r.email) };
}

// Pasted addresses: each goes on the list, and any patient with that address is turned off too
function mktBlockMany_(cfg, body, session) {
  const emails = uniq_((Array.isArray(body.emails) ? body.emails : []).map(mktEmail_).filter(isEmail_)).slice(0, 1000);
  if (!emails.length) return { ok: false, error: 'BAD_REQUEST' };
  const why = MKT_DNC_REASONS_.indexOf(body.why) !== -1 ? body.why : 'Opted out';
  const byEmail = Object.create(null);
  fsListAll_(cfg, 'patient_list', ['Email', 'MergedInto']).forEach(function (d) {
    const f = fromFields_(d.fields || {});
    const e = mktEmail_(f.Email);
    if (isEmail_(e) && !f.MergedInto) (byEmail[e] = byEmail[e] || []).push(d.name.split('/').pop());
  });
  const now = new Date().toISOString();
  const by = String(session.name || '');
  const consent = { status: 'no', at: now, by: by, byUid: String(session.uid || ''), source: 'Do not contact list', note: why };
  const writes = [];
  let matched = 0;
  emails.forEach(function (e) {
    const pids = byEmail[e] || [];
    if (pids.length) matched++;
    writes.push(updateWrite_(cfg, MKT_SUPPRESS_ + '/' + mktEmailKey_(e), {
      email: e, reason: 'dnc', why: why, note: 'Added from a pasted list', at: now, by: by,
      patientId: pids[0] || '', source: 'Do not contact list', campaignId: '',
    }));
    pids.forEach(function (id) {
      writes.push(patchWrite_(cfg, 'patient_list/' + id, { 'Marketing OK': false, 'Marketing Consent': consent }));
    });
    writes.push(updateWrite_(cfg, MKT_LOG_ + '/c_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
      patientId: pids[0] || '', patientName: '', email: e, status: 'no', source: 'Do not contact list', why: why,
      note: 'Added from a pasted list', by: by, byUid: String(session.uid || ''), campaignId: '', at: now,
    }));
  });
  commitWrites_(cfg, writes, 300);
  console.log('Do not contact: ' + emails.length + ' address(es) added by ' + by);
  return { ok: true, added: emails.length, matched: matched };
}

function mktUnblock_(cfg, body, session) {
  const pid = String(body.patientId || '').trim();
  const email = mktEmail_(body.email);
  const note = String(body.note || '').trim().slice(0, 300);
  if (!note) return { ok: true, problem: 'Add a note saying why they can be contacted again.' };
  if (!pid && !isEmail_(email)) return { ok: false, error: 'BAD_REQUEST' };
  const cur = isEmail_(email) ? mktSuppressed_(cfg, email) : null;
  if (cur && cur.reason === 'bounced') {
    return { ok: true, problem: "Emails to this address bounce, so it stays on the list. Update the patient's email address instead." };
  }
  mktSetConsent_(cfg, pid, true, { by: session.name, byUid: session.uid, source: 'Told staff', note: note, email: email });
  return { ok: true };
}

/* ---------- Email templates: send a test ---------- */
// The template's finished email is saved in mkt_templates/{id}.html by the portal. Only {First name} / {Full name}
// are filled in here, and the footer goes where the template keeps room for it.
// Pictures are hosted (Firebase Storage), so they're left as they are (not attached).

const MKT_TEMPLATES_ = 'mkt_templates';

function mktPlaceFooter_(html, footer) {
  const re = /<div data-mkt-footer=""><\/div>/;
  return re.test(html) ? html.replace(re, function () { return footer; }) : html + footer;
}

function mktTestTemplate_(cfg, body, session) {
  const id = String(body.templateId || '');
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  const t = fsGetDoc_(cfg, MKT_TEMPLATES_ + '/' + id);
  if (!t || t.status === 'archived') return { ok: true, problem: 'This template no longer exists.' };
  const to = uniq_((Array.isArray(body.to) ? body.to : []).map(mktEmail_).filter(isEmail_)).slice(0, 5);
  if (!to.length) return { ok: true, problem: 'Add an email address to send it to.' };
  const raw = String(t.html || '');
  if (!raw.trim()) return { ok: true, problem: 'The template is empty. Add a block first.' };

  const cache = CacheService.getScriptCache();
  const rk = 'mkt_test_' + session.uid;
  const used = Number(cache.get(rk) || 0);
  if (used + to.length > 30) return { ok: true, problem: "You've sent a lot of tests in the last hour. Try again a bit later." };
  if (MailApp.getRemainingDailyQuota() < to.length) return { ok: true, problem: "The clinic's daily email limit has been reached. Try again tomorrow." };

  // "Let me send the form for real": the form links work like a patient's own, for the patient chosen
  const real = body.real === true;
  const pid = String(body.patientId || '').trim();
  const p = pid && recDocIdOk_(pid) ? flowPatient_(cfg, pid) : null;
  if (real && !p) return { ok: true, problem: 'Choose the patient in "Fill in the tags as" to send the form for real.' };
  let who = { name: String(session.name || ''), first: String(session.name || '').split(' ')[0] };
  if (p) who = flowWho_(p);
  const parts = String(who.name || '').trim().split(/\s+/);
  const vals = { 'first name': who.first || 'there', 'last name': parts.length > 1 ? parts[parts.length - 1] : '',
    'full name': who.name || 'there', 'patient name': who.name || '' };
  const subject = '[Test] ' + (flowFill_(String(body.subject || t.subject || ''), vals, false).replace(/\s+/g, ' ').trim().slice(0, 190)
    || 'A message from Dermedica');
  const cid = real ? PF_TESTLIVE_ + Utilities.getUuid().replace(/-/g, '').slice(0, 16) : 'test';
  const filled = mktFormLinks_(sanitizeEmailHtml_(flowFillHtml_(raw, vals)), cid, p ? p._id : '');
  const banner = '<div style="margin:0 auto 12px;max-width:600px;padding:10px 14px;border:1px dashed #f59e0b;border-radius:10px;' +
    'background:#fffbeb;color:#92400e;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:1.5">' +
    '<strong>Test of the template "' + invEsc_(t.name || '') + '".</strong> Filled in as ' + invEsc_(who.name || 'you') + '. ' +
    (real ? '<strong>The form button works for real:</strong> sending the form saves it to ' + invEsc_(who.name) +
      '\'s record (marked as a test) and tells the staff. ' : '') +
    'The Unsubscribe link at the bottom works, so only press it if you want this address taken off marketing.</div>';

  to.forEach(function (addr) {
    const html = banner + mktPlaceFooter_(filled, mktFooterHtml_('', addr, 'test'));
    MailApp.sendEmail({ to: addr, subject: subject, htmlBody: html, body: emailHtmlToText_(html), name: 'Dermedica Clinic' });
  });
  cache.put(rk, String(used + to.length), 3600);
  console.log('Template "' + t.name + '" test sent to ' + to.length + ' address(es) by ' + session.name + (real ? ' (form for real)' : ''));
  return { ok: true, sent: to.length, to: to };
}


/* ===================== Marketing: campaigns ===================== */
// A campaign is drafted in the portal (mkt_campaigns/{id}, status "draft"). Scheduling takes a copy of the template's
// email, so changing the template afterwards never changes the campaign. When it's time, runCampaigns picks the
// patients (the same rules as Email flows), saves them in mkt_campaigns/{id}/queue, then sends in batches between
// 9 am and 6 pm Perth, keeping MKT_RESERVE_ of the day's emails free for the rest of the portal.
// The do-not-contact list is checked when the list is made and again just before each email goes.
// Statuses: draft → scheduled → building (choosing patients) → sending → sent. Also paused, cancelled.

const MKT_CAMPAIGNS_ = 'mkt_campaigns';
const MKT_CSTATE_ = 'mkt_campaign_state';   // Apps Script only: progress while choosing patients
const MKT_CHUNK_ = 250;                     // patients per queue document
const MKT_RESERVE_ = 300;                   // emails a day always left for appointments, forms and tasks
const MKT_PER_RUN_ = 120;                   // emails per 10-minute run
const MKT_DAILY_DEFAULT_ = 800;
// Send in batches: n emails every `mins` minutes (n 0 = all at once). The runner goes every 10 minutes,
// so batch times are multiples of 10.
const MKT_PACE_MINS_ = [10, 20, 30, 60, 120];
function mktPace_(p) {
  p = p || {};
  const n = Math.floor(Number(p.n) || 0);
  const mins = Number(p.mins) || 0;
  return n >= 10 && n <= 300 && MKT_PACE_MINS_.indexOf(mins) !== -1 ? { n: n, mins: mins } : { n: 0, mins: 0 };
}
// Rules that make sense without a purchase or visit (the same list as CAMPAIGN_FIELDS in js/mkt-campaigns.js)
const MKT_RULE_FIELDS_ = ['hist.bought', 'hist.bought_between', 'hist.days_since', 'appt.has_future', 'appt.next_days', 'appt.last_days', 'appt.visits',
  'appt.future_service', 'appt.past_service', 'appt.visit_between', 'appt.last_between', 'ssp.active', 'ssp.age_days', 'ssp.expiry_days', 'plan.status', 'plan.due',
  'plan.overdue', 'form.saved', 'pt.age', 'pt.birth_year', 'pt.birthday', 'pt.email', 'pt.mobile'];
// "Make a list from this": who, from an earlier campaign
const MKT_LIST_KINDS_ = ['opened', 'notOpened', 'clicked', 'notClicked', 'link'];

function mktAudience_(a) {
  a = a || {};
  const g = a.rules || {};
  const okRule = function (r) { return r && MKT_RULE_FIELDS_.indexOf(r.field) !== -1; };
  const rules = (Array.isArray(g.rules) ? g.rules : []).map(function (r) {
    if (r && Array.isArray(r.rules)) {   // a group: its allowed rules, with its own all / any
      const kids = r.rules.filter(okRule).slice(0, 20);
      return kids.length ? { id: String(r.id || ''), type: 'group', match: r.match === 'any' ? 'any' : 'all', rules: kids } : null;
    }
    return okRule(r) ? r : null;
  }).filter(Boolean).slice(0, 20);
  const l = a.list || {};
  const list = {
    campaignId: /^[A-Za-z0-9_-]{10,40}$/.test(String(l.campaignId || '')) ? String(l.campaignId) : '',
    kind: MKT_LIST_KINDS_.indexOf(l.kind) !== -1 ? String(l.kind) : 'opened',
    link: Math.max(0, Math.min(39, Math.floor(Number(l.link) || 0))),
    name: String(l.name || '').slice(0, 120), label: String(l.label || '').slice(0, 80),
  };
  const mode = a.mode === 'rules' ? 'rules' : (a.mode === 'list' && list.campaignId ? 'list' : 'all');
  // Patients left out by hand in the portal (kept when the campaign is scheduled)
  const exclude = (Array.isArray(a.exclude) ? a.exclude : []).slice(0, 500).map(function (x) {
    return { id: String((x && x.id) || '').slice(0, 80), name: String((x && x.name) || '').slice(0, 120),
      email: mktEmail_((x && x.email) || '').slice(0, 254) };
  }).filter(function (x) { return x.id; });
  // Earlier campaigns: anyone they were sent to is left out (kept when the campaign is scheduled)
  const skip = [];
  const seenSkip = {};
  (Array.isArray(a.skip) ? a.skip : []).forEach(function (x) {
    const id = String((x && x.id) || '');
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(id) || seenSkip[id] || skip.length >= 20) return;
    seenSkip[id] = true;
    skip.push({ id: id, name: String((x && x.name) || '').slice(0, 120) });
  });
  return { mode: mode, rules: { match: g.match === 'any' ? 'any' : 'all', rules: rules }, list: list, exclude: exclude, skip: skip };
}

// The patients left out by hand, and their email addresses (a shared address is left out too)
function mktExcluded_(aud) {
  const ids = {}, emails = {};
  (aud.exclude || []).forEach(function (x) {
    ids[x.id] = true;
    if (isEmail_(x.email)) emails[x.email] = true;
  });
  return { ids: ids, emails: emails };
}

// Patients (and their addresses) already sent the campaigns chosen in "Leave out anyone already sent".
// Only the part of each queue it has reached so far, and not anyone whose email failed.
function mktSkipSet_(cfg, aud, selfId) {
  const ids = {}, emails = {};
  (aud.skip || []).forEach(function (s) {
    if (s.id === selfId) return;
    const base = MKT_CAMPAIGNS_ + '/' + s.id;
    const c = fsGetDoc_(cfg, base);
    if (!c) return;
    const upto = Number(c.cursor || 0);
    const failed = {};
    (Array.isArray(c.failures) ? c.failures : []).forEach(function (f) { if (f && f.patientId) failed[String(f.patientId)] = true; });
    const paths = [];
    for (let i = 0; i < Number(c.chunks || 0); i++) paths.push(base + '/queue/q' + i);
    const got = paths.length ? fsBatchGet_(cfg, paths) : {};
    Object.keys(got).forEach(function (k) {
      const q = Number((/\/q(\d+)$/.exec(k) || [])[1] || 0);
      (got[k].list || []).forEach(function (r, j) {
        const id = docId_(r.p);
        if (!id || q * MKT_CHUNK_ + j >= upto || failed[id]) return;
        ids[id] = true;
        const e = mktEmail_(r.e);
        if (isEmail_(e)) emails[e] = true;
      });
    });
  });
  return { ids: ids, emails: emails };
}

// Takes them off the pool, and notes how many (shown under Count patients)
function mktSkipPool_(cfg, aud, pool, selfId) {
  pool.stats.alreadySent = 0;
  if (!aud.skip || !aud.skip.length) return;
  const s = mktSkipSet_(cfg, aud, selfId);
  const before = pool.list.length;
  pool.list = pool.list.filter(function (e) { return !s.ids[e.doc._id] && !s.emails[e.email]; });
  pool.stats.alreadySent = before - pool.list.length;
}

// One patient for the "See who" list in the portal
const MKT_PEOPLE_MAX_ = 3000;
function mktPerson_(e, today) {
  const v = planVisits_(e.pre, [], today).filter(function (x) { return !x.future; });
  return { id: e.doc._id, name: flowWho_(e.doc).name, email: e.email, last: v.length ? v[v.length - 1].dateKey : '' };
}
function mktNeedsVisits_(aud) { return aud.mode !== 'all' && aud.rules.rules.length > 0; }

// Why a list from an earlier campaign can't be used, or ''
function mktListProblem_(cfg, aud, selfId) {
  if (aud.mode !== 'list') return '';
  if (selfId && aud.list.campaignId === selfId) return "A campaign can't use its own results.";
  const src = fsGetDoc_(cfg, MKT_CAMPAIGNS_ + '/' + aud.list.campaignId);
  if (!src || !Number(src.sent || 0)) return "The campaign this list comes from hasn't sent any emails yet.";
  if (src.track !== true) return "That campaign didn't track opens and clicks, so there's no list to make.";
  return '';
}

// Everyone who can be sent marketing: one per email address (merged duplicates and shared addresses count once),
// with an email, not turned off and not on the do-not-contact list. withVisits: their visits too, for the rules.
function mktPool_(cfg, withVisits) {
  const supp = {};
  fsListAll_(cfg, MKT_SUPPRESS_, ['email']).forEach(function (d) { supp[d.name.split('/').pop()] = true; });
  const pres = {};
  if (withVisits) {
    fsListAll_(cfg, 'pcn_results', ['patientId'].concat(PLAN_VISIT_FIELDS_)).forEach(function (d) {
      const o = fromFields_(d.fields || {});
      o._key = d.name.split('/').pop();
      pres[o._key] = o;
    });
  }
  const stats = { patients: 0, noEmail: 0, optedOut: 0, shared: 0 };
  const seen = {};
  const list = [];
  fsListAll_(cfg, 'patient_list', ['PttID', 'Patient Name', 'First Name', 'Last Name', 'Email', 'Mobile', 'DobKey',
    'Marketing OK', 'MergedInto', 'MergedIds', 'MergedNames']).forEach(function (d) {
    const f = fromFields_(d.fields || {});
    if (f.MergedInto) return;
    f._id = d.name.split('/').pop();
    stats.patients++;
    const email = mktEmail_(f.Email);
    if (!isEmail_(email)) { stats.noEmail++; return; }
    if (f['Marketing OK'] === false || supp[mktEmailKey_(email)]) { stats.optedOut++; return; }
    const key = docId_(f.PttID || f._id);
    list.push({ key: f._id, doc: f, email: email, pre: pres[key] || { patientId: String(f.PttID || f._id), _key: key } });
  });
  list.sort(function (a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; });
  const out = list.filter(function (e) {
    if (seen[e.email]) { stats.shared++; return false; }
    seen[e.email] = true;
    return true;
  });
  return { list: out, stats: stats };
}

// Lists every document under a path such as "mkt_campaigns/<id>/clicks" (fsListAll_ only does top-level collections)
function mktListPath_(cfg, path, maskFields) {
  const mask = (maskFields || []).map(function (f) { return '&mask.fieldPaths=' + encodeURIComponent(quoteField_(f)); }).join('');
  const docs = [];
  let pageToken = '';
  let pages = 0;
  do {
    const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + '/' + path + '?pageSize=300' + mask +
      (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''), {
      headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) }, muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) throw new Error('Firestore list ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
    const body = JSON.parse(res.getContentText());
    (body.documents || []).forEach(function (d) { docs.push(d); });
    pageToken = body.nextPageToken || '';
    pages++;
  } while (pageToken && pages < 200);
  return docs;
}

// The patients in a list from an earlier campaign: { patientDocId: true }
function mktListSet_(cfg, list) {
  const base = MKT_CAMPAIGNS_ + '/' + list.campaignId;
  const ids = function (sub) {
    const s = {};
    listDocIds_(cfg, base + '/' + sub).forEach(function (x) { s[x] = true; });
    return s;
  };
  if (list.kind === 'opened') return ids('opens');
  if (list.kind === 'clicked') return ids('clicks');
  if (list.kind === 'link') {
    const s = {};
    mktListPath_(cfg, base + '/clicks', ['links']).forEach(function (d) {
      const f = fromFields_(d.fields || {});
      if ((Array.isArray(f.links) ? f.links : []).map(Number).indexOf(list.link) !== -1) s[d.name.split('/').pop()] = true;
    });
    return s;
  }
  // Didn't open / didn't click: everyone it reached so far, less those who did
  const src = fsGetDoc_(cfg, base) || {};
  const not = ids(list.kind === 'notOpened' ? 'opens' : 'clicks');
  const upto = Number(src.cursor || 0);
  const paths = [];
  for (let i = 0; i < Number(src.chunks || 0); i++) paths.push(base + '/queue/q' + i);
  const got = paths.length ? fsBatchGet_(cfg, paths) : {};
  const s = {};
  Object.keys(got).forEach(function (k) {
    const q = Number((/\/q(\d+)$/.exec(k) || [])[1] || 0);
    (got[k].list || []).forEach(function (r, j) {
      const id = docId_(r.p);
      if (id && q * MKT_CHUNK_ + j < upto && !not[id]) s[id] = true;
    });
  });
  return s;
}

// Does this patient match the campaign's audience?
function mktMatches_(cfg, aud, e, memo) {
  if (aud.mode === 'all') return true;
  if (aud.mode === 'list') {
    if (!memo.listSet) memo.listSet = mktListSet_(cfg, aud.list);
    if (!memo.listSet[e.doc._id]) return false;
    if (!aud.rules.rules.length) return true;
  }
  memo.pts = memo.pts || {};
  memo.pts[String(e.pre.patientId || '').trim()] = e.doc;   // already read, so the rules don't read it again
  const ctx = flowLazyCtx_(cfg, e.pre, memo);
  const run = { patientId: e.doc._id, kind: 'campaign', product: '', purchaseDate: flowKey_(Date.now()), sourceKey: e.pre._key };
  return flowGroupOk_(cfg, aud.rules, run, ctx);
}

// "Count patients" in the portal (up to about 3½ minutes; a big rule list may only be partly checked).
// withPeople: also every patient who matches (for "See who" and "Leave out"), up to MKT_PEOPLE_MAX_
function mktCount_(cfg, body, session) {
  const aud = mktAudience_(body.audience);
  if (aud.mode === 'rules' && !aud.rules.rules.length) return { ok: true, problem: 'Add at least one rule, or send it to everyone.' };
  const lp = mktListProblem_(cfg, aud, String(body.campaignId || ''));
  if (lp) return { ok: true, problem: lp };
  const cache = CacheService.getScriptCache();
  const rk = 'mkt_count_' + session.uid;
  const used = Number(cache.get(rk) || 0);
  if (used >= 20) return { ok: true, problem: "You've counted a lot in the last hour. Try again a bit later." };
  cache.put(rk, String(used + 1), 3600);

  const started = Date.now();
  const withPeople = body.withPeople === true;
  const pool = mktPool_(cfg, mktNeedsVisits_(aud) || withPeople);   // visits too, for "last visit" in the list
  mktSkipPool_(cfg, aud, pool, String(body.campaignId || ''));      // already sent an earlier campaign you chose
  const today = flowKey_(Date.now());
  const people = [];
  let peopleMore = 0;
  const addPerson = function (e) {
    if (!withPeople) return;
    if (people.length < MKT_PEOPLE_MAX_) people.push(mktPerson_(e, today));
    else peopleMore++;
  };
  const byName = function () { people.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); }); };

  if (aud.mode === 'all') {
    pool.list.forEach(addPerson);
    byName();
    return { ok: true, count: pool.list.length, checked: pool.list.length, total: pool.list.length, partial: false,
      excluded: pool.stats, people: withPeople ? people : undefined, peopleMore: peopleMore };
  }
  const memo = {};
  let checked = 0;
  let count = 0;
  const sample = [];
  for (let i = 0; i < pool.list.length; i++) {
    if (Date.now() - started > 210000) break;
    let ok = false;
    try { ok = mktMatches_(cfg, aud, pool.list[i], memo); } catch (e) { ok = false; }
    checked++;
    if (!ok) continue;
    count++;
    if (sample.length < 12) sample.push(flowWho_(pool.list[i].doc).name);
    addPerson(pool.list[i]);
  }
  byName();
  return { ok: true, count: count, checked: checked, total: pool.list.length, partial: checked < pool.list.length,
    sample: sample, excluded: pool.stats, people: withPeople ? people : undefined, peopleMore: peopleMore };
}
// "Send now" / "Schedule": a copy of the email is taken (its links ready for tracking), and the runner takes it from here
function mktSchedule_(cfg, body, session) {
  const id = String(body.campaignId || '');
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: true, problem: 'Busy. Try again in a moment.' };
  try {
    const path = MKT_CAMPAIGNS_ + '/' + id;
    const c = fsGetDoc_(cfg, path);
    if (!c) return { ok: false, error: 'NOT_FOUND' };
    if (c.status !== 'draft') return { ok: true, problem: 'This campaign has already been scheduled.' };
    const tid = String(c.templateId || '');
    const t = /^[A-Za-z0-9_-]{10,40}$/.test(tid) ? fsGetDoc_(cfg, MKT_TEMPLATES_ + '/' + tid) : null;
    if (!t || t.status === 'archived') return { ok: true, problem: 'Choose the email it sends.' };
    const html = sanitizeEmailHtml_(String(t.html || ''));
    if (!html) return { ok: true, problem: 'That email template is empty.' };
    const subject = String(c.subject || t.subject || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!subject) return { ok: true, problem: 'Add a subject line.' };
    const aud = mktAudience_(c.audience);
    if (aud.mode === 'rules' && !aud.rules.rules.length) return { ok: true, problem: 'Add at least one rule, or send it to everyone.' };
    const lp = mktListProblem_(cfg, aud, id);
    if (lp) return { ok: true, problem: lp };
    let at = Date.now();
    if (body.now !== true) {
      at = Date.parse(String(body.sendAt || ''));
      if (!at || at < Date.now() + 4 * 60000) return { ok: true, problem: 'Choose a time at least 5 minutes from now.' };
      if (at > Date.now() + 90 * 86400000) return { ok: true, problem: 'Choose a time in the next 90 days.' };
    }
    const track = c.track !== false;
    const prep = track ? mktPrepLinks_(html) : { html: html, links: [] };
    const replyTo = String(c.replyTo || '').trim();
    const now = new Date().toISOString();
    commitWrites_(cfg, [deleteWrite_(cfg, MKT_CSTATE_ + '/' + id)]);
    fsPatch_(cfg, path, {
      status: 'scheduled', sendAtMs: at, sendAt: new Date(at).toISOString(), html: prep.html, links: prep.links, track: track,
      subject: subject, templateName: String(t.name || ''), audience: aud,
      dailyCap: Math.max(50, Math.min(1400, Number(c.dailyCap) || MKT_DAILY_DEFAULT_)),
      pace: mktPace_(c.pace), paceAt: 0, paceN: 0,
      fromName: String(c.fromName || '').replace(/[\r\n"<>]/g, '').trim().slice(0, 80) || 'Dermedica Clinic',
      replyTo: isEmail_(replyTo) ? replyTo : '',
      total: 0, sent: 0, skipped: 0, failed: 0, cursor: 0, chunks: 0, built: false, failures: [], waiting: '', lastError: '', note: '',
      buildChecked: 0, buildTotal: 0, startedAt: '', finishedAt: '', sentDay: '', sentDayN: 0,
      stats: { opens: 0, opensTotal: 0, clicks: 0, clicksTotal: 0, unsubscribes: 0, bounces: 0 }, linkClicks: {},
      scheduledAt: now, scheduledBy: String(session.name || ''), scheduledByUid: String(session.uid || ''),
    });
    CacheService.getScriptCache().remove('mkl_' + id);
    console.log('Campaign "' + c.name + '" scheduled for ' + new Date(at).toISOString() + ' by ' + session.name);
    return { ok: true, sendAt: new Date(at).toISOString() };
  } finally {
    lock.releaseLock();
  }
}

// Pause, resume, cancel, or (before it starts) back to a draft
function mktControl_(cfg, body, session) {
  const id = String(body.campaignId || '');
  const act = String(body.act || '');
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: true, problem: 'Busy. Try again in a moment.' };
  try {
    const path = MKT_CAMPAIGNS_ + '/' + id;
    const c = fsGetDoc_(cfg, path);
    if (!c) return { ok: false, error: 'NOT_FOUND' };
    const now = new Date().toISOString();
    const who = String(session.name || '');
    if (act === 'pause') {
      if (['scheduled', 'building', 'sending'].indexOf(c.status) === -1) return { ok: true, problem: "It isn't sending, so it can't be paused." };
      fsPatch_(cfg, path, { status: 'paused', pausedFrom: c.status, pausedAt: now, pausedBy: who, waiting: '' });
    } else if (act === 'resume') {
      if (c.status !== 'paused') return { ok: true, problem: "It isn't paused." };
      const back = ['scheduled', 'building', 'sending'].indexOf(c.pausedFrom) !== -1 ? c.pausedFrom : 'sending';
      fsPatch_(cfg, path, { status: back, resumedAt: now, resumedBy: who });
    } else if (act === 'cancel') {
      if (['sent', 'cancelled', 'draft'].indexOf(c.status) !== -1) return { ok: true, problem: "It can't be cancelled now." };
      fsPatch_(cfg, path, { status: 'cancelled', cancelledAt: now, cancelledBy: who, waiting: '', finishedAt: now });
    } else if (act === 'unschedule') {
      if (c.status !== 'scheduled' || c.startedAt) return { ok: true, problem: "It's already started, so it can only be paused or cancelled." };
      fsPatch_(cfg, path, { status: 'draft', sendAtMs: 0, updatedAt: now, updatedBy: who });
      commitWrites_(cfg, [deleteWrite_(cfg, MKT_CSTATE_ + '/' + id)]);
    } else {
      return { ok: false, error: 'BAD_REQUEST' };
    }
    console.log('Campaign ' + id + ': ' + act + ' by ' + who);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- The runner (its own 10-minute trigger: installCampaignSender) ---------- */
// It doesn't take the script lock, so sending never makes the rest of the portal wait.

function runCampaigns() {
  const cache = CacheService.getScriptCache();
  const busy = Number(cache.get('mkt_runner') || 0);
  if (busy && Date.now() - busy < 7 * 60000) return;
  cache.put('mkt_runner', String(Date.now()), 600);
  try {
    const cfg = getConfig_();
    const deadline = Date.now() + 4.5 * 60000;
    try { mktCheckBounces_(cfg, false); } catch (e) { console.warn('Bounce check failed: ' + e); }
    fsQuery_(cfg, MKT_CAMPAIGNS_, 'status', 'IN', ['scheduled', 'building', 'sending'], 30)
      .sort(function (a, b) { return Number(a.sendAtMs || 0) - Number(b.sendAtMs || 0); })
      .forEach(function (c) {
        if (Date.now() > deadline) return;
        try { mktRunOne_(cfg, c, deadline); }
        catch (e) {
          console.error('Campaign ' + c._id + ': ' + (e && e.stack ? e.stack : e));
          try {
            fsPatch_(cfg, MKT_CAMPAIGNS_ + '/' + c._id, {
              lastError: String(e && e.message ? e.message : e).slice(0, 300), updatedAt: new Date().toISOString(),
            });
          } catch (e2) { /* not essential */ }
        }
      });
  } finally {
    cache.remove('mkt_runner');
  }
}

function mktRunOne_(cfg, c, deadline) {
  const path = MKT_CAMPAIGNS_ + '/' + c._id;
  if (c.status === 'scheduled') {
    if (Number(c.sendAtMs || 0) > Date.now()) return;
    fsPatch_(cfg, path, { status: 'building', startedAt: new Date().toISOString(), waiting: 'Choosing who it goes to…', lastError: '' });
    c.status = 'building';
  }
  if (c.status === 'building' && !mktBuild_(cfg, c, deadline)) return;
  mktSendBatch_(cfg, c, deadline);
}

// Works through every patient, saving the ones who match. A big list carries on in the next run.
// Returns true once the list is finished and sending can start.
function mktBuild_(cfg, c, deadline) {
  const path = MKT_CAMPAIGNS_ + '/' + c._id;
  const spath = MKT_CSTATE_ + '/' + c._id;
  const st = fsGetDoc_(cfg, spath) || {};
  const after = String(st.after || '');
  let chunks = Number(st.chunks || 0);
  let total = Number(st.total || 0);
  const pending = Array.isArray(st.pending) ? st.pending : [];
  const aud = mktAudience_(c.audience);
  const ex = mktExcluded_(aud);
  const pp = mktPool_(cfg, mktNeedsVisits_(aud));
  mktSkipPool_(cfg, aud, pp, c._id);   // already sent an earlier campaign you chose
  const pool = pp.list;
  const memo = {};
  let i = 0;
  while (i < pool.length && after && pool[i].key <= after) i++;
  let last = after;
  for (; i < pool.length; i++) {
    if (Date.now() > deadline - 20000) break;   // leaves time to save
    const e = pool[i];
    last = e.key;
    if (ex.ids[e.doc._id] || ex.emails[e.email]) continue;   // left out by hand in the portal
    let ok = false;
    try { ok = mktMatches_(cfg, aud, e, memo); } catch (err) { console.warn('Campaign ' + c._id + ', ' + e.key + ': ' + err); }
    if (!ok) continue;
    const w = flowWho_(e.doc);
    const parts = String(w.name || '').trim().split(/\s+/);
    pending.push({ p: e.doc._id, e: e.email, f: w.first || '', n: w.name || '', l: parts.length > 1 ? parts[parts.length - 1] : '' });
    total++;
  }
  const finished = i >= pool.length;
  const writes = [];
  while (pending.length >= MKT_CHUNK_ || (finished && pending.length)) {
    writes.push(updateWrite_(cfg, path + '/queue/q' + chunks, { n: chunks, list: pending.splice(0, MKT_CHUNK_) }));
    chunks++;
  }
  writes.push(updateWrite_(cfg, spath, { after: last, chunks: chunks, total: total, pending: pending, at: new Date().toISOString() }));
  commitWrites_(cfg, writes, 20);

  const now = fsGetDoc_(cfg, path) || {};
  if (now.status !== 'building') return false;   // paused or cancelled meanwhile
  if (!finished) {
    fsPatch_(cfg, path, { buildChecked: i, buildTotal: pool.length,
      waiting: 'Choosing who it goes to… (' + i + ' of ' + pool.length + ' patients checked)' });
    return false;
  }
  if (!total) {
    fsPatch_(cfg, path, { status: 'sent', built: true, total: 0, buildChecked: pool.length, buildTotal: pool.length,
      finishedAt: new Date().toISOString(), waiting: '', note: 'Nobody matched when it was time to send.' });
    return false;
  }
  fsPatch_(cfg, path, { status: 'sending', built: true, total: total, chunks: chunks, cursor: 0,
    buildChecked: pool.length, buildTotal: pool.length, builtAt: new Date().toISOString(), waiting: '' });
  c.status = 'sending'; c.total = total; c.cursor = 0; c.sent = 0; c.skipped = 0; c.failed = 0; c.waiting = '';
  return true;
}

// One batch. Progress is saved after every email, so a crash never sends one twice.
function mktSendBatch_(cfg, c, deadline) {
  if (c.status !== 'sending') return;
  const path = MKT_CAMPAIGNS_ + '/' + c._id;
  const wait = function (txt) { if (String(c.waiting || '') !== txt) fsPatch_(cfg, path, { waiting: txt }); };
  if (flowSendWindow_(Date.now()) > Date.now()) { wait('Waiting for sending hours (9 am to 6 pm).'); return; }
  const day = flowKey_(Date.now());
  let today = c.sentDay === day ? Number(c.sentDayN || 0) : 0;
  const cap = Math.max(50, Math.min(1400, Number(c.dailyCap) || MKT_DAILY_DEFAULT_));
  if (today >= cap) { wait("Today's limit for this campaign is reached. It carries on tomorrow from 9 am."); return; }
  if (MailApp.getRemainingDailyQuota() <= MKT_RESERVE_) {
    wait("The clinic's email allowance for today is nearly used. It carries on tomorrow from 9 am.");
    return;
  }

  // Batches: how many this batch can still send
  const pace = mktPace_(c.pace);
  const span = pace.mins * 60000;
  let paceAt = Number(c.paceAt || 0);
  let paceN = Number(c.paceN || 0);
  let room = MKT_PER_RUN_;
  const nextBatch = function () { return Utilities.formatDate(new Date(paceAt + span), REC_TZ_, 'h:mm a'); };
  if (pace.n) {
    if (!paceAt || Date.now() - paceAt >= span) { paceAt = Date.now(); paceN = 0; }   // a new batch
    room = Math.min(room, pace.n - paceN);
    if (room <= 0) { wait('This batch of ' + pace.n + ' has gone. The next batch starts about ' + nextBatch() + '.'); return; }
  }

  const supp = {};
  fsListAll_(cfg, MKT_SUPPRESS_, ['email']).forEach(function (d) { supp[d.name.split('/').pop()] = true; });
  const html0 = String(c.html || '');
  const subject0 = String(c.subject || '');
  const fromName = String(c.fromName || 'Dermedica Clinic');
  const replyTo = isEmail_(String(c.replyTo || '')) ? String(c.replyTo) : '';
  const track = c.track === true;
  const web = track ? mktWebAppUrl_() : '';
  const total = Number(c.total || 0);
  let cursor = Number(c.cursor || 0);
  let sent = Number(c.sent || 0);
  let skipped = Number(c.skipped || 0);
  let failed = Number(c.failed || 0);
  const failures = Array.isArray(c.failures) ? c.failures.slice(-99) : [];
  let chunk = null;
  let chunkN = -1;
  let n = 0;
  let stop = '';

  while (cursor < total && n < room && today < cap && Date.now() < deadline) {
    if (n && n % 25 === 0) {   // paused or cancelled in the portal?
      const s = (fsGetDoc_(cfg, path) || {}).status;
      if (s !== 'sending') { stop = 'status'; break; }
    }
    if (MailApp.getRemainingDailyQuota() <= MKT_RESERVE_) { stop = 'quota'; break; }
    const q = Math.floor(cursor / MKT_CHUNK_);
    if (q !== chunkN) {
      chunk = fsGetDoc_(cfg, path + '/queue/q' + q);
      chunkN = q;
      if (!chunk) throw new Error('Part of the list of patients is missing.');
    }
    const r = (chunk.list || [])[cursor % MKT_CHUNK_] || {};
    let result = 'skipped';
    if (isEmail_(String(r.e || '')) && !supp[mktEmailKey_(r.e)]) {
      const vals = { 'first name': r.f || 'there', 'last name': r.l || '', 'full name': r.n || 'there', 'patient name': r.n || '' };
      let body = flowFillHtml_(html0, vals);
      body = mktFormLinks_(body, c._id, r.p);   // "Open a form" buttons get this patient's own link
      let tail = mktFooterHtml_(r.p, r.e, c._id);
      if (track) {
        body = body.replace(/__MKTL(\d+)__/g, function (m, i) {
          return invEsc_(MKT_TRACK_PAGE_ + '#' + mktTrackTok_(c._id, r.p, Number(i)));
        });
        if (web) {
          tail += '<img src="' + invEsc_(web + '?o=' + mktTrackTok_(c._id, r.p)) + '" width="1" height="1" alt="" ' +
            'style="display:block;width:1px;height:1px;border:0;">';
        }
      }
      const html = mktPlaceFooter_(body, tail);
      const mail = {
        to: r.e, name: fromName, htmlBody: html, body: emailHtmlToText_(html),
        subject: flowFill_(subject0, vals, false).replace(/\s+/g, ' ').trim().slice(0, 200) || 'News from Dermedica',
      };
      if (replyTo) mail.replyTo = replyTo;
      try {
        MailApp.sendEmail(mail);
        result = 'sent';
        today++;
        n++;
        paceN++;
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (/too many|quota|limit/i.test(msg)) { stop = 'quota'; break; }   // not this patient's fault: tried again later
        result = 'failed';
        failures.push({ email: mktMask_(r.e), patientId: String(r.p || ''), error: msg.slice(0, 160), at: new Date().toISOString() });
      }
    }
    cursor++;
    if (result === 'sent') sent++; else if (result === 'failed') failed++; else skipped++;
    const patch = { cursor: cursor, sent: sent, skipped: skipped, failed: failed, sentDay: day, sentDayN: today,
      paceAt: paceAt, paceN: paceN, lastSentAt: new Date().toISOString(), waiting: '' };
    if (result === 'failed') patch.failures = failures.slice(-100);
    fsPatch_(cfg, path, patch);
    c.waiting = '';
  }

  if (stop === 'status') return;
  if (cursor >= total) {
    fsPatch_(cfg, path, { status: 'sent', finishedAt: new Date().toISOString(), waiting: '' });
    console.log('Campaign "' + c.name + '" finished: ' + sent + ' sent, ' + skipped + ' skipped, ' + failed + ' failed.');
  } else if (stop === 'quota') {
    fsPatch_(cfg, path, { waiting: "The clinic's email allowance for today is nearly used. It carries on tomorrow from 9 am." });
  } else if (today >= cap) {
    fsPatch_(cfg, path, { waiting: "Today's limit for this campaign is reached. It carries on tomorrow from 9 am." });
  } else if (pace.n && paceN >= pace.n) {
    fsPatch_(cfg, path, { waiting: 'This batch of ' + pace.n + ' has gone. The next batch starts about ' + nextBatch() + '.' });
  }
}

// Run ONCE from the editor, as the account that sends (info@), to start sending campaigns (every 10 minutes)
function installCampaignSender() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runCampaigns'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runCampaigns').timeBased().everyMinutes(10).create();
  console.log('Campaign sender installed (every 10 minutes).');
}

/* ===================== Marketing: opens, clicks, unsubscribes and bounces ===================== */
// Opens: a 1×1 picture at the end of each email, loaded from this web app (doGet ?o=<token>).
// Clicks: each web link goes to r.html#<token> on the portal, which tells this script (op "click") and is sent on
//   to the real address. The address comes from the campaign (links[]), never from the link, so it can't be misused.
// Tokens are signed: "m1.<campaign, patient[, link]>.<signature>".
// Each patient gets one document per campaign in opens/, clicks/, unsubs/ and bounces/ (mkt_campaigns/{id}/…),
// and the campaign's counters (stats.*, linkClicks.l<n>) go up in the same write, so they can't drift apart.

const MKT_TRACK_PAGE_ = PORTAL_URL_ + 'r.html';
const MKT_A_RE_ = /(<a\b[^>]*?\shref\s*=\s*")(https?:\/\/[^"]+)("[^>]*>)([\s\S]*?)(<\/a>)/gi;
const MKT_BOUNCE_LABEL_ = 'Portal-bounces-checked';

// The web app's /exec address (Script Property WEBAPP_URL). Without it, opens aren't tracked.
function mktWebAppUrl_() {
  const u = String(PropertiesService.getScriptProperties().getProperty('WEBAPP_URL') || '').trim();
  return /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u) ? u : '';
}

function mktTrackTok_(cid, pid, link) {
  const payload = 'm1.' + b64url_(JSON.stringify(link === undefined ? [String(cid), String(pid)] : [String(cid), String(pid), link]));
  return payload + '.' + mktSig_(payload).slice(0, 22);
}
function mktReadTrack_(t) {
  const m = /^m1\.([A-Za-z0-9_-]{4,400})\.([A-Za-z0-9_-]{22})$/.exec(String(t || ''));
  if (!m || mktSig_('m1.' + m[1]).slice(0, 22) !== m[2]) return null;
  try {
    const s = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const a = JSON.parse(Utilities.newBlob(Utilities.base64Decode(s + '==='.slice((s.length + 3) % 4))).getDataAsString());
    if (!Array.isArray(a) || !/^[A-Za-z0-9_-]{10,40}$/.test(String(a[0])) || !docId_(a[1])) return null;
    const link = a.length > 2 ? Math.floor(Number(a[2])) : -1;
    if (a.length > 2 && !(link >= 0 && link < 40)) return null;
    return { cid: String(a[0]), pid: docId_(a[1]), link: link };
  } catch (e) { return null; }
}

// Every web link in the email becomes __MKTL<n>__; each patient's own tracked link goes in when it's sent
function mktPrepLinks_(html) {
  const links = [];
  const out = String(html || '').replace(MKT_A_RE_, function (m, a, url, b, inner, c) {
    if (links.length >= 40) return m;
    const text = emailHtmlToText_(inner).replace(/\s+/g, ' ').trim().slice(0, 80) || (/<img\b/i.test(inner) ? 'Picture' : 'Link');
    links.push({ url: url.replace(/&amp;/g, '&'), text: text });
    return a + '__MKTL' + (links.length - 1) + '__' + b + inner + c;
  });
  return { html: out, links: links };
}

function mktInc_(fieldPath, n) { return { fieldPath: fieldPath, increment: { integerValue: String(n || 1) } }; }

// One commit. True if it went through (a failed "only if new" check comes back false, not an error)
function mktCommit_(cfg, writes) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + ':commit', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
      payload: JSON.stringify({ writes: writes }),
    });
    const code = res.getResponseCode();
    if (code !== 429 && code < 500) return code === 200;
    Utilities.sleep(500 * (attempt + 1));
  }
  return false;
}

// First time for this patient: saves mkt_campaigns/{cid}/{sub}/{pid} and adds to the counters, together.
// Already there: nothing changes, and it returns false.
function mktOnce_(cfg, cid, sub, pid, data, fts) {
  const base = fsBase_(cfg) + '/' + MKT_CAMPAIGNS_ + '/' + cid;
  return mktCommit_(cfg, [
    { update: { name: base + '/' + sub + '/' + pid, fields: toFields_(data) }, currentDocument: { exists: false } },
    { transform: { document: base, fieldTransforms: fts }, currentDocument: { exists: true } },
  ]);
}
function mktBump_(cfg, docPath, fts) {
  return mktCommit_(cfg, [{ transform: { document: fsBase_(cfg) + '/' + docPath, fieldTransforms: fts }, currentDocument: { exists: true } }]);
}

// doGet ?o=<token>
function mktOpen_(t) {
  const tok = mktReadTrack_(t);
  if (!tok || tok.link !== -1) return;
  const cache = CacheService.getScriptCache();
  const k = 'mko_' + flowHash_(t);
  if (cache.get(k)) return;   // email apps often load the picture twice in a row
  cache.put(k, '1', 120);
  const cfg = getConfig_();
  const total = [mktInc_('stats.opensTotal')];
  if (!mktOnce_(cfg, tok.cid, 'opens', tok.pid, { at: new Date().toISOString(), patientId: tok.pid },
      [mktInc_('stats.opens')].concat(total))) {
    mktBump_(cfg, MKT_CAMPAIGNS_ + '/' + tok.cid, total);
  }
}

// The real address of link n in a campaign (remembered for 6 hours)
function mktCampaignLink_(cfg, cid, n) {
  const cache = CacheService.getScriptCache();
  const k = 'mkl_' + cid;
  let links = null;
  const hit = cache.get(k);
  if (hit) links = JSON.parse(hit);
  else {
    const c = fsGetDoc_(cfg, MKT_CAMPAIGNS_ + '/' + cid);
    links = c && Array.isArray(c.links) ? c.links.map(function (l) { return String((l && l.url) || ''); }) : [];
    try { cache.put(k, JSON.stringify(links), 21600); } catch (e) { /* not essential */ }
  }
  // Tags like {First name} can't be filled in here, so they're left out
  const u = String(links[n] || '').replace(FLOW_TOKEN_RE_, '').trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(u) ? u : '';
}

// r.html → { url } to send them on to
function mktClick_(body) {
  const t = String(body.t || '');
  const tok = mktReadTrack_(t);
  if (!tok || tok.link < 0) return { ok: true, problem: 'BAD_LINK' };
  const cfg = getConfig_();
  const url = mktCampaignLink_(cfg, tok.cid, tok.link);
  if (!url) return { ok: true, problem: 'BAD_LINK' };
  const cache = CacheService.getScriptCache();
  const k = 'mkc_' + flowHash_(t);
  if (!cache.get(k)) {
    cache.put(k, '1', 30);
    try { mktRecordClick_(cfg, tok); } catch (e) { console.warn('Click not recorded: ' + e); }
  }
  return { ok: true, url: mktFormLinks_(url, tok.cid, tok.pid) };
}

function mktRecordClick_(cfg, tok) {
  const now = new Date().toISOString();
  const per = [mktInc_('stats.clicksTotal'), mktInc_('linkClicks.l' + tok.link)];
  const first = mktOnce_(cfg, tok.cid, 'clicks', tok.pid, { at: now, patientId: tok.pid, links: [tok.link] },
    [mktInc_('stats.clicks')].concat(per));
  if (!first) {
    mktBump_(cfg, MKT_CAMPAIGNS_ + '/' + tok.cid, per);
    mktBump_(cfg, MKT_CAMPAIGNS_ + '/' + tok.cid + '/clicks/' + tok.pid,
      [{ fieldPath: 'links', appendMissingElements: { values: [{ integerValue: String(tok.link) }] } }]);
  }
  // A click means they opened it, even if their email app blocked the pictures
  mktOnce_(cfg, tok.cid, 'opens', tok.pid, { at: now, patientId: tok.pid, fromClick: true }, [mktInc_('stats.opens')]);
}

// Counted once per patient per campaign (flows and tests have no campaign, so aren't counted)
function mktCountUnsub_(cfg, tok) {
  const pid = docId_(tok.pid);
  if (!pid || !/^[A-Za-z0-9_-]{10,40}$/.test(String(tok.cid || ''))) return;
  try { mktOnce_(cfg, tok.cid, 'unsubs', pid, { at: new Date().toISOString(), patientId: pid }, [mktInc_('stats.unsubscribes')]); }
  catch (e) { console.warn('Unsubscribe not counted: ' + e); }
}

/* ---------- Bounces: "Address not found" emails in the sending account's inbox (hourly) ---------- */

function mktCheckBounces_(cfg, force) {
  const props = PropertiesService.getScriptProperties();
  if (!force && Date.now() - Number(props.getProperty('MKT_BOUNCE_AT') || 0) < 55 * 60000) return 0;
  props.setProperty('MKT_BOUNCE_AT', String(Date.now()));
  const label = GmailApp.getUserLabelByName(MKT_BOUNCE_LABEL_) || GmailApp.createLabel(MKT_BOUNCE_LABEL_);
  const threads = GmailApp.search('from:(mailer-daemon OR postmaster) newer_than:7d -label:' + MKT_BOUNCE_LABEL_, 0, 40);
  let n = 0;
  threads.forEach(function (th) {
    try {
      th.getMessages().forEach(function (msg) {
        if (!/mailer-daemon|postmaster/i.test(msg.getFrom())) return;
        const b = mktParseBounce_(msg);
        if (b && b.hard) { mktRecordBounce_(cfg, b); n++; }
      });
      th.addLabel(label);
    } catch (e) { console.warn('Bounce email ' + th.getId() + ' not read: ' + e); }
  });
  if (n) console.log('Bounces: ' + n + ' address(es) put on do not contact.');
  return n;
}

// { email, hard, why, track: { cid, pid } | null } or null
function mktParseBounce_(msg) {
  const body = String(msg.getPlainBody() || '');
  let to = String(msg.getHeader('X-Failed-Recipients') || '').split(',')[0].trim();
  if (!isEmail_(to)) {
    const m = /(?:wasn't delivered to|failed permanently:|could not be delivered to)\s*<?([^\s<>@]+@[^\s<>]+?)>?[\s.,]/i.exec(body);
    to = m ? m[1] : '';
  }
  to = mktEmail_(to);
  if (!isEmail_(to)) return null;
  const soft = /\b4\.\d{1,3}\.\d{1,3}\b|temporar|mailbox (?:is )?full|over quota|quota exceeded|try again later/i.test(body);
  const hard = /\b5\.1\.\d{1,3}\b|\b550\b|\b553\b|address not found|does(?: not|n't) exist|no such user|user unknown|recipient (?:address )?rejected|unable to receive mail/i.test(body);
  const code = (/\b5\.\d{1,3}\.\d{1,3}\b/.exec(body) || [''])[0];
  // Which campaign: from a tracked link, the open picture or the unsubscribe link in the original email
  const all = String(msg.getBody() || '') + '\n' + body;
  let track = null;
  const m1 = /m1\.[A-Za-z0-9_-]{4,400}\.[A-Za-z0-9_-]{22}/.exec(all);
  if (m1) track = mktReadTrack_(m1[0]);
  if (!track) {
    const u1 = /u1\.[A-Za-z0-9_-]{4,800}\.[A-Za-z0-9_-]{32}/.exec(all);
    const u = u1 ? mktReadToken_(u1[0]) : null;
    if (u && docId_(u.pid)) track = { cid: u.cid, pid: docId_(u.pid), link: -1 };
  }
  return { email: to, hard: hard && !soft, why: code ? 'Bounced (' + code + ')' : 'Bounced', track: track };
}

function mktRecordBounce_(cfg, b) {
  const now = new Date().toISOString();
  const t = b.track;
  commitWrites_(cfg, [
    updateWrite_(cfg, MKT_SUPPRESS_ + '/' + mktEmailKey_(b.email), {
      email: b.email, reason: 'bounced', why: 'Email bounced', note: b.why, at: now, by: 'Bounce check',
      patientId: t ? t.pid : '', source: 'Email bounced', campaignId: t ? t.cid : '',
    }),
    updateWrite_(cfg, MKT_LOG_ + '/c_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
      patientId: t ? t.pid : '', patientName: '', email: b.email, status: 'no', source: 'Email bounced', why: 'Email bounced',
      note: b.why, by: 'Bounce check', byUid: '', campaignId: t ? t.cid : '', at: now,
    }),
  ]);
  if (t && /^[A-Za-z0-9_-]{10,40}$/.test(String(t.cid || ''))) {
    try { mktOnce_(cfg, t.cid, 'bounces', t.pid, { at: now, email: mktMask_(b.email) }, [mktInc_('stats.bounces')]); }
    catch (e) { console.warn('Bounce not counted: ' + e); }
  }
}

/* ---------- Public: the unsubscribe page and r.html (no login, only signed links) ---------- */

function handleMarketingPublic_(body) {
  if (String(body.op || '') === 'click') {
    try { return mktClick_(body); }
    catch (err) { console.error('Click failed: ' + (err && err.stack ? err.stack : err)); return { ok: true, problem: 'SERVER' }; }
  }
  const tok = mktReadToken_(body.t);
  if (!tok) return { ok: true, problem: 'BAD_LINK' };
  const cache = CacheService.getScriptCache();
  const rk = 'mkt_rl_' + flowHash_(String(body.t));
  const n = Number(cache.get(rk) || 0);
  if (n >= 20) return { ok: true, problem: 'BUSY' };
  cache.put(rk, String(n + 1), 3600);

  const op = String(body.op || 'status');
  try {
    const cfg = getConfig_();
    if (op === 'unsubscribe' || op === 'resubscribe') {
      const yes = op === 'resubscribe';
      const wasIn = !mktSuppressed_(cfg, tok.email);
      mktSetConsent_(cfg, tok.pid, yes, {
        by: 'The patient', source: yes ? 'Resubscribed' : 'Unsubscribe link', email: tok.email, campaignId: tok.cid,
      });
      if (!yes && wasIn) mktCountUnsub_(cfg, tok);
      console.log('Marketing: ' + mktMask_(tok.email) + (yes ? ' resubscribed' : ' unsubscribed') + (tok.cid ? ' (' + tok.cid + ')' : ''));
    }
    const s = mktSuppressed_(cfg, tok.email);
    return { ok: true, email: mktMask_(tok.email), subscribed: !s, bounced: !!(s && s.reason === 'bounced') };
  } catch (err) {
    console.error('Unsubscribe page failed: ' + (err && err.stack ? err.stack : err));
    return { ok: true, problem: 'SERVER' };
  }
}

// Run from the editor: logs a working unsubscribe link for one patient, to try the page
function testMarketingLink() {
  const pid = 'PASTE_A_PATIENT_ID';
  const p = flowPatient_(getConfig_(), pid);
  console.log(p && isEmail_(p.Email) ? mktUnsubUrl_(p._id, p.Email, 'test') : 'That patient has no email address.');
}

// Run from the editor: checks tracking is set up, and reads the inbox for bounces straight away
function testMarketingTracking() {
  console.log('Open picture address: ' + (mktWebAppUrl_() || 'MISSING. Add WEBAPP_URL (the /exec address) in Script Properties.'));
  console.log('Click page: ' + MKT_TRACK_PAGE_);
  console.log('Bounces found: ' + mktCheckBounces_(getConfig_(), true));
}

/* ===================== Online forms: a patient fills in a form from a link ===================== */
// An "Open a form" button in a marketing email links to form.html#f=<form>. When the email goes out, mktFormLinks_ swaps it
// for the patient's own signed link: form.html#t=p1.<form, patient, campaign, expiry>.<signature>.
// The page asks for the form (op "get"), and sends the answers back (op "submit"). They're checked against the published
// form and saved to form_submissions, in the same write as online_forms/{key}, so each link can be sent once only.
// Only forms with "Patients can fill this in online" ticked (form_templates/{id}.online.on), and never treatment
// records, prescriptions or forms with staff-only fields (the same list as js/form-live.js).

const PF_DONE_ = 'online_forms';
const PF_PAGE_ = PORTAL_URL_ + 'form.html';
const PF_DAYS_ = 60;

const PF_TESTLIVE_ = 'tl_';   // "Let me send the form for real" in a template test: works like a real link, marked as a test
function pfIsTestLive_(cid) { return String(cid || '').indexOf(PF_TESTLIVE_) === 0; }

const PF_LAYOUT_ = ['text_block', 'space', 'letterhead', 'watermark', 'button'];
const PF_NO_CATS_ = ['treatment', 'prescription'];
const PF_OK_TYPES_ = ['patient', 'short_text', 'long_text', 'email', 'number', 'date', 'record_date', 'dropdown',
  'single_choice', 'checkboxes', 'checkbox_notes', 'sub_checks', 'table', 'calculation', 'signature', 'image',
  'text_block', 'space', 'letterhead', 'watermark', 'button'];
const PF_NO_REQUIRE_ = ['calculation', 'image', 'patient', 'text_block', 'space', 'letterhead', 'watermark', 'button'];
const PF_FILLS_ = { 'patient.name': 'name', 'patient.firstName': 'firstName', 'patient.lastName': 'lastName', 'patient.dob': 'dobKey',
  'patient.email': 'email', 'patient.mobile': 'mobile', 'patient.address': 'address' };
const PF_PARTS_ = { name: 'name', dob: 'dobKey', mobile: 'mobile', email: 'email', address: 'address', pttId: 'pttId' };

function pfToken_(tid, pid, cid, exp) {
  const payload = 'p1.' + b64url_(JSON.stringify([String(tid), String(pid || ''), String(cid || ''), exp || Date.now() + PF_DAYS_ * 86400000]));
  return payload + '.' + mktSig_(payload).slice(0, 22);
}
function pfRead_(t) {
  const m = /^p1\.([A-Za-z0-9_-]{4,600})\.([A-Za-z0-9_-]{22})$/.exec(String(t || ''));
  if (!m || mktSig_('p1.' + m[1]).slice(0, 22) !== m[2]) return null;
  try {
    const s = m[1].replace(/-/g, '+').replace(/_/g, '/');
    const a = JSON.parse(Utilities.newBlob(Utilities.base64Decode(s + '==='.slice((s.length + 3) % 4))).getDataAsString());
    if (!Array.isArray(a) || !/^[A-Za-z0-9_-]{10,40}$/.test(String(a[0]))) return null;
    const pid = a[1] ? docId_(a[1]) : '';
    if (a[1] && !pid) return null;
    return { tid: String(a[0]), pid: pid, cid: String(a[2] || ''), exp: Number(a[3]) || 0, raw: m[0] };
  } catch (e) { return null; }
}
const PF_LINK_MAX_ = 10;   // sends allowed from one email link (all its buttons together)
// The answers a button fills in (from its link), tidied, so each button counts as its own form
function pfPicks_(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, 5)
    .map(function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200); })
    .filter(function (s) { return /^[a-z0-9_-]{1,80}:./.test(s); })
    .sort();
}
const pfLinkKey_ = function (tok) { return 'o_' + flowHash_([tok.tid, tok.pid, tok.cid].join('|')); };
// No preset answer: the same key as before (so forms already sent are still recognised)
const pfDoneKey_ = function (tok, picks) {
  return picks && picks.length ? 'o_' + flowHash_([tok.tid, tok.pid, tok.cid, picks.join('|')].join('|')) : pfLinkKey_(tok);
};

// form.html#f=<id> links in an email → this patient's own link
function mktFormLinks_(html, cid, pid) {
  return String(html || '').replace(/https:\/\/[^"'\s<>]*\/form\.html#f=([A-Za-z0-9_-]{10,40})/g, function (m, id) {
    return m.indexOf(PF_PAGE_) === 0 ? PF_PAGE_ + '#t=' + pfToken_(id, pid, cid) : m;
  });
}

function pfBlocked_(fields) {
  return (fields || []).some(function (f) {
    return !f || PF_OK_TYPES_.indexOf(f.type) === -1 ||
      (f.type === 'image' && (f.source === 'staff' || f.annotate === true)) ||
      (f.type === 'signature' && f.signer === 'practitioner');
  });
}

// The template and the patient (and anything in extraPaths) in ONE Firestore request
function pfLoad_(cfg, tok, extraPaths) {
  const tPath = 'form_templates/' + tok.tid;
  const pPath = tok.pid ? 'patient_list/' + tok.pid : '';
  const got = fsBatchGet_(cfg, [tPath].concat(pPath ? [pPath] : [], extraPaths || []));
  const tpl = got[tPath];
  if (!tpl || tpl.status !== 'live' || !(tpl.online && tpl.online.on === true) || PF_NO_CATS_.indexOf(tpl.category) !== -1 ||
      !Number(tpl.version)) return { problem: 'UNAVAILABLE' };
  const ver = pfCached_('pf_ver_' + tok.tid + '_' + Number(tpl.version), 21600, function () {
    return fsGetDoc_(cfg, 'form_templates/' + tok.tid + '/versions/' + Number(tpl.version));
  });
  if (!ver || !Array.isArray(ver.fields) || pfBlocked_(ver.fields)) return { problem: 'UNAVAILABLE' };
  let doc = null;
  if (tok.pid) {
    doc = got[pPath] || null;
    if (doc && !doc.MergedInto) doc._id = tok.pid;
    else doc = flowPatient_(cfg, tok.pid);   // merged (or not found by ID): follow it the slow way
    if (!doc) return { problem: 'NO_PATIENT' };
  }
  return { tpl: tpl, ver: ver, doc: doc, test: !tok.pid || tok.cid === 'test', got: got };
}

// Only the details this form uses (never Medicare)
function pfPatient_(doc, fields) {
  const w = flowWho_(doc);
  const all = { name: w.name, firstName: w.first, lastName: String(doc['Last Name'] || ''), dobKey: String(doc.DobKey || ''),
    email: String(doc.Email || ''), mobile: String(doc.Mobile || ''), address: String(doc.Address || ''), pttId: String(doc.PttID || doc._id) };
  const need = { name: true, firstName: true, lastName: true };
  (fields || []).forEach(function (f) {
    if (PF_FILLS_[f.fill]) need[PF_FILLS_[f.fill]] = true;
    if (f.type === 'patient') {
      (Array.isArray(f.parts) && f.parts.length ? f.parts : ['name', 'dob', 'address'])
        .forEach(function (k) { if (PF_PARTS_[k]) need[PF_PARTS_[k]] = true; });
    }
  });
  const txt = JSON.stringify(fields || []).toLowerCase();
  if (/\{\s*(date of birth|patient age)\s*\}/.test(txt)) need.dobKey = true;
  if (/\{\s*patient address\s*\}/.test(txt)) need.address = true;
  if (/\{\s*patient mobile\s*\}/.test(txt)) need.mobile = true;
  if (/\{\s*patient email\s*\}/.test(txt)) need.email = true;
  if (/\{\s*patient id\s*\}/.test(txt)) need.pttId = true;
  const out = {};
  Object.keys(need).forEach(function (k) { out[k] = all[k]; });
  return out;
}

// The Patient details block on the saved form, from their record (the patient can't change it)
function pfPatientAnswer_(doc, f) {
  const w = flowWho_(doc);
  const all = {
    name: w.name, dob: recLongDate_(doc.DobKey) || String(doc.DOB || ''), mobile: recMobile_(doc.Mobile),
    email: String(doc.Email || ''), address: String(doc.Address || ''), pttId: String(doc.PttID || doc._id),
    medicare: recMedicare_(doc['Medicare Number']), medicareIrn: String(doc['Medicare IRN'] || ''),
    medicareExp: recMedicareExp_(doc['Medicare Expiry']),
  };
  const out = {};
  (Array.isArray(f.parts) && f.parts.length ? f.parts : ['name', 'dob', 'address'])
    .forEach(function (k) { if (k in all) out[k] = all[k]; });
  return out;
}

function pfPatientTags_(doc, recordDate, today) {
  const w = flowWho_(doc);
  return {
    'patient name': w.name, 'first name': w.first, 'last name': String(doc['Last Name'] || ''),
    'date of birth': recLongDate_(doc.DobKey) || String(doc.DOB || ''), 'patient age': recAge_(doc.DobKey, recordDate),
    'patient address': String(doc.Address || ''), 'patient mobile': recMobile_(doc.Mobile), 'patient email': String(doc.Email || ''),
    'patient id': String(doc.PttID || doc._id), 'medicare number': recMedicare_(doc['Medicare Number']),
    'medicare reference number': String(doc['Medicare IRN'] || ''), 'medicare expiry': recMedicareExp_(doc['Medicare Expiry']),
    'record date': recLongDate_(recordDate), 'today': recLongDate_(today), 'my name': '',
  };
}

// A picture for the page (Firebase Storage first, then the older Google Drive bank)
function pfImage_(cfg, id) {
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(String(id || ''))) return '';
  try {
    const hosted = fsGetDoc_(cfg, 'mkt_bank_images/' + id);
    const u = String((hosted && hosted.url) || '');
    if (/^https:\/\/firebasestorage\.googleapis\.com\//.test(u)) return u;
  } catch (e) { /* the picture itself is sent below */ }
  let blob = null;
  try {
    const m = fsGetDoc_(cfg, 'image_bank/' + id);
    if (m && m.fullPath) blob = storageImageBlob_(cfg, String(m.fullPath), String(m.name || 'image'));
  } catch (e) { /* tried the Drive bank below */ }
  if (!blob) {
    const root = String(PropertiesService.getScriptProperties().getProperty('IMAGE_BANK_FOLDER_ID') || '').trim();
    const f = root ? bankFile_(root, id) : null;
    blob = f ? emailImageBlob_(f) : null;
  }
  if (!blob || blob.getBytes().length > 2500000) return '';
  return 'data:' + (blob.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(blob.getBytes());
}

// Answers from the browser: plain values only, kept to a sensible size (no lists inside lists: Firestore can't store them)
function pfClean_(v, d) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.slice(0, 5000);
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (d > 4) return null;
  if (Array.isArray(v)) return v.slice(0, 60).map(function (x) { return Array.isArray(x) ? null : pfClean_(x, d + 1); });
  if (typeof v === 'object') {
    const o = {};
    Object.keys(v).slice(0, 40).forEach(function (k) { if (k.length <= 200) o[k] = pfClean_(v[k], d + 1); });
    return o;
  }
  return null;
}
function pfBlank_(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
}

// Remembers a small read for a while (only things that rarely change). Nothing is remembered when it's missing or too big.
function pfCached_(key, secs, fn) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* read again below */ } }
  const v = fn();
  if (v) { try { const s = JSON.stringify(v); if (s.length < 95000) cache.put(key, s, secs); } catch (e) { /* not essential */ } }
  return v;
}

// What the patient sees after sending (Form Builder → Form settings → Patients fill it in online)
function pfAfter_(tpl) {
  const a = (tpl && tpl.online && tpl.online.after) || {};
  const url = String(a.url || '').trim();
  return {
    title: String(a.title || '').slice(0, 120),
    text: String(a.text || '').slice(0, 600),
    url: /^https:\/\/[^\s"'<>]+$/i.test(url) ? url.slice(0, 500) : '',
    label: String(a.label || '').slice(0, 40),
    auto: a.auto === true,
  };
}

// The form's pictures, asked for once the form is showing
function pfImages_(cfg, L) {
  const started = Date.now();
  const out = {};
  L.ver.fields.forEach(function (f) {
    if (!f || f.type !== 'image' || !f.fileId || (f.fileId in out) || Date.now() - started > 20000) return;
    out[f.fileId] = pfImage_(cfg, String(f.fileId));
  });
  return { ok: true, images: out };
}

function handlePublicForm_(body) {
  const tok = pfRead_(body.t);
  if (!tok) return { ok: true, problem: 'BAD_LINK' };
  if (tok.exp && tok.exp < Date.now()) return { ok: true, problem: 'EXPIRED' };
  const cache = CacheService.getScriptCache();
  const rk = 'pf_rl_' + flowHash_(tok.raw);
  const n = Number(cache.get(rk) || 0);
  if (n >= 60) return { ok: true, problem: 'BUSY' };
  cache.put(rk, String(n + 1), 3600);
  try {
    const t0 = Date.now();
    const cfg = getConfig_();
    const op = String(body.op || '');
    const picks = pfPicks_(body.picks);
    const test = !tok.pid || tok.cid === 'test';
    // "get" also needs the letterhead and the "already sent" check: read with the template and patient
    const extra = op === 'get'
      ? ['form_settings/letterhead'].concat(test ? [] : [PF_DONE_ + '/' + pfDoneKey_(tok, picks)])
      : [];
    const L = pfLoad_(cfg, tok, extra);
    if (L.problem) return { ok: true, problem: L.problem };
    if (op === 'get') {
      const r = pfGet_(cfg, tok, L, picks);
      console.log('Online form get: ' + (Date.now() - t0) + ' ms');
      return r;
    }
    if (op === 'images') return pfImages_(cfg, L);
    if (op === 'submit') return pfSubmit_(cfg, tok, L, body, picks);
    return { ok: false, error: 'BAD_REQUEST' };
  } catch (err) {
    console.error('Online form failed: ' + (err && err.stack ? err.stack : err));
    return { ok: true, problem: 'SERVER' };
  }
}

function pfGet_(cfg, tok, L, picks) {
  if (!L.test && L.got[PF_DONE_ + '/' + pfDoneKey_(tok, picks)]) return { ok: true, done: true };
    const ids = uniq_(L.ver.fields
    .filter(function (f) { return f && f.type === 'image' && f.fileId; })
    .map(function (f) { return String(f.fileId); }));
  const lh = L.got['form_settings/letterhead'] || null;
  return {
    ok: true, test: L.test,
    form: { name: String(L.ver.name || ''), fields: L.ver.fields, settings: L.ver.settings || {}, version: Number(L.tpl.version) },
    letterhead: lh || {}, imageIds: ids, patient: L.doc ? pfPatient_(L.doc, L.ver.fields) : {},
    after: pfAfter_(L.tpl),
    testLive: pfIsTestLive_(tok.cid),

  };
}

function pfSubmit_(cfg, tok, L, body, picks) {
  if (L.test) return { ok: true, problem: 'TEST' };
  if (Number(body.version) !== Number(L.tpl.version)) return { ok: true, problem: 'CHANGED' };
  const inA = body.answers && typeof body.answers === 'object' ? body.answers : {};
  const inS = body.signatures && typeof body.signatures === 'object' ? body.signatures : {};
  if (JSON.stringify(inA).length + JSON.stringify(inS).length > 850000) return { ok: true, problem: 'TOO_BIG' };

  const doc = L.doc;
  const fields = L.ver.fields;
  const byId = {};
  fields.forEach(function (f) { if (f && f.id) byId[f.id] = f; });
  const today = flowKey_(Date.now());
  const answers = {};
  Object.keys(inA).forEach(function (k) {
    const m = /^(.+?)(__x|__d|__p)?$/.exec(k);
    const f = m && byId[m[1]];
    if (!f || PF_LAYOUT_.indexOf(f.type) !== -1 || f.type === 'patient') return;
    answers[k] = pfClean_(inA[k], 0);
  });
  const signatures = {};
  fields.forEach(function (f) {
    if (f.type === 'patient') answers[f.id] = pfPatientAnswer_(doc, f);
    if (f.type !== 'signature') return;
    const s = inS[f.id];
    if (typeof s === 'string' && s.length < 400000 && /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(s)) {
      signatures[f.id] = s;
      const a = answers[f.id] && typeof answers[f.id] === 'object' ? answers[f.id] : {};
      answers[f.id] = { signed: true, name: String(a.name || '').slice(0, 120), date: today };
    } else {
      delete answers[f.id];
    }
  });
  // Questions that always show and must be answered
  const missing = fields.some(function (f) {
    if (f.required !== true || f.showWhen || f.liveHide || PF_NO_REQUIRE_.indexOf(f.type) !== -1) return false;
    return f.type === 'signature' ? !signatures[f.id] : pfBlank_(answers[f.id]);
  });
  if (missing) return { ok: true, problem: 'INCOMPLETE' };

  // The record date: their Record date answer (today or up to 30 days back), otherwise today
  const rdF = fields.filter(function (f) { return f.type === 'record_date'; })[0];
  let recordDate = rdF && typeof answers[rdF.id] === 'string' ? answers[rdF.id] : String(body.recordDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(recordDate) || recordDate > today || flowDays_(recordDate, today) > 30) recordDate = today;

  // Tags: the patient's come from their record
  const tagsIn = inA.__tags && typeof inA.__tags === 'object' ? inA.__tags : {};
  const tags = {};
  Object.keys(tagsIn).slice(0, 150).forEach(function (k) {
    if (k.length <= 80 && typeof tagsIn[k] === 'string') tags[k] = tagsIn[k].slice(0, 1000);
  });
  answers.__tags = Object.assign(tags, pfPatientTags_(doc, recordDate, today));

  // Details they changed on the form (their record isn't changed: staff are told)
  const changed = [];
  const digits = function (s) { return String(s || '').replace(/\D/g, '').replace(/^61(4\d{8})$/, '0$1'); };
  const norm = function (s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
  fields.forEach(function (f) {
    const v = answers[f.id];
    if (typeof v !== 'string' || !v.trim()) return;
    if (f.fill === 'patient.email' && norm(v) !== norm(doc.Email)) changed.push({ what: 'Email', from: String(doc.Email || ''), to: v });
    if (f.fill === 'patient.mobile' && digits(v) !== digits(doc.Mobile)) changed.push({ what: 'Mobile', from: recMobile_(doc.Mobile), to: v });
    if (f.fill === 'patient.address' && norm(v) !== norm(doc.Address)) changed.push({ what: 'Address', from: String(doc.Address || ''), to: v });
  });

  // The answer the button in the email chose (for the staff email; the answer itself is in answers)
  const picked = (Array.isArray(body.picked) ? body.picked : []).slice(0, 5).map(function (x) {
    const f = x && byId[String(x.id || '')];
    return f ? { question: String(f.label || f.title || 'Question').slice(0, 120), answer: String(x.a || '').slice(0, 200) } : null;
  }).filter(Boolean);
  const now = new Date();
  const s = L.ver.settings || {};
  const testLive = pfIsTestLive_(tok.cid);
  const who = flowWho_(doc);
  const subId = 'pf' + Utilities.getUuid().replace(/-/g, '').slice(0, 18);
  const sub = {
     templateId: tok.tid, templateName: (testLive ? '[Test] ' : '') + String(L.ver.name || L.tpl.name || 'Form'),
     category: String(L.tpl.category || ''),
    group: String(s.group || (L.tpl.online && L.tpl.online.group) || ''), version: Number(L.tpl.version),
    patientId: doc._id, patientPttId: String(doc.PttID || ''), patientName: who.name, recordDate: recordDate,
     answers: answers, signatures: signatures, createdAt: now,
     createdBy: testLive ? 'Patient (online) · Test' : 'Patient (online)', createdByUid: '',
     online: { campaignId: tok.cid, at: now.toISOString(), changed: changed.slice(0, 5), test: testLive, picked: picked },
  };
  const key = pfDoneKey_(tok, picks);
  if (picks.length) {   // several buttons, one link: a sensible limit
    const sent = fsQuery_(cfg, PF_DONE_, 'linkKey', 'EQUAL', pfLinkKey_(tok), PF_LINK_MAX_ + 1).length;
    if (sent >= PF_LINK_MAX_) return { ok: true, problem: 'DONE' };
  }
  const base = fsBase_(cfg);
  const ok = mktCommit_(cfg, [
    { update: { name: base + '/' + PF_DONE_ + '/' + key, fields: toFields_({
      templateId: tok.tid, patientId: doc._id, campaignId: tok.cid, submissionId: subId, at: now.toISOString(),
      linkKey: pfLinkKey_(tok), picks: picks }) },
      currentDocument: { exists: false } },
    { update: { name: base + '/form_submissions/' + subId, fields: toFields_(sub) }, currentDocument: { exists: false } },
  ]);
  if (!ok) return { ok: true, problem: fsGetDoc_(cfg, PF_DONE_ + '/' + key) ? 'DONE' : 'SERVER' };

  try { pfNotify_(cfg, L, sub, subId); } catch (e) { console.warn('Online form saved, but staff not told: ' + e); }
  if (!testLive && /^[A-Za-z0-9_-]{10,40}$/.test(tok.cid)) {
    try { mktOnce_(cfg, tok.cid, 'forms', doc._id, { at: now.toISOString(), submissionId: subId }, [mktInc_('stats.forms')]); }
    catch (e) { /* not a campaign (a flow), or not essential */ }
  }
  console.log('Online form "' + sub.templateName + '" filled in by ' + mktMask_(doc.Email) + ' (' + subId + ')');
  return { ok: true };
}

// The staff chosen in Form settings (nobody chosen: the Admins) get an email, and a to-do if it's ticked
function pfNotify_(cfg, L, sub, subId) {
  const o = L.tpl.online || {};
  const ids = (Array.isArray(o.notify) ? o.notify : []).map(String);
  const all = getStaffDocs_().filter(function (x) { return x.active !== false; });
  let who = all.filter(function (x) { return ids.indexOf(x.id) !== -1; });
  if (!who.length) who = all.filter(function (x) { return /^admin$/i.test(String(x.role || '')); });
  const ch = sub.online.changed || [];
  const tag = sub.online.test ? '[Test] ' : '';
  const pk = sub.online.picked || [];
  const inner = '<h2 style="margin:0 0 6px;font-size:20px;color:#0f766e">' + invEsc_(sub.patientName) + ' filled in ' + invEsc_(sub.templateName) + '</h2>' +
    '<p style="margin:0 0 12px;color:#475569">Filled in online by the patient, ' + invEsc_(recLongDate_(sub.recordDate)) + '. It\'s saved to their record.</p>' +
    (pk.length ? '<p style="margin:0 0 12px">Chosen from the email: ' + pk.map(function (x) {
      return invEsc_(x.question) + ' → <strong>' + invEsc_(x.answer) + '</strong>'; }).join(', ') + '</p>' : '') +
    (ch.length ? '<p style="margin:0 0 6px"><strong>They changed their details on the form.</strong> Their record hasn\'t been changed:</p><ul style="margin:0 0 12px;padding-left:20px">' +
      ch.map(function (c) { return '<li>' + invEsc_(c.what) + ': ' + invEsc_(c.from || '(none)') + ' → <strong>' + invEsc_(c.to) + '</strong></li>'; }).join('') + '</ul>' : '');
  const html = invEmailWrap_(inner, 'form-record/' + subId, 'Open the form');
  const to = uniq_(who.map(function (x) { return isEmail_(x.email) ? x.email : ''; }));
  if (to.length && MailApp.getRemainingDailyQuota() > 0) {
      MailApp.sendEmail({ to: to.join(','), name: 'Dermedica Portal', subject: tag + 'Online form: ' + sub.patientName + ' filled in ' + sub.templateName,
      htmlBody: html, body: emailHtmlToText_(html) });
  }
  if (o.todo !== false && who.length) {
    staffTodoCreate_(cfg, {
      recipients: who.map(function (x) { return { id: x.id, name: x.name }; }),
      text: tag + 'Review: ' + sub.patientName + ' filled in ' + sub.templateName + ' online' + (ch.length ? ' (details changed)' : '') +
        (pk.length ? ' · chose ' + pk.map(function (x) { return x.answer; }).join(', ') : ''),
      due: flowKey_(Date.now()), patientId: sub.patientId, patientName: sub.patientName,
      taskId: '', taskName: 'Online form', runId: subId, by: 'Online form', byUid: '',
    });
  }
}

// Every 5 minutes in the day: wakes the web app so patients opening a form don't wait for it to start up
function keepWarm() {
  const url = mktWebAppUrl_();
  if (!url) return;
  const h = Number(Utilities.formatDate(new Date(), 'Australia/Perth', 'H'));
  if (h < 7 || h >= 21) return;   // nobody's opening forms overnight
  try { UrlFetchApp.fetch(url + '?warm=1', { muteHttpExceptions: true, followRedirects: true }); }
  catch (e) { /* not essential */ }
}

// Run ONCE from the editor
function installKeepWarm() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'keepWarm'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('keepWarm').timeBased().everyMinutes(5).create();
  keepWarm();
  console.log('Keep-warm installed (every 5 minutes, 7 am to 9 pm Perth).');
}

// ===================== Recall =====================
// Patients due for their next treatment: one card per patient, treatment and last visit (recalls/{id}).
// recallRun_ makes cards from the appointment book (alltimeappts), books them when an appointment appears, closes them
// when they come in, and shares new cards between the recall team. Staff work the cards through handleRecall_,
// so every change is logged. Settings: recall_settings/config (the portal's Recall settings page).

const RECALL_COL_ = 'recalls';
const RECALL_SET_ = 'recall_settings';
const RECALL_CATS_ = [   // [category, months, on] (the same as RECALL_CATEGORIES in js/recall-settings.js)
  ['Wrinkle Relaxer', 4, true], ['Filler/Radiesse', 9, true], ['Laser/OPL/Peel', 6, true],
  ['RestoraGlow/RF/DermaGlow/Skin Needling', 6, true], ['Firm/Ulthera/eST', 9, true], ['Body Sculpting', 10, true],
  ['Other Injectables', 9, true], ['Hydrarepair/SkinRemod/CG', 6, false], ['Collagen activator', 6, false],
];
const RECALL_REASONS_ = [
  { label: 'Not interested', askDate: false, dnc: false },
  { label: 'Treated elsewhere', askDate: false, dnc: false },
  { label: 'Pregnant or breastfeeding', askDate: true, dnc: false },
  { label: 'Moved away', askDate: false, dnc: false },
  { label: "Don't contact again", askDate: false, dnc: true },
];
const RECALL_OUTCOMES_ = { no_answer: 'No answer', voicemail: 'Left voicemail', spoke: 'Spoke to them',
  texted: 'Sent a text', booked: 'Booked' };

// Services that never count as a treatment visit (Recall settings → Not recalled from these services)
const RECALL_SKIP_ = ['Review', 'Consult', 'Touch up', 'Top up', 'Follow up'];

// A service matches if it contains any of the words. Capitals, spaces and punctuation are ignored.
function recallSkipFn_(words) {
  const ws = (words || []).map(function (w) { return String(w || '').toLowerCase().replace(/[^a-z0-9]/g, ''); })
    .filter(function (w) { return w.length >= 3; });
  const memo = Object.create(null);
  return function (svc) {
    const s = String(svc == null ? '' : svc);
    if (s in memo) return memo[s];
    const k = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    return (memo[s] = ws.some(function (w) { return k.indexOf(w) !== -1; }));
  };
}

// Search keys saved on each card (the board's search box looks these up)
function recallKeys_(name, mobile, email) {
  const n = String(name || '').toLowerCase().replace(/[^a-z0-9' -]/g, ' ').replace(/\s+/g, ' ').trim();
  const parts = n ? n.split(' ') : [];
  let d = String(mobile || '').replace(/\D/g, '');
  if (/^614\d{8}$/.test(d)) d = '0' + d.slice(2);
  return {
    nameKey: n,
    nameKeyR: parts.length > 1 ? [parts[parts.length - 1]].concat(parts.slice(0, -1)).join(' ') : n,
    mobileKey: d,
    emailKey: String(email || '').trim().toLowerCase(),
  };
}

// Every service in the appointment book for a recalled treatment, with how often it's used (for Recall settings)
function recallServices_(cfg) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('recall_svcs_v1');
  if (hit) return JSON.parse(hit);
  const cats = Object.create(null);
  recallSettings_(cfg).categories.forEach(function (c) { cats[c.key.toLowerCase()] = c.key; });
  const by = Object.create(null);
  pcnReadAppts_(pcnCtx_()).forEach(function (r) {
    const cat = cats[String(r[13] == null ? '' : r[13]).trim().toLowerCase()];
    const s = String(r[9] == null ? '' : r[9]).replace(/\s+/g, ' ').trim();
    if (!cat || !s) return;
    const k = cat + '|' + s;
    (by[k] = by[k] || { service: s, category: cat, n: 0 }).n++;
  });
  const out = Object.keys(by).map(function (k) { return by[k]; })
    .sort(function (a, b) { return b.n - a.n; }).slice(0, 800);
  try { const j = JSON.stringify(out); if (j.length < 95000) cache.put('recall_svcs_v1', j, 21600); } catch (e) { /* not essential */ }
  return out;
}

function recallSettings_(cfg) {
  let d = null;
  try { d = fsGetDoc_(cfg, RECALL_SET_ + '/config'); } catch (e) { console.warn('Recall settings not read: ' + e); }
  d = d || {};
  const int = function (v, lo, hi, def) { const n = Math.floor(Number(v)); return isFinite(n) && v !== '' && v != null ? Math.max(lo, Math.min(hi, n)) : def; };
  const seen = {};
  const cats = [];
  (Array.isArray(d.categories) && d.categories.length ? d.categories
    : RECALL_CATS_.map(function (c) { return { key: c[0], months: c[1], on: c[2] }; }))
    .forEach(function (c) {
      const key = String((c && c.key) || '').trim().slice(0, 80);
      if (!key || seen[key]) return;
      seen[key] = true;
      cats.push({
        key: key, months: int(c.months, 1, 36, 6), on: c.on !== false,
        smsName: String((c && c.smsName) || RECALL_SMS_NAMES_[key] || 'treatment').replace(/\s+/g, ' ').trim().slice(0, 60),
      });
    });
  const reasons = (Array.isArray(d.reasons) && d.reasons.length ? d.reasons : RECALL_REASONS_).map(function (r) {
    return { label: String((r && r.label) || '').trim().slice(0, 60), askDate: !!(r && r.askDate), dnc: !!(r && r.dnc) };
  }).filter(function (r) { return r.label; }).slice(0, 20);
  const sm = d.sms && typeof d.sms === 'object' ? d.sms : {};
  return {
    categories: cats,
    maxAgeMonths: int(d.maxAgeMonths, 3, 60, 24),
    leadDays: int(d.leadDays, 0, 60, 0),
    anyFuturePauses: d.anyFuturePauses === true,
    team: (Array.isArray(d.team) ? d.team : []).map(String).filter(Boolean).slice(0, 30),
    perDay: int(d.perDay, 1, 100, 15),
    skipLeave: d.skipLeave !== false,
    reasons: reasons.length ? reasons : RECALL_REASONS_,
    skipServices: (Array.isArray(d.skipServices) ? d.skipServices : RECALL_SKIP_)
      .map(function (s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 40); })
      .filter(function (s) { return s.replace(/[^A-Za-z0-9]/g, '').length >= 3; }).slice(0, 40),
    sms: {
      on: false,   // automatic texts are now cards in the Recall flow
      template: String(sm.template || RECALL_SMS_TEMPLATE_).slice(0, 560),
      phone: String(sm.phone || '').replace(/[^\d +()-]/g, '').trim().slice(0, 30),
      waitDays: int(sm.waitDays, 1, 30, 7),
      perDay: int(sm.perDay, 1, 300, 30),
    },
    updatedAt: String(d.updatedAt || ''),
  };
}

// { category: months } for the treatments that are recalled (the PCN overdue list uses this too)
function recallMonthsMap_(cfg) {
  const out = {};
  recallSettings_(cfg).categories.forEach(function (c) { if (c.on) out[c.key] = c.months; });
  return Object.keys(out).length ? out : PCN_OVERDUE_MONTHS_;
}
// { dnc, dncWhy } for a recall card, from the patient record ('Marketing OK' false = on the do-not-contact list)
function recallDncOf_(p) {
  if (!p || p['Marketing OK'] !== false) return { dnc: false, dncWhy: '' };
  const c = p['Marketing Consent'] || {};
  const at = String(c.at || '').slice(0, 10);
  return { dnc: true, dncWhy: [String(c.source || 'Do not contact list'), at ? recLongDate_(at) : ''].filter(Boolean).join(' · ') };
}
// Every patient by PttID (and doc ID), following merges to the record that was kept
function recallPatients_(cfg) {
  const byId = Object.create(null);
  const byPtt = Object.create(null);
  fsListAll_(cfg, 'patient_list', ['PttID', 'Patient Name', 'First Name', 'Last Name', 'Mobile', 'Email', 'MergedInto',
    'Marketing OK', 'Marketing Consent'])
    .forEach(function (d) {
      const f = fromFields_(d.fields || {});
      const id = d.name.split('/').pop();
      byId[id] = f;
      const ptt = String(f.PttID == null ? '' : f.PttID).trim().toLowerCase();
      if (ptt) byPtt[ptt] = id;
      if (!byPtt[id.toLowerCase()]) byPtt[id.toLowerCase()] = id;
    });
  const kept = function (id) {
    for (let i = 0; i < 5 && byId[id] && byId[id].MergedInto && byId[String(byId[id].MergedInto)]; i++) id = String(byId[id].MergedInto);
    return byId[id] ? id : '';
  };
  return {
    find: function (ptt) { const id = byPtt[String(ptt || '').trim().toLowerCase()]; return id ? kept(id) : ''; },
    doc: function (id) { return byId[id] || null; },
  };
}

// Working today? (Staff → Work schedule: no schedule counts as available)
function recallAvailable_(s, today) {
  const sc = staffSchedClean_(s.schedule).schedule;
  if (!sc) return true;
  if ((sc.leave || []).some(function (l) { return l.from <= today && today <= l.to; })) return false;
  const any = SCHED_DAY_KEYS_.some(function (k) { return sc.week[k] && sc.week[k].on; });
  if (!any) return true;
  const dk = SCHED_DAY_KEYS_[Number(Utilities.formatDate(new Date(), REC_TZ_, 'u')) - 1];
  return !!(sc.week[dk] && sc.week[dk].on);
}

/* ---------- The check ---------- */

// The hourly trigger. The full check runs once a day, after each Day Sheet upload and after settings change;
// the other hours only share out waiting cards.
function runRecall() {
  try { const r = recallRun_(false); if (!r.quick) console.log('Recall: ' + JSON.stringify(r)); }
  catch (e) { console.error('Recall: ' + (e && e.stack ? e.stack : e)); }
}

function recallRun_(force) {
  const cache = CacheService.getScriptCache();
  if (cache.get('up_ds_active') || cache.get('pcn_run_active')) {
    return { ok: true, later: true, why: 'A Day Sheet upload or PCN update is running. Recall checks again after it.' };
  }
  if (cache.get('recall_run')) return { ok: true, later: true, why: 'Recall is already checking. Try again in a minute.' };
  cache.put('recall_run', '1', 600);
  try {
    const cfg = getConfig_();
    const ds = fsGetDoc_(cfg, 'data_uploads/daysheet') || {};
    if (ds.status === 'running') return { ok: true, later: true, why: 'A Day Sheet upload is running. Recall checks again after it.' };
    const set = recallSettings_(cfg);
    const today = flowKey_(Date.now());
    const props = PropertiesService.getScriptProperties();
    const sig = [today, String(ds.at || ''), set.updatedAt].join('|');
    if (!force && props.getProperty('RECALL_SIG') === sig) {
      return { ok: true, quick: true, texted: recallTextSafe_(cfg, set, today), assigned: recallAssign_(cfg, set, today) };
    }
    const res = recallCheck_(cfg, set, today, force);
    res.texted = recallTextSafe_(cfg, set, today);
    res.assigned = recallAssign_(cfg, set, today);
    commitWrites_(cfg, [updateWrite_(cfg, RECALL_SET_ + '/status', {
      at: new Date().toISOString(), made: res.made, booked: res.booked, visited: res.visited, reopened: res.reopened,
      back: res.back, offCat: res.offCat, retired: res.retired, paused: res.paused, texted: res.texted, assigned: res.assigned, rows: res.rows, ms: res.ms,
    })]);
    props.setProperty('RECALL_SIG', sig);
    props.setProperty('RECALL_ROWS', String(res.rows));
    return Object.assign({ ok: true }, res);
  } finally {
    cache.remove('recall_run');
  }
}

function recallCheck_(cfg, set, today, force) {
  const t0 = Date.now();
  const ctx = pcnCtx_();
  const rows = pcnReadAppts_(ctx);
  const was = Number(PropertiesService.getScriptProperties().getProperty('RECALL_ROWS') || 0);
  if (!force && was > 1000 && rows.length < was * 0.7) {
    throw new Error('The appointment book has ' + rows.length + ' rows, but had ' + was + " last time. Recall wasn't changed.");
  }

  // Each patient's last treatment visit and next treatment booking, per treatment.
  // Services on the "Not recalled" list (reviews, consults, touch-ups) don't count.
  const catOf = Object.create(null);
  set.categories.forEach(function (c) { catOf[c.key.toLowerCase()] = c; });
  const skip = recallSkipFn_(set.skipServices);
  const pts = recallPatients_(cfg);
  const pidOf = Object.create(null);
  const groups = Object.create(null);
  const skipped = Object.create(null);   // patient|treatment → past days that had a skipped service
  const anyFuture = Object.create(null);
  rows.forEach(function (r) {
    if (!pcnIsDate_(r[0]) || !pcnStatusOk_(r[7], 'dns')) return;   // cancelled and no-shows don't count
    const ptt = String(r[14] == null ? '' : r[14]).trim();
    if (!ptt) return;                                               // no Patient ID: we can't be sure who it is
    if (!(ptt in pidOf)) pidOf[ptt] = pts.find(ptt);
    const pid = pidOf[ptt];
    if (!pid) return;
    const dk = Utilities.formatDate(r[0], ctx.tz, 'yyyy-MM-dd');
    const future = r[0].getTime() >= ctx.today;                     // today's appointments count as booked
    if (future && (!anyFuture[pid] || dk < anyFuture[pid])) anyFuture[pid] = dk;
    const cat = catOf[String(r[13] == null ? '' : r[13]).trim().toLowerCase()];
    if (!cat) return;
    const k = pid + '|' + cat.key;
    if (skip(r[9])) {
      if (!future) (skipped[k] = skipped[k] || Object.create(null))[dk] = true;
      return;
    }
    const g = groups[k] || (groups[k] = { pid: pid, cat: cat, last: '', staff: '', svc: [], future: '' });
    if (future) { if (!g.future || dk < g.future) g.future = dk; return; }
    if (dk > g.last) { g.last = dk; g.staff = String(r[8] == null ? '' : r[8]).trim(); g.svc = []; }
    if (dk === g.last) {
      const s = String(r[9] == null ? '' : r[9]).trim();
      if (s && g.svc.indexOf(s) === -1 && g.svc.length < 5) g.svc.push(s);
    }
  });

  const now = new Date().toISOString();
  const writes = [];
  const sum = { made: 0, booked: 0, visited: 0, reopened: 0, back: 0, offCat: 0, retired: 0, paused: 0 };
  const add = function (c, what) {
    return (Array.isArray(c.log) ? c.log : []).concat([{ at: now, by: 'Recall', byUid: '', kind: 'auto', what: what, note: '' }]).slice(-80);
  };
  const live = Object.create(null);   // patient|treatment with a card still open or booked

  // Cards already open or booked (newest visit first, so a duplicate is the older one)
  fsQuery_(cfg, RECALL_COL_, 'status', 'IN', ['open', 'booked'], 10000)
    .sort(function (a, b) { return String(b.lastVisit || '').localeCompare(String(a.lastVisit || '')); })
    .forEach(function (c) {
      const path = RECALL_COL_ + '/' + c._id;
      const key = c.patientId + '|' + c.category;
      const lv = String(c.lastVisit || '');
      const fix = c.nameKey ? null : recallKeys_(c.patientName, c.mobile, c.email);   // search keys on older cards
      const dn = recallDncOf_(pts.doc(c.patientId));
      const dncFix = (c.dnc === true) !== dn.dnc || String(c.dncWhy || '') !== dn.dncWhy ? dn : null;
            // Their next appointment (any treatment), for the board's Upcoming visit filter
      const nextAppt = anyFuture[c.patientId] || '';
      const apptFix = typeof c.hasAppt !== 'boolean' || c.hasAppt !== !!nextAppt || String(c.nextAppt || '') !== nextAppt
        ? { nextAppt: nextAppt, hasAppt: !!nextAppt } : null;
      let touched = false;
      const put = function (patch, what) {
        touched = true;
        if (fix) Object.assign(patch, fix);
        if (dncFix) Object.assign(patch, dncFix);
        if (apptFix) Object.assign(patch, apptFix);
        patch.log = add(c, what);
        patch.updatedAt = now;
        writes.push(patchWrite_(cfg, path, patch));
      };
      (function () {
        const cat = catOf[String(c.category || '').toLowerCase()];
        if (!cat || !cat.on) {
          put({ status: 'closed', closeReason: 'Recall is turned off for this treatment', closedAt: now, closedBy: 'Recall' },
            'Closed: recall is turned off for ' + c.category);
          sum.offCat++;
          return;
        }
        const g = groups[key];
        // Started by a visit that's now on the "Not recalled" list: a new card comes from the real treatment visit
        if (skipped[key] && skipped[key][lv] && (!g || g.last < lv)) {
          put({ status: 'closed', closeReason: 'Last visit was not a treatment', closedAt: now, closedBy: 'Recall', remindOn: '' },
            'Closed: the visit on ' + recLongDate_(lv) + " was a service that isn't recalled");
          sum.retired++;
          return;
        }
        if (live[key]) {
          put({ status: 'closed', closeReason: 'Duplicate', closedAt: now, closedBy: 'Recall' }, 'Closed: a newer card is open');
          return;
        }
        if (g && g.last > lv) {
          put({ status: 'closed', closeReason: 'Came in', visitedOn: g.last, closedAt: now, closedBy: 'Recall', remindOn: '' },
            'Came in on ' + recLongDate_(g.last));
          sum.visited++;
          return;
        }
        live[key] = true;
        if (g && g.future) {
          if (c.status !== 'booked' || c.bookedFor !== g.future) {
            put({ status: 'booked', bookedFor: g.future, bookedAt: c.bookedAt || now, remindOn: '' },
              'Booked for ' + recLongDate_(g.future) + ' (in the appointment book)');
            if (c.status !== 'booked') sum.booked++;
          }
          return;
        }
        if (c.status === 'booked') {
          const phoned = !c.bookedFor;
          if (!phoned || Date.now() - (Date.parse(String(c.bookedAt || '')) || 0) > 3 * 86400000) {
            put({ status: 'open', stage: c.assignedToId ? 'call' : 'due', bookedFor: '', bookedAt: '' },
              phoned ? "Marked as booked, but it isn't in the appointment book"
                : 'The booking for ' + recLongDate_(c.bookedFor) + ' is no longer in the appointment book');
            sum.reopened++;
          }
          return;
        }
        // Any appointment booked (for any treatment): paused until the day after it. Recall settings → the tick.
        const appt = set.anyFuturePauses ? anyFuture[c.patientId] : '';
        if (appt) {
          const until = flowAddDaysKey_(appt, 1);
          if (c.stage === 'later' && String(c.remindOn || '') >= until) return;   // already paused long enough
          const fs = String(c.flowState || '');
          const inFlow = ['run', 'wait', 'team', 'cycle', 'queued', 'released', 'joined'].indexOf(fs) !== -1;
          put(Object.assign({ stage: 'later', remindOn: until, pauseReason: 'Has an appointment on ' + recLongDate_(appt), apptPaused: appt,
              callBackDue: '' },
            inFlow ? { flowState: 'paused', pausedFlow: fs, flowNext: '' } : {}),
            'Paused: they have an appointment on ' + recLongDate_(appt) + (inFlow ? '. The recall flow is paused too' : '') +
            ". Back on the list the day after, if they're still due");
          sum.paused++;
          return;
        }
        if (c.stage === 'later' && c.remindOn && String(c.remindOn) <= today) {
          put(Object.assign({ stage: c.assignedToId ? 'call' : 'due', remindOn: '', pauseReason: '', apptPaused: '',
              callBackDue: !c.apptPaused && !c.pauseReason ? today : '' },   // only call-backs staff set, not pauses
            c.flowState === 'paused' ? { flowState: 'released', pausedFlow: '' } : {}),
            c.apptPaused ? 'Back on the list: their appointment on ' + recLongDate_(c.apptPaused) + " has passed and they're still due"
              : c.pauseReason ? 'Back on the list (was paused: ' + c.pauseReason + ')' : 'Reminder: call them back today');
          sum.back++;
        }
      })();
      if (!touched && (fix || dncFix || apptFix)) {
        writes.push(patchWrite_(cfg, path, Object.assign({}, fix || {}, dncFix || {}, apptFix || {})));
      }
    });

  // New cards: due (or due within the lead days), nothing booked, last visit not too long ago
  const minLast = flowAddMonthsKey_(today, -set.maxAgeMonths);
  const until = flowAddDaysKey_(today, set.leadDays);
  const want = [];
  Object.keys(groups).forEach(function (k) {
    const g = groups[k];
    if (!g.cat.on || !g.last || g.future || live[k] || g.last < minLast) return;
    if (set.anyFuturePauses && anyFuture[g.pid]) return;
    const due = flowAddMonthsKey_(g.last, g.cat.months);
    if (due > until) return;
    want.push({ id: flowPart_(g.pid) + '__' + flowPart_(g.cat.key) + '__' + g.last.replace(/-/g, ''), k: k, g: g, due: due });
  });
  // A card closed for this same visit ("Not interested") isn't made again. One closed as "Came in" by a visit
  // that's now on the "Not recalled" list goes back on the list.
  const have = want.length ? fsBatchGet_(cfg, want.map(function (w) { return RECALL_COL_ + '/' + w.id; })) : {};
  want.forEach(function (w) {
    const old = have[RECALL_COL_ + '/' + w.id];
    if (old) {
      if (old.status === 'closed' && old.closeReason === 'Came in' && skipped[w.k] && skipped[w.k][String(old.visitedOn || '')]) {
        writes.push(patchWrite_(cfg, RECALL_COL_ + '/' + w.id, Object.assign({
          status: 'open', stage: 'due', assignedToId: '', assignedToName: '', assignedDay: '',
          closeReason: '', closedAt: '', closedBy: '',
      nextAppt: anyFuture[w.g.pid] || '', hasAppt: !!anyFuture[w.g.pid], visitedOn: '', updatedAt: now,
          log: add(old, 'Back on the list: the visit on ' + recLongDate_(old.visitedOn) + " was a service that isn't recalled"),
        }, recallKeys_(old.patientName, old.mobile, old.email))));
        sum.reopened++;
      }
      return;
    }
    const doc = pts.doc(w.g.pid) || {};
    const who = flowWho_(doc);
    writes.push(updateWrite_(cfg, RECALL_COL_ + '/' + w.id, Object.assign({
      patientId: w.g.pid, pttId: String(doc.PttID || w.g.pid), patientName: who.name,
      mobile: String(doc.Mobile || ''), email: String(doc.Email || ''),
      category: w.g.cat.key, months: w.g.cat.months, lastVisit: w.g.last, lastStaff: w.g.staff, lastServices: w.g.svc,
      dueDate: w.due, status: 'open', stage: 'due', assignedToId: '', assignedToName: '', assignedDay: '',
      remindOn: '', pauseReason: '', attempts: 0, bookedFor: '', bookedAt: '', visitedOn: '',
      closeReason: '', closedAt: '', closedBy: '',
      log: [{ at: now, by: 'Recall', byUid: '', kind: 'auto', what: 'Due for ' + w.g.cat.key + ' (last visit ' + recLongDate_(w.g.last) + ')', note: '' }],
      createdAt: now, updatedAt: now,
    }, recallKeys_(who.name, doc.Mobile, doc.Email), recallDncOf_(doc))));
    sum.made++;
  });

  if (writes.length) commitWrites_(cfg, writes, 100);
  return Object.assign(sum, { rows: rows.length, ms: Date.now() - t0 });
}

// Shares waiting cards between the recall team: oldest due first, to whoever has had the fewest today,
// up to each person's daily limit. Cards held by someone no longer active go back to waiting.
function recallAssign_(cfg, set, today) {
  const all = getStaffDocs_();
  const active = {};
  all.forEach(function (s) { if (s.active !== false) active[s.id] = true; });
  const team = all.filter(function (s) {
    return set.team.indexOf(s.id) !== -1 && s.active !== false && (!set.skipLeave || recallAvailable_(s, today));
  });
  const open = fsQuery_(cfg, RECALL_COL_, 'status', 'EQUAL', 'open', 10000);
  const now = new Date().toISOString();
  const writes = [];
  const load = {};
  team.forEach(function (s) { load[s.id] = { s: s, today: 0, open: 0 }; });
  const waiting = [];
  open.forEach(function (c) {
    if (c.assignedToId && !active[c.assignedToId]) {   // left, or turned off: back to waiting
      c.assignedToId = '';
      if (c.stage === 'call') c.stage = 'due';
      c._freed = true;
    }
    const l = load[c.assignedToId];
    if (l) { if (c.assignedDay === today) l.today++; if (c.stage === 'call') l.open++; }
    // Waiting for an automatic text, or for a reply to one: not shared out yet
    const held = (c.textHoldUntil && String(c.textHoldUntil) > today && !c.replyOpen) || recallWantsText_(c, set, today)
      || ['run', 'wait', 'queued', 'cycle', 'joined', 'released'].indexOf(String(c.flowState || '')) !== -1;   // the Recall flow has it
    if (c._freed && held) {
      writes.push(patchWrite_(cfg, RECALL_COL_ + '/' + c._id, { assignedToId: '', assignedToName: '', assignedDay: '', stage: 'due', updatedAt: now,
        log: (Array.isArray(c.log) ? c.log : []).concat([{ at: now, by: 'Recall', byUid: '', kind: 'auto', what: 'Back to waiting (the person it was given to is no longer active)', note: '' }]).slice(-80) }));
    }
    if (!c.assignedToId && c.stage !== 'later' && !held) waiting.push(c);
  });
  // Most recently due first (they're the likeliest to book), then anyone due soon (Recall settings → lead days)
  waiting.sort(function (a, b) {
    const fa = String(a.dueDate) > today ? 1 : 0;
    const fb = String(b.dueDate) > today ? 1 : 0;
    return fa - fb || (fa ? String(a.dueDate).localeCompare(String(b.dueDate)) : String(b.dueDate).localeCompare(String(a.dueDate)));
  });
  waiting.forEach(function (c) {
    const pick = Object.keys(load).map(function (k) { return load[k]; })
      // Up to the daily number of new calls, and never more than two days' worth waiting to be made
      .filter(function (l) { return l.today < set.perDay && l.open < set.perDay * 2; })
      .sort(function (a, b) { return a.today - b.today || a.open - b.open || String(a.s.name).localeCompare(String(b.s.name)); })[0];
    const log = Array.isArray(c.log) ? c.log : [];
    if (!pick) {
      if (c._freed) {
        writes.push(patchWrite_(cfg, RECALL_COL_ + '/' + c._id, { assignedToId: '', assignedToName: '', assignedDay: '', stage: 'due', updatedAt: now,
          log: log.concat([{ at: now, by: 'Recall', byUid: '', kind: 'auto', what: 'Back to waiting (the person it was given to is no longer active)', note: '' }]).slice(-80) }));
      }
      return;
    }
    pick.today++;
    pick.open++;
    writes.push(patchWrite_(cfg, RECALL_COL_ + '/' + c._id, {
      stage: 'call', assignedToId: pick.s.id, assignedToName: String(pick.s.name || ''), assignedDay: today, updatedAt: now,
      log: log.concat([{ at: now, by: 'Recall', byUid: '', kind: 'auto', what: 'Given to ' + pick.s.name + ' (shared in turn)', note: '' }]).slice(-80),
    }));
  });
  if (writes.length) commitWrites_(cfg, writes, 100);
  return writes.length;
}

/* ---------- From the portal ---------- */

function handleRecall_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const op = String(body.op || '');
  const manage = can_(session, 'recall.manage');
  if (!manage && !can_(session, 'recall.work')) return { ok: false, error: 'FORBIDDEN' };
  try {
    if (op === 'refresh') {
      if (!manage) return { ok: false, error: 'FORBIDDEN' };
      try { return recallRun_(true); }
      catch (e) { return { ok: true, problem: String(e && e.message ? e.message : e).slice(0, 300) }; }
    }
    if (op === 'services') {
      if (!manage) return { ok: false, error: 'FORBIDDEN' };
      return { ok: true, services: recallServices_(getConfig_()) };
    }
    if (op === 'results') {
      if (!manage) return { ok: false, error: 'FORBIDDEN' };
      return recallResults_(body);
    }
    if (op === 'sendEmail') return recallSendEmail_(body, session);   // anyone with Recall access (checked above)
    if (op === 'messages') return recallMessages_(body);   // anyone with Recall access
    if (op === 'flowPreview' || op === 'flowSkip' || op === 'flowAdopt') {
      if (!manage) return { ok: false, error: 'FORBIDDEN' };
      if (op === 'flowAdopt') return recallFlowAdopt_(body, session);
      return op === 'flowPreview' ? recallFlowPreview_(body, session) : recallFlowSkip_(body, session);
    }
    if (op === 'flowTest') {
      if (!manage) return { ok: false, error: 'FORBIDDEN' };
      return recallFlowTest_(body, session);
    }
    if (op === 'smsStatus' || op === 'smsTest') {
      if (!manage) return { ok: false, error: 'FORBIDDEN' };
      return recallSmsAdmin_(op, body, session);
    }
    const id = String(body.id || '');
    if (!/^[A-Za-z0-9_-]{5,200}$/.test(id)) return { ok: false, error: 'BAD_REQUEST' };
    if (CacheService.getScriptCache().get('recall_run')) return { ok: true, problem: 'Recall is updating its list. Try again in a minute.' };
    const unlock = staffTaskLock_('rc_' + id);
    if (!unlock) return { ok: true, problem: 'Someone else is saving this card. Try again.' };
    try { return recallAction_(op, id, body, session); }
    finally { unlock(); }
  } catch (err) {
    console.error('Recall ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: false, error: 'SERVER_ERROR', detail: String(err && err.message ? err.message : err).slice(0, 300) };
  }
}

function recallAction_(op, id, body, session) {
  const cfg = getConfig_();
  const path = RECALL_COL_ + '/' + id;
  const c = fsGetDoc_(cfg, path);
  if (!c) return { ok: false, error: 'NOT_FOUND' };
  const now = new Date().toISOString();
  const today = flowKey_(Date.now());
  const who = String(session.name || 'Staff');
  const uid = String(session.uid || '');
  const note = String(body.note || '').replace(/\r/g, '').trim().slice(0, 1000);
  const log = (Array.isArray(c.log) ? c.log : []).slice(-78);
  const add = function (kind, what, withNote) {
    log.push({ at: now, by: who, byUid: uid, kind: kind, what: what, note: withNote === false ? '' : note });
  };
  const dateOk = function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d) && d > today && flowDays_(today, d) <= 730; };
  let patch = null;

  if (op === 'log') {
    if (c.status !== 'open') return { ok: true, problem: 'This card is booked or closed. Reopen it first.' };
    const out = String(body.outcome || '');
    if (out && !RECALL_OUTCOMES_[out]) return { ok: false, error: 'BAD_REQUEST' };
    const remind = String(body.remindOn || '');
    if (!out && !note && !remind) return { ok: true, problem: 'Choose what happened, or write a note.' };
    if (remind && !dateOk(remind)) return { ok: true, problem: 'Choose a call-back date after today.' };
    const isCall = ['no_answer', 'voicemail', 'spoke'].indexOf(out) !== -1;   // only these count as a call
    patch = {};
    if (isCall) Object.assign(patch, { lastCallAt: now, lastCallBy: uid, lastCallDay: today });
    if (out === 'texted') Object.assign(patch, { lastTextAt: now, lastTextBy: uid, lastTextByName: who, texts: Number(c.texts || 0) + 1 });
    if (out) patch.lastOutcome = out;
    if (out === 'booked') {
      add('call', 'Booked');
      Object.assign(patch, { status: 'booked', bookedFor: '', bookedAt: now, remindOn: '', pauseReason: '' });
    } else {
      add(out ? 'call' : 'note', out ? RECALL_OUTCOMES_[out] : 'Note');
      if (out === 'no_answer' || out === 'voicemail') patch.attempts = Number(c.attempts || 0) + 1;
      if (remind) {
        add('status', 'Call back on ' + recLongDate_(remind), false);
        Object.assign(patch, { stage: 'later', remindOn: remind, pauseReason: '' });
      }
    }
    // Doing something with a waiting card (a call, a text, booked or a call-back date) makes it yours. A note doesn't.
    if (!c.assignedToId && (out || remind)) {
      Object.assign(patch, { assignedToId: uid, assignedToName: who, assignedDay: today });
      if (!patch.stage && out !== 'booked') patch.stage = 'call';
    }
    if (out) patch.replyOpen = false;   // a reply has been followed up
  } else if (op === 'text') {
    if (c.status === 'closed') return { ok: true, problem: 'This card is closed. Reopen it first.' };
    const auth = tmAuth_();
    if (!auth) return { ok: true, problem: "Texts aren't set up yet. Add TextMagic, TextMagicUser and TextMagicFrom in Apps Script → Script Properties." };
    const phone = recallPhone61_(c.mobile);
    if (!phone) return { ok: true, problem: "There's no Australian mobile number on their record." };
    const h = Number(Utilities.formatDate(new Date(), REC_TZ_, 'H'));
    if (h < 8 || h >= 20) return { ok: true, problem: 'Texts can only be sent between 8 am and 8 pm.' };
    const blocked = recallTextBlocked_(cfg, c.patientId);
    if (blocked) return { ok: true, problem: blocked + " Recall texts can't be sent to them." };
    const text = recallSmsText_(body.text);
    if (text.replace(/reply\s+stop\s+to\s+opt\s+out\.?/i, '').trim().length < 10) return { ok: true, problem: 'Write the message first.' };
    const cache = CacheService.getScriptCache();
    const rk = 'rc_sms_' + uid;
    const used = Number(cache.get(rk) || 0);
    if (used >= 60) return { ok: true, problem: "You've sent a lot of texts in the last hour. Try again a bit later." };
    try { tmSend_(auth, phone, text); }
    catch (e) { return { ok: true, problem: "The text wasn't sent: " + String(e && e.message ? e.message : e) }; }
    cache.put(rk, String(used + 1), 3600);
    log.push({ at: now, by: who, byUid: uid, kind: 'text', what: 'Text sent', note: text });
    patch = { lastTextAt: now, lastTextBy: uid, lastTextByName: who, texts: Number(c.texts || 0) + 1, replyOpen: false };
    if (c.status === 'open' && !c.assignedToId) {
      Object.assign(patch, { assignedToId: uid, assignedToName: who, assignedDay: today, stage: c.stage === 'later' ? 'later' : 'call' });
    }
  } else if (op === 'assign') {
    const toId = String(body.toId || '');
    if (toId === String(c.assignedToId || '')) return { ok: true, already: true };
    if (!toId) {
      add('status', 'Back to waiting', false);
      patch = { assignedToId: '', assignedToName: '', assignedDay: '', stage: c.stage === 'later' ? 'later' : 'due' };
    } else {
      const s = getStaffDocs_().filter(function (x) { return x.id === toId && x.active !== false; })[0];
      if (!s) return { ok: false, error: 'NO_STAFF' };
      add('status', 'Given to ' + s.name, false);
      patch = { assignedToId: s.id, assignedToName: String(s.name || ''), assignedDay: today, stage: c.stage === 'later' ? 'later' : 'call' };
    }
  } else if (op === 'close') {
    if (c.status === 'closed') return { ok: true, already: true };
    const r = recallSettings_(cfg).reasons.filter(function (x) { return x.label === String(body.reason || ''); })[0];
    if (!r) return { ok: true, problem: 'Choose a reason.' };
    if (r.askDate) {   // paused, not closed: back on the list on that date
      const until = String(body.until || '');
      if (!dateOk(until)) return { ok: true, problem: 'Choose when to start recalling them again.' };
      add('status', r.label + ': paused until ' + recLongDate_(until));
      patch = { status: 'open', stage: 'later', remindOn: until, pauseReason: r.label, bookedFor: '', bookedAt: '' };
    } else {
      add('status', 'Closed: ' + r.label);
      patch = { status: 'closed', closeReason: r.label, closedAt: now, closedBy: who, remindOn: '' };
      if (r.dnc) {
        try {
          mktSetConsent_(cfg, c.patientId, false, { by: who, byUid: uid, source: 'Do not contact list',
            note: 'From Recall' + (note ? ': ' + note : ''), dnc: true, why: 'Asked not to be contacted' });
        } catch (e) { console.warn('Recall closed, but do-not-contact not saved: ' + e); }
      }
    }
    patch.replyOpen = false;
  } else if (op === 'reopen') {
    if (c.status === 'open') return { ok: true, already: true };
    if (c.status === 'closed' && c.closeReason === 'Came in') {
      return { ok: true, problem: "They've been in since. A new card is made when they're next due." };
    }
    add('status', c.status === 'booked' ? 'Not booked after all' : 'Reopened');
    patch = { status: 'open', stage: c.assignedToId ? 'call' : 'due', closeReason: '', closedAt: '', closedBy: '', bookedFor: '', bookedAt: '' };
  }
  if (!patch) return { ok: false, error: 'BAD_REQUEST' };
  // Working the card clears "call back today". A note, or passing it to someone, doesn't.
  const worked = op === 'close' || op === 'reopen' || op === 'text' ||
    (op === 'log' && !!(String(body.outcome || '') || String(body.remindOn || '')));
  if (worked && c.callBackDue) patch.callBackDue = '';
  patch.log = log.slice(-80);
  patch.updatedAt = now;
  commitWrites_(cfg, [patchWrite_(cfg, path, patch)]);
  return { ok: true };
}


// Run ONCE from the editor: checks every hour, and does the first check now
function installRecall() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runRecall'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runRecall').timeBased().everyHours(1).create();
  console.log('Recall installed (every hour). First check: ' + JSON.stringify(recallRun_(true)));
}

// Run ONCE from the editor after changing the order: cards shared out automatically that nobody has worked yet
// go back to Waiting, then are shared out again, most recently due first. Cards someone has called, noted
// or given to a person by hand are left alone.
function recallReshare() {
  const cfg = getConfig_();
  const now = new Date().toISOString();
  const writes = [];
  fsQuery_(cfg, RECALL_COL_, 'status', 'EQUAL', 'open', 10000).forEach(function (c) {
    if (c.stage !== 'call' || !c.assignedToId || Number(c.attempts || 0) > 0) return;
    const log = Array.isArray(c.log) ? c.log : [];
    if (log.some(function (l) { return l && l.kind !== 'auto'; })) return;   // someone has worked it
    writes.push(patchWrite_(cfg, RECALL_COL_ + '/' + c._id, {
      stage: 'due', assignedToId: '', assignedToName: '', assignedDay: '', updatedAt: now,
      log: log.concat([{ at: now, by: 'Recall', byUid: '', kind: 'auto',
        what: 'Back to waiting (shared again, most recently due first)', note: '' }]).slice(-80),
    }));
  });
  if (writes.length) commitWrites_(cfg, writes, 100);
  const shared = recallAssign_(cfg, recallSettings_(cfg), flowKey_(Date.now()));
  console.log(writes.length + ' card(s) back to waiting. ' + shared + ' shared out again.');
}

// ===================== Recall: texts (Textmagic) =====================
// Script Properties: TextMagic (the API key), TextMagicUser (the username), TextMagicFrom (the dedicated number, e.g. 61412345678).
// Sending: "Send text" on each card, and (Recall settings → Texts) an automatic text when someone becomes due.
// Replies: checked every 5 minutes (runNotifications). Each goes on the matching card; STOP puts them on do not contact.

const TM_API_ = 'https://rest.textmagic.com/api/v2';
const RECALL_REPLIES_ = 'recall_replies';
// Kept general on purpose: Australian advertising rules don't allow prescription medicines to be named
const RECALL_SMS_NAMES_ = {
  'Wrinkle Relaxer': 'anti-wrinkle treatment', 'Filler/Radiesse': 'filler treatment', 'Laser/OPL/Peel': 'laser or peel treatment',
  'RestoraGlow/RF/DermaGlow/Skin Needling': 'skin treatment', 'Firm/Ulthera/eST': 'skin tightening treatment',
  'Body Sculpting': 'body sculpting treatment', 'Other Injectables': 'skin booster treatment',
  'Hydrarepair/SkinRemod/CG': 'skin treatment', 'Collagen activator': 'collagen treatment',
};
const RECALL_SMS_TEMPLATE_ = "Hi {First name}, it's Dermedica. It's been about {Months} months since your {Treatment}, " +
  "so you're due for your next one. Reply YES and we'll call you to book.";

function tmAuth_() {
  const p = PropertiesService.getScriptProperties();
  let key = String(p.getProperty('TextMagic') || '').trim();
  let user = String(p.getProperty('TextMagicUser') || '').trim();
  if (!user && key.indexOf(':') > 0) {   // "username:key" in one property
    user = key.slice(0, key.indexOf(':')).trim();
    key = key.slice(key.indexOf(':') + 1).trim();
  }
  const from = String(p.getProperty('TextMagicFrom') || '').replace(/\D/g, '');
  return key && user ? { key: key, user: user, from: from } : null;
}

function tmFetch_(auth, method, path, payload) {
  const opt = { method: method, muteHttpExceptions: true, headers: { 'X-TM-Username': auth.user, 'X-TM-Key': auth.key } };
  if (payload) opt.payload = payload;
  const res = UrlFetchApp.fetch(TM_API_ + path, opt);
  const code = res.getResponseCode();
  let body = {};
  try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { /* not JSON */ }
  if (code >= 300) {
    const err = new Error(code === 401
      ? 'Textmagic refused the username or API key. Check the Script Properties.'
      : String(body.message || ('Textmagic error ' + code)).slice(0, 200));
    err.code = code;
    throw err;
  }
  return body;
}

// "0414 498 026" / "61414498026" / "+61 414…" → "61414498026" (Australian mobiles only), or ''
function recallPhone61_(m) {
  let d = String(m || '').replace(/\D/g, '');
  if (/^04\d{8}$/.test(d)) d = '61' + d.slice(1);
  if (/^4\d{8}$/.test(d)) d = '61' + d;
  return /^614\d{8}$/.test(d) ? d : '';
}
function recallPhone04_(m) { const d = recallPhone61_(m); return d ? '0' + d.slice(2) : ''; }

// The opt-out line is always on the end (Spam Act 2003)
function recallSmsText_(t) {
  let s = String(t || '').replace(/\s+/g, ' ').trim();
  if (!/reply\s+stop/i.test(s)) s += (s ? ' ' : '') + 'Reply STOP to opt out.';
  return s.slice(0, 612);
}

function recallSmsFill_(tpl, c, set) {
  const cat = set.categories.filter(function (x) { return x.key === c.category; })[0];
  const d = c.lastVisit ? flowDays_(c.lastVisit, flowKey_(Date.now())) : null;
  const months = d !== null ? Math.max(1, Math.round(d / 30.4)) : (cat ? cat.months : '');
  const first = String(c.patientName || '').replace(/\([^)]*\)/g, ' ').trim().split(/\s+/)[0] || 'there';
  return String(tpl || '')
    .replace(/\{\s*first name\s*\}/gi, first)
    .replace(/\{\s*treatment\s*\}/gi, (cat && cat.smsName) || 'treatment')
    .replace(/\{\s*months\s*\}/gi, String(months))
    .replace(/\{\s*clinic phone\s*\}/gi, set.sms.phone || '')
    .replace(/\s+/g, ' ').trim();
}

function tmSend_(auth, phone61, text) {
  const payload = { text: text, phones: phone61 };
  if (auth.from) payload.from = auth.from;
  const r = tmFetch_(auth, 'post', '/messages', payload);
  return String(r.id || r.messageId || '');
}

// Why they can't be texted, or ''
function recallTextBlocked_(cfg, pid) {
  const p = pid ? fsGetDoc_(cfg, 'patient_list/' + encodeURIComponent(pid)) : null;
  if (p && p['Marketing OK'] === false) return "They're on the do-not-contact list.";
  const e = p ? mktEmail_(p.Email) : '';
  if (isEmail_(e)) {
    const s = mktSuppressed_(cfg, e);
    if (s && s.reason !== 'bounced') return "They're on the do-not-contact list.";
  }
  return '';
}

// A card that should get an automatic text before it's shared out
function recallWantsText_(c, set, today) {
  return !!(set.sms && set.sms.on) && !c.textAutoAt && !c.assignedToId && c.stage === 'due' && c.status === 'open'
    && String(c.dueDate) <= today && String(c.dueDate) >= flowAddDaysKey_(today, -7) && !!recallPhone61_(c.mobile);
}

function recallTextSafe_(cfg, set, today) {
  try { return recallFlowRun_(cfg, set, today); }
  catch (e) { console.error('Recall texts: ' + (e && e.stack ? e.stack : e)); return 0; }
}

// Newly due patients (last 7 days), 9 am to 6 pm, up to the daily limit
function recallAutoText_(cfg, set, today) {
  if (!set.sms.on) return 0;
  const h = Number(Utilities.formatDate(new Date(), REC_TZ_, 'H'));
  if (h < 9 || h >= 18) return 0;
  const auth = tmAuth_();
  if (!auth) return 0;
  const props = PropertiesService.getScriptProperties();
  const pk = 'RECALL_SMS_' + today;
  let sent = Number(props.getProperty(pk) || 0);
  if (sent >= set.sms.perDay) return 0;
  const cards = fsQuery_(cfg, RECALL_COL_, 'dueDate', 'GREATER_THAN_OR_EQUAL', flowAddDaysKey_(today, -7), 3000)
    .filter(function (c) { return recallWantsText_(c, set, today); })
    .sort(function (a, b) { return String(b.dueDate).localeCompare(String(a.dueDate)); });
  let n = 0;
  for (let i = 0; i < cards.length && sent < set.sms.perDay; i++) {
    const c = cards[i];
    const path = RECALL_COL_ + '/' + c._id;
    const now = new Date().toISOString();
    const log = Array.isArray(c.log) ? c.log : [];
    const note = function (what, text) {
      return log.concat([{ at: now, by: 'Recall', byUid: '', kind: text ? 'text' : 'auto', what: what, note: text || '' }]).slice(-80);
    };
    const blocked = recallTextBlocked_(cfg, c.patientId);
    if (blocked) {
      fsPatch_(cfg, path, { textAutoAt: now, textAuto: 'skipped', updatedAt: now, log: note('No automatic text: on the do-not-contact list') });
      continue;
    }
    const text = recallSmsText_(recallSmsFill_(set.sms.template, c, set));
    try {
      tmSend_(auth, recallPhone61_(c.mobile), text);
    } catch (e) {
      console.warn('Recall text to ' + c._id + ' failed: ' + e);
      if (e && e.code === 401) break;   // wrong key: stop for now
      fsPatch_(cfg, path, { textAutoAt: now, textAuto: 'failed', updatedAt: now,
        log: note('Automatic text not sent: ' + String(e && e.message ? e.message : e).slice(0, 150)) });
      continue;
    }
    sent++;
    n++;
    props.setProperty(pk, String(sent));
    fsPatch_(cfg, path, {
      textAutoAt: now, textAuto: 'sent', lastTextAt: now, lastTextBy: '', lastTextByName: 'Recall',
      texts: Number(c.texts || 0) + 1, textHoldUntil: flowAddDaysKey_(today, set.sms.waitDays), updatedAt: now,
      log: note('Text sent (automatic)', text),
    });
  }
  if (n) console.log('Recall: ' + n + ' automatic text(s) sent.');
  return n;
}

/* ---------- Replies ---------- */

function recallReplyKind_(t) {
  const s = String(t || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(stop|stop all|unsubscribe|opt out|optout|remove me)( |$)/.test(s)) return 'stop';
  if (/^(yes|yep|yeah|yes please|y|ok|okay|sure|please)( |$)/.test(s)) return 'yes';
  return 'other';
}

// The team member with the fewest open calls (for a reply to a card nobody had)
function recallPickPerson_(cfg, set, memo) {
  const today = flowKey_(Date.now());
  if (!memo.team) {
    memo.team = getStaffDocs_()
      .filter(function (s) { return set.team.indexOf(s.id) !== -1 && s.active !== false && (!set.skipLeave || recallAvailable_(s, today)); })
      .map(function (s) {
        return { s: s, open: fsQuery_(cfg, RECALL_COL_, 'assignedToId', 'EQUAL', s.id, 500)
          .filter(function (c) { return c.status === 'open' && c.stage === 'call'; }).length };
      });
  }
  const pick = memo.team.slice().sort(function (a, b) { return a.open - b.open; })[0];
  if (!pick) return null;
  pick.open++;
  return pick.s;
}

// Every 5 minutes. The first run only notes where to start, so old replies aren't loaded.
function recallReplies_(cfg) {
  const auth = tmAuth_();
  if (!auth) return 0;
  const props = PropertiesService.getScriptProperties();
  const last = Number(props.getProperty('TM_LAST_REPLY_ID') || 0);
  const r = tmFetch_(auth, 'get', '/replies?page=1&limit=100&orderBy=id&direction=desc');
  const list = (Array.isArray(r.resources) ? r.resources : []).map(function (x) {
    return { id: Number(x.id) || 0, from: String(x.sender || ''), text: String(x.text || ''), at: String(x.messageTime || '') };
  }).filter(function (x) { return x.id; });
  if (!list.length) return 0;
  const top = Math.max.apply(null, list.map(function (x) { return x.id; }));
  if (!last) { props.setProperty('TM_LAST_REPLY_ID', String(top)); return 0; }
  const fresh = list.filter(function (x) { return x.id > last; }).sort(function (a, b) { return a.id - b.id; });
  if (!fresh.length) return 0;
  const set = recallSettings_(cfg);
  const memo = {};
  fresh.forEach(function (x) {
    try { recallOneReply_(cfg, set, x, memo); }
    catch (e) { console.error('Recall reply ' + x.id + ': ' + (e && e.stack ? e.stack : e)); }
    props.setProperty('TM_LAST_REPLY_ID', String(x.id));
  });
  console.log('Recall: ' + fresh.length + ' text reply(ies).');
  return fresh.length;
}

function recallOneReply_(cfg, set, x, memo) {
  const phone = recallPhone04_(x.from);
  const kind = recallReplyKind_(x.text);
  const now = new Date().toISOString();
  const at = Date.parse(x.at) ? new Date(Date.parse(x.at)).toISOString() : now;
  const text = x.text.slice(0, 1000);
  const cards = phone ? fsQuery_(cfg, RECALL_COL_, 'mobileKey', 'EQUAL', phone, 50) : [];
  const live = cards.filter(function (c) { return c.status !== 'closed'; });
  // The card they were texted about, otherwise their most recently due open card
  const card = live.filter(function (c) { return c.lastTextAt; })
    .sort(function (a, b) { return String(b.lastTextAt).localeCompare(String(a.lastTextAt)); })[0]
    || live.filter(function (c) { return c.status === 'open'; })
      .sort(function (a, b) { return String(b.dueDate).localeCompare(String(a.dueDate)); })[0]
    || live[0] || null;
  const any = card || cards[0] || null;
  // The newest text sent from a patient page to this number. If it's newer than the recall text, the reply is to it.
  const portal = phone ? fsQuery_(cfg, SMS_COL_, 'phone', 'EQUAL', phone, 50)
    .sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); })[0] || null : null;
  const toPortal = !!portal && (!card || !card.lastTextAt || String(portal.at) > String(card.lastTextAt));
  const pid = any ? String(any.patientId || '') : portal ? String(portal.patientId || '') : '';

  commitWrites_(cfg, [updateWrite_(cfg, RECALL_REPLIES_ + '/r_' + x.id, {
    tmId: String(x.id), phone: phone || x.from, text: text, at: at, kind: kind,
    cardId: card && !toPortal ? card._id : '', patientId: pid,
    patientName: any ? String(any.patientName || '') : portal ? String(portal.patientName || '') : '', seenAt: now,
    toPortal: toPortal,
  })]);
  if (toPortal) smsTellSender_(portal, kind, text);

  const what = kind === 'stop' ? 'Replied STOP' : kind === 'yes' ? 'Replied: wants to book' : 'Replied';
  const entry = { at: at, by: 'Patient', byUid: '', kind: 'reply', what: what, note: text };
  const reply = { at: at, text: text.slice(0, 500), kind: kind };

  if (kind === 'stop') {
    if (pid) {
      try {
        mktSetConsent_(cfg, pid, false, { by: 'The patient', source: 'Replied STOP to a text', dnc: true, why: 'Opted out',
          note: 'Replied "' + text.slice(0, 80) + '" to a recall text' });
      } catch (e) { console.warn('STOP not saved to do not contact: ' + e); }
    }
    const writes = live.map(function (c) {
      const p = { reply: reply, replyOpen: false, updatedAt: now, log: (Array.isArray(c.log) ? c.log : []).concat([entry]).slice(-80) };
      if (c.status === 'open') Object.assign(p, { status: 'closed', closeReason: 'Replied STOP', closedAt: now, closedBy: 'Patient', remindOn: '' });
      return patchWrite_(cfg, RECALL_COL_ + '/' + c._id, p);
    });
    if (writes.length) commitWrites_(cfg, writes);
    return;
  }
  if (!card || toPortal) return;   // saved in recall_replies (a reply to a patient-page text shows in their conversation)

  const log = (Array.isArray(card.log) ? card.log : []).concat([entry]);
  const patch = { replyOpen: true, reply: reply, textHoldUntil: '', updatedAt: now };
  if (card.status === 'open' && ['run', 'wait', 'queued'].indexOf(String(card.flowState || '')) !== -1) {
    // In the Recall flow: the flow decides what happens next (a Wait set to "or until they reply" moves on at the next check)
  } else if (card.status === 'open') {
    const active = getStaffDocs_().filter(function (s) { return s.active !== false; });
    const find = function (sid) { return active.filter(function (s) { return s.id === sid; })[0] || null; };
    let to = card.assignedToId ? find(card.assignedToId) : null;
    if (!to) {
      to = (card.lastTextBy && find(card.lastTextBy)) || recallPickPerson_(cfg, set, memo);
      if (to) log.push({ at: now, by: 'Recall', byUid: '', kind: 'auto', what: 'Given to ' + to.name + ' to follow up the reply', note: '' });
    }
    Object.assign(patch, {
      stage: to ? 'call' : 'due', remindOn: '', pauseReason: '',
      assignedToId: to ? to.id : '', assignedToName: to ? String(to.name || '') : '', assignedDay: to ? flowKey_(Date.now()) : '',
    });
  }
  patch.log = log.slice(-80);
  commitWrites_(cfg, [patchWrite_(cfg, RECALL_COL_ + '/' + card._id, patch)]);
}

/* ---------- Recall settings: status and a test text ---------- */

function recallSmsAdmin_(op, body, session) {
  const auth = tmAuth_();
  if (!auth) {
    return { ok: true, ready: false,
      problem: 'Add TextMagic (the API key), TextMagicUser and TextMagicFrom in Apps Script → Project Settings → Script Properties.' };
  }
  if (op === 'smsStatus') {
    try {
      const u = tmFetch_(auth, 'get', '/user');
      return { ok: true, ready: true, user: String(u.username || auth.user), from: auth.from,
        balance: u.balance != null ? Number(u.balance) : null, currency: String((u.currency && u.currency.id) || '') };
    } catch (e) {
      return { ok: true, ready: false, problem: String(e && e.message ? e.message : e) };
    }
  }
  const to = recallPhone61_(body.to);
  if (!to) return { ok: true, problem: 'Type an Australian mobile number, like 0412 345 678.' };
  const cache = CacheService.getScriptCache();
  const rk = 'rc_smstest_' + session.uid;
  const used = Number(cache.get(rk) || 0);
  if (used >= 10) return { ok: true, problem: "You've sent a lot of tests in the last hour. Try again a bit later." };
  try { tmSend_(auth, to, '[Test] ' + recallSmsText_(body.text)); }
  catch (e) { return { ok: true, problem: "The test wasn't sent: " + String(e && e.message ? e.message : e) }; }
  cache.put(rk, String(used + 1), 3600);
  return { ok: true };
}

// ===================== Recall: the flow (Recall settings → Flow) =====================
// recall_settings/flow: { on, trigger: { rules, withinDays, dailyMax }, stop: { rules }, steps, style }.
// Runs every hour inside recallRun_, before cards are shared out. A card's place in the flow is kept on the card:
//   flowState: queued (starts when there's room today) · run (sending, or waiting for 9 am) · wait · team · cycle · skip · done
//   flowNext (the next card's id), flowDueAt, flowReply, flowTeam, flowCycle, flowStartedAt
// Booked, came in or STOP: the card leaves "open", so the flow stops. Staff picking up a card take it over.

const RECALL_FLOW_DOC_ = RECALL_SET_ + '/flow';
const RECALL_FLOW_LIVE_ = ['run', 'wait', 'team', 'cycle', 'queued'];

// The "This recall" rules (flow-rules.js → group "This recall")
Object.assign(FLOW_FIELD_TYPE_, {
  'rc.category': 'names', 'rc.service': 'text', 'rc.staff': 'text', 'rc.months': 'number', 'rc.overdue': 'number',
  'rc.due_between': 'range', 'rc.cycle': 'number', 'rc.tries': 'number', 'rc.texts': 'number', 'rc.emails': 'number',
  'rc.last_out': 'choice', 'rc.replied': 'bool', 'rc.replied_yes': 'bool', 'rc.reply_text': 'text',
  'rc.assigned': 'bool', 'rc.assigned_to': 'text', 'rc.other_due': 'bool',
});
Object.keys(FLOW_FIELD_TYPE_).forEach(function (k) {
  if (k.indexOf('rc.') === 0) FLOW_RULE_COST_[k] = k === 'rc.other_due' ? 2 : 0;
});

function recallFact_(cfg, key, run, ctx) {
  const c = run.rc || {};
  const today = flowKey_(Date.now());
  const since = String(c.flowStartedAt || '');
  const rep = c.reply && c.reply.kind !== 'stop' && String(c.reply.at || '') >= since ? c.reply : null;
  switch (key) {
    case 'rc.category': return [String(c.category || '')];
    case 'rc.service': return Array.isArray(c.lastServices) ? c.lastServices : [];
    case 'rc.staff': return String(c.lastStaff || '');
    case 'rc.months': { const d = c.lastVisit ? flowDays_(c.lastVisit, today) : null; return d === null ? null : Math.round(d / 30.4); }
    case 'rc.overdue': return c.dueDate ? flowDays_(c.dueDate, today) : null;
    case 'rc.cycle': return Number(c.flowCycle || 1);
    case 'rc.tries': return Number(c.attempts || 0);
    case 'rc.texts': return Number(c.texts || 0);
    case 'rc.emails': return Number(c.emails || 0);
    case 'rc.last_out': return String(c.lastOutcome || 'none');
    case 'rc.replied': return !!rep;
    case 'rc.replied_yes': return !!(rep && rep.kind === 'yes');
    case 'rc.reply_text': return rep ? String(rep.text || '') : '';
    case 'rc.assigned': return !!c.assignedToId;
    case 'rc.assigned_to': return String(c.assignedToName || '');
    case 'rc.other_due':
      return !!c.patientId && fsQuery_(cfg, RECALL_COL_, 'patientId', 'EQUAL', c.patientId, 50)
        .some(function (x) { return x._id !== c._id && x.status === 'open'; });
  }
  return null;
}

// "Treatment category is one of …" and "Due date between …"
function recallRuleOk_(cfg, r, run, ctx) {
  if (r.field === 'rc.due_between') {
    const from = String(r.from || ''), to = String(r.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return false;
    const d = String((run.rc || {}).dueDate || '');
    const has = !!d && d >= from && d <= to;
    return r.op === 'no' ? !has : has;
  }
  const wanted = (Array.isArray(r.value) ? r.value : []).map(flowNorm_).filter(Boolean);
  if (!wanted.length) return false;
  const v = flowFact_(cfg, r.field, run, ctx);
  const has = (Array.isArray(v) ? v : [v]).some(function (x) { return wanted.indexOf(flowNorm_(x)) !== -1; });
  return r.op === 'none' ? !has : has;
}

// The blanks in recall texts and emails. {Treatment} names everything they're due for; {Main treatment} just this card's.
function recallFlowVals_(c, set) {
  const nameOf = function (key) {
    const x = set.categories.filter(function (k) { return k.key === key; })[0];
    return (x && x.smsName) || 'treatment';
  };
  const keys = [c.category].concat(Array.isArray(c.alsoDue) ? c.alsoDue : [])
    .filter(function (k, i, a) { return k && a.indexOf(k) === i; });
  const names = keys.map(nameOf).filter(function (n, i, a) { return a.indexOf(n) === i; });
  const all = names.length <= 1 ? (names[0] || 'treatment') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  const cat = set.categories.filter(function (x) { return x.key === c.category; })[0];
  const d = c.lastVisit ? flowDays_(c.lastVisit, flowKey_(Date.now())) : null;
  const name = String(c.patientName || '');
  return {
    'first name': name.replace(/\([^)]*\)/g, ' ').trim().split(/\s+/)[0] || 'there',
    'full name': name || 'there',
    'treatment': all,
    'main treatment': names[0] || 'treatment',
    'months': String(d !== null ? Math.max(1, Math.round(d / 30.4)) : (cat ? cat.months : '')),
    'due date': recLongDate_(c.dueDate) || '',
    'last visit': recLongDate_(c.lastVisit) || '',
    'last seen with': String(c.lastStaff || '') || 'our team',
    'clinic phone': set.sms.phone || '',
  };
}

// One text or email card. test: { email, mobile, steps } sends to the person testing instead.
function recallFlowSend_(cfg, set, s, c, test) {
  const k = s.cfg || {};
  const vals = recallFlowVals_(c, set);
  const what = s.type === 'text' ? 'Text' : 'Email';
  if (!test) {
    const b = recallTextBlocked_(cfg, c.patientId);
    if (b) return { sent: false, what: what + ' skipped: on the do-not-contact list' };
  }
  if (s.type === 'text') {
    const auth = tmAuth_();
    if (!auth) return { sent: false, what: "Text skipped: Textmagic isn't set up" };
    const to = recallPhone61_(test ? test.mobile : c.mobile);
    if (!to) return { sent: false, what: test ? 'Text skipped: no test mobile was given' : 'Text skipped: no mobile number' };
    const text = recallSmsText_(flowFill_(k.message, vals, false));
    try { tmSend_(auth, to, (test ? '[Test] ' : '') + text); }
    catch (e) { return { sent: false, what: 'Text not sent: ' + String(e && e.message ? e.message : e).slice(0, 150) }; }
    return { sent: true, what: 'Text sent' + (test ? ' to ' + test.mobile : ''), text: text };
  }
  const to = test ? test.email : mktEmail_(c.email);
  if (!isEmail_(to)) return { sent: false, what: 'Email skipped: no email address' };
  if (!test) {
    const sup = mktSuppressed_(cfg, to);
    if (sup && sup.reason === 'bounced') return { sent: false, what: 'Email skipped: emails to this address bounce' };
  }
  if (MailApp.getRemainingDailyQuota() < MKT_RESERVE_ / 3) return { sent: false, what: "Email not sent: the clinic's daily email limit is nearly used" };
  const subject = flowFill_(k.subject, vals, false).replace(/\s+/g, ' ').trim().slice(0, 200) || 'A message from Dermedica';
  let html = sanitizeEmailHtml_(flowFillHtml_(String(k.html || k.body || ''), vals)) + mktFooterHtml_(test ? '' : c.patientId, to, 'recall');
  if (test) html = flowTestBanner_('Recall', 'This would have gone to ' + (c.patientName || 'the patient') + '.') + html;
  const inl = inlineTaskImages_(cfg, html);
  const mail = { to: to, subject: (test ? '[Test] ' : '') + subject, htmlBody: inl.html, body: emailHtmlToText_(inl.html), name: 'Dermedica Clinic' };
  if (Object.keys(inl.images).length) mail.inlineImages = inl.images;
  MailApp.sendEmail(mail);
  if (!test) recallLogEmail_(cfg, c, to, subject, 'Recall flow', '', true);
  return { sent: true, what: 'Email sent: ' + subject };
}

// Who a "Give to the recall team" card goes to
function recallFlowPerson_(cfg, set, k, c, memo) {
  const active = getStaffDocs_().filter(function (s) { return s.active !== false; });
  if (k.who === 'person') return active.filter(function (s) { return s.id === String(k.personId || ''); })[0] || null;
  if (k.who === 'last') {
    const n = flowNorm_(c.lastStaff);
    const hit = n && active.filter(function (s) {
      const sn = flowNorm_(s.name);
      return sn === n || sn.split(' ')[0] === n || sn.indexOf(n) !== -1;
    })[0];
    if (hit) return hit;
  }
  return recallPickPerson_(cfg, set, memo);
}

// Moves one card along from c.flowNext until it has to wait. base: changes saved with it.
function recallFlowAdvance_(cfg, flow, set, c, memo, test, base) {
  const now = new Date().toISOString();
  const today = flowKey_(Date.now());
  const log = (Array.isArray(c.log) ? c.log : []).slice(-70);
  const note = function (what, text) {
    if (test) test.steps.push(what + (text ? ': "' + text + '"' : ''));
    else log.push({ at: now, by: 'Recall flow', byUid: '', kind: 'flow', what: what, note: text || '' });
  };
  const patch = Object.assign({}, base || {});
  const run = { _id: c._id || 'test', patientId: c.patientId, kind: 'recall', product: '', purchaseDate: today,
    sourceKey: docId_(c.pttId || c.patientId), rc: c, apptKeys: [] };
  let ctx = null;
  try { ctx = c.patientId ? flowCtx_(cfg, run, memo) : null; } catch (e) { console.warn('Recall flow: patient not read: ' + e); }
  const done = function (extra) { Object.assign(patch, { flowState: 'done', flowNext: '' }, extra || {}); };
  let next = String(c.flowNext || '');
  let sent = 0;
  let halted = false;

  for (let n = 0; n < 15 && !halted; n++) {
    if (!next) { note('The flow has finished. The card goes to the recall team as usual'); done(); halted = true; break; }
    const loc = flowFind_(flow.steps, next);
    if (!loc) { note('The flow stopped: it was changed and its next card was removed'); done(); halted = true; break; }
    const s = loc.list[loc.i];
    const k = s.cfg || {};
    const after = flowAfter_(loc);
    const afterId = after ? String(after.id || '') : '';

    if (s.type === 'text' || s.type === 'email') {
      if (!test && ctx && flowHasRules_((flow.stop || {}).rules) && flowGroupOk_(cfg, flow.stop.rules, run, ctx)) {
        note('The flow stopped: one of its stop rules matched'); done(); halted = true; break;
      }
      const win = flowSendWindow_(Date.now());
      if (!test && win > Date.now()) { Object.assign(patch, { flowState: 'run', flowNext: next, flowDueAt: win }); halted = true; break; }
      const r = recallFlowSend_(cfg, set, s, c, test);
      note(r.what, r.text);
      if (r.sent) {
        sent++;
        if (s.type === 'text') {
          c.texts = Number(c.texts || 0) + 1;
          Object.assign(patch, { texts: c.texts, lastTextAt: now, lastTextBy: '', lastTextByName: 'Recall flow' });
        } else {
          c.emails = Number(c.emails || 0) + 1;
          patch.emails = c.emails;
          patch.lastEmailAt = now;
        }
      }
      next = afterId;
      continue;
    }
    if (s.type === 'wait') {
      note('Waiting ' + flowWaitText_(k) + (k.reply !== false ? ', or until they reply' : '') + (test ? ' (skipped in a test)' : ''));
      if (test) { next = afterId; continue; }
      Object.assign(patch, { flowState: 'wait', flowNext: afterId, flowDueAt: flowAddWait_(Date.now(), k), flowReply: k.reply !== false });
      halted = true;
      break;
    }
    if (s.type === 'branch') {
      const yes = ctx ? flowGroupOk_(cfg, k.rules, run, ctx) : false;
      note('If / else: ' + (yes ? 'Yes' : 'No'));
      const path = (yes ? k.yes : k.no) || [];
      next = path.length ? String(path[0].id || '') : afterId;
      continue;
    }
    if (s.type === 'team') {
      const to = recallFlowPerson_(cfg, set, k, c, memo);
      note(to ? 'Given to ' + to.name + ' to call' : 'Waiting for the recall team');
      if (test) { next = afterId; continue; }
      Object.assign(patch, {
        flowState: 'team', flowNext: afterId,
        flowTeam: { tries0: Number(c.attempts || 0), tries: Number(k.tries) || 0,
          until: Number(k.days) > 0 ? flowAddDaysKey_(today, Number(k.days)) : '' },
        stage: to ? 'call' : 'due', assignedToId: to ? to.id : '', assignedToName: to ? String(to.name || '') : '',
        assignedDay: to ? today : '',
      });
      halted = true;
      break;
    }
    if (s.type === 'cycle') {
      const max = Math.max(1, Number(k.max) || 1);
      const round = Number(c.flowCycle || 1);
      const reason = String(k.reason || 'No response').slice(0, 60);
      if (round > max) {
        note('Recall closed after ' + round + ' rounds: ' + reason);
        if (!test) done({ status: 'closed', closeReason: reason, closedAt: now, closedBy: 'Recall flow', remindOn: '' });
        halted = true;
        break;
      }
      const num = Math.max(1, Math.floor(Number(k.num) || 1));
      const back = k.unit === 'weeks' ? flowAddDaysKey_(today, 7 * num) : flowAddMonthsKey_(today, num);
      note('Trying again on ' + recLongDate_(back));
      if (!test) {
        Object.assign(patch, { flowState: 'cycle', flowNext: '', stage: 'later', remindOn: back, pauseReason: 'Recall flow',
          assignedToId: '', assignedToName: '', assignedDay: '' });
      }
      halted = true;
      break;
    }
    if (s.type === 'end') {
      const reason = String(k.reason || 'No response').slice(0, 60);
      note('Recall closed: ' + reason);
      if (!test) done({ status: 'closed', closeReason: reason, closedAt: now, closedBy: 'Recall flow', remindOn: '' });
      halted = true;
      break;
    }
    next = afterId;   // a card type this version doesn't know
  }
  if (!halted) Object.assign(patch, { flowState: 'run', flowNext: next, flowDueAt: Date.now() });   // carries on next hour
  if (test) return { sent: sent };
  patch.log = log.slice(-80);
  patch.updatedAt = now;
  fsPatch_(cfg, RECALL_COL_ + '/' + c._id, patch);
  return { sent: sent };
}

// A card already in the flow: is it time for the next step?
function recallFlowTick_(cfg, flow, set, c, memo, today, nowMs) {
  const st = String(c.flowState || '');
  const now = new Date().toISOString();
  const add = function (what) {
    return (Array.isArray(c.log) ? c.log : []).concat([{ at: now, by: 'Recall flow', byUid: '', kind: 'flow', what: what, note: '' }]).slice(-80);
  };
  if ((st === 'run' || st === 'wait') && c.assignedToId) {   // someone picked it up: they take over
    fsPatch_(cfg, RECALL_COL_ + '/' + c._id, { flowState: 'done', flowNext: '', updatedAt: now,
      log: add('The flow stopped: ' + (c.assignedToName || 'someone') + ' has it now') });
    return 0;
  }
  if (st === 'run' || st === 'wait') {
    const replied = c.flowReply === true && c.replyOpen === true;
    if (Number(c.flowDueAt || 0) > nowMs && !replied) return 0;
    return recallFlowAdvance_(cfg, flow, set, c, memo, null).sent;
  }
  if (st === 'team') {
    if (c.stage === 'later') return 0;   // a staff call-back: their decision
    const tm = c.flowTeam || {};
    const tries = Number(tm.tries || 0) > 0 && Number(c.attempts || 0) - Number(tm.tries0 || 0) >= Number(tm.tries);
    const late = !!tm.until && String(tm.until) <= today;
    if (!tries && !late) return 0;
    c.log = add(tries ? 'Moved on after ' + tm.tries + ' call' + (Number(tm.tries) === 1 ? '' : 's') + ' without a booking'
      : 'Moved on: the recall team had it for long enough');
    Object.assign(c, { stage: 'due', assignedToId: '', assignedToName: '', assignedDay: '' });
    return recallFlowAdvance_(cfg, flow, set, c, memo, null, { stage: 'due', assignedToId: '', assignedToName: '', assignedDay: '' }).sent;
  }
  if (st === 'cycle') {
    if (c.stage === 'later' && c.remindOn && String(c.remindOn) > today) return 0;
    c.flowCycle = Number(c.flowCycle || 1) + 1;
    c.log = add('Starting the flow again (round ' + c.flowCycle + ')');
    c.flowNext = String((flow.steps[0] || {}).id || '');
    c.flowStartedAt = now;
    return recallFlowAdvance_(cfg, flow, set, c, memo, null,
      { flowCycle: c.flowCycle, flowStartedAt: now, stage: 'due', remindOn: '', pauseReason: '', replyOpen: false }).sent;
  }
  return 0;
}

// Every hour (recallRun_ → recallTextSafe_). Returns how many texts and emails went.
function recallFlowRun_(cfg, set, today) {
  let flow = null;
  try { flow = fsGetDoc_(cfg, RECALL_FLOW_DOC_); } catch (e) { console.warn('Recall flow not read: ' + e); return 0; }
  const nowIso = new Date().toISOString();
  if (!flow || flow.on !== true || !Array.isArray(flow.steps) || !flow.steps.length) {
    // Turned off: cards still in it go back to the recall team as usual
    const writes = fsQuery_(cfg, RECALL_COL_, 'flowState', 'IN', ['run', 'wait', 'queued', 'joined', 'released'], 3000).map(function (c) {
      return patchWrite_(cfg, RECALL_COL_ + '/' + c._id, { flowState: 'done', flowNext: '', joinedTo: '', updatedAt: nowIso,
        log: (Array.isArray(c.log) ? c.log : []).concat([{ at: nowIso, by: 'Recall flow', byUid: '', kind: 'flow',
          what: 'The flow was turned off. The card goes to the recall team as usual', note: '' }]).slice(-80) });
    });
    if (writes.length) commitWrites_(cfg, writes, 100);
    return 0;
  }
  const t = flow.trigger || {};
  const memo = { pts: {}, pc: {} };
  const deadline = Date.now() + 3.5 * 60000;
  const nowMs = Date.now();
  let sent = 0;

  // 0. Treatments riding along with another one: let go (or close) when that one has finished
  try { recallFlowRelease_(cfg, nowIso); } catch (e) { console.error('Recall flow release: ' + (e && e.stack ? e.stack : e)); }

  // 1. Cards already in the flow
  fsQuery_(cfg, RECALL_COL_, 'flowState', 'IN', ['run', 'wait', 'team', 'cycle'], 3000).forEach(function (c) {
    if (Date.now() > deadline || c.status !== 'open') return;   // booked or closed: the flow has stopped for it
    try { sent += recallFlowTick_(cfg, flow, set, c, memo, today, nowMs); }
    catch (e) { console.error('Recall flow ' + c._id + ': ' + (e && e.stack ? e.stack : e)); }
  });

  // 2. Newly due cards (and ones let go in step 0) start it: one flow per patient, most important treatment leads
  const win = Number(t.withinDays);
  const from = win > 0 ? flowAddDaysKey_(today, -win) : '';
  const pool = (from ? fsQuery_(cfg, RECALL_COL_, 'dueDate', 'GREATER_THAN_OR_EQUAL', from, 3000)
    : fsQuery_(cfg, RECALL_COL_, 'status', 'EQUAL', 'open', 10000))
    .concat(fsQuery_(cfg, RECALL_COL_, 'flowState', 'EQUAL', 'released', 1000));
  const seen = {};

  // Everyone's other treatments in one read, instead of one lookup per patient
  try {
    fsQuery_(cfg, RECALL_COL_, 'status', 'EQUAL', 'open', 10000).forEach(function (c) {
      if (c.patientId) (memo.pc[c.patientId] = memo.pc[c.patientId] || []).push(c);
    });
    memo.pcAll = true;
  } catch (e) { console.warn('Recall flow: open cards not read in one go: ' + e); memo.pc = {}; }
  const cands = pool.filter(function (c) {
    if (seen[c._id]) return false;
    seen[c._id] = true;
    return c.status === 'open' && c.stage === 'due' && !c.assignedToId && c.dnc !== true && String(c.dueDate) <= today
      && (!c.flowState || c.flowState === 'queued' || c.flowState === 'released');
  });
  const byPt = {};
  cands.forEach(function (c) { const k = c.patientId || c._id; (byPt[k] = byPt[k] || []).push(c); });
  const waitedFirst = function (g) { return g.some(function (c) { return c.flowState === 'queued' || c.flowState === 'released'; }) ? 0 : 1; };
  const newest = function (g) { return g.reduce(function (m, c) { return String(c.dueDate) > m ? String(c.dueDate) : m; }, ''); };
  const groups = Object.keys(byPt).map(function (k) {
    return byPt[k].sort(function (a, b) {
      return recallPri_(flow, set, a.category) - recallPri_(flow, set, b.category) || String(b.dueDate).localeCompare(String(a.dueDate));
    });
  }).sort(function (a, b) { return waitedFirst(a) - waitedFirst(b) || newest(b).localeCompare(newest(a)); });

  const props = PropertiesService.getScriptProperties();
  const pk = 'RECALL_FLOW_' + today;
  let started = Number(props.getProperty(pk) || 0);
  const cap = Math.max(1, Math.min(500, Number(t.dailyMax) || 25));
  const quiet = Math.max(0, Number(t.quietDays) || 0);
  const first = String((flow.steps[0] || {}).id || '');
  const queue = [];
  const queueAll = function (g) {
    g.forEach(function (c) { if (c.flowState !== 'queued') queue.push(patchWrite_(cfg, RECALL_COL_ + '/' + c._id, { flowState: 'queued' })); });
  };

  for (let gi = 0; gi < groups.length; gi++) {
    if (Date.now() > deadline) break;
    const g = groups[gi];
    try {
      const ids = g.map(function (c) { return c._id; });
      const others = g[0].patientId ? recallPatientCards_(cfg, g[0].patientId, memo)
        .filter(function (x) { return x.status === 'open' && ids.indexOf(x._id) === -1; }) : [];

      // Already hearing from us about another treatment (in the flow, or someone on the team has it): join that one
      const running = others.filter(function (x) {
        return ['run', 'wait', 'team', 'cycle'].indexOf(String(x.flowState || '')) !== -1 || !!x.assignedToId;
      }).sort(function (a, b) { return recallPri_(flow, set, a.category) - recallPri_(flow, set, b.category); })[0];
      if (running) { recallFlowJoin_(cfg, running, g, nowIso, false); continue; }

      // Quiet time: nothing new if they had a recall text or email recently
      const last = others.concat(g).reduce(function (m, x) {
        [x.lastTextAt, x.lastEmailAt].forEach(function (v) { if (v && String(v) > m) m = String(v); });
        return m;
      }, '');
      if (quiet && last && nowMs - Date.parse(last) < quiet * 86400000) { queueAll(g); continue; }
      if (started >= cap) { queueAll(g); continue; }

      // The most important treatment that matches the start rules leads
      let lead = null;
      for (let i = 0; i < g.length && !lead; i++) {
        if (!flowHasRules_(t.rules) || recallFlowMatches_(cfg, t.rules, g[i], memo, today)) lead = g[i];
      }
      if (!lead) {
        g.forEach(function (c) {
          fsPatch_(cfg, RECALL_COL_ + '/' + c._id, { flowState: 'skip', updatedAt: nowIso,
            log: (Array.isArray(c.log) ? c.log : []).concat([{ at: nowIso, by: 'Recall flow', byUid: '', kind: 'flow',
              what: "Not started in the flow: they don't match its start rules", note: '' }]).slice(-80) });
        });
        continue;
      }
      // Everything else they're due for joins it (their other unclaimed cards too, so nobody calls about them separately)
      const rest = g.filter(function (c) { return c !== lead; })
        .concat(others.filter(function (x) { return x.stage === 'due' && !x.assignedToId && x.flowState !== 'joined'; }));
      started++;
      props.setProperty(pk, String(started));
      lead.alsoDue = rest.map(function (c) { return c.category; })
        .filter(function (k, i, a) { return k && k !== lead.category && a.indexOf(k) === i; });
      lead.flowNext = first;
      lead.flowCycle = 1;
      lead.flowStartedAt = nowIso;
      lead.log = (Array.isArray(lead.log) ? lead.log : []).concat([{ at: nowIso, by: 'Recall flow', byUid: '', kind: 'flow',
        what: 'Started the recall flow' + (lead.alsoDue.length ? ' (also due: ' + lead.alsoDue.join(', ') + ')' : ''), note: '' }]);
      sent += recallFlowAdvance_(cfg, flow, set, lead, memo, null,
        { flowState: 'run', flowCycle: 1, flowStartedAt: nowIso, alsoDue: lead.alsoDue, joinedTo: '', joinedCat: '' }).sent;
      if (rest.length) recallFlowJoin_(cfg, lead, rest, nowIso, true);
    } catch (e) { console.error('Recall flow start ' + ids_(g) + ': ' + (e && e.stack ? e.stack : e)); }
  }
  if (queue.length) commitWrites_(cfg, queue, 100);
  if (sent) console.log('Recall flow: ' + sent + ' text(s) and email(s) sent.');
  return sent;
}

function ids_(g) { return (g || []).map(function (c) { return c._id; }).join(', '); }

// Where a treatment sits in Flow settings → "Due for more than one treatment" (lower = more important)
function recallPri_(flow, set, key) {
  const p = flow && flow.trigger && Array.isArray(flow.trigger.priority) ? flow.trigger.priority : [];
  const i = p.indexOf(key);
  if (i !== -1) return i;
  const j = set.categories.map(function (c) { return c.key; }).indexOf(key);
  return 100 + (j === -1 ? 99 : j);
}

// A patient's recall cards (once per run)
function recallPatientCards_(cfg, pid, memo) {
  memo.pc = memo.pc || {};
  if (!memo.pc[pid]) memo.pc[pid] = memo.pcAll ? [] : fsQuery_(cfg, RECALL_COL_, 'patientId', 'EQUAL', pid, 50);
  return memo.pc[pid];
}

function recallFlowMatches_(cfg, rules, c, memo, today) {
  const run = { _id: c._id, patientId: c.patientId, kind: 'recall', product: '', purchaseDate: today,
    sourceKey: docId_(c.pttId || c.patientId), rc: c, apptKeys: [] };
  const ctx = flowCtx_(cfg, run, memo);
  return !!ctx && flowGroupOk_(cfg, rules, run, ctx);
}

// cards ride along with lead: no texts, emails or calls of their own. leadSaved: lead.alsoDue is already written.
function recallFlowJoin_(cfg, lead, cards, nowIso, leadSaved) {
  const keys = (Array.isArray(lead.alsoDue) ? lead.alsoDue : []).slice();
  const writes = cards.map(function (c) {
    if (c.category && c.category !== lead.category && keys.indexOf(c.category) === -1) keys.push(c.category);
    return patchWrite_(cfg, RECALL_COL_ + '/' + c._id, {
      flowState: 'joined', joinedTo: lead._id, joinedCat: String(lead.category || ''), updatedAt: nowIso,
      log: (Array.isArray(c.log) ? c.log : []).concat([{ at: nowIso, by: 'Recall flow', byUid: '', kind: 'flow',
        what: 'Joined their ' + lead.category + ' recall, so they only hear from us once', note: '' }]).slice(-80),
    });
  });
  if (!leadSaved) {
    lead.alsoDue = keys;
    writes.push(patchWrite_(cfg, RECALL_COL_ + '/' + lead._id, { alsoDue: keys }));
  }
  if (writes.length) commitWrites_(cfg, writes, 100);
}

// Joined cards whose main recall has finished: booked → keep waiting; closed by the flow or STOP → close too;
// came in, or closed by staff → start their own flow (after the quiet time)
function recallFlowRelease_(cfg, nowIso) {
  const writes = [];
  const leads = {};
  fsQuery_(cfg, RECALL_COL_, 'flowState', 'EQUAL', 'joined', 2000).forEach(function (c) {
    if (c.status !== 'open') return;
    const id = String(c.joinedTo || '');
    if (id && !(id in leads)) {
      try { leads[id] = fsGetDoc_(cfg, RECALL_COL_ + '/' + id); } catch (e) { leads[id] = null; }
    }
    const lead = id ? leads[id] : null;
    if (lead && (lead.status === 'open' || lead.status === 'booked')) return;
    const reason = String((lead && lead.closeReason) || '');
    const closeToo = !!lead && (lead.closedBy === 'Recall flow' || /stop|do.?not.?contact/i.test(reason));
    const what = closeToo ? 'Closed with their ' + lead.category + ' recall: ' + (reason || 'No response')
      : 'Their ' + ((lead && lead.category) || 'other') + ' recall has finished, so this one starts the flow after the quiet time';
    const patch = closeToo
      ? { status: 'closed', closeReason: reason || 'No response', closedAt: nowIso, closedBy: 'Recall flow', flowState: 'done', joinedTo: '' }
      : { flowState: 'released', joinedTo: '', joinedCat: '' };
    patch.updatedAt = nowIso;
    patch.log = (Array.isArray(c.log) ? c.log : []).concat([{ at: nowIso, by: 'Recall flow', byUid: '', kind: 'flow', what: what, note: '' }]).slice(-80);
    writes.push(patchWrite_(cfg, RECALL_COL_ + '/' + c._id, patch));
  });
  if (writes.length) commitWrites_(cfg, writes, 100);
}

// Recall settings → Flow → Test with a patient: the whole flow now, waits skipped, everything to the person testing
function recallFlowTest_(body, session) {
  const cfg = getConfig_();
  const flow = fsGetDoc_(cfg, RECALL_FLOW_DOC_);
  if (!flow || !Array.isArray(flow.steps) || !flow.steps.length) return { ok: true, problem: 'Add some cards to the flow first.' };
  const me = getStaffDocs_().filter(function (s) { return s.id === session.uid; })[0];
  if (!me || !isEmail_(me.email)) return { ok: true, problem: 'Add your email address in Staff first, so the test emails reach you.' };
  const doc = flowPatient_(cfg, String(body.patientId || ''));
  if (!doc) return { ok: true, problem: "That patient couldn't be found." };
  const cache = CacheService.getScriptCache();
  const rk = 'rc_flowtest_' + session.uid;
  const used = Number(cache.get(rk) || 0);
  if (used >= 15) return { ok: true, problem: "You've run a lot of tests in the last hour. Try again a bit later." };
  cache.put(rk, String(used + 1), 3600);

  const set = recallSettings_(cfg);
  const cat = String(body.category || '');
  let c = fsQuery_(cfg, RECALL_COL_, 'patientId', 'EQUAL', doc._id, 50)
    .filter(function (x) { return !cat || x.category === cat; })
    .sort(function (a, b) {
      return (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(b.dueDate).localeCompare(String(a.dueDate));
    })[0];
  const steps = [];
  if (!c) {
    const w = flowWho_(doc);
    const def = set.categories.filter(function (x) { return x.key === cat; })[0] || set.categories.filter(function (x) { return x.on; })[0] || set.categories[0];
    c = { _id: 'test', patientId: doc._id, pttId: String(doc.PttID || doc._id), patientName: w.name, mobile: String(doc.Mobile || ''),
      email: String(doc.Email || ''), category: def ? def.key : '', months: def ? def.months : 6, lastVisit: '', lastServices: [],
      lastStaff: '', dueDate: flowKey_(Date.now()), attempts: 0, texts: 0, emails: 0 };
    steps.push("They have no recall card" + (cat ? ' for ' + cat : '') + ', so an example one was used (' + c.category + ').');
  } else {
    c = JSON.parse(JSON.stringify(c));
    steps.push('Using their ' + c.category + ' recall card (due ' + recLongDate_(c.dueDate) + ').');
  }
  c.alsoDue = fsQuery_(cfg, RECALL_COL_, 'patientId', 'EQUAL', doc._id, 50)
    .filter(function (x) { return x.status === 'open' && x._id !== c._id && x.category !== c.category; })
    .map(function (x) { return x.category; });
  if (c.alsoDue.length) steps.push('Also due: ' + c.alsoDue.join(', ') + '. They join this recall, so they hear from us once.');
  c.flowNext = String(flow.steps[0].id || '');
  c.flowCycle = 1;
  c.flowStartedAt = new Date().toISOString();
  const memo = { pts: {} };
  memo.pts[doc._id] = doc;
  const t = flow.trigger || {};
  if (flowHasRules_(t.rules)) {
    const run = { _id: c._id, patientId: doc._id, kind: 'recall', product: '', purchaseDate: flowKey_(Date.now()),
      sourceKey: docId_(c.pttId || doc._id), rc: c, apptKeys: [] };
    const ctx = flowCtx_(cfg, run, memo);
    steps.push(ctx && flowGroupOk_(cfg, t.rules, run, ctx) ? 'They match the start rules.'
      : "Heads up: they don't match the start rules, so the real flow wouldn't start for them. The test carries on anyway.");
  }
  const test = { email: me.email, mobile: String(body.mobile || ''), steps: steps };
  const r = recallFlowAdvance_(cfg, flow, set, c, memo, test);
  return { ok: true, steps: test.steps, sent: r.sent, to: me.email };
}

// ===================== Recall: emailing a patient from a card (the compose window) =====================
// ===================== Recall: emailing a patient from a card (the compose window) =====================
// Problems come back as { ok: true, problem } so callApi passes the message through to the window.
function recallSendEmail_(body, session) {
  const cfg = getConfig_();
  const id = String(body.id || '');
  const card = id ? fsGetDoc_(cfg, RECALL_COL_ + '/' + id) : null;
  if (!card) return { ok: true, problem: "That recall card couldn't be found. Refresh and try again." };
  const to = String(body.to || '').trim();
  if (!isEmail_(to)) return { ok: true, problem: 'Check the email address.' };
  if (recallTextBlocked_(cfg, card.patientId)) {
    return { ok: true, problem: "They're on the do-not-contact list, so recall emails can't be sent." };
  }
  const sup = mktSuppressed_(cfg, to);
  if (sup && sup.reason === 'bounced') return { ok: true, problem: 'Emails to this address bounce. Check it with the patient.' };
  const subject = String(body.subject || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!subject) return { ok: true, problem: 'Add a subject.' };
  const raw = String(body.html || '');
  if (raw.length > 400000) return { ok: true, problem: 'The email is too big. Use fewer or smaller pictures.' };
  if (!emailHtmlToText_(raw).replace(/\s+/g, '')) return { ok: true, problem: 'Write a message first.' };
  if (MailApp.getRemainingDailyQuota() < 5) return { ok: true, problem: "The clinic's daily email limit is used up. Try again tomorrow." };

  const cache = CacheService.getScriptCache();
  const rk = 'rc_mail_' + session.uid;
  const used = Number(cache.get(rk) || 0);
  if (used >= 60) return { ok: true, problem: "You've sent a lot of emails in the last hour. Try again a bit later." };

  const html = sanitizeEmailHtml_(raw) + mktFooterHtml_(card.patientId, to, 'recall');
  const inl = inlineTaskImages_(cfg, html);
  const mail = { to: to, subject: subject, htmlBody: inl.html, body: emailHtmlToText_(inl.html), name: 'Dermedica Clinic' };
  if (Object.keys(inl.images).length) mail.inlineImages = inl.images;
  MailApp.sendEmail(mail);
  cache.put(rk, String(used + 1), 3600);   // counted only once it's actually sent

  const me = getStaffDocs_().filter(function (s) { return s.id === session.uid; })[0];
  const now = new Date().toISOString();
  fsPatch_(cfg, RECALL_COL_ + '/' + id, {
    emails: Number(card.emails || 0) + 1, lastEmailAt: now, lastEmailBy: session.uid, updatedAt: now,
    log: (Array.isArray(card.log) ? card.log : []).concat([{ at: now, by: String((me && me.name) || 'Staff'), byUid: session.uid,
      kind: 'email', what: 'Email sent: ' + subject, note: 'To ' + to }]).slice(-80),
  });
  recallLogEmail_(cfg, Object.assign({}, card, { _id: id }), to, subject, String((me && me.name) || 'Staff'), session.uid, false);
  return { ok: true };
}

// ===================== Recall flow: who's in it, and who's next (Flow tab → Who's in the flow) =====================
const RECALL_STEP_NAMES_ = { text: 'Text', email: 'Email', wait: 'Wait', branch: 'If / else', team: 'Recall team', cycle: 'Try again', end: 'End' };

// A dry run of recallFlowRun_ step 2 (keep the two in step): nothing is sent or saved
// A dry run of recallFlowRun_ step 2 (keep the two in step): nothing is sent or saved.
// One read of every open card; start rules are only checked for roughly the next three days.
function recallFlowPreview_(body, session) {
  const cfg = getConfig_();
  const flow = fsGetDoc_(cfg, RECALL_FLOW_DOC_);
  if (!flow || !Array.isArray(flow.steps) || !flow.steps.length) return { ok: true, problem: 'Add some cards to the flow first.' };
  const set = recallSettings_(cfg);
  const t = flow.trigger || {};
  const today = flowKey_(Date.now());
  const nowMs = Date.now();
  const deadline = Date.now() + 90000;
  const MAXL = 300;
  const row = function (c, extra) {
    return Object.assign({ id: c._id, name: String(c.patientName || ''), patientId: String(c.patientId || ''),
      category: String(c.category || ''), dueDate: String(c.dueDate || ''),
      alsoDue: Array.isArray(c.alsoDue) ? c.alsoDue : [] }, extra || {});
  };
  const stepName = function (id) {
    const loc = id ? flowFind_(flow.steps, id) : null;
    if (!loc) return '';
    const s = loc.list[loc.i];
    return (RECALL_STEP_NAMES_[s.type] || s.type) + (s.type === 'email' && s.cfg && s.cfg.subject ? ': ' + s.cfg.subject : '');
  };

  // The one read: every open card, grouped by patient
  const open = fsQuery_(cfg, RECALL_COL_, 'status', 'EQUAL', 'open', 10000);
  const memo = { pts: {}, pc: {} };
  open.forEach(function (c) { if (c.patientId) (memo.pc[c.patientId] = memo.pc[c.patientId] || []).push(c); });

  // Already in the flow
  const order = { run: 0, wait: 1, team: 2, cycle: 3 };
  const inFlow = open.filter(function (c) { return c.flowState in order; }).map(function (c) {
    return row(c, { state: c.flowState, next: stepName(c.flowNext), at: Number(c.flowDueAt || 0), on: String(c.remindOn || ''),
      with: String(c.assignedToName || ''), texts: Number(c.texts || 0), emails: Number(c.emails || 0),
      replied: c.replyOpen === true, round: Number(c.flowCycle || 1) });
  }).sort(function (a, b) { return order[a.state] - order[b.state] || (a.at || 0) - (b.at || 0); });
  const along = open.filter(function (c) { return c.flowState === 'joined'; })
    .map(function (c) { return row(c, { joinedCat: String(c.joinedCat || ''), already: true }); });

  // Who starts, and when (the same steps as recallFlowRun_)
  const win = Number(t.withinDays);
  const from = win > 0 ? flowAddDaysKey_(today, -win) : '';
  const cands = open.filter(function (c) {
    const st = String(c.flowState || '');
    if (c.stage !== 'due' || c.assignedToId || c.dnc === true || String(c.dueDate) > today) return false;
    if (st === 'released') return true;
    return (!st || st === 'queued') && (!from || String(c.dueDate) >= from);
  });
  const byPt = {};
  cands.forEach(function (c) { const k = c.patientId || c._id; (byPt[k] = byPt[k] || []).push(c); });
  const waitedFirst = function (g) { return g.some(function (c) { return c.flowState === 'queued' || c.flowState === 'released'; }) ? 0 : 1; };
  const newest = function (g) { return g.reduce(function (m, c) { return String(c.dueDate) > m ? String(c.dueDate) : m; }, ''); };
  const groups = Object.keys(byPt).map(function (k) {
    return byPt[k].sort(function (a, b) {
      return recallPri_(flow, set, a.category) - recallPri_(flow, set, b.category) || String(b.dueDate).localeCompare(String(a.dueDate));
    });
  }).sort(function (a, b) { return waitedFirst(a) - waitedFirst(b) || newest(b).localeCompare(newest(a)); });

  const started = Number(PropertiesService.getScriptProperties().getProperty('RECALL_FLOW_' + today) || 0);
  const cap = Math.max(1, Math.min(500, Number(t.dailyMax) || 25));
  const left = Math.max(0, cap - started);
  const quiet = Math.max(0, Number(t.quietDays) || 0);
  const hasRules = flowHasRules_(t.rules);
  const ruleBudget = Math.min(400, left + cap * 3);   // about the next three days
  let checked = 0, unsure = 0;
  const starts = [], quietL = [], nomatch = [];

  groups.forEach(function (g) {
    const ids = g.map(function (c) { return c._id; });
    const others = g[0].patientId ? (memo.pc[g[0].patientId] || []).filter(function (x) { return ids.indexOf(x._id) === -1; }) : [];
    const running = others.filter(function (x) {
      return ['run', 'wait', 'team', 'cycle'].indexOf(String(x.flowState || '')) !== -1 || !!x.assignedToId;
    }).sort(function (a, b) { return recallPri_(flow, set, a.category) - recallPri_(flow, set, b.category); })[0];
    if (running) { g.forEach(function (c) { along.push(row(c, { joinedCat: String(running.category || '') })); }); return; }
    const last = others.concat(g).reduce(function (m, x) {
      [x.lastTextAt, x.lastEmailAt].forEach(function (v) { if (v && String(v) > m) m = String(v); });
      return m;
    }, '');
    if (quiet && last && nowMs - Date.parse(last) < quiet * 86400000) {
      const free = flowKey_(Date.parse(last) + quiet * 86400000);
      g.forEach(function (c) { quietL.push(row(c, { until: free })); });
      return;
    }
    let lead = null, maybe = false;
    if (!hasRules) lead = g[0];
    else if (checked >= ruleBudget || Date.now() > deadline) { lead = g[0]; maybe = true; unsure++; }
    else {
      checked++;
      for (let i = 0; i < g.length && !lead; i++) {
        try { if (recallFlowMatches_(cfg, t.rules, g[i], memo, today)) lead = g[i]; }
        catch (e) { console.warn('Recall flow preview ' + g[i]._id + ': ' + e); }
      }
      if (!lead) { g.forEach(function (c) { nomatch.push(row(c)); }); return; }
    }
    const also = g.filter(function (c) { return c !== lead; }).map(function (c) { return c.category; })
      .concat(others.filter(function (x) { return x.stage === 'due' && !x.assignedToId && x.flowState !== 'joined'; })
        .map(function (x) { return x.category; }))
      .filter(function (k, i, a) { return k && k !== lead.category && a.indexOf(k) === i; });
    starts.push(row(lead, { alsoDue: also, waited: lead.flowState === 'queued' || lead.flowState === 'released', unsure: maybe }));
  });

  starts.forEach(function (r, i) { r.day = flowAddDaysKey_(today, i < left ? 0 : 1 + Math.floor((i - left) / cap)); });
  const next = starts.filter(function (r) { return r.day === today; });
  const later = starts.filter(function (r) { return r.day !== today; });
  const cut = function (a) { return a.slice(0, MAXL); };
  return {
    ok: true, on: flow.on === true, cap: cap, started: started, left: left, quietDays: quiet, today: today,
    checkedAt: new Date().toISOString(), unsure: unsure,
    next: cut(next), nextCount: next.length,
    later: cut(later), laterCount: later.length, lastDay: starts.length ? starts[starts.length - 1].day : '',
    inFlow: cut(inFlow), inFlowCount: inFlow.length,
    quiet: cut(quietL), quietCount: quietL.length,
    along: cut(along), alongCount: along.length,
    nomatch: cut(nomatch), nomatchCount: nomatch.length,
    unchecked: 0,
  };
}

// "Keep out": out of the flow (or stopped), and the card goes to the recall team as usual
function recallFlowSkip_(body, session) {
  const cfg = getConfig_();
  const id = String(body.id || '');
  const c = id ? fsGetDoc_(cfg, RECALL_COL_ + '/' + id) : null;
  if (!c) return { ok: true, problem: "That card couldn't be found. Press Refresh." };
  if (c.status !== 'open') return { ok: true, problem: 'That card is already booked or closed.' };
  const me = getStaffDocs_().filter(function (s) { return s.id === session.uid; })[0];
  const now = new Date().toISOString();
  const was = String(c.flowState || '');
  const patch = {
    flowState: 'skip', flowNext: '', joinedTo: '', joinedCat: '', updatedAt: now,
    log: (Array.isArray(c.log) ? c.log : []).concat([{ at: now, by: String((me && me.name) || 'Staff'), byUid: session.uid, kind: 'flow',
      what: ['run', 'wait', 'team', 'cycle'].indexOf(was) !== -1 ? 'Taken out of the recall flow' : 'Kept out of the recall flow', note: '' }]).slice(-80),
  };
  if (was === 'cycle') Object.assign(patch, { stage: 'due', remindOn: '', pauseReason: '' });
  fsPatch_(cfg, RECALL_COL_ + '/' + id, patch);
  return { ok: true };
}

// ===================== Recall: Texts & emails page (#/recall/messages) =====================
// Texts and replies come straight from Textmagic (the real record, with delivery status).
// Emails are logged in recall_messages when they're sent (Gmail doesn't report delivery).

function recallLogEmail_(cfg, c, to, subject, by, byUid, auto) {
  try {
    fsPatch_(cfg, 'recall_messages/' + Utilities.getUuid(), {
      kind: 'email', at: new Date().toISOString(), to: String(to || ''), subject: String(subject || '').slice(0, 200),
      cardId: String(c._id || ''), patientId: String(c.patientId || ''), patientName: String(c.patientName || ''),
      category: String(c.category || ''), by: String(by || ''), byUid: String(byUid || ''), auto: !!auto,
    });
  } catch (e) { console.warn('Recall email log: ' + e); }
}

function recallTmGet_(path) {
  const p = PropertiesService.getScriptProperties();
  const user = p.getProperty('TextMagicUser'), key = p.getProperty('TextMagic');
  if (!user || !key) return null;
  const r = UrlFetchApp.fetch('https://rest.textmagic.com/api/v2' + path, {
    method: 'get', headers: { 'X-TM-Username': user, 'X-TM-Key': key }, muteHttpExceptions: true,
  });
  if (r.getResponseCode() >= 300) throw new Error('Textmagic ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText());
}

// "61414498026" or "0414 498 026" → "0414498026" (the same as mobileKey on recall cards)
function recallMobKey_(s) {
  let d = String(s || '').replace(/\D/g, '');
  if (/^614\d{8}$/.test(d)) d = '0' + d.slice(2);
  if (/^4\d{8}$/.test(d)) d = '0' + d;
  return /^04\d{8}$/.test(d) ? d : '';
}

function recallMessages_(body) {
  const cfg = getConfig_();
  const kind = body.kind === 'replies' ? 'replies' : 'messages';
  const page = Math.max(1, Math.min(500, Math.floor(Number(body.page) || 1)));
  let res;
  try { res = recallTmGet_('/' + kind + '?page=' + page + '&limit=50'); }
  catch (e) { return { ok: true, problem: "Couldn't reach Textmagic: " + String(e && e.message ? e.message : e).slice(0, 200) }; }
  if (!res) return { ok: true, problem: "Textmagic isn't set up yet. Add TextMagic and TextMagicUser in Script Properties." };
  const list = Array.isArray(res.resources) ? res.resources : [];
  const phoneOf = function (x) { return kind === 'replies' ? x.sender : x.receiver; };

  // Which patient each number belongs to (their recall card, open ones first)
  const keys = list.map(function (x) { return recallMobKey_(phoneOf(x)); }).filter(function (k, i, a) { return k && a.indexOf(k) === i; });
  const cards = {};
  for (let i = 0; i < keys.length; i += 30) {
    try {
      fsQuery_(cfg, RECALL_COL_, 'mobileKey', 'IN', keys.slice(i, i + 30), 300).forEach(function (c) {
        const k = String(c.mobileKey || '');
        const was = cards[k];
        if (!was || (was.status !== 'open' && c.status === 'open')
          || (was.status === c.status && String(c.updatedAt || '') > String(was.updatedAt || ''))) cards[k] = c;
      });
    } catch (e) { console.warn('Recall messages: card lookup ' + e); }
  }
  const rows = list.map(function (x) {
    const k = recallMobKey_(phoneOf(x));
    const c = k ? cards[k] : null;
    const tmName = [x.firstName, x.lastName].filter(Boolean).join(' ');
    return {
      id: String(x.id || ''), at: String(x.messageTime || ''), phone: k || String(phoneOf(x) || ''),
      text: String(x.text || ''), status: String(x.status || ''), parts: Number(x.partsCount || 0),
      name: c ? String(c.patientName || '') : tmName, patientId: c ? String(c.patientId || '') : '',
      category: c ? String(c.category || '') : '',
    };
  });
  return { ok: true, rows: rows, page: page, pageCount: Number(res.pageCount || 1) };
}

// ===================== Recall flow: move calls shared out before the flow into it =====================
// Cards become "released": held from sharing, and started by recallFlowRun_ before newly due ones (any due date)
function recallFlowAdopt_(body, session) {
  const cfg = getConfig_();
  const flow = fsGetDoc_(cfg, RECALL_FLOW_DOC_);
  if (!flow || flow.on !== true) return { ok: true, problem: 'Turn the flow on first, so the cards have somewhere to go.' };
  const all = body.mode === 'all';
  const given = fsQuery_(cfg, RECALL_COL_, 'stage', 'EQUAL', 'call', 5000).filter(function (c) {
    return c.status === 'open' && !!c.assignedToId && !c.replyOpen
      && ['run', 'wait', 'team', 'cycle', 'joined'].indexOf(String(c.flowState || '')) === -1;   // not the flow's own
  });
  const called = function (c) { return Number(c.attempts || 0) > 0 || !!c.lastCallAt; };
  const move = given.filter(function (c) { return all || !called(c); });
  const withCalls = all ? 0 : given.filter(called).length;
  const per = {};
  move.forEach(function (c) { const n = String(c.assignedToName || 'Someone'); per[n] = (per[n] || 0) + 1; });
  const byPerson = Object.keys(per).sort(function (a, b) { return per[b] - per[a]; }).map(function (n) { return { name: n, n: per[n] }; });
  if (body.dryRun) return { ok: true, count: move.length, byPerson: byPerson, withCalls: withCalls };

  const me = getStaffDocs_().filter(function (s) { return s.id === session.uid; })[0];
  const now = new Date().toISOString();
  const writes = move.map(function (c) {
    return patchWrite_(cfg, RECALL_COL_ + '/' + c._id, {
      stage: 'due', assignedToId: '', assignedToName: '', assignedDay: '',
      flowState: 'released', flowNext: '', joinedTo: '', joinedCat: '', updatedAt: now,
      log: (Array.isArray(c.log) ? c.log : []).concat([{ at: now, by: String((me && me.name) || 'Staff'), byUid: session.uid, kind: 'flow',
        what: 'Moved from ' + String(c.assignedToName || 'someone') + "'s calls into the recall flow", note: '' }]).slice(-80),
    });
  });
  if (writes.length) commitWrites_(cfg, writes, 100);
  return { ok: true, moved: writes.length };
}

// ===================== Flow rules: Birthday and Year of birth (Patient) =====================
FLOW_FIELD_TYPE_['pt.birthday'] = 'birthday';
FLOW_FIELD_TYPE_['pt.birth_year'] = 'year';
FLOW_RULE_COST_['pt.birthday'] = 1;
FLOW_RULE_COST_['pt.birth_year'] = 1;

// { y, m, d } from the patient's date of birth, whichever field and format it's in (y is 0 if the year isn't known)
function flowDob_(p) {
  const keys = ['DobKey', 'DOB', 'Dob', 'dob', 'DateOfBirth', 'Date of Birth', 'DateofBirth', 'Date Of Birth',
    'BirthDate', 'Birthdate', 'Birthday', 'birthDate'];
  const yy = Number(Utilities.formatDate(new Date(), 'Australia/Perth', 'yy'));
  const mon = function (s) { return MONTHS_[String(s).slice(0, 3).toLowerCase()] || 0; };
  for (let i = 0; i < keys.length; i++) {
    const v = p[keys[i]];
    if (v === undefined || v === null || v === '') continue;
    if (v instanceof Date && !isNaN(v)) {
      const k = Utilities.formatDate(v, 'Australia/Perth', 'yyyy-M-d').split('-').map(Number);
      return okDob_(k[0], k[1], k[2]);
    }
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);                        // 1985-03-14
    if (m) return okDob_(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/.exec(s);               // 14/03/1985 (day first, as in Australia)
    if (m) {
      let y = +m[3];
      if (y < 100) y += y > yy ? 1900 : 2000;                                // 14/03/85 → 1985
      return okDob_(y, +m[2], +m[1]);
    }
    m = /^(?:[A-Za-z]+,?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s);   // 14 March 1985
    if (m && mon(m[2])) return okDob_(+m[3], mon(m[2]), +m[1]);
    m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s);                // March 14, 1985
    if (m && mon(m[1])) return okDob_(+m[3], mon(m[1]), +m[2]);
  }
  return null;
}
function okDob_(y, m, d) {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { y: y >= 1900 && y <= 2100 ? y : 0, m: m, d: d } : null;
}

// Their date of birth, worked out once per patient per run
function flowDobOf_(cfg, run, ctx) {
  if (!('_dob' in ctx._f)) {
    let b = null;
    try {
      const p = ctx.pt || ctx.patient || ctx.doc || (run.patientId ? flowPatient_(cfg, run.patientId) : null);
      b = p ? flowDob_(p) : null;
    } catch (e) { console.warn('Date of birth rule: patient not read: ' + e); }
    ctx._f._dob = b;
  }
  return ctx._f._dob;
}

function flowBirthdayOk_(cfg, r, run, ctx) {
  const b = flowDobOf_(cfg, run, ctx);
  if (!b) return false;                              // no date of birth on file: never matches
  const t = flowKey_(Date.now()).split('-').map(Number);
  const today = Date.UTC(t[0], t[1] - 1, t[2]);
  const DAY = 86400000;
  const on = function (year) {                       // 29 Feb → 28 Feb in other years
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return Date.UTC(year, b.m - 1, b.m === 2 && b.d === 29 && !leap ? 28 : b.d);
  };
  if (r.op === 'month') return b.m === t[1];
  if (r.op === 'today') return on(t[0]) === today;
  const n = Math.max(0, Math.floor(Number(r.value) || 0));
  if (r.op === 'next') { let o = on(t[0]); if (o < today) o = on(t[0] + 1); return (o - today) / DAY <= n; }
  if (r.op === 'last') { let o = on(t[0]); if (o > today) o = on(t[0] - 1); return (today - o) / DAY <= n; }
  return false;
}

// Year of birth: is / before / after / between (both years included)
function flowBirthYearOk_(cfg, r, run, ctx) {
  const b = flowDobOf_(cfg, run, ctx);
  if (!b || !b.y) return false;                      // no year of birth on file: never matches
  const a = Math.floor(Number(r.value));
  if (!(a >= 1900 && a <= 2100)) return false;
  if (r.op === 'lt') return b.y < a;
  if (r.op === 'gt') return b.y > a;
  if (r.op === 'between') {
    const z = Math.floor(Number(r.value2));
    if (!(z >= 1900 && z <= 2100)) return false;
    return b.y >= Math.min(a, z) && b.y <= Math.max(a, z);
  }
  return b.y === a;
}

// ===================== Date blanks: {Today}, {Today + 30 days}, {Today + 2 weeks}, {Today + 3 months} =====================
// Worked out in Perth time when each message is sent. Every flow and recall message goes through these two.
function flowFill_() {
  const a = Array.prototype.slice.call(arguments);
  a[0] = flowDateTokens_(a[0]);
  return flowFillBase_.apply(null, a);
}
function flowFillHtml_() {
  const a = Array.prototype.slice.call(arguments);
  a[0] = flowDateTokens_(a[0]);
  return flowFillHtmlBase_.apply(null, a);
}

const FLOW_DATE_SP_ = '(?:\\s|&nbsp;|\\u00a0)*';
const FLOW_DATE_RE_ = new RegExp('\\{' + FLOW_DATE_SP_ + 'today' + FLOW_DATE_SP_ +
  '(?:([+-])' + FLOW_DATE_SP_ + '(\\d{1,4})' + FLOW_DATE_SP_ + '(days?|weeks?|months?|years?)?)?' + FLOW_DATE_SP_ + '\\}', 'gi');

function flowDateTokens_(s) {
  if (s === null || s === undefined) return s;
  return String(s).replace(FLOW_DATE_RE_, function (all, sign, num, unit) {
    let n = num ? Number(num) : 0;
    if (sign === '-') n = -n;
    const u = String(unit || 'days').toLowerCase();
    const k = Utilities.formatDate(new Date(), 'Australia/Perth', 'yyyy-MM-dd').split('-').map(Number);
    const d = new Date(Date.UTC(k[0], k[1] - 1, k[2]));
    if (/^day/.test(u)) d.setUTCDate(d.getUTCDate() + n);
    else if (/^week/.test(u)) d.setUTCDate(d.getUTCDate() + 7 * n);
    else {
      const months = /^year/.test(u) ? 12 * n : n;
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + months);
      d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
    }
    return Utilities.formatDate(d, 'UTC', 'd MMMM yyyy');
  });
}

// ===================== Flow rules: Purchases between two dates (Purchase history) =====================
FLOW_FIELD_TYPE_['hist.bought_between'] = 'prange';
FLOW_RULE_COST_['hist.bought_between'] = 2;

// last: their most recent purchase (of these products) was in the range · any: bought in the range · none: didn't
// No products chosen means any product. Purchases come from the Invoice Record (skincare/{key}.purchases).
function flowBoughtBetweenOk_(cfg, r, run, ctx) {
  const from = String(r.from || ''), to = String(r.to || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return false;
  const want = Array.isArray(r.value) ? r.value.filter(Boolean) : [];
  const dates = flowPurchases_(cfg, run, ctx)
    .filter(function (p) {
      return /^\d{4}-\d{2}-\d{2}$/.test(String(p.date || '')) &&
        (!want.length || want.some(function (w) { return flowSameProduct_(p.product, w); }));
    })
    .map(function (p) { return String(p.date); });
  if (r.op === 'last') {
    const last = dates.sort().pop();
    return !!last && last >= from && last <= to;
  }
  const has = dates.some(function (d) { return d >= from && d <= to; });
  return r.op === 'none' ? !has : has;
}

// ===================== Purchase flows: who bought recently, and starting the ones it missed =====================

const FLOW_BUY_WINDOWS_ = [7, 14, 30, 60, 90];

// The run a purchase starts: the same ID flowEnrol_ uses, so it never starts twice
function flowBuyRunId_(flowId, sid, p) {
  return flowPart_(flowId) + '__' + flowPart_(sid) + '__' + flowHash_([p.invoiceId, p.product, p.date].join('|'));
}

function flowPurchasePreview_(body, session) {
  const flowId = String(body.flowId || '');
  if (!/^[A-Za-z0-9_-]{5,60}$/.test(flowId)) return { ok: false, error: 'BAD_REQUEST' };
  const cfg = getConfig_();
  const flow = fsGetDoc_(cfg, 'email_flows/' + flowId);
  if (!flow || flow.status === 'archived') return { ok: false, error: 'NOT_FOUND' };
  flow._id = flowId;
  const t = flow.trigger || {};
  if ((t.event || 'purchase') !== 'purchase') return { ok: false, error: 'BAD_REQUEST' };
  const cache = CacheService.getScriptCache();
  const rk = 'flowbuys_' + session.uid;
  const used = Number(cache.get(rk) || 0);
  if (used >= 20) return { ok: false, error: 'RATE_LIMITED' };
  cache.put(rk, String(used + 1), 3600);

  const started = Date.now();
  const days = FLOW_BUY_WINDOWS_.indexOf(Number(body.days)) !== -1 ? Number(body.days) : 14;
  const today = flowKey_(Date.now());
  const from = flowAddDaysKey_(today, -days);
  const live = flow.status === 'live';
  const liveMs = Date.parse(String(flow.liveAt || ''));
  const liveKey = liveMs ? flowKey_(liveMs) : today;
  const autoFrom = flowKey_(Date.now() - FLOW_LOOKBACK_DAYS_ * 86400000);
  const memo = { pts: {} };
  const productOk = function (product) {
    if (t.scope === 'catalogue') return !!flowProduct_(cfg, memo, product);
    if (t.scope === 'list') return (Array.isArray(t.products) ? t.products : []).some(function (n) { return flowSameProduct_(n, product); });
    return true;
  };

  // Matching purchases in the window: newest first, one per patient and product
  const all = [];
  fsListAll_(cfg, 'skincare', ['patientId', 'patientName', 'purchases']).forEach(function (d) {
    const sk = fromFields_(d.fields || {});
    const key = d.name.split('/').pop();
    (Array.isArray(sk.purchases) ? sk.purchases : []).forEach(function (p) {
      const date = String(p.date || '');
      const product = String(p.product || '').trim();
      if (!product || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > today || !productOk(product)) return;
      all.push({ key: key, sid: String(sk.patientId || '').trim(), name: String(sk.patientName || ''),
        product: product, date: date, invoiceId: String(p.invoiceId || ''), soldBy: String(p.staff || '') });
    });
  });
  all.sort(function (a, b) { return b.date.localeCompare(a.date); });
  const seen = {};
  const list = all.filter(function (r) {
    const k = (r.sid || 'n:' + r.key) + '|' + flowNorm_(r.product);
    if (seen[k]) return false;
    seen[k] = true;
    return true;
  });

  // This flow's runs and holds, and the patients in one read
  const runs = fsQuery_(cfg, FLOW_RUNS_, 'flowId', 'EQUAL', flowId, 5000);
  const held = flowHoldSet_(cfg, flowId);
  const got = fsBatchGet_(cfg, uniq_(list.map(function (r) { return r.sid; }).filter(recDocIdOk_))
    .map(function (s) { return 'patient_list/' + s; }));
  const RUN_WORD = { done: 'Finished', stopped: 'Stopped', failed: 'Not sent', skipped: 'Skipped' };

  const rows = list.map(function (r) {
    const row = { id: '', name: r.name, product: r.product, date: r.date, invoiceId: r.invoiceId, key: r.key, state: '', note: '', runId: '' };
    if (!r.sid) { row.state = 'noid'; row.note = 'The invoice line has no Patient ID. Link the name in Daily uploads, then check again.'; return row; }
    let doc = got['patient_list/' + r.sid] || null;
    if (doc && !doc.MergedInto) doc._id = r.sid;
    else doc = Date.now() - started < 200000 ? flowPatient_(cfg, r.sid) : null;   // merged, or saved under a different ID
    if (!doc) { row.state = 'nopatient'; row.note = 'Patient ID ' + r.sid + " isn't in the Patient List."; return row; }
    memo.pts[doc._id] = doc;
    row.id = doc._id;
    row.name = flowWho_(doc).name || r.name;
    if (held[doc._id]) { row.state = 'held'; return row; }

    const base = flowBuyRunId_(flowId, r.sid, r);
    const mine = runs.filter(function (x) { return x._id === base || x._id.indexOf(base + '__r') === 0; })
      .sort(function (a, b) { return String(b.startedAt || '').localeCompare(String(a.startedAt || '')); })[0];
    if (mine) {
      row.runId = mine._id;
      if (mine.status === 'active') { row.state = 'active'; return row; }
      row.state = 'ran';
      row.note = (RUN_WORD[mine.status] || 'Finished') + (mine.reason && mine.status !== 'done' ? ': ' + mine.reason : '');
      return row;
    }
    const earlier = runs.some(function (x) {
      return x.status === 'active' && x.patientId === doc._id && flowSameProduct_(x.product, r.product);
    });
    if (earlier && (flow.stop || {}).rebuy === false) {
      row.state = 'active';
      row.note = 'Already in this flow for an earlier purchase of this product.';
      return row;
    }
    if (flowHasRules_(t.rules)) {
      if (Date.now() - started > 210000) { row.state = 'unchecked'; row.note = 'Start rules not checked: the list was too long.'; return row; }
      const run = { patientId: doc._id, kind: 'purchase', product: r.product, purchaseDate: r.date, invoiceId: r.invoiceId,
        soldBy: r.soldBy, sourceKey: r.key, sourceId: r.sid };
      let ok = false;
      try { const ctx = flowCtx_(cfg, run, memo); ok = !!ctx && flowGroupOk_(cfg, t.rules, run, ctx); } catch (e) { ok = false; }
      if (!ok) { row.state = 'norules'; return row; }
    }
    if (!isEmail_(String(doc.Email || '').trim())) {
      row.state = 'noemail';
      row.note = 'While testing, their emails still come to you. Sending to patients, the flow stops for them.';
      return row;
    }
    const auto = r.date >= autoFrom && r.date >= liveKey;
    row.state = !live ? 'off' : auto ? 'will' : 'old';
    if (row.state === 'old') {
      row.note = r.date < liveKey ? 'Bought before the flow was turned on.'
        : 'Bought more than ' + FLOW_LOOKBACK_DAYS_ + " days ago, so it won't start by itself.";
    }
    if (earlier && live) row.note = (row.note ? row.note + ' ' : '') + 'Their current run for this product starts over.';
    return row;
  });

  const order = ['will', 'old', 'noemail', 'unchecked', 'off', 'active', 'ran', 'norules', 'held', 'noid', 'nopatient'];
  rows.sort(function (a, b) { return order.indexOf(a.state) - order.indexOf(b.state) || b.date.localeCompare(a.date); });
  return { ok: true, days: days, total: rows.length, rows: rows.slice(0, 400), more: Math.max(0, rows.length - 400),
    live: live, mode: flow.sendMode === 'real' ? 'real' : 'test' };
}

// "Start now" from See recent purchases. Everything is checked again here; the browser's list isn't trusted.
function flowStartPurchase_(body, session) {
  const flowId = String(body.flowId || '');
  if (!/^[A-Za-z0-9_-]{5,60}$/.test(flowId)) return { ok: false, error: 'BAD_REQUEST' };
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, 50);
  if (!items.length) return { ok: false, error: 'BAD_REQUEST' };
  const cfg = getConfig_();
  const flow = fsGetDoc_(cfg, 'email_flows/' + flowId);
  if (!flow || flow.status !== 'live' || !Array.isArray(flow.steps) || !flow.steps.length) return { ok: false, error: 'NOT_LIVE' };
  flow._id = flowId;
  const t = flow.trigger || {};
  if ((t.event || 'purchase') !== 'purchase') return { ok: false, error: 'BAD_REQUEST' };

  const lock = LockService.getScriptLock();   // so the 15-minute run can't start the same purchase at the same time
  if (!lock.tryLock(30000)) return { ok: false, error: 'BUSY' };
  try {
    const memo = { pts: {} };
    const sks = {};
    const who = String(session.name || 'staff');
    const made = [];
    const skipped = [];
    items.forEach(function (it, i) {
      it = it || {};
      const skip = function (why, name) { skipped.push({ i: i, name: String(name || it.name || ''), why: why }); };
      const key = String(it.key || '');
      if (!recDocIdOk_(key)) return skip('not found');
      if (!(key in sks)) sks[key] = fsGetDoc_(cfg, 'skincare/' + encodeURIComponent(key));
      const sk = sks[key];
      const p = sk && (Array.isArray(sk.purchases) ? sk.purchases : []).filter(function (x) {
        return String(x.date || '') === String(it.date || '') && String(x.product || '').trim() === String(it.product || '').trim()
          && String(x.invoiceId || '') === String(it.invoiceId || '');
      })[0];
      if (!p) return skip('the purchase is no longer in the Invoice Record');
      const sid = String(sk.patientId || '').trim();
      if (!sid) return skip('no Patient ID on the invoice', sk.patientName);
      const doc = flowPatient_(cfg, sid);
      if (!doc) return skip('not in the Patient List', sk.patientName);
      memo.pts[doc._id] = doc;
      const name = flowWho_(doc).name;
      if (flowHeld_(cfg, memo, flowId, doc._id)) return skip('held', name);

      const product = String(p.product).trim();
      const date = String(p.date);
      const base = { kind: 'purchase', product: product, purchaseDate: date, invoiceId: String(p.invoiceId || ''),
        soldBy: String(p.staff || ''), sourceKey: key, sourceId: sid };
      const trun = Object.assign({ patientId: doc._id }, base);
      if (flowHasRules_(t.rules)) {
        const ctx = flowCtx_(cfg, trun, memo);
        if (!ctx || !flowGroupOk_(cfg, t.rules, trun, ctx)) return skip("doesn't match the start rules", name);
      }
      const baseId = flowBuyRunId_(flowId, sid, { invoiceId: base.invoiceId, product: product, date: date });
      const theirs = fsQuery_(cfg, FLOW_RUNS_, 'patientId', 'EQUAL', doc._id, 100)
        .filter(function (r) { return r.flowId === flowId && r.status === 'active'; });
      if (theirs.some(function (r) { return r._id === baseId || r._id.indexOf(baseId + '__r') === 0; })) {
        return skip('already in this flow for this purchase', name);
      }
      const same = theirs.filter(function (r) { return flowSameProduct_(r.product, product); });
      if (same.length && (flow.stop || {}).rebuy === false) return skip('already in this flow for this product', name);

      const now = new Date().toISOString();
      const rid = fsGetDoc_(cfg, FLOW_RUNS_ + '/' + baseId) ? baseId + '__r' + Date.now().toString(36) : baseId;
      const writes = same.map(function (r) {
        return patchWrite_(cfg, FLOW_RUNS_ + '/' + r._id, {
          status: 'stopped', reason: 'Started again for a newer purchase by ' + who + '.', next: '', updatedAt: now,
        });
      });
      writes.push(updateWrite_(cfg, FLOW_RUNS_ + '/' + rid, flowNewRun_(flow, doc, Object.assign({}, base, {
        apptKeys: (flow.stop || {}).booking === true ? flowUpcoming_(cfg, doc, memo) : [],
        events: [{ at: now, what: 'Started by ' + who + ': bought ' + product + ' on ' + (recLongDate_(date) || date) }],
      }))));
      commitWrites_(cfg, writes);
      made.push(rid);
    });
    flowKick_(cfg, flow, made, memo);
    console.log('Flow ' + flowId + ': ' + made.length + ' purchase run(s) started by ' + who);
    return { ok: true, started: made.length, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

// When this patient last had this email card from this flow (ms), if it was within `days`, else 0.
// Looks at every run of the flow for them: the card's send time, and older runs' history (matched by subject).
// mode: 'real' or 'test' (test emails don't count against real ones, and the other way round)
function flowRecentSend_(cfg, flow, s, pid, mode, days) {
  if (!pid) return 0;
  const since = Date.now() - days * 86400000;
  const subj = 'Emailed “' + String((s.cfg || {}).subject || '').slice(0, 120) + '”';
  let last = 0;
  fsQuery_(cfg, FLOW_RUNS_, 'patientId', 'EQUAL', pid, 200).forEach(function (r) {
    if (r.flowId !== flow._id || (r.mode === 'test') !== (mode === 'test')) return;
    const a = Date.parse(String((r.sentCards || {})[s.id] || '')) || 0;
    if (a > last) last = a;
    (Array.isArray(r.events) ? r.events : []).forEach(function (e) {
      if (String((e && e.what) || '').indexOf(subj) !== 0) return;
      const t = Date.parse(String(e.at || '')) || 0;
      if (t > last) last = t;
    });
  });
  return last >= since ? last : 0;
}

// ===================== Patient page → SMS (Textmagic) =====================
// Staff text a patient from their page. Sent here, so the Textmagic key never reaches the browser.
// Each text is kept in sms_messages; replies arrive through recallReplies_ (every 5 minutes) into recall_replies.

const SMS_COL_ = 'sms_messages';
const SMS_MAX_ = 612;

function handleSms_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  if (!can_(session, 'sms.send')) return { ok: false, error: 'FORBIDDEN' };
  const op = String(body.op || '');
  try {
    const cfg = getConfig_();
    const doc = flowPatient_(cfg, String(body.patientId || ''));
    if (!doc) return { ok: true, problem: "This patient couldn't be found." };
    if (op === 'thread') return smsThread_(cfg, doc);
    if (op === 'send') return smsSend_(cfg, doc, body, session);
  } catch (err) {
    console.error('SMS ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: true, problem: 'Something went wrong: ' + String(err && err.message ? err.message : err).slice(0, 200) };
  }
  return { ok: false, error: 'BAD_REQUEST' };
}

// On the do-not-contact list, or replied STOP: texts about their care only
function smsBlock_(cfg, doc) {
  const c = doc['Marketing Consent'] || {};
  const stop = doc['Marketing OK'] === false && c.source === 'Replied STOP to a text';
  const why = recallTextBlocked_(cfg, doc._id);
  if (!stop && !why) return { dnc: false, stop: false, why: '' };
  return {
    dnc: true, stop: stop,
    why: stop ? 'They replied STOP to a text' + (c.at ? ' on ' + recLongDate_(String(c.at).slice(0, 10)) : '') + '.'
      : "They're on the do-not-contact list" + (c.source ? ' (' + c.source + ')' : '') + '.',
  };
}

// Texts from patient pages, Recall texts, and replies to this number: oldest first, the last 60
function smsThread_(cfg, doc) {
  const phone = recallPhone04_(doc.Mobile);
  const ids = uniq_([String(doc._id)].concat(Array.isArray(doc.MergedIds) ? doc.MergedIds.map(String) : [])).slice(0, 10);
  const items = [];
  ids.forEach(function (id) {
    fsQuery_(cfg, SMS_COL_, 'patientId', 'EQUAL', id, 200).forEach(function (m) {
      items.push({ dir: 'out', at: String(m.at || ''), text: String(m.text || ''), by: String(m.by || ''), src: '' });
    });
    fsQuery_(cfg, RECALL_COL_, 'patientId', 'EQUAL', id, 50).forEach(function (c) {
      (Array.isArray(c.log) ? c.log : []).forEach(function (l) {
        if (!l || !l.note) return;
        const isText = l.kind === 'text' || (l.kind === 'flow' && /^Text sent/.test(String(l.what || '')));
        if (isText) items.push({ dir: 'out', at: String(l.at || ''), text: String(l.note), by: String(l.by || ''), src: 'Recall' });
      });
    });
  });
  if (phone) {
    fsQuery_(cfg, RECALL_REPLIES_, 'phone', 'EQUAL', phone, 200).forEach(function (r) {
      items.push({ dir: 'in', at: String(r.at || ''), text: String(r.text || ''), kind: String(r.kind || '') });
    });
  }
  items.sort(function (a, b) { return a.at.localeCompare(b.at); });
  return {
    ok: true, ready: !!tmAuth_(), mobile: phone, items: items.slice(-60), blocked: smsBlock_(cfg, doc),
  };
}

function smsSend_(cfg, doc, body, session) {
  const auth = tmAuth_();
  if (!auth) return { ok: true, problem: "Texts aren't set up yet. Add TextMagic, TextMagicUser and TextMagicFrom in Script Properties." };
  const phone61 = recallPhone61_(doc.Mobile);
  if (!phone61) return { ok: true, problem: "There's no Australian mobile number on their record." };
  const h = Number(Utilities.formatDate(new Date(), REC_TZ_, 'H'));
  if (h < 7 || h >= 21) return { ok: true, problem: 'Texts can only be sent between 7 am and 9 pm.' };
  const text = String(body.text || '').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 2) return { ok: true, problem: 'Write the message first.' };
  if (text.length > SMS_MAX_) return { ok: true, problem: 'The message is too long. Keep it under ' + SMS_MAX_ + ' characters.' };
  const blk = smsBlock_(cfg, doc);
  if (blk.dnc && body.service !== true) {
    return { ok: true, problem: blk.why + ' Tick "This is about their appointment or care" to send it.' };
  }
  const cache = CacheService.getScriptCache();
  const rk = 'sms_rl_' + session.uid;
  const used = Number(cache.get(rk) || 0);
  if (used >= 60) return { ok: true, problem: "You've sent a lot of texts in the last hour. Try again a bit later." };

  let tmId = '';
  try { tmId = tmSend_(auth, phone61, text); }
  catch (e) { return { ok: true, problem: "The text wasn't sent: " + String(e && e.message ? e.message : e).slice(0, 200) }; }
  cache.put(rk, String(used + 1), 3600);

  const at = new Date().toISOString();
  const who = String(session.name || 'Staff');
  commitWrites_(cfg, [updateWrite_(cfg, SMS_COL_ + '/s_' + Date.now() + '_' + Utilities.getUuid().slice(0, 8), {
    patientId: String(doc._id), patientName: flowWho_(doc).name, phone: recallPhone04_(doc.Mobile), text: text,
    at: at, by: who, byUid: String(session.uid || ''), tmId: String(tmId || ''), service: blk.dnc,
  })]);
  console.log('SMS to ' + flowWho_(doc).name + ' by ' + who);
  return { ok: true, item: { dir: 'out', at: at, text: text, by: who, src: '' } };
}

// A reply to a patient-page text: the person who sent it gets an email
function smsTellSender_(portal, kind, text) {
  try {
    const s = getStaffDocs_().filter(function (x) { return x.id === portal.byUid; })[0];
    if (!s || s.active === false || !isEmail_(s.email) || MailApp.getRemainingDailyQuota() < 1) return;
    const name = String(portal.patientName || 'A patient');
    const html = invEmailWrap_(
      '<h2 style="margin:0 0 6px;font-size:20px;color:#0f766e">' + invEsc_(name) + ' replied to your text</h2>' +
      '<p style="margin:0 0 6px;color:#64748b;font-size:13px">You wrote: “' + invEsc_(String(portal.text || '').slice(0, 200)) + '”</p>' +
      '<p style="margin:0 0 6px;padding:12px 14px;border-radius:10px;background:#f0fdfa;color:#134e4a;white-space:pre-wrap">' +
        invEsc_(text) + '</p>' +
      (kind === 'stop' ? '<p style="margin:10px 0 0;color:#b91c1c">They replied STOP, so they\'re now on the do-not-contact list.</p>' : ''),
      'patient/' + encodeURIComponent(String(portal.patientId || '')), "Open the patient's page");
    MailApp.sendEmail({ to: s.email, name: 'Dermedica Portal', subject: 'Text reply from ' + name,
      htmlBody: html, body: emailHtmlToText_(html) });
  } catch (e) { console.warn('Text reply email not sent: ' + e); }
}

// ===================== Recall: results (Recall → Results) =====================
// Worked out from the cards themselves: every card that became due in the period, and what its History
// says happened before it was booked. Nothing extra is saved on the cards. Remembered for 10 minutes.

const RECALL_RES_SKIP_ = { 'Duplicate': 1, 'Recall is turned off for this treatment': 1, 'Last visit was not a treatment': 1 };
const RECALL_RES_REOPEN_ = /^(Not booked after all|Reopened|Marked as booked, but|The booking for |Back on the list: the visit)/;
const RECALL_RES_CALL_ = { 'No answer': 1, 'Left voicemail': 1, 'Spoke to them': 1 };
const RECALL_RES_FIELDS_ = ['category', 'dueDate', 'status', 'closeReason', 'bookedAt', 'visitedOn', 'flowStartedAt', 'log'];
const RECALL_RES_NEAR_ = 30 * 86400000;   // a contact counts towards a booking if it was in the 30 days before

// Every card due between two dates, only the fields the results need, 500 at a time
function recallResultsCards_(cfg, from, to) {
  const out = [];
  let after = null;
  for (let page = 0; page < 30; page++) {
    const sq = {
      from: [{ collectionId: RECALL_COL_ }],
      select: { fields: RECALL_RES_FIELDS_.map(function (f) { return { fieldPath: f }; }) },
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'dueDate' }, op: 'GREATER_THAN_OR_EQUAL', value: { stringValue: from } } },
        { fieldFilter: { field: { fieldPath: 'dueDate' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: to } } },
      ] } },
      orderBy: [{ field: { fieldPath: 'dueDate' } }, { field: { fieldPath: '__name__' } }],
      limit: 500,
    };
    if (after) sq.startAt = { values: [{ stringValue: after.due }, { referenceValue: after.name }], before: false };
    const res = UrlFetchApp.fetch('https://firestore.googleapis.com/v1/' + fsBase_(cfg) + ':runQuery', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + getAccessToken_(cfg) },
      payload: JSON.stringify({ structuredQuery: sq }),
    });
    if (res.getResponseCode() !== 200) {
      throw new Error('Recall cards not read (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
    }
    const docs = JSON.parse(res.getContentText()).filter(function (r) { return r.document; }).map(function (r) { return r.document; });
    docs.forEach(function (d) { const o = fromFields_(d.fields || {}); o._id = d.name.split('/').pop(); out.push(o); });
    if (docs.length < 500) break;
    const last = docs[docs.length - 1];
    after = { due: String(fromFields_(last.fields || {}).dueDate || ''), name: last.name };
  }
  return out;
}

// What happened to one card, from its History.
// { result: booked | open | lost, reason, via: call | reply | text | email | self, by, tries, flow, days }
function recallOutcome_(c) {
  const log = Array.isArray(c.log) ? c.log : [];
  const ok = c.status === 'booked' || (c.status === 'closed' && c.closeReason === 'Came in');

  // The booking that stuck: the first one after the last time it was reopened
  let bi = -1;
  if (ok) {
    let from = 0;
    for (let i = log.length - 1; i >= 0; i--) {
      if (RECALL_RES_REOPEN_.test(String((log[i] || {}).what || ''))) { from = i + 1; break; }
    }
    for (let i = from; i < log.length; i++) {
      const l = log[i] || {};
      const w = String(l.what || '');
      if ((l.kind === 'call' && w === 'Booked') || (l.kind === 'auto' && /^(Booked for |Came in on )/.test(w))) { bi = i; break; }
    }
  }

  const o = {
    result: ok ? 'booked' : c.status === 'open' ? 'open' : 'lost',
    reason: ok ? '' : String(c.closeReason || ''),
    via: '', by: '', tries: 0, flow: !!c.flowStartedAt, days: null,
  };
  let last = null;
  let lastStaff = null;
  const end = bi >= 0 ? bi : log.length;
  for (let i = 0; i < end; i++) {
    const l = log[i] || {};
    const w = String(l.what || '');
    const staff = !!l.byUid;
    let type = '';
    if (l.kind === 'flow' || l.by === 'Recall flow') {
      type = /^Text sent/.test(w) ? 'text' : /^Email sent/.test(w) ? 'email' : '';
      if (type || /^(Started the recall flow|Joined their|Starting the flow again)/.test(w)) o.flow = true;
    } else if (l.kind === 'text') {
      type = 'text';
      if (!staff) o.flow = true;   // the older automatic text
    } else if (l.kind === 'email') {
      type = 'email';
    } else if (l.kind === 'call') {
      if (RECALL_RES_CALL_[w]) { type = 'call'; o.tries++; }
      else if (w === 'Sent a text') type = 'text';
    } else if (l.kind === 'reply' && !/STOP/i.test(w)) {
      type = 'reply';
    }
    if (!type) continue;
    last = { type: type, at: String(l.at || ''), by: staff ? String(l.by || '') : '' };
    if (staff) lastStaff = last;
  }
  if (!ok) return o;

  const be = bi >= 0 ? log[bi] : null;
  const ms = Date.parse(String((be && be.at) || c.bookedAt || ''));
  o.days = flowDays_(c.dueDate, ms ? flowKey_(ms) : String(c.visitedOn || ''));
  const near = function (t) { return !!t && (!ms || ms - (Date.parse(t.at) || 0) <= RECALL_RES_NEAR_); };
  if (be && be.kind === 'call') {   // staff logged it as booked: that was a call
    o.tries++;
    o.via = near(last) && last.type === 'reply' ? 'reply' : 'call';
    o.by = String(be.by || '');
  } else {
    o.via = near(last) ? last.type : 'self';
    o.by = near(lastStaff) ? lastStaff.by : '';
  }
  if (!o.by && o.flow && o.via !== 'self') o.by = 'Recall flow';
  return o;
}

function recallResults_(body) {
  const cfg = getConfig_();
  const today = flowKey_(Date.now());
  let from = String(body.from || '');
  let to = String(body.to || '');
  const span = [30, 90, 180, 365].indexOf(Number(body.days)) !== -1 ? Number(body.days) : 0;
  if (span) { from = flowAddDaysKey_(today, -span); to = today; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return { ok: true, problem: 'Choose the dates.' };
  if (flowDays_(from, to) > 731) return { ok: true, problem: 'Choose up to two years at a time.' };

  const cache = CacheService.getScriptCache();
  const ck = 'rc_res_' + from + '_' + to;
  if (!body.fresh) {
    const hit = cache.get(ck);
    if (hit) return JSON.parse(hit);
  }

  const cards = recallResultsCards_(cfg, from, to).filter(function (c) {
    return !(c.status === 'closed' && RECALL_RES_SKIP_[String(c.closeReason || '')]);
  });

  let total = 0, booked = 0, open = 0, lost = 0;
  const cats = {}, people = {}, reasons = {}, months = {}, dayList = [];
  const via = { call: 0, reply: 0, text: 0, email: 0, self: 0 };
  const tries = { t0: 0, t1: 0, t2: 0, t3: 0 };
  const flow = { cards: 0, booked: 0, noCall: 0, afterCall: 0, open: 0, lost: 0 };
  const person = function (n) { return people[n] || (people[n] = { name: n, calls: 0, texts: 0, emails: 0, booked: 0 }); };

  cards.forEach(function (c) {
    const o = recallOutcome_(c);
    const key = String(c.category || 'Other');
    const cat = cats[key] || (cats[key] = { key: key, due: 0, booked: 0, open: 0, lost: 0, days: [] });
    const mk = String(c.dueDate || '').slice(0, 7);
    const mo = months[mk] || (months[mk] = { month: mk, due: 0, booked: 0 });
    total++; cat.due++; mo.due++;

    // What each person did on these cards
    (Array.isArray(c.log) ? c.log : []).forEach(function (l) {
      if (!l || !l.byUid || !l.by) return;
      const w = String(l.what || '');
      if (l.kind === 'call' && (RECALL_RES_CALL_[w] || w === 'Booked')) person(l.by).calls++;
      else if (l.kind === 'text' || (l.kind === 'call' && w === 'Sent a text')) person(l.by).texts++;
      else if (l.kind === 'email') person(l.by).emails++;
    });

    if (o.flow) flow.cards++;
    if (o.result === 'booked') {
      booked++; cat.booked++; mo.booked++;
      via[o.via] = (via[o.via] || 0) + 1;
      tries[o.tries >= 3 ? 't3' : 't' + o.tries]++;
      if (o.by && o.by !== 'Recall flow') person(o.by).booked++;
      if (o.flow) { flow.booked++; if (o.tries === 0) flow.noCall++; else flow.afterCall++; }
      if (o.days !== null) { dayList.push(o.days); cat.days.push(o.days); }
    } else if (o.result === 'open') {
      open++; cat.open++;
      if (o.flow) flow.open++;
    } else {
      lost++; cat.lost++;
      if (o.flow) flow.lost++;
      const r = o.reason || 'Other';
      reasons[r] = (reasons[r] || 0) + 1;
    }
  });

  const median = function (a) {
    if (!a.length) return null;
    const s = a.slice().sort(function (x, y) { return x - y; });
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
  };
  const days = {
    n: dayList.length, median: median(dayList),
    avg: dayList.length ? Math.round(dayList.reduce(function (t, x) { return t + x; }, 0) / dayList.length) : null,
    early: 0, w1: 0, m1: 0, m3: 0, later: 0,
  };
  dayList.forEach(function (d) {
    days[d < 0 ? 'early' : d <= 7 ? 'w1' : d <= 30 ? 'm1' : d <= 90 ? 'm3' : 'later']++;
  });

  const out = {
    ok: true, from: from, to: to, checkedAt: new Date().toISOString(),
    total: total, booked: booked, open: open, lost: lost, via: via, tries: tries, flow: flow, days: days,
    cats: Object.keys(cats).map(function (k) {
      const c = cats[k];
      return { key: c.key, due: c.due, booked: c.booked, open: c.open, lost: c.lost, median: median(c.days) };
    }).sort(function (a, b) { return b.due - a.due; }),
    people: Object.keys(people).map(function (k) { return people[k]; })
      .sort(function (a, b) { return b.booked - a.booked || b.calls - a.calls; }),
    reasons: Object.keys(reasons).map(function (k) { return { label: k, n: reasons[k] }; })
      .sort(function (a, b) { return b.n - a.n; }),
    months: Object.keys(months).sort().map(function (k) { return months[k]; }),
  };
  try { const j = JSON.stringify(out); if (j.length < 95000) cache.put(ck, j, 600); } catch (e) { /* not essential */ }
  return out;
}

// Inventory → a purchase order's emails, straight from this account's Gmail Sent folder.
// Only messages sent BY this account (or its "Send mail as" aliases) that mention the PO number.
function inventoryFindSentPo_(p) {
  var number = String(p.poNumber || '').trim();
  if (!/^PO-[A-Z0-9-]{3,40}$/i.test(number)) return { messages: [], reason: 'BAD_NUMBER' };
  var to = String(p.to || '').trim().toLowerCase();
  if (!/^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/.test(to)) to = '';

  var mine = [Session.getEffectiveUser().getEmail()].concat(GmailApp.getAliases())
    .map(function (a) { return String(a).toLowerCase(); });
  var fromMe = function (from) {
    var f = String(from || '').toLowerCase();
    return mine.some(function (a) { return a && f.indexOf(a) !== -1; });
  };

  var q = 'in:sent "' + number + '"' + (to ? ' to:' + to : '');
  var out = [];
  GmailApp.search(q, 0, 10).forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (out.length >= 8 || m.isDraft() || !fromMe(m.getFrom())) return;
      var subject = m.getSubject() || '';
      var html = m.getBody() || '';
      if (subject.indexOf(number) === -1 && html.indexOf(number) === -1) return;
      if (to && (String(m.getTo()) + ',' + String(m.getCc())).toLowerCase().indexOf(to) === -1) return;
      var tooBig = html.length > 800000;
      out.push({
        id: m.getId(), date: m.getDate().toISOString(), subject: subject,
        from: m.getFrom(), to: m.getTo(), cc: m.getCc(),
        html: tooBig ? '' : html, tooBig: tooBig, link: t.getPermalink(),
      });
    });
  });
  out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  return { messages: out };
}

// ===================== Reporting: patient lists =====================
// Reporting → Packages left, Skin Scripts expiring and New patients not back. Worked out from the PCN sheets
// (alltimeappts, customer_packages, SSP_NEW) and Firestore (patient_list, ssp_records). Each answer is remembered
// for 10 minutes; "Refresh" works it out again. Contacts are logged by the portal in report_contacts.

const REP_OPS_ = ['packages', 'ssp', 'newpts'];
// Timely sometimes puts a no-show or cancellation in the service instead of the status
const REP_NOT_VISIT_ = /\bno[\s-]?show\b|\bdna\b|did not (attend|show)|\bcancel/i;
const REP_PKG_DONE_ = /expir|cancel|refund|void|complete|closed|inactive|used up/i;   // package statuses that can't be used

function handleReports_(body) {
  const session = getSession_(String(body.session || ''));
  if (!session) return { ok: false, error: 'UNAUTHORIZED' };
  const op = String(body.op || '');
  if (REP_OPS_.indexOf(op) === -1 && op !== 'retention') return { ok: false, error: 'BAD_REQUEST' };
  // Retention is numbers only (no patient details), so Reporting access is enough
  if (!can_(session, op === 'retention' ? 'menu.reports' : 'reports.patients')) return { ok: false, error: 'FORBIDDEN' };
  const key = 'rep_' + op + '_v4';
  if (body.fresh !== true) {
    const hit = repCacheGet_(key);
    if (hit) return Object.assign({ ok: true, cached: true }, hit);
  }
  const cache = CacheService.getScriptCache();
  if (cache.get('up_ds_active') || cache.get('pcn_run_active')) {
    return { ok: true, problem: 'A Day Sheet upload or PCN update is running. Try again in a few minutes.' };
  }
  try {
    const t0 = Date.now();
    const cfg = getConfig_();
    const ctx = pcnCtx_();
    const pts = recallPatients_(cfg);
    let out;
    if (op === 'retention') {
      out = repRetention_(ctx, pts);
    } else {
      const idx = repVisits_(ctx, pts);
      const rows = op === 'packages' ? repPackages_(ctx, pts, idx)
        : op === 'ssp' ? repSsp_(cfg, ctx, pts, idx) : repNewPts_(ctx, pts, idx);
      const sent = repSent_(cfg, pts);
      rows.forEach(function (r) { if (r.id && sent[r.id]) r.sent = sent[r.id]; });
      out = { rows: rows };
    }
    out.at = new Date().toISOString();
    out.today = ctx.todayKey;
    out.ms = Date.now() - t0;
    repCachePut_(key, out);
    console.log('Report ' + op + ' in ' + out.ms + ' ms for ' + session.name);
    return Object.assign({ ok: true }, out);
  } catch (err) {
    console.error('Report ' + op + ' failed: ' + (err && err.stack ? err.stack : err));
    return { ok: true, problem: "The report couldn't be made: " + String(err && err.message ? err.message : err).slice(0, 200) };
  }
}

// Every patient's visits from the appointment book: first and last visit, how many visit days, next booking.
// Keyed by the patient record kept after merges (or "ptt:<id>" when the ID isn't in the Patient List).
// Cancelled, no-shows and DNA don't count. Today's appointments count as booked.
function repVisits_(ctx, pts) {
  const idx = Object.create(null);
  const keyOf = Object.create(null);
  pcnReadAppts_(ctx).forEach(function (r) {
    if (!pcnIsDate_(r[0]) || !pcnStatusOk_(r[7], 'full')) return;
    if (REP_NOT_VISIT_.test(String(r[9] == null ? '' : r[9]))) return;   // "NO SHOW" as the service
    const ptt = String(r[14] == null ? '' : r[14]).trim();
    if (!ptt) return;
    if (!(ptt in keyOf)) keyOf[ptt] = pts.find(ptt) || ('ptt:' + ptt);
    const k = keyOf[ptt];
    const x = idx[k] || (idx[k] = { name: '', first: '', firstSvc: [], firstCat: [], firstStaff: '', last: '', next: '', nextSvc: [],
      days: Object.create(null), n: 0 });
    if (!x.name) x.name = String(r[1] == null ? '' : r[1]).trim();
    const dk = Utilities.formatDate(r[0], ctx.tz, 'yyyy-MM-dd');
    const svc = String(r[9] == null ? '' : r[9]).trim();
    const add = function (list) { if (svc && list.indexOf(svc) === -1 && list.length < 4) list.push(svc); };
    if (r[0].getTime() >= ctx.today) {
      if (!x.next || dk < x.next) { x.next = dk; x.nextSvc = []; }
      if (dk === x.next) add(x.nextSvc);
      return;
    }
    if (!x.days[dk]) { x.days[dk] = true; x.n++; }
    if (!x.first || dk < x.first) { x.first = dk; x.firstSvc = []; x.firstCat = []; x.firstStaff = String(r[8] == null ? '' : r[8]).trim(); }
    if (dk === x.first) {
      add(x.firstSvc);
      const cat = String(r[13] == null ? '' : r[13]).trim();   // N: the PCN category
      if (cat && x.firstCat.indexOf(cat) === -1 && x.firstCat.length < 4) x.firstCat.push(cat);
    }
    if (dk > x.last) x.last = dk;
  });
  return idx;
}

// Name, mobile, email and do-not-contact from their patient record (or just the name, if they're not linked)
function repWho_(pts, key, name) {
  const d = key && key.indexOf('ptt:') !== 0 ? pts.doc(key) : null;
  if (!d) return { id: '', name: String(name || ''), mobile: '', email: '', dnc: false };
  const w = flowWho_(d);
  return { id: key, name: w.name || String(name || ''), mobile: recMobile_(d.Mobile), email: String(d.Email || ''),
    dnc: d['Marketing OK'] === false };
}

// customer_packages: one row per service in a package. Grouped into one row per patient + package.
function repPackages_(ctx, pts, idx) {
  const sh = pcnSheet_(ctx, UP_PKG_TAB_);
  const last = sh.getLastRow();
  const rows = last >= 2 ? sh.getRange(2, 1, last - 1, 13).getValues() : [];
  const num = function (v) {
    const n = typeof v === 'number' ? v : Number(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : 0;
  };
  const groups = Object.create(null);
  rows.forEach(function (r) {
    const left = num(r[7]);                                          // H Remaining
    if (!(left > 0)) return;
    const status = String(r[2] == null ? '' : r[2]).trim();         // C Status
    if (REP_PKG_DONE_.test(status)) return;
    const exp = pcnIsDate_(r[3]) ? Utilities.formatDate(r[3], ctx.tz, 'yyyy-MM-dd') : upDateKey_(String(r[3] == null ? '' : r[3]));
    if (exp && exp < ctx.todayKey) return;                           // expired: can't be used now
    const name = String(r[0] == null ? '' : r[0]).trim();
    const pkg = String(r[1] == null ? '' : r[1]).trim() || 'Package';
    const ptt = String(r[12] == null ? '' : r[12]).trim();          // M Patient ID
    const key = ptt ? (pts.find(ptt) || ('ptt:' + ptt)) : '';
    const g = groups[(key || 'n:' + name.toLowerCase()) + '|' + pkg.toLowerCase() + '|' + exp]
      || (groups[(key || 'n:' + name.toLowerCase()) + '|' + pkg.toLowerCase() + '|' + exp] =
        { key: key, ptt: ptt, name: name, pkg: pkg, status: status, expires: exp, left: 0, value: 0, lines: [] });
    const price = num(r[9]);                                         // J ServicePrice
    g.left += left;
    if (price > 0) g.value += price * left;
    if (g.lines.length < 8) g.lines.push({ svc: String(r[6] == null ? '' : r[6]).trim(), left: left, used: num(r[8]) });
  });
  return Object.keys(groups).map(function (k) {
    const g = groups[k];
    const v = (g.key && idx[g.key]) || {};
    return Object.assign(repWho_(pts, g.key, g.name), {
      ptt: g.ptt, pkg: g.pkg, status: g.status, expires: g.expires, left: g.left, value: Math.round(g.value), lines: g.lines,
      last: v.last || '', next: v.next || '', nextSvc: v.nextSvc || [],
    });
  });
}

// Each patient's most recent Skin Script (portal ones first, then SSP_NEW), expiring between a year ago and 4 months ahead
function repSsp_(cfg, ctx, pts, idx) {
  let months = 12;
  try { const s = fsGetDoc_(cfg, 'form_settings/ssp'); if (s && Number(s.validMonths) > 0) months = Number(s.validMonths); }
  catch (e) { /* 12 months */ }
  const best = Object.create(null);
  const put = function (key, name, date, validUntil, by) {
    if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const cur = best[key];
    if (cur && cur.date >= date) return;                              // keep the newest (a portal one wins a tie)
    const vu = String(validUntil || '').slice(0, 10);
    best[key] = { name: String(name || ''), date: date, by: String(by || ''),
      expires: /^\d{4}-\d{2}-\d{2}$/.test(vu) ? vu : flowAddMonthsKey_(date, months) };
  };
  fsListAll_(cfg, 'ssp_records', ['patientId', 'patientPttId', 'patientName', 'recordDate', 'validUntil', 'createdBy'])
    .forEach(function (d) {
      const f = fromFields_(d.fields || {});
      put(pts.find(f.patientId) || pts.find(f.patientPttId), f.patientName, String(f.recordDate || ''),
        String(f.validUntil || ''), f.createdBy);
    });
  const sh = SpreadsheetApp.openById(SSP_SHEET_ID).getSheetByName(SSP_SHEET_NAME);
  if (sh && sh.getLastRow() >= 2) {
    const tz = sh.getParent().getSpreadsheetTimeZone();
    sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (r) {   // A record · B date · C name · D Patient ID
      const ptt = String(r[3] == null ? '' : r[3]).trim();
      if (ptt) put(pts.find(ptt), String(r[2] == null ? '' : r[2]).trim(), sheetDateKey_(r[1], tz), '', '');
    });
  }
  const lo = flowAddDaysKey_(ctx.todayKey, -365);
  const hi = flowAddDaysKey_(ctx.todayKey, 120);
  return Object.keys(best).filter(function (k) { return best[k].expires >= lo && best[k].expires <= hi; }).map(function (k) {
    const s = best[k];
    const v = idx[k] || {};
    return Object.assign(repWho_(pts, k, s.name), {
      date: s.date, expires: s.expires, by: s.by, last: v.last || '', next: v.next || '', nextSvc: v.nextSvc || [],
    });
  });
}

// One visit day in the last 12 months, and nothing booked
function repNewPts_(ctx, pts, idx) {
  const lo = flowAddDaysKey_(ctx.todayKey, -365);
  return Object.keys(idx).filter(function (k) { const x = idx[k]; return x.n === 1 && !x.next && x.first >= lo; })
    .map(function (k) {
      const x = idx[k];
      return Object.assign(repWho_(pts, k, x.name), { first: x.first, firstSvc: x.firstSvc, firstCat: x.firstCat, firstStaff: x.firstStaff });
    });
}

// What's already been sent to each patient in the last 30 days, newest first:
// Task Manager emails, texts from the patient page, and Recall calls, texts and emails (staff or the Recall flow).
// → { patientKey: { at, how: "email"|"text"|"call", src, what, by, auto } }
function repSent_(cfg, pts) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const out = Object.create(null);
  const add = function (pid, c) {
    const k = pid ? pts.find(String(pid)) : '';
    if (!k || !c.at || c.at < since) return;
    if (!out[k] || c.at > out[k].at) out[k] = c;
  };

  try {   // Task Manager (and Email flows) emails to patients
    fsQuery_(cfg, 'task_runs', 'sentAt', 'GREATER_THAN', since, 5000).forEach(function (r) {
      if (r.category !== 'patient' || !r.patientId || r.taskName === 'Aftercare email') return;
      const auto = r.flow === true;
      add(r.patientId, { at: String(r.sentAt || ''), how: 'email', src: auto ? 'Email flow' : 'Task Manager',
        what: String(r.taskName || r.subject || '').replace(/^Email flow: /, '').slice(0, 80),
        by: auto ? '' : String(r.sentBy || '').replace(/ \(scheduled\)$/, ''), auto: auto });
    });
  } catch (e) { console.warn('Report: task history not read: ' + e); }

  try {   // Texts from the patient page
    fsQuery_(cfg, SMS_COL_, 'at', 'GREATER_THAN', since, 5000).forEach(function (m) {
      add(m.patientId, { at: String(m.at || ''), how: 'text', src: 'Patient page', what: '', by: String(m.by || ''), auto: false });
    });
  } catch (e) { console.warn('Report: texts not read: ' + e); }

  try {   // Recall: what's in each card's history
    fsQuery_(cfg, RECALL_COL_, 'updatedAt', 'GREATER_THAN', since, 5000).forEach(function (c) {
      (Array.isArray(c.log) ? c.log : []).forEach(function (l) {
        if (!l || String(l.at || '') < since) return;
        const w = String(l.what || '');
        let how = '';
        if (l.kind === 'call') how = w === 'Sent a text' ? 'text' : 'call';
        else if (l.kind === 'text') how = 'text';
        else if (l.kind === 'email') how = 'email';
        else if (l.kind === 'flow') how = /^Text sent/.test(w) ? 'text' : /^Email sent/.test(w) ? 'email' : '';
        if (!how) return;
        const auto = !l.byUid;
        add(c.patientId, { at: String(l.at), how: how, src: auto ? 'Recall flow' : 'Recall',
          what: how === 'call' ? w : '', by: auto ? '' : String(l.by || ''), auto: auto });
      });
    });
  } catch (e) { console.warn('Report: recall history not read: ' + e); }

  return out;
}

// Reporting → Retention: every patient's visits from the last 3 years, compact, so the portal can work out any
// date range, clinician, treatment or patient type instantly. Numbers only, no names.
// Each patient: [first visit ever, booked (1/0), then per visit: day, clinician (index, list or -1), treatments (bits), kind]
// Days are counted from 2000-01-01. Cancellations, no-shows and "NO SHOW" services don't count as visits.
function repRetention_(ctx, pts) {
  const DAY0 = Date.UTC(2000, 0, 1);
  const dn = function (dk) { const p = dk.split('-').map(Number); return Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - DAY0) / 864e5); };
  const today = dn(ctx.todayKey);
  const keep = today - 1096;   // about 3 years
  const dict = function () {
    const ix = Object.create(null), list = [];
    return { list: list, of: function (s) { if (!(s in ix)) { ix[s] = list.length; list.push(s); } return ix[s]; } };
  };
  const S = dict(), C = dict(), K = dict();
  const per = Object.create(null);
  const keyOf = Object.create(null);
  pcnReadAppts_(ctx).forEach(function (r) {
    if (!pcnIsDate_(r[0]) || !pcnStatusOk_(r[7], 'full')) return;
    const svc = String(r[9] == null ? '' : r[9]).trim();
    if (REP_NOT_VISIT_.test(svc)) return;
    const ptt = String(r[14] == null ? '' : r[14]).trim();
    if (!ptt) return;
    if (!(ptt in keyOf)) keyOf[ptt] = pts.find(ptt) || ('ptt:' + ptt);
    const p = per[keyOf[ptt]] || (per[keyOf[ptt]] = { d: Object.create(null), future: false });
    if (r[0].getTime() >= ctx.today) { p.future = true; return; }
    const dk = Utilities.formatDate(r[0], ctx.tz, 'yyyy-MM-dd');
    const v = p.d[dk] || (p.d[dk] = { s: [], c: [], v: [] });
    const staff = String(r[8] == null ? '' : r[8]).trim();
    const cat = String(r[13] == null ? '' : r[13]).trim();
    if (staff && !SCHED_NOT_PERSON_.test(staff) && v.s.indexOf(staff) === -1) v.s.push(staff);
    if (cat && v.c.indexOf(cat) === -1) v.c.push(cat);
    if (svc && v.v.length < 6 && v.v.indexOf(svc) === -1) v.v.push(svc);
  });
  const kindOf = function (v) {
    if (v.v.length && v.v.every(function (s) { return /consult|medicare|review/i.test(s); })) return 'Consult only';
    return v.c.filter(function (c) { return !/consult|^other$|^add ons$/i.test(c); })[0] || 'Other treatment';
  };

  let lapsed = 0;
  const out = [];
  Object.keys(per).forEach(function (key) {
    const p = per[key];
    const days = Object.keys(p.d).sort();
    if (!days.length) return;
    const first = dn(days[0]);
    const last = dn(days[days.length - 1]);
    if (days.length >= 3 && last <= today - 180 && last > today - 365 && !p.future) lapsed++;
    if (last < keep) return;   // nothing in the last 3 years
    const row = [first, p.future ? 1 : 0];
    days.forEach(function (dk) {
      const d = dn(dk);
      if (d < keep) return;
      const v = p.d[dk];
      const s = v.s.map(S.of);
      let cm = 0;
      v.c.forEach(function (c) { const i = C.of(c); if (i < 30) cm |= (1 << i); });
      row.push(d, s.length === 1 ? s[0] : s.length ? s : -1, cm, K.of(kindOf(v)));
    });
    out.push(row);
  });
  return { todayN: today, keepN: keep, staff: S.list, cats: C.list, kinds: K.list, pts: out, lapsed: lapsed };
}

// Remembered in parts (one cache value holds 100 KB at most)
function repCacheGet_(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(key) || 0);
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  const got = c.getAll(keys);
  if (!keys.every(function (k) { return got[k]; })) return null;
  try { return JSON.parse(keys.map(function (k) { return got[k]; }).join('')); } catch (e) { return null; }
}
function repCachePut_(key, val) {
  try {
    const json = JSON.stringify(val);
    if (json.length > 6000000) return;
    const parts = {};
    let n = 0;
    for (let i = 0; i < json.length; i += 45000) parts[key + '_' + (n++)] = json.slice(i, i + 45000);
    const c = CacheService.getScriptCache();
    c.putAll(parts, 600);
    c.put(key, String(n), 600);
  } catch (e) { console.warn('Report not remembered: ' + e); }
}

// A Drive file ID, or a photo link (e.g. a Firebase Storage link from a saved scan)
const SCAN_TEST_FILE_ID_ = 'https://firebasestorage.googleapis.com/v0/b/disco-serenity-428708-t8.firebasestorage.app/o/scans%2Fbilling%2F2026-10-24%2FYFsn6NSYpHJ08pZm8A6R.jpg?alt=media&token=21a3fd22-2fdc-4322-8de3-d58b6e6c86b9';

function testScanner() {
  const p = PropertiesService.getScriptProperties();
  const cfg = getConfig_();
  const fast = p.getProperty('CLAUDE_FAST_MODEL') || 'claude-haiku-5-5';
  const main = p.getProperty('CLAUDE_MODEL') || 'claude-sonnet-5-5';

  // 1) The key
  const rawKey = p.getProperty('ClaudeApi') || '';
  if (!rawKey) { console.log('✗ Script Property "ClaudeApi" is missing.'); return; }
  console.log('Key: ' + rawKey.trim().length + ' characters, starts "' + rawKey.trim().slice(0, 7) + '…"' +
    (rawKey !== rawKey.trim() ? '  ⚠ HAS SPACES OR A NEW LINE AT THE START/END: remove them in Script Properties' : ''));
  console.log('Models: sort = ' + fast + ' · read = ' + main);

  // 2) The photo
  const src = scanTestSource_(SCAN_TEST_FILE_ID_);
  if (!src) return;
  const full = src.full;
  const small = src.small || src.full;
  const fullB64 = Utilities.base64Encode(full.getBytes());
  const smallB64 = src.small ? Utilities.base64Encode(small.getBytes()) : fullB64;
  const fullMime = full.getContentType() || 'image/jpeg';
  const smallMime = small.getContentType() || 'image/jpeg';
  console.log('Photo: ' + Math.round(fullB64.length / 1024) + ' KB (base64)' +
    (src.small ? ' · resized ' + Math.round(smallB64.length / 1024) + ' KB' : ' · as saved by the scanner (not resized)'));

  // 3) The product list (sorted by id, so the prompt is the same every time and can be cached)
  const products = fsListAll_(cfg, 'inv_products', ['name', 'brand', 'active'])
    .map(function (d) {
      const f = fromFields_(d.fields || {});
      return { id: d.name.split('/').pop(), name: String(f.name || ''), brand: String(f.brand || ''), active: f.active };
    })
    .filter(function (x) { return x.name && x.active !== false; })
    .sort(function (a, b) { return a.id < b.id ? -1 : 1; });
  console.log('Products: ' + products.length);

  const run = function (label, fn) {
    const t0 = Date.now();
    try {
      const out = fn();
      console.log('✓ ' + label + ': ' + (Date.now() - t0) + ' ms');
      return out;
    } catch (e) {
      console.log('✗ ' + label + ': ' + (Date.now() - t0) + ' ms · ' + ((e && e.message) || e));
      return null;
    }
  };

  // 4) Sort step: Claude fast model
  const sorted = run('Claude sort (' + fast + ')', function () {
    return claudeJson_(SCAN_CLASSIFY_PROMPT_, smallB64, smallMime, SCAN_CLASSIFY_SCHEMA_, fast, 1024);
  });
  if (sorted) console.log('   → ' + JSON.stringify(sorted));
  const kind = sorted && (sorted.kind === 'billing' || sorted.kind === 'docket') ? sorted.kind : 'docket';
  if (!sorted || ['billing', 'docket'].indexOf(sorted.kind) === -1) console.log('   (reading it as a docket)');

  const prompt = kind === 'billing' ? scanBillingPrompt_(products) : scanDocketPrompt_(products);
  const schema = kind === 'billing' ? SCAN_BILLING_SCHEMA_ : SCAN_DOCKET_SCHEMA_;
  const summary = function (r) {
    if (!r) return;
    const lines = kind === 'billing' ? (r.written || []) : (r.lines || []);
    console.log('   → ' + lines.length + ' line(s)' + (kind === 'docket' ? ' · form ' + r.formType + ' · ' + (r.transferType || 'no tick') : '') +
      ' · first: ' + JSON.stringify(lines[0] || {}).slice(0, 250));
  };

  // 5) Read step: Claude main model, twice (the second should use the cached prompt)
  summary(run('Claude read (' + main + ')', function () { return claudeJson_(prompt, smallB64, smallMime, schema, main, 8192); }));
  run('Claude read again (cache)', function () { return claudeJson_(prompt, smallB64, smallMime, schema, main, 8192); });
  if (src.small) {
    if (fullB64.length <= 10 * 1024 * 1024) {
      run('Claude read, full size', function () { return claudeJson_(prompt, fullB64, fullMime, schema, main, 8192); });
    } else {
      console.log('✗ Full-size photo is over 10 MB: Claude would refuse it.');
    }
  }

  // 6) Gemini, for comparison
  summary(run('Gemini read', function () { return geminiJson_(prompt, smallB64, smallMime, schema); }));
}

// { full, small } from a Drive file ID (small = resized to 2000 px) or a photo link (small = null)
// { full, small } from a Drive file ID (small = resized to 2000 px) or a Firebase Storage link (small = null)
function scanTestSource_(ref) {
  ref = String(ref || '').trim();
  try {
    if (/^https:\/\//i.test(ref)) {
      // https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media&token=…
      const m = /\/v0\/b\/([^\/]+)\/o\/([^?#]+)/.exec(ref);
      if (!m) { console.log('✗ That link isn\'t a Firebase Storage link.'); return null; }
      const bucket = m[1];
      const path = decodeURIComponent(m[2]);
      // Read through storage.googleapis.com with the service account (already allowed, like the consultation audio)
      const res = UrlFetchApp.fetch('https://storage.googleapis.com/storage/v1/b/' + encodeURIComponent(bucket) +
        '/o/' + encodeURIComponent(path) + '?alt=media', {
        headers: { Authorization: 'Bearer ' + getAccessToken_(getConfig_()) }, muteHttpExceptions: true,
      });
      if (res.getResponseCode() !== 200) {
        console.log('✗ The photo returned HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
        return null;
      }
      console.log('Photo: ' + path);
      return { full: res.getBlob(), small: null };
    }
    const file = DriveApp.getFileById(ref);
    return { full: file.getBlob(), small: scanTestResize_(file.getId(), 2000) };
  } catch (e) {
    console.log('✗ The photo could not be opened: ' + e);
    return null;
  }
}

// Run from the editor: open recall cards whose patient has an upcoming appointment, and why they're not paused yet
function recallCheckPauses() {
  const cfg = getConfig_();
  const set = recallSettings_(cfg);
  console.log('"Don\'t recall anyone with an appointment booked": ' + (set.anyFuturePauses ? 'ON' : 'OFF. Tick it in Recall settings and Save.'));
  const ctx = pcnCtx_();
  const pts = recallPatients_(cfg);
  const byPid = {};
  const byName = {};
  pcnReadAppts_(ctx).forEach(function (r) {
    if (!pcnIsDate_(r[0]) || r[0].getTime() < ctx.today || !pcnStatusOk_(r[7], 'dns')) return;
    const dk = Utilities.formatDate(r[0], ctx.tz, 'yyyy-MM-dd');
    const ptt = String(r[14] == null ? '' : r[14]).trim();
    const pid = ptt ? pts.find(ptt) : '';
    if (pid) { if (!byPid[pid] || dk < byPid[pid]) byPid[pid] = dk; return; }
    const n = schedNorm_(r[1]);
    if (n && (!byName[n] || dk < byName[n])) byName[n] = dk;
  });
  let willPause = 0, noId = 0;
  fsQuery_(cfg, RECALL_COL_, 'status', 'EQUAL', 'open', 10000).forEach(function (c) {
    if (c.stage === 'later') return;
    const who = c.patientName + ' (' + c.category + (c.assignedToName ? ', with ' + c.assignedToName : '') + ')';
    if (byPid[c.patientId]) {
      willPause++;
      console.log('Has a booking on ' + byPid[c.patientId] + ', not paused yet: ' + who);
    } else if (byName[schedNorm_(c.patientName)]) {
      noId++;
      console.log('Booking on ' + byName[schedNorm_(c.patientName)] + ' has NO Patient ID: ' + who);
    }
  });
  console.log(willPause + ' will pause at the next full check (press "Check for due patients now"). ' +
    noId + " can't be paused: link their name in Daily uploads, then fill in the missing Patient IDs.");
}