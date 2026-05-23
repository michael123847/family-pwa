/**
 * sw.js — Service Worker for offline support.
 *
 * A Service Worker is a script that runs in the background, separate from
 * the browser tab. It intercepts all network requests made by the app and
 * can serve responses from a local cache, making the app work offline.
 *
 * This Service Worker uses two caches:
 *
 *  APP_SHELL cache ("shell-vN"):
 *    Contains all static files that make up the app itself (HTML, CSS, JS).
 *    Strategy: cache-first — always serve from cache, fall back to network.
 *    These files rarely change, and when they do the VERSION string is bumped
 *    which triggers a fresh install of the new shell.
 *
 *  RUNTIME cache ("runtime-vN"):
 *    Contains responses from the two public APIs (open-meteo, transport.opendata.ch).
 *    Strategy: network-first with 4-second timeout — try the network, fall back
 *    to cached data if the network is slow or offline.
 *
 * Local server requests (192.168.1.187, *.local) are NEVER intercepted.
 * They need the Authorization header attached by the app and must always
 * return fresh data — caching them here would break authentication and
 * show stale todos or images.
 *
 * Updating the Service Worker:
 *  Bump VERSION to force all clients to install the new worker and clear
 *  old caches. The activate event deletes any cache that is not in the
 *  current version's set.
 */

// Bump on every deploy. Keep in sync with CONFIG.APP_VERSION in src/config.js
// (the Info subapp compares the two to flag a pending update).
const VERSION   = 'v27';
const APP_SHELL = 'shell-'   + VERSION; // cache name for static app files
const RUNTIME   = 'runtime-' + VERSION; // cache name for API responses

// Version-independent cache owned by background.js (the family photo).
// It must survive Service Worker updates, so it is excluded from cleanup.
const FAMILY_BG = 'family-bg-v1';

// All static files that must be cached during installation.
// If any file fails to download, the installation is aborted.
const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './manifest.webmanifest',
  './src/main.js',
  './src/app.js',
  './src/config.js',
  './src/auth.js',
  './src/localBridge.js',
  './src/siteConfig.js',
  './src/modules/weather.js',
  './src/modules/transit.js',
  './src/modules/todo.js',
  './src/modules/background.js',
  './src/modules/swatch.js',
  './src/modules/photos.js',
  './src/modules/hauschat.js',
  './src/modules/info.js',
  './src/modules/audiotest.js',
  './src/modules/ai.js',
  './src/ultrasound.js',
  './src/ultrasoundChannel.js',
];

// Optional assets — cached if present, but their absence does NOT abort the
// install. The vendored ggwave library lives here (a single self-contained
// file — the WASM is embedded). Until it is added (see vendor/ggwave/README.md)
// ultrasound messaging stays disabled.
const OPTIONAL_ASSETS = [
  './vendor/ggwave/ggwave.js',
];

/**
 * Install event — runs once when the Service Worker is first registered or
 * when VERSION changes. Caches all shell assets (mandatory) and then the
 * optional assets (best-effort — a missing one is ignored).
 * skipWaiting() makes the new worker take over immediately.
 */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(APP_SHELL);
    await cache.addAll(SHELL_ASSETS);
    await Promise.allSettled(OPTIONAL_ASSETS.map(a => cache.add(a)));
    await self.skipWaiting();
  })());
});

/**
 * Activate event — runs after the new Service Worker takes over.
 * Deletes old version caches, but keeps the current shell, runtime and the
 * family photo cache. clients.claim() makes the worker control open tabs.
 */
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [APP_SHELL, RUNTIME, FAMILY_BG];
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))
    );
    self.clients.claim();
  })());
});

/**
 * Fetch event — intercepts every network request made by the app.
 * Routes each request to the appropriate caching strategy.
 */
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // ── Local server ─────────────────────────────────────────────────────
  // Never intercept — these requests need auth headers and fresh data.
  // Returning without calling e.respondWith() lets the browser handle them.
  if (url.hostname === '192.168.1.187' || url.hostname.endsWith('.local')) {
    return;
  }

  // ── App shell ─────────────────────────────────────────────────────────
  // Requests to the same origin as the app (GitHub Pages) = static files.
  // Serve from cache; on a cache miss fetch from network AND store the result,
  // so assets added after install (e.g. the ggwave files) become available
  // offline once they have been loaded once.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(resp => {
        if (resp.ok) {
          const copy = resp.clone();
          caches.open(APP_SHELL).then(c => c.put(e.request, copy));
        }
        return resp;
      }))
    );
    return;
  }

  // ── Public APIs ───────────────────────────────────────────────────────
  // open-meteo and transport.opendata.ch — network-first, cache as fallback.
  e.respondWith(networkFirst(e.request, RUNTIME, 4000));
});

/**
 * Network-first strategy with timeout.
 * Tries to fetch from the network within timeoutMs milliseconds.
 * If the request succeeds, caches the response for offline use.
 * If it fails (offline or timeout), returns the last cached response.
 * If nothing is cached either, returns a synthetic 503 response.
 *
 * @param {Request} req         - The original request.
 * @param {string}  cacheName   - Which cache bucket to use.
 * @param {number}  timeoutMs   - How long to wait before giving up on the network.
 * @returns {Promise<Response>}
 */
async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    // AbortController lets us cancel the fetch after the timeout expires.
    const ctrl = new AbortController();
    const t    = setTimeout(() => ctrl.abort(), timeoutMs);
    const r    = await fetch(req, { signal: ctrl.signal });
    clearTimeout(t);
    // Only cache successful responses — don't cache error pages.
    if (r.ok) cache.put(req, r.clone());
    return r;
  } catch {
    // Network failed or timed out — try the cache.
    const cached = await cache.match(req);
    return cached || new Response('offline', { status: 503 });
  }
}
