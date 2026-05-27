/**
 * localBridge.js — Connection bridge to the local server.
 *
 * Two responsibilities:
 *
 *  1. **Base-URL routing.** The server is reachable under three hostnames,
 *     but only one is hard-coded in the public bundle:
 *       - `CONFIG.LAN_BASE` (server.local, mDNS) — always known.
 *       - `bases.lan_ip` (direct LAN IP) and `bases.ts` (Tailscale MagicDNS)
 *         are fetched from /api/config on first contact and cached in
 *         localStorage; see siteConfig.js.
 *     probeBase() races whichever candidates are currently available; the
 *     first to answer wins, and the choice is persisted across reloads so
 *     a cold start doesn't have to race again. On failure we fall back to
 *     the cached Tailscale URL (works off the home network) or LAN_BASE.
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
// guess instead of falling through to the cached Tailscale URL every time.
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
 * Before probeBase() resolves: prefer the persisted active base from the
 * previous session, else the cached Tailscale URL (works off-LAN), else
 * LAN_BASE as a last resort.
 */
export function getActiveBase() {
  if (_activeBase) return _activeBase;
  const bases = readCachedBases();
  return bases.ts || CONFIG.LAN_BASE;
}

// Same localStorage key siteConfig.js writes to. Kept inline here (rather
// than imported) to avoid the localBridge ↔ siteConfig circular dependency
// — both modules just read this one key.
const BASES_KEY = 'pwa.bases';
function readCachedBases() {
  try { return JSON.parse(localStorage.getItem(BASES_KEY)) || {}; }
  catch { return {}; }
}

/**
 * Probes all candidate base URLs IN PARALLEL and uses whichever responds
 * first:
 *   - LAN_BASE                       (server.local, mDNS)
 *   - bases.lan_ip from /api/config  (cached LAN IP, bypasses mDNS)
 *   - bases.ts     from /api/config  (Tailscale MagicDNS hostname)
 *
 * Only LAN_BASE is hard-coded; the other two are cached in localStorage
 * after the first successful /api/config fetch (see siteConfig.js). On a
 * brand-new install with no cached bases, probeBase() races LAN_BASE alone
 * — which works on any device that does mDNS on the home Wi-Fi.
 *
 * Sequential probing used to waste up to 3 s on phones that aren't on the
 * home LAN — the unreachable candidates each had to time out before
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
  const bases = readCachedBases();
  const candidates = [CONFIG.LAN_BASE, bases.lan_ip, bases.ts].filter(Boolean);
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
    // All candidates failed. Prefer the cached Tailscale URL if we have one
    // (works off the home network); otherwise fall back to LAN_BASE — the
    // PWA will run in degraded / public-API-only mode until mDNS reaches
    // the server again.
    chose = bases.ts || CONFIG.LAN_BASE;
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
