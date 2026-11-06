// Shares identical reads while one patient page is open, so several sections asking for the same
// records only fetch them once. Every other page reads fresh, as before.
const TTL = 60_000;           // a read is reused for up to a minute
let store = null;             // Map while a patient page is open; null = no caching
let current = 0;              // which page owns the cache

// Starts a fresh cache for a page. Keep the token to stop it later.
export function startPageCache() {
  store = new Map();
  return ++current;
}

// Stops the cache, but only if that page still owns it (the next patient may already have started its own)
export function stopPageCache(token) {
  if (token === current) store = null;
}

// Throws away everything read so far (Refresh, or after something was changed)
export function clearPageCache() {
  if (store) store.clear();
}

// Each caller gets its own copy, so one section changing its result can't affect another
const copy = (v) => {
  try { return structuredClone(v); } catch { return v; }
};

export function cachedRead(key, fn) {
  if (!store) return fn();
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.p.then(copy);
  const p = Promise.resolve().then(fn);
  const map = store;
  map.set(key, { p, at: Date.now() });
  p.catch(() => { if (map.get(key) && map.get(key).p === p) map.delete(key); });   // failed reads aren't kept
  return p.then(copy);
}