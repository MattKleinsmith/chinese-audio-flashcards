// sw.js — service worker for offline use (PLAN §5.9).
// - install: precache the app shell + data/*.json, then skipWaiting
// - activate: drop old shell caches, clients.claim
// - data/*.json: network-first, cache fallback (so bundle updates arrive when online)
// - clips/**: cache-first in "clips-v1" (clips are immutable; ids are content-derived). Range
//   requests (Safari <audio>) are answered with 206 slices of the cached full response.
// - everything else same-origin: cache-first for a deployed build; network-first when running
//   an un-stamped dev build so local edits show up without cache busting.
// SHELL_VERSION is replaced with the short git SHA by .github/workflows/pages.yml.

const SHELL_VERSION = '__BUILD_SHA__';
const SHELL_CACHE = `shell-${SHELL_VERSION}`;
const DATA_CACHE = 'data-v1';
const CLIP_CACHE = 'clips-v1';
const DEV = SHELL_VERSION.startsWith('__');

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/db.js',
  './js/data.js',
  './js/state.js',
  './js/importer.js',
  './js/scheduler.js',
  './js/queue.js',
  './js/audio.js',
  './js/pinyin.js',
  './js/util.js',
  './js/screens/home.js',
  './js/screens/study.js',
  './js/screens/import.js',
  './js/screens/vocab.js',
  './js/screens/settings.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];
const DATA = ['./data/manifest.json', './data/words.json', './data/sentences.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // Add individually so one missing file does not abort the whole install.
    await Promise.allSettled(SHELL.map((u) => shell.add(new Request(u, { cache: 'reload' }))));
    const data = await caches.open(DATA_CACHE);
    await Promise.allSettled(DATA.map((u) => data.add(new Request(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/** Serve a (possibly ranged) request from a full cached response. */
async function fromFull(request, response) {
  const range = request.headers.get('range');
  if (!range || !response) return response;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) return response;
  const buf = await response.arrayBuffer();
  const size = buf.byteLength;
  let start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buf.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'audio/mpeg',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    },
  });
}

async function clipCacheFirst(request) {
  const cache = await caches.open(CLIP_CACHE);
  const key = request.url;
  let full = await cache.match(key);
  if (!full) {
    // Fetch the full file (no Range header) so the cached copy is complete. If that fails
    // (offline, or a cross-origin host without CORS) pass the original request through.
    let res;
    try { res = await fetch(key, { credentials: 'omit' }); } catch { return fetch(request); }
    if (res.status !== 200) return res;
    await cache.put(key, res.clone()).catch(() => {});
    full = res;
  }
  return fromFull(request, full.clone());
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function shellCacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && request.method === 'GET') await cache.put(request, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // Clips may live on another host via manifest.baseUrl; match by path.
  if (/\/clips\/.+\.(mp3|m4a|ogg|opus|wav)$/i.test(url.pathname)) {
    event.respondWith(clipCacheFirst(request));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (/\/data\/[^/]+\.json$/.test(url.pathname)) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }
  if (request.mode === 'navigate') {
    event.respondWith(DEV ? networkFirst(request, SHELL_CACHE) : shellCacheFirst(new Request('./index.html')).catch(() => fetch(request)));
    return;
  }
  event.respondWith(DEV ? networkFirst(request, SHELL_CACHE) : shellCacheFirst(request));
});
