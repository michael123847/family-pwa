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

// ── EXIF helper ───────────────────────────────────────────────────────────────

/**
 * Reads the EXIF DateTimeOriginal from a JPEG file and returns a ms timestamp,
 * or null if the tag is absent or the file is not a JPEG.
 *
 * Android's file picker sets file.lastModified to the share time rather than
 * the capture time, so we parse the EXIF tag directly. iOS sets lastModified
 * correctly from the EXIF tag, but using the tag directly works there too.
 *
 * Only the first 64 KB is read — enough to cover the APP1/EXIF segment.
 */
async function readJpegCaptureDateMs(file) {
  if (file.type !== 'image/jpeg') return null;
  try {
    const buf  = await file.slice(0, 65536).arrayBuffer();
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xFFD8) return null;

    // Walk JPEG markers to find APP1 (0xFFE1) containing the Exif block.
    let pos = 2;
    while (pos + 4 <= buf.byteLength) {
      const marker = view.getUint16(pos);
      if (marker === 0xFFD9 || (marker & 0xFF00) !== 0xFF00) break;
      const segLen = view.getUint16(pos + 2);
      if (marker === 0xFFE1 && segLen >= 8) {
        const h = String.fromCharCode(
          view.getUint8(pos+4), view.getUint8(pos+5),
          view.getUint8(pos+6), view.getUint8(pos+7));
        if (h === 'Exif') return _parseExifDto(view, pos + 10);
      }
      if (segLen < 2) break;
      pos += 2 + segLen;
    }
  } catch { /* fall back to file.lastModified */ }
  return null;
}

/** Parses DateTimeOriginal (tag 0x9003) from a TIFF block starting at `base`. */
function _parseExifDto(view, base) {
  if (base + 8 > view.byteLength) return null;
  const le  = view.getUint16(base) === 0x4949;
  const u16 = o => view.getUint16(base + o, le);
  const u32 = o => view.getUint32(base + o, le);
  if (u16(2) !== 42) return null;                     // TIFF magic check

  // IFD0 — look for ExifIFD pointer (tag 0x8769).
  let off = u32(4);
  const n0 = u16(off); off += 2;
  let exifOff = 0;
  for (let i = 0; i < n0; i++, off += 12)
    if (u16(off) === 0x8769) { exifOff = u32(off + 8); break; }
  if (!exifOff) return null;

  // ExifIFD — look for DateTimeOriginal (tag 0x9003).
  const ne = u16(exifOff); off = exifOff + 2;
  for (let i = 0; i < ne; i++, off += 12) {
    if (u16(off) !== 0x9003) continue;
    const count  = u32(off + 4);
    const valOff = count <= 4 ? off + 8 : u32(off + 8);
    let str = '';
    for (let j = 0; j < count - 1 && base + valOff + j < view.byteLength; j++)
      str += String.fromCharCode(view.getUint8(base + valOff + j));
    // EXIF date format: "YYYY:MM:DD HH:MM:SS"
    const m = str.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (m) return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  return null;
}

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
 * The photo's stored filename on the server (id + extension, e.g.
 * "20260518_0834_01.jpg"). Shown in the gallery and used as the download
 * name — meta.name only holds the original (often generic) upload name.
 */
function storedName(meta) {
  return meta.id + '.' + meta.ext;
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

    const name = storedName(meta);

    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.alt = name;
    img.loading = 'lazy';
    tile.appendChild(img);

    const bar = document.createElement('div');
    bar.className = 'photo-bar';
    bar.innerHTML = `<span class="photo-name" title="${name}">${name}</span>
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
    a.download = storedName(meta);
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    setStatus('Download fehlgeschlagen — Server nicht erreichbar.', true);
  }
}

/** Deletes a photo after a confirmation prompt, then reloads the gallery. */
async function deletePhoto(meta) {
  if (!confirm(`Foto „${storedName(meta)}" wirklich löschen?`)) return;
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
      // Prefer the EXIF capture date (reliable on both iOS and Android).
      // Android's file picker often sets lastModified to the share time rather
      // than the photo's actual capture time — EXIF tag 0x9003 is the fix.
      const ts = (await readJpegCaptureDateMs(file)) ?? (file.lastModified || Date.now());
      await api('?name=' + encodeURIComponent(file.name)
                + '&ts=' + ts, {
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

  // Refresh the gallery whenever the user navigates to the Photos tab — forces
  // a fresh health-check so photos appear immediately after joining home WiFi.
  window.addEventListener('pwa:page', e => {
    if (e.detail === 'photos') { invalidateLocal(); load(); }
  });

  // Reload when the device comes back onto the home network.
  window.addEventListener('online', () => { invalidateLocal(); load(); });

  load();
}
