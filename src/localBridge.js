/**
 * localBridge.js — Connection bridge to the local server.
 *
 * Two responsibilities:
 *
 *  1. **Base-URL routing.** The server is reachable under two hostnames:
 *     `LAN_BASE` (mDNS, only on home Wi-Fi) and `TS_BASE` (Tailscale, anywhere
 *     on the tailnet). At startup we probe LAN_BASE with a short timeout; if
 *     it answers, the session prefers LAN to keep large uploads / photo loads
 *     off the Tailscale tunnel. On failure we fall back to TS_BASE.
 *     getActiveBase() returns the resolved URL; callers should use it instead
 *     of CONFIG.LOCAL_BASE so a network change automatically reroutes traffic.
 *
 *  2. **Availability + auth helpers.** isLocalAvailable() pings /api/health
 *     (cached 30 s) so UI can show offline banners. authHeaders() returns the
 *     Bearer-token header — the token is the whitelist-issued token from
 *     /api/enroll-self (see auth.js).
 *
 * The probe is rerun on the browser `online` event so a phone moving from
 * cellular onto home Wi-Fi (or vice versa) picks up the better path.
 */

import { CONFIG } from './config.js';
import { getToken, clearToken } from './auth.js';

// Cached availability result. null means "not checked yet".
let _available = null;
// Timestamp (ms) of the last health check.
let _lastCheck = 0;
// How long to trust the cached result before sending a new health check.
const TTL = 30_000; // 30 seconds

// Resolved base URL for the session. null until probeBase() runs at boot.
let _activeBase = null;

/**
 * Returns the Authorization header needed for local server requests.
 * The token is whitelist-issued by /api/enroll-self at first contact.
 * Returns an empty object if no token is stored (e.g., enrollment failed).
 *
 * @returns {{ Authorization: string } | {}}
 */
export function authHeaders() {
  const t = getToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

/**
 * Returns the base URL the rest of the app should use for server calls.
 * Before probeBase() resolves, falls back to TS_BASE — that always works
 * on the tailnet, just adds a tiny encryption hop on home Wi-Fi.
 */
export function getActiveBase() {
  return _activeBase ?? CONFIG.TS_BASE;
}

/**
 * Probes LAN_BASE/health with a short timeout. If anything comes back (even
 * 401 from no-token) the LAN path is reachable and TLS is valid, so we use
 * LAN. Otherwise fall back to Tailscale.
 *
 * Called once at boot (from main.js, before module init) and on every
 * 'online' event. Re-runs are cheap and harmless.
 */
export async function probeBase() {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.HEALTH_TIMEOUT_MS);
  let chose = CONFIG.TS_BASE;
  try {
    const r = await fetch(CONFIG.LAN_BASE + CONFIG.LOCAL_HEALTH_PATH, {
      signal:      ctrl.signal,
      cache:       'no-store',
      credentials: 'omit',
      // No auth header here — we just need to confirm TLS+routing.
      // Any HTTP response (401 included) proves the LAN is reachable.
    });
    // Defensive: even a network-level success without an explicit status
    // counts as reachable. We don't require r.ok.
    if (r) chose = CONFIG.LAN_BASE;
  } catch {
    // Aborted / DNS-fail / TLS-fail / unreachable → stick with TS_BASE.
  } finally {
    clearTimeout(timer);
  }

  const previous = _activeBase;
  _activeBase = chose;

  // If the base actually changed, the cached "available" result is stale.
  if (previous !== chose) invalidateLocal();
}

// Re-probe whenever the device transitions back online (Wi-Fi reconnect,
// cellular handoff, etc). The cost is one health request.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { probeBase(); });
}

/**
 * Checks whether the local server is currently reachable on the active base.
 * Uses a 30-second cache to avoid spamming health checks.
 *
 * @returns {Promise<boolean>}
 */
export async function isLocalAvailable() {
  const now = Date.now();

  // Return cached result if it is still within the TTL window.
  if (_available !== null && now - _lastCheck < TTL) return _available;

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.HEALTH_TIMEOUT_MS);

  try {
    const r = await fetch(getActiveBase() + CONFIG.LOCAL_HEALTH_PATH, {
      signal:      ctrl.signal,
      cache:       'no-store',
      credentials: 'omit',
      headers:     authHeaders(),
    });

    if (r.status === 401) {
      // Token rejected — auth.js's whoami flow will handle re-enrollment.
      // We don't clearToken() here anymore (that was the v31 over-aggressive
      // path); just report the server as unreachable for this caller.
      _available = false;
    } else {
      _available = r.ok;
    }
  } catch {
    _available = false;
  } finally {
    clearTimeout(timer);
    _lastCheck = now;
  }

  return _available;
}

/**
 * Resets the availability cache so the next isLocalAvailable() call sends a
 * fresh health check. Called when a request fails unexpectedly (e.g., server
 * went offline mid-session) or when the active base just changed.
 */
export function invalidateLocal() { _available = null; }
