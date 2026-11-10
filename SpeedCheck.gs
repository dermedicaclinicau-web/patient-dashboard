function speedCheck() {
  const t = function (label, fn) {
    const s = Date.now();
    let r, err = '';
    try { r = fn(); } catch (e) { err = '  ✗ ' + e.message; }
    console.log(String(Date.now() - s).padStart(6) + ' ms  ' + label + err);
    return r;
  };
  const c = CacheService.getScriptCache();
  t('Script Properties (sessionKey_)', function () { return sessionKey_(); });
  t('getConfig_', function () { return getConfig_(); });
  t('Access token', function () { return getAccessToken_(getConfig_()); });

  const before = c.get('staff_docs_v1');
  console.log('Staff cache before: ' + (before ? 'cached' : 'EMPTY'));
  const docs = t('getStaffDocs_ (1st)', getStaffDocs_);
  const size = Math.round(JSON.stringify(docs || []).length / 1024);
  console.log('Staff list is ' + size + ' KB' + (size >= 100 ? '  ✗ TOO BIG TO CACHE: every request reads Firestore' : ' (fits in the cache)'));
  t('getStaffDocs_ (2nd, should be fast)', getStaffDocs_);
  t('rolesData_', rolesData_);

  const tok = createSession_((docs || [])[0] || { id: 'test' });
  t('getSession_ (the full login check)', function () { return getSession_(tok); });
  t('handleStaffList_ (the whole ping, inside Apps Script)', function () { return handleStaffList_({ session: tok }); });
  t('One Firestore read', function () { return fsGetDoc_(getConfig_(), 'staff_roles/config'); });
}