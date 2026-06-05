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

    const bar = document.createElement('div');
    bar.className = 'photo-bar';
    bar.innerHTML = `<span class="photo-name" title="${name}">${name}</span>
                     <span class="photo-size">${fmtSize(meta.size)}</span>`;

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
  } catch {
    img.classList.add('photo-thumb-failed');
    img.alt = 'Bild konnte nicht geladen werden';
  }
}

// ── Lightbox (fullscreen viewer) ────────────────────────────────────────────
// Tapping a tile opens the full-resolution image (no ?thumb) over the page.
// One object URL is kept for the open image and revoked on close.
let _lbUrl  = null;
let _lbMeta = null;

async function openLightbox(meta) {
  const lb = document.getElementById('photo-lightbox');
  if (!lb) return;
  _lbMeta = meta;
  document.getElementById('photo-lb-caption').textContent = storedName(meta);
  const content = document.getElementById('photo-lb-content');
  content.innerHTML = '';
  lb.hidden = false;
  document.body.style.overflow = 'hidden';
  try {
    const blob = await (await api('/' + meta.id)).blob(); // full image, not the thumb
    if (lb.hidden) return;                                 // closed while loading
    if (_lbUrl) URL.revokeObjectURL(_lbUrl);
    _lbUrl = URL.createObjectURL(blob);
    const img = document.createElement('img');
    img.src = _lbUrl;
    img.alt = storedName(meta);
    content.appendChild(img);
  } catch {
    content.textContent = 'Bild konnte nicht geladen werden.';
  }
}

function closeLightbox() {
  const lb = document.getElementById('photo-lightbox');
  if (lb) lb.hidden = true;
  const content = document.getElementById('photo-lb-content');
  if (content) content.innerHTML = '';
  if (_lbUrl) { URL.revokeObjectURL(_lbUrl); _lbUrl = null; }
  document.body.style.overflow = '';
  _lbMeta = null;
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

  // Lightbox controls: close button, download, tap-backdrop, and Escape.
  document.getElementById('photo-lb-close')?.addEventListener('click', closeLightbox);
  document.getElementById('photo-lb-dl')?.addEventListener('click', () => { if (_lbMeta) downloadPhoto(_lbMeta); });
  document.getElementById('photo-lightbox')?.addEventListener('click', e => {
    const lb = document.getElementById('photo-lightbox');
    if (e.target === lb || e.target === document.getElementById('photo-lb-content')) closeLightbox();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('photo-lightbox')?.hidden) closeLightbox();
  });

  load();
}
