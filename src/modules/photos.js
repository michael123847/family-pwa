/**
 * photos.js — Photo gallery backed by the local WLAN server.
 *
 * Unlike the todo list, the gallery has no offline queue: photos are only
 * available when the device is on the home network and the local server is
 * reachable. When offline, the gallery shows a banner and an empty grid.
 *
 * Image display:
 *  The photo endpoints require an Authorization header, which a plain
 *  <img src> cannot send. So each thumbnail is fetched manually as a binary
 *  Blob and turned into an object URL (blob:...) that the <img> can use.
 *  Object URLs are revoked before every re-render to release memory.
 *
 * Upload:
 *  The selected File is sent as the raw request body with its MIME type in
 *  the Content-Type header. The original filename travels in the ?name=
 *  query parameter and is used only as a display label / download name.
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, invalidateLocal, authHeaders } from '../localBridge.js';
import { clearToken } from '../auth.js';

const PHOTOS_URL = CONFIG.LOCAL_BASE + CONFIG.LOCAL_PHOTOS_PATH;

// MIME types the server accepts — mirrors PHOTO_TYPES in server.js.
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Object URLs currently in use by thumbnails, keyed by photo id.
// Revoked on every re-render so old blobs do not leak memory.
let objectUrls = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Shows a transient status message; pass '' to clear it. */
function setStatus(msg, isError = false) {
  const el = document.getElementById('photo-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

/** Shows or hides the "not on home WiFi" banner. */
function setOffline(offline) {
  document.getElementById('photo-offline-banner')?.classList.toggle('visible', offline);
}

/** Human-readable file size, e.g. "2.4 MB". */
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * Fetches a photo (or the photo list) from the local server.
 * On HTTP 401 the token is cleared and the page reloads so auth.js prompts
 * for the passphrase again.
 *
 * @param {string} path - Path appended to PHOTOS_URL (e.g. '' or '/<id>').
 * @param {RequestInit} [opts]
 * @returns {Promise<Response>}
 */
async function api(path, opts = {}) {
  const r = await fetch(PHOTOS_URL + path, {
    credentials: 'omit',
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  if (r.status === 401) {
    clearToken();
    location.reload();
  }
  if (!r.ok) {
    invalidateLocal();
    throw new Error('HTTP_' + r.status);
  }
  return r;
}

// ── Render ────────────────────────────────────────────────────────────────────

/**
 * Renders the gallery grid from the given photo metadata list.
 * Each tile is created as a real DOM node so its blob image and button
 * handlers can be wired up directly. The actual image bytes are fetched
 * lazily per tile after the grid is in place.
 */
function render(photos) {
  const grid  = document.getElementById('photo-grid');
  const empty = document.getElementById('photo-empty');

  // Release the object URLs from the previous render.
  objectUrls.forEach(url => URL.revokeObjectURL(url));
  objectUrls = new Map();

  grid.innerHTML = '';
  empty.style.display = photos.length ? 'none' : 'block';

  for (const meta of photos) {
    const tile = document.createElement('div');
    tile.className = 'photo-tile';

    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.alt = meta.name;
    img.loading = 'lazy';
    tile.appendChild(img);

    const bar = document.createElement('div');
    bar.className = 'photo-bar';
    bar.innerHTML = `<span class="photo-name" title="${meta.name}">${meta.name}</span>
                     <span class="photo-size">${fmtSize(meta.size)}</span>`;

    const dl = document.createElement('button');
    dl.className = 'photo-dl';
    dl.textContent = '↓';
    dl.title = 'Herunterladen';
    dl.addEventListener('click', () => downloadPhoto(meta));

    const del = document.createElement('button');
    del.className = 'photo-del';
    del.textContent = '✕';
    del.title = 'Löschen';
    del.addEventListener('click', () => deletePhoto(meta));

    bar.append(dl, del);
    tile.appendChild(bar);
    grid.appendChild(tile);

    // Load the thumbnail image bytes (auth-protected → fetch as blob).
    loadThumb(meta, img);
  }
}

/** Fetches one photo's bytes and shows them in the given <img>. */
async function loadThumb(meta, img) {
  try {
    const blob = await (await api('/' + meta.id)).blob();
    const url  = URL.createObjectURL(blob);
    objectUrls.set(meta.id, url);
    img.src = url;
  } catch {
    img.classList.add('photo-thumb-failed');
    img.alt = 'Bild konnte nicht geladen werden';
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

/** Downloads a photo to the device using a temporary <a download> element. */
async function downloadPhoto(meta) {
  try {
    const blob = await (await api('/' + meta.id)).blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = meta.name;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    setStatus('Download fehlgeschlagen — Server nicht erreichbar.', true);
  }
}

/** Deletes a photo after a confirmation prompt, then reloads the gallery. */
async function deletePhoto(meta) {
  if (!confirm(`Foto „${meta.name}" wirklich löschen?`)) return;
  try {
    await api('/' + meta.id, { method: 'DELETE' });
    setStatus('Foto gelöscht.');
    load();
  } catch {
    setStatus('Löschen fehlgeschlagen — Server nicht erreichbar.', true);
  }
}

/**
 * Uploads one or more selected files in sequence, then reloads the gallery.
 * Files with an unsupported type are skipped with a warning.
 */
async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  if (!(await isLocalAvailable())) {
    setOffline(true);
    setStatus('Upload nicht möglich — nicht im Heim-WLAN.', true);
    return;
  }

  let done = 0, skipped = 0;
  for (const file of files) {
    if (!ACCEPTED.includes(file.type)) { skipped++; continue; }
    setStatus(`Lade hoch… (${done + 1}/${files.length})`);
    try {
      await api('?name=' + encodeURIComponent(file.name), {
        method:  'POST',
        headers: { 'Content-Type': file.type },
        body:    file,
      });
      done++;
    } catch {
      setStatus('Upload fehlgeschlagen — Server nicht erreichbar.', true);
      break;
    }
  }

  if (done)    setStatus(`${done} Foto${done !== 1 ? 's' : ''} hochgeladen.`);
  if (skipped) setStatus(`${skipped} Datei(en) übersprungen — nur JPEG, PNG, WebP, GIF.`, true);
  load();
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Loads the photo list from the server and renders the grid.
 * Shows the offline banner if the local server is not reachable.
 */
async function load() {
  if (!(await isLocalAvailable())) {
    setOffline(true);
    render([]);
    return;
  }
  setOffline(false);
  try {
    const photos = await (await api('')).json();
    render(photos);
  } catch {
    setOffline(true);
    render([]);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Wires up the upload button and file input, then loads the gallery.
 * Called once by app.js during boot.
 */
export function initPhotos() {
  const input = document.getElementById('photo-input');

  document.getElementById('photo-upload-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    uploadFiles(input.files);
    input.value = ''; // allow re-selecting the same file later
  });

  // Reload when the device comes back onto the home network.
  window.addEventListener('online', () => { invalidateLocal(); load(); });

  load();
}
