// Reloads the portal with the newest copy of every script and stylesheet it has loaded.
// extra: more files to refresh (e.g. the list from version.json)
// jitterMs: wait a random time first, so every computer in the clinic doesn't hit GitHub at once
export async function freshReload(extra = [], { jitterMs = 0 } = {}) {
  if (jitterMs > 0) await new Promise((r) => setTimeout(r, Math.random() * jitterMs));

  const urls = new Set([location.href.split("#")[0]]);   // the page itself
  (Array.isArray(extra) ? extra : []).forEach((f) => {
    try { const u = new URL(f, location.href); if (u.origin === location.origin) urls.add(u.href); } catch {}
  });
  performance.getEntriesByType("resource").forEach((e) => {
    try {
      const u = new URL(e.name);
      if (u.origin === location.origin && /\.(js|css)$/i.test(u.pathname)) urls.add(u.href);
    } catch { /* not a normal address */ }
  });

  // 6 at a time instead of all at once, and never wait more than 15 seconds
  const list = [...urls];
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const u = list[i++];
      try { await fetch(u, { cache: "reload", credentials: "same-origin" }); } catch {}
    }
  };
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(6, list.length) }, worker)),
    new Promise((r) => setTimeout(r, 15000)),
  ]);
  location.reload();
}