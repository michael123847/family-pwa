/**
 * localBridge.js — Connection bridge to the local WLAN server.
 *
 * The local server (Caddy + Express) is only reachable on the home network.
 * This module provides two things:
 *
 *  1. isLocalAvailable() — checks whether the server is up by calling the
 *     /api/health endpoint. The result is cached for 30 seconds to avoid
 *     sending a request before every single API call.
 *
 *  2. authHeaders() — returns the Authorization header object that must be
 *     attached to every request to the local server.
 *
 * If the health check returns HTTP 401 (wrong token), the stored token is
 * deleted and the user will be prompted for the passphrase on next reload.
 */

import { CONFIG } from './config.js';
import { getToken, clearToken } from './auth.js';

// Cached availability result. null means "not checked yet".
let _available = null;

// Timestamp (ms) of the last health check.
let _lastCheck = 0;

// How long to trust the cached result before sending a new health check.
const TTL = 30_000; // 30 seconds

/**
 * Returns the Authorization header needed for local server requests.
 * The token is the PBKDF2 hash of the user's passphrase (see auth.js).
 * Returns an empty object if no token is stored (user not authenticated).
 *
 * @returns {{ Authorization: string } | {}}
 */
export function authHeaders() {
  const t = getToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

/**
 * Checks whether the local WLAN server is currently reachable.
 * Uses a 30-second cache to avoid sending a health check before every API call.
 *
 * Returns false immediately if:
 *  - The server does not respond within HEALTH_TIMEOUT_MS (1.5 s).
 *  - The server returns HTTP 401 (token invalid — also clears the token).
 *  - The network request fails for any reason (e.g. not on home WiFi).
 *
 * @returns {Promise<boolean>}
 */
export async function isLocalAvailable() {
  const now = Date.now();

  // Return cached result if it is still within the TTL window.
  if (_available !== null && now - _lastCheck < TTL) return _available;

  // AbortController lets us cancel the fetch after a timeout.
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.HEALTH_TIMEOUT_MS);

  try {
    const r = await fetch(CONFIG.LOCAL_BASE + CONFIG.LOCAL_HEALTH_PATH, {
      signal:      ctrl.signal,
      cache:       'no-store',   // always ask the server, never use browser cache
      credentials: 'omit',      // do not send cookies
      headers:     authHeaders(),
    });

    if (r.status === 401) {
      // Token is wrong or expired — force re-authentication.
      clearToken();
      _available = false;
    } else {
      _available = r.ok; // true for HTTP 200, false for any other status
    }
  } catch {
    // Network error, timeout, or CORS failure — server is not reachable.
    _available = false;
  } finally {
    clearTimeout(timer);
    _lastCheck = now;
  }

  return _available;
}

/**
 * Resets the availability cache so the next call to isLocalAvailable()
 * sends a fresh health check instead of returning the cached value.
 * Called when a request fails unexpectedly (e.g. server went offline mid-session).
 */
export function invalidateLocal() { _available = null; }
