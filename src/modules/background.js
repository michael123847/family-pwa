/**
 * background.js — Family photo background loaded from the local server.
 *
 * The image is fetched with an Authorization header (Bearer token) because it
 * is served by the private local server, not a public URL. A regular <img src>
 * tag cannot attach custom headers, so we fetch the image manually as a binary
 * Blob and convert it to an object URL — a temporary browser-internal URL like
 * "blob:https://..." — which can then be used as a CSS background-image.
 *
 * Caching strategy (Cache API):
 *  The image is stored in the browser's Cache API after the first successful
 *  load. On subsequent visits the cached version is displayed immediately,
 *  even if the local server is unreachable (e.g. the user is away from home).
 *  If the server is available, a fresh copy is fetched in the background and
 *  the cache is updated silently.
 *
 * Why Cache API and not localStorage?
 *  localStorage only stores text strings. Storing a binary image would require
 *  Base64 encoding which bloats the size by ~33% and is slow to encode/decode.
 *  The Cache API is designed for binary data like images, fonts, and scripts.
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, authHeaders, getBaseUrl } from '../localBridge.js';

// Name of the Cache API bucket used for the family photo.
const CACHE_NAME = 'family-bg-v1';

// Symbolic key used to store/retrieve the image in the cache.
// Not a real URL — just a unique string identifier.
const CACHE_KEY  = 'family-bg';

// Holds the current object URL so we can revoke it before creating a new one.
// Revoking releases the memory held by the previous blob.
let _objectUrl = null;

/**
 * Reads the cached image blob from the Cache API.
 * Returns null if nothing is cached yet.
 *
 * @returns {Promise<Blob|null>}
 */
async function readImageCache() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const r     = await cache.match(CACHE_KEY);
    return r ? r.blob() : null;
  } catch { return null; }
}

/**
 * Writes an image blob to the Cache API for offline use.
 * blob.slice() is used to create an independent copy of the data so that
 * revoking the object URL later does not affect what is stored in the cache.
 *
 * @param {Blob} blob
 */
async function writeImageCache(blob) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(CACHE_KEY, new Response(blob.slice(), {
      headers: { 'Content-Type': blob.type || 'image/jpeg' },
    }));
  } catch {}
}

/**
 * Applies a blob as the CSS background image of the given element.
 * Creates a new object URL and revokes the previous one to free memory.
 *
 * @param {HTMLElement} el   - The element to apply the background to.
 * @param {Blob}        blob - The image data.
 */
function applyBlob(el, blob) {
  if (_objectUrl) URL.revokeObjectURL(_objectUrl); // free previous blob from memory
  _objectUrl = URL.createObjectURL(blob);
  el.style.backgroundImage = `url('${_objectUrl}')`;
  el.removeAttribute('data-state');
}

/**
 * Main entry point — loads and displays the family background image.
 * Called once by app.js during boot.
 *
 * Flow:
 *  1. Try to read the cached image and display it immediately.
 *  2. If the local server is not reachable and nothing is cached, show the
 *     CSS fallback gradient instead.
 *  3. If the server is reachable, fetch a fresh copy, update the cache,
 *     and update the displayed image.
 *
 * @param {HTMLElement} el - The #family-bg div element.
 */
export async function setFamilyBackground(el) {
  if (!el) return;

  // Show cached image immediately — no blank area while checking the server.
  const cached = await readImageCache();
  if (cached) applyBlob(el, cached);

  if (!(await isLocalAvailable())) {
    // Server is offline. If we have a cached image it is already displayed.
    // Otherwise fall back to the CSS gradient defined in style.css.
    if (!cached) {
      el.style.backgroundImage = 'var(--fallback-bg)';
      el.setAttribute('data-state', 'offline');
    }
    return;
  }

  try {
    const r = await fetch(getBaseUrl() + CONFIG.LOCAL_BG_PATH, {
      headers:     authHeaders(),
      credentials: 'omit',
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);

    const blob = await r.blob();
    await writeImageCache(blob); // update the cache for next offline visit
    applyBlob(el, blob);         // replace the cached image with the fresh one
  } catch {
    // Fetch failed — keep whatever is already displayed (cached or gradient).
    if (!cached) {
      el.style.backgroundImage = 'var(--fallback-bg)';
      el.setAttribute('data-state', 'error');
    }
  }
}
