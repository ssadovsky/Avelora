const CACHE_NAME = 'avelora-v5'; // bump when the file list changes
const ASSETS_TO_CACHE = [
  './',
  'Avelora.html',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-512-maskable.png',
  'js/manifest.json',
  'js/lib/three.min.js',
  'js/lib/GLTFLoader.js',
  'js/lib/Water.js',
  'js/lib/simplex-noise.js',
  'js/assets_data.js',
  'js/content_data.js',
  'js/world_data.js',
  'js/location_groups.js',
  'js/pathfinding.js',
  'js/terrain.js',
  'js/water.js',
  'js/waterfall.js',
  'js/environment.js',
  'js/characters.js',
  'js/save.js',
  'js/items.js',
  'js/game_state.js',
  'js/world_objects.js',
  'js/skills.js',
  'js/ui_hotbar.js',
  'js/creatures.js',
  'js/harvest.js',
  'js/combat.js',
  'js/character.js',
  'js/map.js',
  'js/main.js'
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
    }).catch(() => caches.match('Avelora.html'))
  );
});
