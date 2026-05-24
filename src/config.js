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
  APP_VERSION: 'v31',

  // ── Local WLAN server ──────────────────────────────────────────────
  // The Express API runs behind Caddy (TLS) on the home network.
  // Only reachable when the device is connected to the home WiFi.
  // ▼ THE SWITCH ▼ — change this single line back to 'https://server.local:8443'
  // and bump APP_VERSION (and sw.js VERSION) to roll back to LAN-only mode.
  // The cert and Caddyfile keep both names, so flipping this is the only
  // step needed in either direction.
  LOCAL_BASE:        'https://server.tail2636e9.ts.net:8443',
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
