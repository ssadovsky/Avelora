// Avelora service worker (loaded by the root /sw.js via importScripts — see there).
//
// Caching model:
//  * shell (ASSETS_TO_CACHE, small) — pre-cached on install; bump CACHE_NAME when this list changes.
//  * everything else (scripts, assets_data.js ~61 MB, content_data.js, ...) is cached at runtime on first
//    use under its EXACT url, including the ?v=... query string from Avelora.html. A new ?v= therefore
//    means a new download, and the old copy of the same file is deleted. => adding a new script needs
//    nothing here: just reference it in Avelora.html with a ?v=.
//  * Avelora.html itself (and navigations) is network-first so a new release is picked up on the next
//    start; offline it falls back to the cached copy.
const CACHE_NAME = 'avelora-v27';          // shell cache
const RUNTIME_CACHE = 'avelora-runtime-v1'; // scripts / assets, keyed by exact url
const ASSETS_TO_CACHE = [
  './',
  'Avelora.html',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'js/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // one by one: a single failed file must not leave the whole cache empty (addAll is all-or-nothing)
      Promise.all(ASSETS_TO_CACHE.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => (k !== CACHE_NAME && k !== RUNTIME_CACHE) ? caches.delete(k) : null))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // The page: network first, cached copy when offline
  if (req.mode === 'navigate' || url.pathname.endsWith('/Avelora.html')) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put('Avelora.html', copy)); }
        return res;
      }).catch(() => caches.match('Avelora.html').then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // Everything else: cache first (exact url), otherwise download and remember
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(RUNTIME_CACHE).then(async (c) => {
          await c.put(req, copy);
          const keys = await c.keys();   // drop older ?v= copies of the same file
          await Promise.all(keys.filter((k) => { const u = new URL(k.url); return u.pathname === url.pathname && u.search !== url.search; }).map((k) => c.delete(k)));
        }).catch(() => {});
      }
      return res;
    }))
  );
});
