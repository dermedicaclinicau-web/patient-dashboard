// Reloads the portal with the newest copy of every script and stylesheet it has loaded.
// GitHub Pages lets browsers keep files for 10 minutes; this refreshes them straight away.
export async function freshReload() {
  const urls = new Set([location.href.split("#")[0]]);   // the page itself
  performance.getEntriesByType("resource").forEach((e) => {
    try {
      const u = new URL(e.name);
      if (u.origin === location.origin && /\.(js|css)$/i.test(u.pathname)) urls.add(u.href);
    } catch { /* not a normal address */ }
  });
  // Fetch each one past the cache (this replaces the cached copy), but never wait more than 8 seconds
  await Promise.race([
    Promise.allSettled([...urls].map((u) => fetch(u, { cache: "reload", credentials: "same-origin" }))),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  location.reload();
}