/**
 * siteConfig.js — Location-dependent configuration from the local server.
 *
 * The weather coordinates and the transit stop list reveal where the family
 * lives, so they are NOT stored in this public frontend repository. Instead
 * the local server serves them at /api/config, and this module fetches that
 * once the device is on the home network and caches it in localStorage.
 *
 * After the first successful fetch, weather and departures keep working
 * everywhere (the open-meteo and transport.opendata.ch APIs are public) —
 * only the location config itself comes from home.
 *
 * Shape of the config:
 *   { weather: { label, lat, lon },
 *     stops:   [ { label, name, limit, nextStop? }, ... ] }
 *
 * The server's config.json also carries an ENABLE_TAILSCALE flag, but the
 * client's auth mode is NOT derived from it — that is the build-time constant
 * CONFIG.ENABLE_TAILSCALE in config.js (see isTailscaleMode there). This
 * module simply ignores the extra field.
 */

import { CONFIG } from './config.js';
import { isLocalAvailable, authHeaders, getBaseUrl } from './localBridge.js';

// localStorage key under which the fetched config is cached.
const CACHE_KEY = 'pwa.siteConfig';

/**
 * Returns the cached site config, or null if it has never been fetched
 * (i.e. the device has not yet been on the home network).
 *
 * @returns {{weather: object, stops: Array} | null}
 */
export function getSiteConfig() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)); }
  catch { return null; }
}

/**
 * Fetches the site config from the local server and caches it.
 * If the server is not reachable, the previously cached config is kept and
 * returned unchanged — so this is safe to call on every startup.
 *
 * @returns {Promise<{weather: object, stops: Array} | null>}
 */
export async function loadSiteConfig() {
  if (!(await isLocalAvailable())) return getSiteConfig();

  try {
    const r = await fetch(getBaseUrl() + CONFIG.LOCAL_CONFIG_PATH, {
      headers:     authHeaders(),
      credentials: 'omit',
      cache:       'no-store',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const cfg = await r.json();
    localStorage.setItem(CACHE_KEY, JSON.stringify(cfg));
    return cfg;
  } catch {
    // Server hiccup — keep whatever was cached before.
    return getSiteConfig();
  }
}
