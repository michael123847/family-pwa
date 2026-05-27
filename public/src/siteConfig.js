/**
 * siteConfig.js — Location-dependent + network configuration from the local
 * server.
 *
 * The weather coordinates and the transit stop list reveal where the family
 * lives, and the bases (LAN IP, Tailscale hostname) reveal home-network
 * identifiers, so neither is stored in this public frontend repository.
 * Instead the local server serves them at /api/config, and this module
 * fetches that once the device is on the home network and caches it in
 * localStorage.
 *
 * After the first successful fetch:
 *   - weather and departures keep working everywhere (the open-meteo and
 *     transport.opendata.ch APIs are public).
 *   - the LAN IP and Tailscale URL are remembered, so off-mDNS cold starts
 *     can race them in probeBase() without re-discovery.
 *
 * Shape of the config:
 *   { weather: { label, lat, lon },
 *     stops:   [ { label, name, limit, nextStop? }, ... ],
 *     bases:   { lan_ip, ts } }
 */

import { CONFIG } from './config.js';
import { isLocalAvailable, authHeaders, getActiveBase } from './localBridge.js';

// localStorage key under which the fetched config is cached.
const CACHE_KEY = 'pwa.siteConfig';
// Separate key for the bases — read by localBridge before this module's
// async load can complete, so it must be standalone.
const BASES_KEY = 'pwa.bases';

/**
 * Returns the cached site config, or null if it has never been fetched
 * (i.e. the device has not yet been on the home network).
 *
 * @returns {{weather: object, stops: Array, bases?: object} | null}
 */
export function getSiteConfig() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); }
  catch { return null; }
}

/**
 * Returns the cached server bases ({ lan_ip, ts }) or {} if not yet known.
 * Synchronous and side-effect-free — safe to call from probeBase() at boot.
 */
export function getCachedBases() {
  try { return JSON.parse(localStorage.getItem(BASES_KEY)) || {}; }
  catch { return {}; }
}

/**
 * Fetches the site config from the local server and caches it.
 * If the server is not reachable, the previously cached config is kept and
 * returned unchanged — so this is safe to call on every startup.
 *
 * @returns {Promise<{weather: object, stops: Array, bases?: object} | null>}
 */
export async function loadSiteConfig() {
  if (!(await isLocalAvailable())) return getSiteConfig();

  try {
    const r = await fetch(getActiveBase() + CONFIG.LOCAL_CONFIG_PATH, {
      headers:     authHeaders(),
      credentials: 'omit',
      cache:       'no-store',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const cfg = await r.json();
    localStorage.setItem(CACHE_KEY, JSON.stringify(cfg));
    // Cache bases separately so probeBase() can read them without parsing
    // the whole config on cold start.
    if (cfg.bases && typeof cfg.bases === 'object') {
      localStorage.setItem(BASES_KEY, JSON.stringify(cfg.bases));
    }
    return cfg;
  } catch {
    // Server hiccup — keep whatever was cached before.
    return getSiteConfig();
  }
}
