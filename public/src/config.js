/**
 * config.js — Central configuration for the Family PWA.
 *
 * All URLs, coordinates, and authentication parameters are defined here so
 * that changing a value in one place affects the entire app.
 *
 * Security note about server URLs:
 *   Only LAN_BASE (the generic mDNS hostname server.local) is hard-coded
 *   here. The direct LAN IP and the Tailscale MagicDNS name are NOT shipped
 *   in the public GitHub Pages bundle — they would identify the home
 *   network's IP / tailnet name to anyone reading the JS. Instead, the PWA
 *   fetches them at runtime from the local server's /api/config endpoint
 *   (gated by the whitelist token) and caches them in localStorage. See
 *   src/siteConfig.js and src/localBridge.js -> probeBase().
 *
 *   Bootstrap path for a fresh install: device must be on the home Wi-Fi
 *   so mDNS resolves server.local; after one successful connection the
 *   bases are cached and subsequent cold starts work without mDNS.
 */

export const CONFIG = {

  // ── App version ────────────────────────────────────────────────────
  // Shown in the Info subapp so it is easy to verify which build a device
  // is really running. Bump this together with VERSION in sw.js on every
  // deploy — they should always match.
  APP_VERSION: 'v1.0.53',

  // ── Local server — only the generic mDNS hostname is public ────────
  // LAN_BASE  — mDNS hostname, works on the home Wi-Fi on devices that
  //             do mDNS resolution (most do).
  // The cached direct-LAN-IP base and the Tailscale base are loaded from
  // /api/config -> bases on first successful connection; see siteConfig.js
  // (getCachedBases) and localBridge.js (probeBase).
  LAN_BASE:          'https://server.local:8443',
  // Fallback used when no cached bases are available yet. We pick LAN_BASE
  // because that's the only base the public bundle knows; if mDNS fails on
  // a fresh install the PWA degrades to public-only features (Wetter /
  // Abfahrten / Farben) until it can reach the server once.
  LOCAL_BASE:        'https://server.local:8443',
  LOCAL_HEALTH_PATH: '/api/health',   // simple ping endpoint to check availability
  LOCAL_TODO_PATH:   '/api/todos',    // CRUD endpoint for the shopping/todo list
  LOCAL_PHOTOS_PATH: '/api/photos',   // upload / list / download endpoint for the photo gallery
  LOCAL_SHARE_PATH:  '/api/share',    // general-purpose file storage (any type, ≤ 10 MB)
  LOCAL_CHAT_PATH:   '/api/chat',     // Hauschat: device registry + message relay
  LOCAL_CONFIG_PATH: '/api/config',   // weather location + transit stops (kept off the public repo)
  LOCAL_BG_PATH:     '/assets/family-bg.jpg', // family photo served by the local server
  LOCAL_AI_PATH:     '/api/ai/chat',  // streaming AI chat proxy → Ollama
  LOCAL_AI_MODELS_PATH: '/api/ai/models', // list of installed Ollama models
  HEALTH_TIMEOUT_MS: 1500,            // abort the health check after 1.5 s to avoid long waits

  // ── Weather — open-meteo.com ───────────────────────────────────────
  // Free, CORS-enabled API — no API key or proxy required.
  // The location coordinates are NOT stored here — they would reveal where
  // the family lives. They come from the local server's /api/config and are
  // cached on the device (see siteConfig.js).
  METEO_BASE: 'https://api.open-meteo.com/v1',

  // ── Public transport — transport.opendata.ch ───────────────────────
  // Free, CORS-enabled API — no API key or proxy required.
  // The list of stops also comes from /api/config — not from this public repo.
  ZVV_BASE: 'https://transport.opendata.ch/v1',

  // ── Authentication ─────────────────────────────────────────────────
  // No shared secret. Each device is auto-enrolled as "Visitor" on first
  // contact (POST /api/enroll-self) and gets a long random Bearer token
  // stored in localStorage under 'pwa.auth.token'. Admin promotes the
  // device to a higher role via tools/admin.html on the server.
  // See src/auth.js for the enrollment + role-tracking logic.
};
