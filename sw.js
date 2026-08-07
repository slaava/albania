// Service worker for the Albania 2026 trip guide PWA.
// Strategy:
//  - App shell (HTML, icons, maps, CDN CSS/JS/fonts) is precached on install.
//  - OSM tiles for Albania (zoom 8-10) are precached so the route map works offline;
//    deeper zooms and remote images are cached at runtime as the user browses online.
const CACHE = 'albania-v3';
const TILE_CACHE = 'albania-tiles-v1';
const RUNTIME_CACHE = 'albania-runtime-v3';
const TILE_LIMIT = 1200;

const SHELL = [
  './',
  'tisk.html',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'mapa-tisk.png',
  'mapa-ksamil.png',
  'mapa-riviera.png',
  'mapa-vlora.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap'
];

// Albania route bounding box for offline tiles
const TILE_BBOX = { latMin: 39.55, latMax: 41.75, lonMin: 19.15, lonMax: 20.65 };
const TILE_ZOOMS = [8, 9, 10];

function tileRange(zoom) {
  const n = 2 ** zoom;
  const lon2x = lon => Math.floor((lon + 180) / 360 * n);
  const lat2y = lat => {
    const r = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  };
  return {
    xMin: lon2x(TILE_BBOX.lonMin), xMax: lon2x(TILE_BBOX.lonMax),
    yMin: lat2y(TILE_BBOX.latMax), yMax: lat2y(TILE_BBOX.latMin)
  };
}

async function precacheTiles() {
  const cache = await caches.open(TILE_CACHE);
  const urls = [];
  for (const z of TILE_ZOOMS) {
    const { xMin, xMax, yMin, yMax } = tileRange(z);
    for (let x = xMin; x <= xMax; x++)
      for (let y = yMin; y <= yMax; y++)
        urls.push(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`);
  }
  // fetch sequentially in small batches to be polite to OSM servers
  for (let i = 0; i < urls.length; i += 2) {
    await Promise.all(urls.slice(i, i + 2).map(async u => {
      try {
        if (await cache.match(u)) return;
        const res = await fetch(u, { mode: 'no-cors' });
        if (res) await cache.put(u, res);
      } catch (e) { /* offline tile stays missing */ }
    }));
  }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(SHELL.map(async u => {
      try {
        const res = await fetch(u, u.startsWith('http') ? { mode: 'no-cors' } : undefined);
        await cache.put(u, res);
      } catch (e) { /* non-fatal */ }
    }));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = [CACHE, TILE_CACHE, RUNTIME_CACHE];
    for (const key of await caches.keys())
      if (!keep.includes(key)) await caches.delete(key);
    await self.clients.claim();
    // seed offline map tiles in the background after activation
    precacheTiles();
  })());
});

async function trimCache(name, limit) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length > limit)
    for (const key of keys.slice(0, keys.length - limit)) await cache.delete(key);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // OSM tiles: cache-first with runtime fill
  if (url.hostname.endsWith('tile.openstreetmap.org')) {
    event.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        cache.put(req.url, res.clone());
        trimCache(TILE_CACHE, TILE_LIMIT);
        return res;
      } catch (e) {
        return new Response('', { status: 404 });
      }
    })());
    return;
  }

  // Weather API: always network-first so forecasts stay fresh; cache only as offline fallback
  if (url.hostname.endsWith('open-meteo.com')) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      try {
        const res = await fetch(req);
        cache.put(req, res.clone());
        return res;
      } catch (e) {
        return (await cache.match(req)) || Response.error();
      }
    })());
    return;
  }

  // Navigations: network-first (bypassing HTTP cache so updates show immediately),
  // fall back to cached shell when offline
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        const cache = await caches.open(CACHE);
        cache.put(url.pathname.endsWith('tisk.html') ? 'tisk.html' : './', res.clone());
        return res;
      } catch (e) {
        const cache = await caches.open(CACHE);
        return (await cache.match(url.pathname.endsWith('tisk.html') ? 'tisk.html' : './'))
          || Response.error();
      }
    })());
    return;
  }

  // Everything else (fonts, CDN, images): cache-first, fill runtime cache
  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, res.clone());
      trimCache(RUNTIME_CACHE, 400);
      return res;
    } catch (e) {
      return Response.error();
    }
  })());
});
