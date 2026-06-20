/**
 * photos.js — Photo gallery backed by the local WLAN server.
 *
 * Unlike the todo list, the gallery has no offline queue: photos are only
 * available when the device is on the home network and the local server is
 * reachable. When offline, the gallery shows a banner and an empty grid.
 *
 * Folder model:
 *  The gallery has up to two levels of folders. The current location is a
 *  forward-slash-joined path string ("" = root, "vacation" = one level deep,
 *  "vacation/2026" = two levels). Folders are listed as tiles before the
 *  photo grid; tapping a folder enters it; the back-button goes one level up.
 *  Folder creation/deletion is exposed via the kebab (⋮) menu in the header.
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
 *  ?folder=<currentFolder> targets the active subfolder.
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, invalidateLocal, authHeaders, getActiveBase } from '../localBridge.js';
import { clearToken } from '../auth.js';

// Computed lazily so a network change (LAN ↔ Tailscale) is picked up
// automatically — see localBridge.getActiveBase() + probeBase().
const photosUrl  = () => getActiveBase() + CONFIG.LOCAL_PHOTOS_PATH;
const foldersUrl = () => photosUrl() + '/folders';

// Maximum folder nesting depth — must match server's MAX_FOLDER_DEPTH.
const MAX_FOLDER_DEPTH = 2;

// MIME types the server accepts — mirrors PHOTO_TYPES in server.js.
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Object URLs currently in use by thumbnails, keyed by photo id.
// Revoked on every re-render so old blobs do not leak memory.
let objectUrls = new Map();

// Current folder location ("" = root). State, not persisted — re-resets to
// root every time the user reopens the app.
let currentFolder = '';

// Most-recently fetched folder list. Cached so the menu can decide whether
// "Ordner löschen" should be enabled without an extra request.
let folderList = []; // [{ path, photoCount }, ...]

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

/** Current folder's depth: 0 = root, 1 = first level, 2 = second level. */
function folderDepth(folder) {
  return folder ? folder.split('/').length : 0;
}

/** Parent folder of the current one, or '' if already at root. */
function parentFolder(folder) {
  if (!folder) return '';
  const i = folder.lastIndexOf('/');
  return i < 0 ? '' : folder.slice(0, i);
}

