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
  APP_VERSION: 'v1.0.35',

  // ── Local server — two reachable hostnames ─────────────────────────
  // The server is served by Caddy on the same port under two names:
  //   LAN_BASE — mDNS hostname, only reachable on the home Wi-Fi
  //   TS_BASE  — Tailscale MagicDNS name, reachable from anywhere on the
  //              tailnet (and direct-LAN-routed when the device is at home)
  // At startup, localBridge probes LAN_BASE with a short timeout. If the
  // probe succeeds the session uses LAN_BASE; otherwise it falls back to
  // TS_BASE. See src/localBridge.js -> probeBase() and getActiveBase().
  LAN_BASE:          'https://server.local:8443',
  // Direct LAN IP — used as a fallback when mDNS resolution of server.local
  // doesn't make it across (some phones cache stale Bonjour entries).
  // Update this if your router ever reassigns the server's address.
  LAN_IP_BASE:       'https://192.168.1.5:8443',
  TS_BASE:           'https://server.tail2636e9.ts.net:8443',
  // Kept as a fallback / convenience: any code that imports CONFIG.LOCAL_BASE
  // without going through getActiveBase() will at least pick the Tailscale
  // hostname, which works everywhere on the tailnet.
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
