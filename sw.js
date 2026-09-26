const CACHE_NAME = 'avelora-v3'; // bump when the file list changes
const ASSETS_TO_CACHE = [
  './',
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'lib_js/three.min.js',
  'lib_js/GLTFLoader.js',
  'lib_js/Water.js',
  'lib_js/simplex-noise.js',
  'content_data.js',
  'world_data.js',
  'location_groups.js',
  'pathfinding.js',
  'terrain.js',
  'water.js',
  'environment.js',
  'characters.js',
  'save.js',
  'items.js',
  'game_state.js',
  'world_objects.js',
  'skills.js',
  'ui_hotbar.js',
  'creatures.js',
  'harvest.js',
  'combat.js',
  'character.js',
  'main.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((k) => {
          if (k !== CACHE_NAME) return caches.delete(k);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    }).catch(() => caches.match('index.html'))
  );
});