/** Folder name only (last segment), for display in tiles + breadcrumb. */
function folderLeafName(folder) {
  if (!folder) return '';
  const i = folder.lastIndexOf('/');
  return i < 0 ? folder : folder.slice(i + 1);
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
  const r = await fetch(photosUrl() + path, {
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

/** Like api(), but targets the folders endpoint directly. */
async function folderApi(opts = {}, queryOrPath = '') {
  const r = await fetch(foldersUrl() + queryOrPath, {
    credentials: 'omit',
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  if (r.status === 401) { clearToken(); location.reload(); }
  if (!r.ok) {
    invalidateLocal();
    const detail = await r.json().catch(() => ({}));
    throw new Error(detail.error || ('HTTP_' + r.status));
  }
  return r;
}

// ── Render ────────────────────────────────────────────────────────────────────

/** Updates header: back button visibility + breadcrumb text. */
function renderHeader() {
  document.getElementById('photo-back-btn').hidden = (currentFolder === '');
  const crumb = document.getElementById('photo-breadcrumb');
  crumb.textContent = currentFolder
    ? 'Galerie › ' + currentFolder.split('/').join(' › ')
    : 'Foto-Galerie';
}

/** Updates the kebab menu state — which items are visible/enabled. */
function renderMenu() {
  const newBtn = document.getElementById('photo-menu-newfolder');
  const delBtn = document.getElementById('photo-menu-delfolder');

  // "Neuer Ordner" is only allowed when the current depth still has room for
  // a child (i.e. depth < MAX_FOLDER_DEPTH).
  newBtn.hidden = (folderDepth(currentFolder) >= MAX_FOLDER_DEPTH);

  // "Ordner löschen" only applies to the current folder when:
  // - we're not at root, AND
  // - the current folder is empty (no photos AND no subfolders).
  let canDelete = false;
  if (currentFolder !== '') {
    const meta     = folderList.find(f => f.path === currentFolder);
    const hasPhotos = meta ? meta.photoCount > 0 : false;
    const hasChild  = folderList.some(f => f.path.startsWith(currentFolder + '/'));
    canDelete = !hasPhotos && !hasChild;
  }
  delBtn.hidden = !canDelete;
}

/** Renders the folder-tile row (folders that are direct children of currentFolder). */
function renderFolders() {
  const row     = document.getElementById('photo-folders');
  const prefix  = currentFolder ? currentFolder + '/' : '';
  // Direct children only — no grandchildren in the same view.
  const children = folderList.filter(f =>
    f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/')
  );

  row.innerHTML = '';
  if (!children.length) return;

  for (const f of children) {
    const tile = document.createElement('button');
    tile.className = 'photo-folder-tile';
    tile.dataset.path = f.path;
    tile.innerHTML = `
      <span class="photo-folder-icon">📁</span>
      <span class="photo-folder-name">${folderLeafName(f.path)}</span>
      <span class="photo-folder-count">${f.photoCount}</span>`;
    tile.addEventListener('click', () => enterFolder(f.path));
    row.appendChild(tile);
  }
}

/**
 * Renders the gallery grid from the given photo metadata list.
 * Each tile is created as a real DOM node so its blob image and button
 * handlers can be wired up directly. The actual image bytes are fetched
 * lazily per tile after the grid is in place.
 */
function renderGrid(photos) {
  _gallery = photos;
  const grid  = document.getElementById('photo-grid');
  const empty = document.getElementById('photo-empty');

  // Release the object URLs from the previous render.
  objectUrls.forEach(url => URL.revokeObjectURL(url));
  objectUrls = new Map();

  grid.innerHTML = '';

  // "Empty" hint only matters if both photos AND folders are empty here.
  const folderRow = document.getElementById('photo-folders');
  const hasFolderChildren = folderRow.children.length > 0;
  empty.style.display = (photos.length || hasFolderChildren) ? 'none' : 'block';

  for (const meta of photos) {
    const tile = document.createElement('div');
    tile.className = 'photo-tile';

    const name = storedName(meta);

    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.alt = name;
    img.loading = 'lazy';
    tile.appendChild(img);

    // Like overlay — top-right corner of the tile thumbnail.
    const likeBtn = document.createElement('button');
    likeBtn.type = 'button';
    likeBtn.className = 'photo-like' + (meta.liked ? ' liked' : '');
    likeBtn.setAttribute('aria-label', 'Like');
    const heart = document.createElement('span');
    heart.className = 'heart';
    heart.textContent = '♥';
    const likeCount = document.createElement('span');
    likeCount.className = 'like-count' + ((meta.likes || 0) === 0 ? ' zero' : '');
    likeCount.textContent = meta.likes || 0;
    likeBtn.append(heart, likeCount);
    likeBtn.addEventListener('click', e => { e.stopPropagation(); toggleLike(meta, likeBtn); });
    tile.appendChild(likeBtn);

    const nameEl = document.createElement('div');
    nameEl.className = 'photo-name';
    nameEl.title = name;
    nameEl.textContent = name;
    tile.appendChild(nameEl);

    const bar = document.createElement('div');
    bar.className = 'photo-bar';
    bar.innerHTML = `<span class="photo-size">${fmtSize(meta.size)}</span>`;

    const dl = document.createElement('button');
    dl.className = 'photo-dl';
    dl.textContent = '↓';
    dl.title = 'Herunterladen';
    dl.addEventListener('click', e => { e.stopPropagation(); downloadPhoto(meta); });

    const del = document.createElement('button');
    del.className = 'photo-del';
    del.textContent = '✕';
    del.title = 'Löschen';
    del.addEventListener('click', e => { e.stopPropagation(); deletePhoto(meta); });

    bar.append(dl, del);
    tile.appendChild(bar);
    // Tap the tile (not the buttons) to open the fullscreen viewer.
    tile.addEventListener('click', () => openLightbox(meta));
    grid.appendChild(tile);

    // Load the thumbnail image bytes (auth-protected → fetch as blob).
    loadThumb(meta, img);
  }
}

/** Fetches one photo's bytes and shows them in the given <img>. */
async function loadThumb(meta, img) {
  try {
    // ?thumb=1 → small server-generated JPEG for the grid. Download and any
    // full view still fetch the original (no ?thumb). Falls back to the full
    // image automatically if the server has no thumbnailer installed.
    const blob = await (await api('/' + meta.id + '?thumb=1')).blob();
    const url  = URL.createObjectURL(blob);
    objectUrls.set(meta.id, url);
    img.src = url;
    if (meta.rotate) img.style.transform = `rotate(${meta.rotate}deg)`;
  } catch {
    img.classList.add('photo-thumb-failed');
    img.alt = 'Bild konnte nicht geladen werden';
  }
}

/** Optimistically toggles a like on a photo, then confirms with the server. */
async function toggleLike(meta, btn) {
  const willLike = !btn.classList.contains('liked');
  btn.classList.toggle('liked', willLike);
  const countEl = btn.querySelector('.like-count');
  let n = Math.max(0, (parseInt(countEl.textContent, 10) || 0) + (willLike ? 1 : -1));
  countEl.textContent = n;
  countEl.classList.toggle('zero', n === 0);
  meta.liked = willLike;
  meta.likes = n;
  // Sync the lightbox like button if this photo is open.
  const lbBtn = document.getElementById('photo-lb-like');
  if (lbBtn && _lbMeta?.id === meta.id) syncLightboxLike(meta, lbBtn);
  try {
    const r = await fetch(getActiveBase() + '/api/photos/' + meta.id + '/like', {
      method:      'POST',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json', ...authHeaders() },
      body:        JSON.stringify({ like: willLike }),
    });
    if (r.ok) {
      const data = await r.json();
      if (typeof data.likes === 'number') {
        meta.likes = data.likes;
        meta.liked = data.liked;
        countEl.textContent = data.likes;
        countEl.classList.toggle('zero', data.likes === 0);
        if (lbBtn && _lbMeta?.id === meta.id) syncLightboxLike(meta, lbBtn);
      }
    }
  } catch { /* keep optimistic value; next load() reconciles */ }
}

/** Updates the lightbox like button to match meta's current like state. */
function syncLightboxLike(meta, btn) {
  btn.classList.toggle('liked', !!meta.liked);
  const countEl = btn.querySelector('.like-count');
  if (!countEl) return;
  countEl.textContent = meta.likes || 0;
  countEl.classList.toggle('zero', !meta.likes);
}

// ── Lightbox (fullscreen viewer) ────────────────────────────────────────────
// Tapping a tile opens the full-resolution image (no ?thumb) over the page.
// One object URL is kept for the open image and revoked on close.
let _lbUrl   = null;
let _lbMeta  = null;
let _gallery = [];  // current rendered photo list — set by renderGrid
let _lbIndex = -1;  // index of the currently open photo within _gallery
let _lbRotation = 0; // view-only rotation (0/90/180/270) — never changes the JPEG or the print

// ── Crop-mode state ───────────────────────────────────────────────────────────
let _cropMode  = false;  // true while the user is in the Drucken→Abschicken flow
let _cropPan   = 0;      // pan offset along the cut axis, in natural pixels
let _cropRect  = null;   // { x, y, w, h } in natural px — updated by updateCropOverlay
let _dragCleanup = null; // fn that removes the active pointer/touch drag listeners

function _updateNavButtons() {
  const show = _gallery.length > 1;
  document.getElementById('photo-lb-prev')?.toggleAttribute('hidden', !show);
  document.getElementById('photo-lb-next')?.toggleAttribute('hidden', !show);
}

async function loadLightboxImage(meta) {
  // Always exit crop mode when navigating to a new photo.
  if (_cropMode) exitCropMode();
  _lbMeta = meta;
  _lbRotation = meta.rotate || 0;
  const lb      = document.getElementById('photo-lightbox');
  const content = document.getElementById('photo-lb-content');
  document.getElementById('photo-lb-caption').textContent = '';
  const lbFooter = document.getElementById('photo-lb-footer');
  if (lbFooter) lbFooter.textContent = storedName(meta);
  const lbLike = document.getElementById('photo-lb-like');
  if (lbLike) syncLightboxLike(meta, lbLike);
  content.style.transform = '';
  Array.from(content.children).forEach(c => { if (c.id !== 'photo-lb-crop-overlay') c.remove(); });
  clearCropOverlay();
  try {
    const blob = await (await api('/' + meta.id)).blob();
    if (lb.hidden) return;                    // closed while loading
    if (_lbUrl) URL.revokeObjectURL(_lbUrl);
    _lbUrl = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.src = _lbUrl;
    img.alt = storedName(meta);
    img.addEventListener('load', applyLbRotation, { once: true });
    content.appendChild(img);
  } catch {
    const err = document.createElement('div');
    err.className = 'lb-error';
    err.textContent = 'Bild konnte nicht geladen werden.';
    content.appendChild(err);
  }
}

function showAt(i) {
  if (!_gallery.length) return;
  _lbIndex = Math.max(0, Math.min(_gallery.length - 1, i));
  loadLightboxImage(_gallery[_lbIndex]);
}
function next() { showAt(_lbIndex + 1); }
function prev() { showAt(_lbIndex - 1); }

function openLightbox(meta) {
  const lb = document.getElementById('photo-lightbox');
  if (!lb) return;
  const idx = _gallery.indexOf(meta);
  _lbIndex  = idx >= 0 ? idx : 0;
  lb.hidden = false;
  document.body.style.overflow = 'hidden';
  _updateNavButtons();
  loadLightboxImage(meta);
}

// Entering Drucken now enters crop-mode instead of immediately printing.
function printPhoto(meta) {
  enterCropMode();
}

// ── Crop-mode entry / exit ────────────────────────────────────────────────────

function enterCropMode() {
  if (!_lbMeta) return;
  _cropMode = true;
  _cropPan  = 0;
  _cropRect = null;
  const lb = document.getElementById('photo-lightbox');
  if (lb) lb.classList.add('cropping');
  // Hide prev/next nav while cropping.
  document.getElementById('photo-lb-prev')?.toggleAttribute('hidden', true);
  document.getElementById('photo-lb-next')?.toggleAttribute('hidden', true);
  // Swap the toolbar: hide the normal actions, reveal Abschicken/Abbrechen.
  // The global [hidden]{display:none!important} rule means visibility must be
  // driven by the hidden attribute, not by a CSS class.
  ['photo-lb-rotate', 'photo-lb-like', 'photo-lb-print', 'photo-lb-dl']
    .forEach(id => document.getElementById(id)?.toggleAttribute('hidden', true));
  ['photo-lb-send', 'photo-lb-crop-cancel']
    .forEach(id => document.getElementById(id)?.toggleAttribute('hidden', false));
  updateCropOverlay();
  _bindCropDrag();
}

function exitCropMode() {
  _cropMode = false;
  _cropPan  = 0;
  _cropRect = null;
  const lb = document.getElementById('photo-lightbox');
  if (lb) lb.classList.remove('cropping');
  _unbindCropDrag();
  clearCropOverlay();
  // Restore the normal toolbar; re-hide Abschicken/Abbrechen.
  ['photo-lb-rotate', 'photo-lb-like', 'photo-lb-print', 'photo-lb-dl']
    .forEach(id => document.getElementById(id)?.toggleAttribute('hidden', false));
  ['photo-lb-send', 'photo-lb-crop-cancel']
    .forEach(id => document.getElementById(id)?.toggleAttribute('hidden', true));
  // Restore prev/next visibility (only when gallery has >1 photo).
  _updateNavButtons();
}

// ── Drag handler for crop panning ─────────────────────────────────────────────
// The drag adjusts _cropPan along the cut axis (X if sides are cut, Y if top/bottom
// are cut). Screen deltas are divided by the render scale to convert to natural px.
// Rotation-aware axis mapping: at 90/270° a horizontal screen drag maps to the
// vertical cut axis, and vice-versa. At 180° the sign of X is flipped.

function _bindCropDrag() {
  _unbindCropDrag(); // clear any previous handlers

  const content = document.getElementById('photo-lb-content');
  if (!content) return;

  let startX = 0, startY = 0, startPan = 0;
  let dragging = false;

  function getScale() {
    const img = content.querySelector('img');
    if (!img || !img.naturalWidth || !img.naturalHeight) return 1;
    const boxW = content.clientWidth, boxH = content.clientHeight;
    return Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight);
  }

  // Determine which screen-axis maps to the cut axis, and its sign.
  // Returns { useX: bool, sign: 1|-1 } where useX means horizontal screen drag
  // drives the pan (i.e. the cut axis is X in natural coords).
  function dragMapping() {
    const img = content.querySelector('img');
    if (!img) return { useX: true, sign: 1 };
    const W = img.naturalWidth, H = img.naturalHeight;
    const isLandscape = W > H;
    const targetAR = isLandscape ? 3 / 2 : 2 / 3;
    const imgAR = W / H;
    // Cut axis: X when sides are cut (imgAR > targetAR), Y when top/bottom cut.
    const cutAxisIsX = imgAR > targetAR;
    // At rotation 0/180 a horizontal screen drag → X-axis in natural coords.
    // At rotation 90/270 a horizontal screen drag → Y-axis.
    let useX; // true = horizontal screen movement drives the cut axis
    if (_lbRotation === 0 || _lbRotation === 180) {
      useX = cutAxisIsX;
    } else {
      // 90/270: screen axes are swapped relative to natural image axes
      useX = !cutAxisIsX;
    }
    // Sign: at 180° horizontal drag is flipped; at 270° vertical is flipped.
    let sign = 1;
    if (_lbRotation === 180 && cutAxisIsX)  sign = -1;
    if (_lbRotation === 90  && !cutAxisIsX) sign = -1;
    if (_lbRotation === 270 && cutAxisIsX)  sign = -1;
    return { useX, sign };
  }

  function onPointerDown(e) {
    if (!_cropMode) return;
    if (e.target.closest('button')) return;
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    startPan = _cropPan;
    content.setPointerCapture && content.setPointerCapture(e.pointerId);
    content.style.cursor = 'grabbing';
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!_cropMode || !dragging) return;
    const { useX, sign } = dragMapping();
    const screenDelta = useX ? (e.clientX - startX) : (e.clientY - startY);
    const scale = getScale();
    const naturalDelta = scale > 0 ? screenDelta / scale : 0;
    _cropPan = startPan + sign * naturalDelta;
    updateCropOverlay();
    e.preventDefault();
  }

  function onPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    content.style.cursor = '';
    content.releasePointerCapture && content.releasePointerCapture(e.pointerId);
  }

  // Pointer Events cover mouse, touch and pen on every current browser
  // (iOS 13+, Android, Windows, macOS, Linux). Crop mode disables the gallery
  // swipe/scroll, so a single pointer stream is unambiguous; `touch-action: none`
  // (set on .lightbox.cropping .lightbox-content in CSS) stops the browser from
  // scrolling/zooming the image during a touch drag.
  content.addEventListener('pointerdown',   onPointerDown);
  content.addEventListener('pointermove',   onPointerMove);
  content.addEventListener('pointerup',     onPointerUp);
  content.addEventListener('pointercancel', onPointerUp);

  _dragCleanup = () => {
    content.removeEventListener('pointerdown',   onPointerDown);
    content.removeEventListener('pointermove',   onPointerMove);
    content.removeEventListener('pointerup',     onPointerUp);
    content.removeEventListener('pointercancel', onPointerUp);
  };
}

function _unbindCropDrag() {
  if (_dragCleanup) { _dragCleanup(); _dragCleanup = null; }
}

// ── Actual print fetch (fires after user confirms paper-insertion) ─────────────

async function doPrint(meta, crop) {
  // Feedback must show INSIDE the lightbox — the page's #photo-status is hidden
  // behind the fullscreen overlay. Use the send button label + caption for messages.
  const btn = document.getElementById('photo-lb-send');
  const cap = document.getElementById('photo-lb-caption');
  if (btn) { btn.disabled = true; btn.textContent = 'Drucke…'; }
  try {
    const r = await fetch(getActiveBase() + '/api/print', {
      method:      'POST',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json', ...authHeaders() },
      body:        JSON.stringify({ source: 'photo', id: meta.id, crop }),
    });
    if (r.ok) {
      if (btn) btn.textContent = '✓ Gesendet';
    } else {
      const b = await r.json().catch(() => ({}));
      if (cap) cap.textContent = b.error || ('Druck fehlgeschlagen (HTTP ' + r.status + ')');
      if (btn) btn.textContent = 'Abschicken';
    }
  } catch {
    if (cap) cap.textContent = 'Druck fehlgeschlagen — Server nicht erreichbar.';
    if (btn) btn.textContent = 'Abschicken';
  } finally {
    if (btn) {
      btn.disabled = false;
      setTimeout(() => { if (btn.textContent === '✓ Gesendet') btn.textContent = 'Abschicken'; }, 2500);
    }
  }
}

// ── Crop-preview overlay ─────────────────────────────────────────────────────
// Veils the strips that will be cut off when printing on 4x6 photo paper.
// Uses the same cover-crop algorithm as the server (printPhotoSized / sharp):
//   orientation: landscape if W>H, else portrait
//   targetAR:    portrait → 2/3 (W:H), landscape → 3/2
//   cover-crop:  if imgAR > targetAR → cut sides; else → cut top/bottom
// The image is displayed with object-fit:contain so we first compute the
// rendered image rect inside the content box, then apply the crop math.
// Only draws when _cropMode is true; otherwise hides the overlay.
// Stores the resulting kept rect in _cropRect (natural px) for the print payload.
function updateCropOverlay() {
  const content = document.getElementById('photo-lb-content');
  const overlay = document.getElementById('photo-lb-crop-overlay');
  if (!content || !overlay) return;

  // Only show the overlay in crop mode.
  if (!_cropMode) {
    overlay.style.display = 'none';
    return;
  }

  const img = content.querySelector('img');
  if (!img || !img.complete || !img.naturalWidth) {
    overlay.style.display = 'none';
    return;
  }

  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const isLandscape = W > H;
  const targetAR = isLandscape ? 3 / 2 : 2 / 3;
  const imgAR    = W / H;

  // Base centered kept rect in natural-image pixels
  let keptW, keptH, baseCropX, baseCropY;
  if (imgAR > targetAR) {
    // cut sides — pan is along X
    keptW = Math.round(H * targetAR);
    keptH = H;
    baseCropX = (W - keptW) / 2;
    baseCropY = 0;
  } else {
    // cut top/bottom — pan is along Y
    keptW = W;
    keptH = Math.round(W / targetAR);
    baseCropX = 0;
    baseCropY = (H - keptH) / 2;
  }

  // Apply pan along the cut axis (clamped so the kept rect stays within the image).
  let cropX, cropY;
  if (imgAR > targetAR) {
    // Cut axis is X; clamp pan so kept rect stays in [0 .. W-keptW]
    cropX = Math.max(0, Math.min(W - keptW, baseCropX + _cropPan));
    cropY = 0;
  } else {
    // Cut axis is Y; clamp pan so kept rect stays in [0 .. H-keptH]
    cropX = 0;
    cropY = Math.max(0, Math.min(H - keptH, baseCropY + _cropPan));
  }

  // Store the kept rect for the print payload (rounded natural px).
  _cropRect = {
    x: Math.round(cropX),
    y: Math.round(cropY),
    w: keptW,
    h: keptH,
  };

  // Rendered image rect inside content box (object-fit: contain)
  const boxW = content.clientWidth;
  const boxH = content.clientHeight;
  const scale = Math.min(boxW / W, boxH / H);
  const rendW = W * scale;
  const rendH = H * scale;
  const offX  = (boxW - rendW) / 2;   // left gap (letterbox / pillarbox)
  const offY  = (boxH - rendH) / 2;   // top gap

  // Map kept rect into box coordinates
  const kx = offX + cropX * scale;
  const ky = offY + cropY * scale;
  const kw = keptW * scale;
  const kh = keptH * scale;

  // Position the four veil bands and the frame
  const setEl = (id, t, l, w, h) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.top    = t + 'px';
    el.style.left   = l + 'px';
    el.style.width  = w + 'px';
    el.style.height = h + 'px';
  };

  // Top veil: from top of rendered image to top of kept rect
  setEl('photo-lb-veil-top',    offY,        offX,        rendW, ky - offY);
  // Bottom veil: from bottom of kept rect to bottom of rendered image
  setEl('photo-lb-veil-bottom', ky + kh,     offX,        rendW, (offY + rendH) - (ky + kh));
  // Left veil: cut sides case only (height = kh)
  setEl('photo-lb-veil-left',   ky,          offX,        kx - offX, kh);
  // Right veil: right side
  setEl('photo-lb-veil-right',  ky,          kx + kw,     (offX + rendW) - (kx + kw), kh);
  // Frame around kept area
  setEl('photo-lb-crop-frame',  ky,          kx,          kw, kh);

  overlay.style.display = '';
}

function clearCropOverlay() {
  const overlay = document.getElementById('photo-lb-crop-overlay');
  if (overlay) overlay.style.display = 'none';
}

// ── View rotation (display-only — does NOT change the JPEG or the print) ─────
async function rotateLightbox() {
  _lbRotation = (_lbRotation + 90) % 360;
  applyLbRotation();
  if (!_lbMeta) return;
  _lbMeta.rotate = _lbRotation || undefined;
  if (_lbRotation === 0) delete _lbMeta.rotate;
  // Reflect the new rotation on the gallery grid thumbnail for this photo.
  const grid = document.getElementById('photo-grid');
  if (grid) {
    const tiles = Array.from(grid.querySelectorAll('.photo-tile'));
    const idx   = _gallery.indexOf(_lbMeta);
    if (idx >= 0 && tiles[idx]) {
      const thumb = tiles[idx].querySelector('img.photo-thumb');
      if (thumb) thumb.style.transform = `rotate(${_lbRotation}deg)`;
    }
  }
  // Persist optimistically; keep the in-memory value on network failure.
  try {
    await fetch(getActiveBase() + '/api/photos/' + _lbMeta.id + '/rotate', {
      method:      'POST',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json', ...authHeaders() },
      body:        JSON.stringify({ rotate: _lbRotation }),
    });
  } catch { /* keep optimistic value; next load() reconciles */ }
}

function applyLbRotation() {
  const content = document.getElementById('photo-lb-content');
  const img = content?.querySelector('img');
  if (!content) return;
  if (_lbRotation === 0 || _lbRotation === 180) {
    content.style.transform = _lbRotation === 0 ? '' : 'rotate(180deg)';
    updateCropOverlay();
    return;
  }
  // 90° / 270°: rotate the content box, then scale so it still fits the viewport.
  // The crop overlay is a child of the content box and rotates with it.
  const cW = content.clientWidth, cH = content.clientHeight;
  if (!img || !img.naturalWidth || !img.naturalHeight || !cW || !cH) {
    content.style.transform = `rotate(${_lbRotation}deg)`;
    updateCropOverlay();
    return;
  }
  const nW = img.naturalWidth, nH = img.naturalHeight;
  const fit = Math.min(cW / nW, cH / nH);   // contained size at 0°
  const rW = nW * fit, rH = nH * fit;
  const s  = Math.min(cW / rH, cH / rW);    // fit the swapped bounding box
  content.style.transform = `rotate(${_lbRotation}deg) scale(${s})`;
  updateCropOverlay();
}

function closeLightbox() {
  // Always exit crop mode first (cleans up drag handlers + class).
  if (_cropMode) exitCropMode();
  const lb = document.getElementById('photo-lightbox');
  if (lb) lb.hidden = true;
  const content = document.getElementById('photo-lb-content');
  if (content) {
    content.style.transform = '';
    Array.from(content.children).forEach(c => { if (c.id !== 'photo-lb-crop-overlay') c.remove(); });
  }
  clearCropOverlay();
  if (_lbUrl) { URL.revokeObjectURL(_lbUrl); _lbUrl = null; }
  document.body.style.overflow = '';
  _lbMeta  = null;
  _lbIndex = -1;
  _lbRotation = 0;
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
    // Must be in the DOM for Safari/Firefox; defer revoke so it doesn't cancel
    // the download the browser starts asynchronously.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
      const qs = new URLSearchParams({
        name:   file.name,
        ts:     String(ts),
        folder: currentFolder,
      }).toString();
      await api('?' + qs, {
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

// ── Folder navigation + management ────────────────────────────────────────────

/** Sets currentFolder and reloads the view. */
function enterFolder(path) {
  currentFolder = path;
  closeMenu();
  load();
}

/** Goes one level up. */
function exitFolder() {
  currentFolder = parentFolder(currentFolder);
  closeMenu();
  load();
}

/** Prompts the user for a folder name and creates it via the API. */
async function createFolderInteractive() {
  closeMenu();
  if (folderDepth(currentFolder) >= MAX_FOLDER_DEPTH) {
    setStatus(`Maximal ${MAX_FOLDER_DEPTH} Ebenen — hier kein Unterordner möglich.`, true);
    return;
  }
  const raw = prompt('Name für den neuen Ordner:');
  if (raw == null) return; // user cancelled
  const name = raw.trim();
  if (!name) return;
  // Client-side check to give an instant error; server enforces the same rules.
  if (!/^[A-Za-z0-9_ \-äöüÄÖÜß]{1,40}$/.test(name) || name.includes('/')) {
    setStatus('Ungültiger Name — erlaubt sind Buchstaben, Zahlen, Leerzeichen, _ und -.', true);
    return;
  }
  const target = currentFolder ? `${currentFolder}/${name}` : name;
  try {
    await folderApi({
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ folder: target }),
    });
    setStatus(`Ordner „${name}" angelegt.`);
    await load();
  } catch (e) {
    setStatus('Anlegen fehlgeschlagen: ' + e.message, true);
  }
}

/** Deletes the current folder (empty only). On success, jumps up one level. */
async function deleteFolderInteractive() {
  closeMenu();
  if (!currentFolder) return;
  if (!confirm(`Ordner „${folderLeafName(currentFolder)}" wirklich löschen?`)) return;
  try {
    await folderApi({ method: 'DELETE' }, '?folder=' + encodeURIComponent(currentFolder));
    setStatus('Ordner gelöscht.');
    currentFolder = parentFolder(currentFolder);
    await load();
  } catch (e) {
    setStatus('Löschen fehlgeschlagen: ' + e.message, true);
  }
}

// ── Kebab (⋮) menu ────────────────────────────────────────────────────────────

function toggleMenu() {
  const list = document.getElementById('photo-menu-list');
  const btn  = document.getElementById('photo-menu-btn');
  const open = list.hidden;
  list.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}

function closeMenu() {
  const list = document.getElementById('photo-menu-list');
  const btn  = document.getElementById('photo-menu-btn');
  if (!list.hidden) {
    list.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Loads the folder list + the photos of the current folder from the server,
 * then renders everything. Shows the offline banner if the local server is
 * not reachable.
 */
async function load() {
  renderHeader();

  if (!(await isLocalAvailable())) {
    setOffline(true);
    folderList = [];
    renderFolders();
    renderGrid([]);
    renderMenu();
    return;
  }
  setOffline(false);

  try {
    // Fetch folders + photos in parallel — both depend only on the server,
    // not on each other.
    const [foldersResp, photosResp] = await Promise.all([
      folderApi({ method: 'GET' }),
      api('?folder=' + encodeURIComponent(currentFolder)),
    ]);
    folderList = await foldersResp.json();
    const photos = await photosResp.json();
    renderFolders();
    renderGrid(photos);
    renderMenu();
  } catch {
    setOffline(true);
    folderList = [];
    renderFolders();
    renderGrid([]);
    renderMenu();
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Wires up the upload button, file input, folder navigation, and kebab menu,
 * then loads the gallery. Called once by app.js during boot.
 */
export function initPhotos() {
  const input = document.getElementById('photo-input');

  document.getElementById('photo-upload-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    uploadFiles(input.files);
    input.value = ''; // allow re-selecting the same file later
  });

  document.getElementById('photo-back-btn').addEventListener('click', exitFolder);

  document.getElementById('photo-menu-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleMenu();
  });
  document.getElementById('photo-menu-newfolder').addEventListener('click', createFolderInteractive);
  document.getElementById('photo-menu-delfolder').addEventListener('click', deleteFolderInteractive);

  // Click anywhere outside the menu closes it.
  document.addEventListener('click', e => {
    if (!e.target.closest('#photo-menu')) closeMenu();
  });

  // Refresh the gallery whenever the user navigates to the Photos tab — forces
  // a fresh health-check so photos appear immediately after joining home WiFi.
  window.addEventListener('pwa:page', e => {
    if (e.detail === 'photos') { invalidateLocal(); load(); }
  });

  // Reload when the device comes back onto the home network.
  window.addEventListener('online', () => { invalidateLocal(); load(); });

  // Lightbox controls: close, download, tap-backdrop, nav arrows, swipe, Escape/arrow keys.
  document.getElementById('photo-lb-close')?.addEventListener('click', closeLightbox);
  document.getElementById('photo-lb-dl')?.addEventListener('click', () => { if (_lbMeta) downloadPhoto(_lbMeta); });
  document.getElementById('photo-lb-print')?.addEventListener('click', () => { if (_lbMeta) printPhoto(_lbMeta); });
  document.getElementById('photo-lb-rotate')?.addEventListener('click', rotateLightbox);
  document.getElementById('photo-lb-like')?.addEventListener('click', () => {
    const btn = document.getElementById('photo-lb-like');
    if (_lbMeta && btn) toggleLike(_lbMeta, btn);
  });

  // Abschicken: confirm paper insertion, then send the crop to the server.
  document.getElementById('photo-lb-send')?.addEventListener('click', () => {
    if (!_lbMeta || !_cropMode) return;
    if (!confirm('Auf dem Heimdrucker drucken?\n\nBitte Fotopapier mit Druckseite nach unten einlegen.')) return;
    const meta = _lbMeta;
    const crop = _cropRect ? { ..._cropRect } : null;
    doPrint(meta, crop);
    exitCropMode();
  });

  // Abbrechen: leave crop mode without printing.
  document.getElementById('photo-lb-crop-cancel')?.addEventListener('click', () => {
    if (_cropMode) exitCropMode();
  });

  document.getElementById('photo-lb-prev')?.addEventListener('click', e => { e.stopPropagation(); prev(); });
  document.getElementById('photo-lb-next')?.addEventListener('click', e => { e.stopPropagation(); next(); });

  // Backdrop click: only close the lightbox when NOT in crop mode.
  document.getElementById('photo-lightbox')?.addEventListener('click', e => {
    if (_cropMode) return;
    const lb = document.getElementById('photo-lightbox');
    if (e.target === lb || e.target === document.getElementById('photo-lb-content')) closeLightbox();
  });
  const lbEl = document.getElementById('photo-lightbox');
  if (lbEl) {
    let swipeX = 0, swipeY = 0;
    lbEl.addEventListener('touchstart', e => {
      if (e.target.closest('button')) return;
      // Crop drag is handled separately on the content element; ignore here.
      if (_cropMode) return;
      swipeX = e.touches[0].clientX; swipeY = e.touches[0].clientY;
    }, { passive: true });
    lbEl.addEventListener('touchend', e => {
      if (e.target.closest('button')) return;
      if (_cropMode) return;
      const dx = e.changedTouches[0].clientX - swipeX;
      const dy = e.changedTouches[0].clientY - swipeY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) dx < 0 ? next() : prev();
    }, { passive: true });
  }
  document.addEventListener('keydown', e => {
    if (document.getElementById('photo-lightbox')?.hidden) return;
    if (e.key === 'Escape') {
      // In crop mode Escape cancels the crop instead of closing the lightbox.
      if (_cropMode) { exitCropMode(); return; }
      closeLightbox();
      return;
    }
    // Arrow keys are disabled in crop mode (drag is the only pan mechanism).
    if (_cropMode) return;
    if (e.key === 'ArrowLeft')  prev();
    if (e.key === 'ArrowRight') next();
  });

  // Recompute crop overlay on resize (e.g. device rotate, window resize).
  // updateCropOverlay guards on _cropMode internally.
  window.addEventListener('resize', () => {
    if (!document.getElementById('photo-lightbox')?.hidden) applyLbRotation();
  });

  load();
}
