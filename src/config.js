/**
 * config.js — Central configuration for the Family PWA.
 *
 * All URLs, coordinates, and authentication parameters are defined here so
 * that changing a value in one place affects the entire app.
 *
 * Security note: SALT and EXPECTED_HASH_B64 are intentionally stored in
 * plain text. The security of the password gate comes from the high PBKDF2
 * iteration count (200 000), which makes brute-force attacks very slow, not
 * from keeping the hash secret.
 */

export const CONFIG = {

  // ── App version ────────────────────────────────────────────────────
  // Shown in the Info subapp so it is easy to verify which build a device
  // is really running. Bump this together with VERSION in sw.js on every
  // deploy — they should always match.
  APP_VERSION: 'v23',

  // ── Local WLAN server ──────────────────────────────────────────────
  // The Express API runs behind Caddy (TLS) on the home network.
  // Only reachable when the device is connected to the home WiFi.
  LOCAL_BASE:        'https://server.local:8443',
  LOCAL_HEALTH_PATH: '/api/health',   // simple ping endpoint to check availability
  LOCAL_TODO_PATH:   '/api/todos',    // CRUD endpoint for the shopping/todo list
  LOCAL_PHOTOS_PATH: '/api/photos',   // upload / list / download endpoint for the photo gallery
  LOCAL_CHAT_PATH:   '/api/chat',     // Hauschat: device registry + message relay
  LOCAL_CONFIG_PATH: '/api/config',   // weather location + transit stops (kept off the public repo)
  LOCAL_BG_PATH:     '/assets/family-bg.jpg', // family photo served by the local server
  LOCAL_AI_PATH:     '/api/ai/chat',  // streaming AI chat proxy → Ollama
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
  // The password is never stored. Instead, PBKDF2 derives a hash from the
  // passphrase. That hash is compared to EXPECTED_HASH_B64. If they match,
  // the hash itself is used as the Bearer token for all local API calls.
  AUTH: {
    SALT:              'family-pwa-2026', // makes the hash unique to this app
    ITERATIONS:        200_000,           // high cost = slow brute-force
    HASH_BITS:         256,               // output size in bits (= 32 bytes)
    EXPECTED_HASH_B64: 'zbpB97WcaJM7Ta2TUSsFV2IDu5Bcsw5DUh0XV/3PrjU=',
  },
};
