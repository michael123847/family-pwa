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

// Persisted across page loads — last base URL that successfully answered the
// health probe. On cold boot, getActiveBase() returns this BEFORE probeBase()
// completes, so isLocalAvailable() and the modules start with a sensible
// guess instead of falling through to TS_BASE every time.
const ACTIVE_BASE_KEY = 'pwa.activeBase';
let _activeBase = (() => {
  try { return localStorage.getItem(ACTIVE_BASE_KEY); } catch { return null; }
})();

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
 * Probes all candidate base URLs IN PARALLEL and uses whichever responds
 * first:
 *   - LAN_BASE     (server.local, mDNS)
 *   - LAN_IP_BASE  (192.168.1.x, bypass mDNS)
 *   - TS_BASE      (server.<tailnet>.ts.net)
 *
 * Sequential probing wasted up to 3 s on phones that aren't on the home
 * LAN — the two unreachable candidates each had to time out before
 * Tailscale got a chance. Racing them with Promise.any() collapses the
 * total wait to roughly the fastest candidate's response time
 * (typically ~300-700 ms on cellular Tailscale, near-zero on LAN).
 *
 * Any HTTP response (including 401) counts as success — we just need to
 * prove TLS + routing work. Console logs each attempt as "[probeBase]"
 * so unreachable paths are visible in DevTools.
 *
 * Persists the winning base in localStorage as a hint for faster future
 * isLocalAvailable() decisions on cold start (before this probe completes).
 */
export async function probeBase() {
  const candidates = [CONFIG.LAN_BASE, CONFIG.LAN_IP_BASE, CONFIG.TS_BASE];
  const timeout    = CONFIG.HEALTH_TIMEOUT_MS;

  // Each racer resolves with its base URL on success, rejects on failure.
  const racers = candidates.map(async base => {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(base + CONFIG.LOCAL_HEALTH_PATH, {
        signal:      ctrl.signal,
        cache:       'no-store',
        credentials: 'omit',
      });
      console.log(`[probeBase] ${base} → HTTP ${r.status}`);
      return base;
    } catch (e) {
      console.log(`[probeBase] ${base} → failed: ${e?.message || e}`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });

  let chose;
  try {
    chose = await Promise.any(racers); // first success wins
  } catch {
    chose = CONFIG.TS_BASE; // all candidates failed — last-resort default
  }

  const previous = _activeBase;
  _activeBase = chose;
  console.log(`[probeBase] active base = ${chose}`);
  try { localStorage.setItem(ACTIVE_BASE_KEY, chose); } catch {}
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
