/**
 * share.js — Allzweck-Dateiablage backed by the local WLAN server.
 *
 * A parallel implementation to photos.js for arbitrary file types up to 10 MB.
 * Key differences from photos:
 *  - Any file type accepted (no MIME filter)
 *  - The on-disk filename is the original upload name (sanitised only against
 *    Windows-illegal chars), so the share folder is usable from File Explorer
 *  - Same 2-level folder model + ⋮ menu for create/delete
 *  - No thumbnails — list view with file icon + name + size
 *  - Filename conflicts trigger a Windows-style modal: Ersetzen / Beide
 *    behalten / Abbrechen
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, invalidateLocal, authHeaders, getActiveBase } from '../localBridge.js';
import { clearToken } from '../auth.js';

// Computed lazily — see localBridge.getActiveBase() / probeBase().
const shareUrl   = () => getActiveBase() + CONFIG.LOCAL_SHARE_PATH;
const foldersUrl = () => shareUrl() + '/folders';

const MAX_FOLDER_DEPTH = 2;
const MAX_BYTES        = 10 * 1024 * 1024;

let currentFolder = '';        // "" = root
let folderList    = [];        // [{ path, fileCount }, ...]

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  const el = document.getElementById('share-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function setOffline(offline) {
  document.getElementById('share-offline-banner')?.classList.toggle('visible', offline);
}

function fmtSize(bytes) {
  if (bytes < 1024)              return bytes + ' B';
  if (bytes < 1024 * 1024)       return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function folderDepth(folder)   { return folder ? folder.split('/').length : 0; }
function parentFolder(folder)  { const i = folder.lastIndexOf('/'); return i < 0 ? '' : folder.slice(0, i); }
function folderLeafName(f)     { const i = f.lastIndexOf('/'); return i < 0 ? f : f.slice(i + 1); }

/** Crude file-icon guess from extension. Falls back to a neutral page icon. */
function fileIconFor(name) {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (['jpg','jpeg','png','gif','webp','heic','bmp'].includes(ext))    return '🖼️';
  if (['mp4','mov','mkv','avi','webm'].includes(ext))                  return '🎬';
  if (['mp3','wav','flac','ogg','m4a'].includes(ext))                  return '🎵';
  if (['zip','7z','rar','tar','gz','tgz'].includes(ext))               return '📦';
  if (['pdf'].includes(ext))                                           return '📕';
  if (['doc','docx','odt','rtf'].includes(ext))                        return '📄';
  if (['xls','xlsx','ods','csv'].includes(ext))                        return '📊';
  if (['ppt','pptx','odp','key'].includes(ext))                        return '📽️';
  if (['txt','md','log'].includes(ext))                                return '📝';
  return '📄';
}

async function api(path, opts = {}) {
  const r = await fetch(shareUrl() + path, {
    credentials: 'omit',
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  if (r.status === 401) { clearToken(); location.reload(); }
  return r; // caller checks .ok — needed because 409 has a useful body
}

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

function renderHeader() {
  document.getElementById('share-back-btn').hidden = (currentFolder === '');
  document.getElementById('share-breadcrumb').textContent = currentFolder
    ? 'Share › ' + currentFolder.split('/').join(' › ')
    : 'Share';
}

function renderMenu() {
  const newBtn = document.getElementById('share-menu-newfolder');
  const delBtn = document.getElementById('share-menu-delfolder');

  newBtn.hidden = (folderDepth(currentFolder) >= MAX_FOLDER_DEPTH);

  let canDelete = false;
  if (currentFolder !== '') {
    const meta      = folderList.find(f => f.path === currentFolder);
    const hasFiles  = meta ? meta.fileCount > 0 : false;
    const hasChild  = folderList.some(f => f.path.startsWith(currentFolder + '/'));
    canDelete = !hasFiles && !hasChild;
  }
  delBtn.hidden = !canDelete;
}

function renderFolders() {
  const row    = document.getElementById('share-folders');
  const prefix = currentFolder ? currentFolder + '/' : '';
  const kids = folderList.filter(f =>
    f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/')
  );

  row.innerHTML = '';
  for (const f of kids) {
    const tile = document.createElement('button');
    tile.className = 'photo-folder-tile';
    tile.dataset.path = f.path;
    tile.innerHTML = `
      <span class="photo-folder-icon">📁</span>
      <span class="photo-folder-name">${folderLeafName(f.path)}</span>
      <span class="photo-folder-count">${f.fileCount}</span>`;
    tile.addEventListener('click', () => enterFolder(f.path));
    row.appendChild(tile);
  }
}

function renderList(items) {
  const list  = document.getElementById('share-list');
  const empty = document.getElementById('share-empty');
  const foldersHasKids = document.getElementById('share-folders').children.length > 0;

  list.innerHTML = '';
  empty.style.display = (items.length || foldersHasKids) ? 'none' : 'block';

  for (const meta of items) {
    const row = document.createElement('div');
    row.className = 'share-row';

    row.innerHTML = `
      <span class="share-icon">${fileIconFor(meta.name)}</span>
      <span class="share-name" title="${esc(meta.name)}">${esc(meta.name)}</span>
      <span class="share-size">${fmtSize(meta.size)}</span>`;

    const dl = document.createElement('button');
    dl.className = 'photo-dl';
    dl.textContent = '↓';
    dl.title = 'Herunterladen';
    dl.addEventListener('click', () => downloadFile(meta));

    const pr = document.createElement('button');
    pr.className = 'photo-print';
    pr.textContent = '🖨';
    pr.title = 'Drucken';
    pr.addEventListener('click', () => printFile(meta));

    const del = document.createElement('button');
    del.className = 'photo-del';
    del.textContent = '✕';
    del.title = 'Löschen';
    del.addEventListener('click', () => deleteFile(meta));

    row.append(dl, pr, del);
    list.appendChild(row);
  }
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                  .replace(/"/g, '&quot;');
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function downloadFile(meta) {
  try {
    const r = await api('/' + meta.id);
    if (!r.ok) throw new Error('HTTP_' + r.status);
    const blob = await r.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = meta.name;
    // The anchor MUST be in the DOM for click() to trigger a download in
    // Safari/Firefox (Chrome tolerates a detached node). Revoke is deferred so
    // it doesn't cancel the download that the browser starts asynchronously.
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    setStatus('Download fehlgeschlagen.', true);
  }
}

async function printFile(meta) {
  setStatus('Drucke „' + meta.name + '" …');
  try {
    const r = await fetch(getActiveBase() + '/api/print', {
      method:      'POST',
      credentials: 'omit',
      headers:     { 'Content-Type': 'application/json', ...authHeaders() },
      body:        JSON.stringify({ source: 'share', id: meta.id }),
    });
    if (r.ok) { setStatus('An den Drucker gesendet: ' + meta.name); return; }
    const b = await r.json().catch(() => ({}));
    setStatus(b.error || ('Druck fehlgeschlagen (HTTP ' + r.status + ').'), true);
  } catch {
    setStatus('Druck fehlgeschlagen — Server nicht erreichbar.', true);
  }
}

async function deleteFile(meta) {
  if (!confirm(`Datei „${meta.name}" wirklich löschen?`)) return;
  try {
    const r = await api('/' + meta.id, { method: 'DELETE' });
    if (!r.ok) throw new Error('HTTP_' + r.status);
    setStatus('Datei gelöscht.');
    load();
  } catch {
    setStatus('Löschen fehlgeschlagen.', true);
  }
}

/** Uploads one file. On 409 (conflict) returns the existing meta so the caller can prompt the user. */
async function uploadOne(file, onConflict) {
  if (file.size > MAX_BYTES) {
    return { error: `„${file.name}" überschreitet das 10 MB-Limit.` };
  }
  const qs = new URLSearchParams({
    name:       file.name,
    folder:     currentFolder,
    onConflict,
  }).toString();
  const r = await api('?' + qs, {
    method:  'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body:    file,
  });
  if (r.status === 409) {
    const body = await r.json().catch(() => ({}));
    return { conflict: body.existing };
  }
  if (!r.ok) {
    return { error: 'Upload fehlgeschlagen (HTTP ' + r.status + ').' };
  }
  return { ok: true };
}

/** Promise that resolves with the user's choice from the conflict dialog. */
function askConflict(filename) {
  return new Promise(resolve => {
    const dialog   = document.getElementById('share-conflict-dialog');
    const backdrop = document.getElementById('share-conflict-backdrop');
    const msg      = document.getElementById('share-conflict-message');
    msg.textContent = `„${filename}" existiert bereits in diesem Ordner.`;
    dialog.hidden   = false;
    backdrop.hidden = false;

    const pick = choice => {
      dialog.hidden   = true;
      backdrop.hidden = true;
      replaceBtn.removeEventListener('click', onReplace);
      renameBtn .removeEventListener('click', onRename);
      cancelBtn .removeEventListener('click', onCancel);
      backdrop  .removeEventListener('click', onCancel);
      resolve(choice);
    };
    const replaceBtn = document.getElementById('share-conflict-replace');
    const renameBtn  = document.getElementById('share-conflict-rename');
    const cancelBtn  = document.getElementById('share-conflict-cancel');
    const onReplace = () => pick('overwrite');
    const onRename  = () => pick('rename');
    const onCancel  = () => pick(null);
    replaceBtn.addEventListener('click', onReplace);
    renameBtn .addEventListener('click', onRename);
    cancelBtn .addEventListener('click', onCancel);
    backdrop  .addEventListener('click', onCancel);
  });
}

/**
 * Uploads each selected file. Conflicts trigger the modal one-by-one so the
 * user can choose Ersetzen / Beide behalten / Abbrechen per file.
 */
async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;

  if (!(await isLocalAvailable())) {
    setOffline(true);
    setStatus('Upload nicht möglich — nicht im Heim-WLAN.', true);
    return;
  }

  let done = 0, skipped = 0, errors = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    setStatus(`Lade hoch… (${i + 1}/${files.length}) ${file.name}`);
    let result = await uploadOne(file, 'reject');

    if (result.conflict) {
      const choice = await askConflict(file.name);
      if (choice === null) { skipped++; continue; }
      result = await uploadOne(file, choice);
    }

    if (result.error)    { errors++;  setStatus(result.error, true); continue; }
    if (result.ok)       { done++; }
  }

  const parts = [];
  if (done)    parts.push(`${done} hochgeladen`);
  if (skipped) parts.push(`${skipped} übersprungen`);
  if (errors)  parts.push(`${errors} Fehler`);
  setStatus(parts.length ? parts.join(', ') + '.' : '', errors > 0);
  load();
}

// ── Folder navigation + management ────────────────────────────────────────────

function enterFolder(p)  { currentFolder = p; closeMenu(); load(); }
function exitFolder()    { currentFolder = parentFolder(currentFolder); closeMenu(); load(); }

async function createFolderInteractive() {
  closeMenu();
  if (folderDepth(currentFolder) >= MAX_FOLDER_DEPTH) {
    setStatus(`Maximal ${MAX_FOLDER_DEPTH} Ebenen — hier kein Unterordner möglich.`, true);
    return;
  }
  const raw = prompt('Name für den neuen Ordner:');
  if (raw == null) return;
  const name = raw.trim();
  if (!name) return;
  if (!/^[A-Za-z0-9_ \-äöüÄÖÜß]{1,40}$/.test(name) || name.includes('/')) {
    setStatus('Ungültiger Name — Buchstaben, Zahlen, Leerzeichen, _ und -.', true);
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
  const list = document.getElementById('share-menu-list');
  const btn  = document.getElementById('share-menu-btn');
  const open = list.hidden;
  list.hidden = !open;
  btn.setAttribute('aria-expanded', String(open));
}
function closeMenu() {
  const list = document.getElementById('share-menu-list');
  const btn  = document.getElementById('share-menu-btn');
  if (!list.hidden) { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
}

// ── Load ──────────────────────────────────────────────────────────────────────

async function load() {
  renderHeader();
  if (!(await isLocalAvailable())) {
    setOffline(true);
    folderList = [];
    renderFolders();
    renderList([]);
    renderMenu();
    return;
  }
  setOffline(false);
  try {
    const [foldersResp, itemsResp] = await Promise.all([
      folderApi({ method: 'GET' }),
      api('?folder=' + encodeURIComponent(currentFolder)),
    ]);
    if (!itemsResp.ok) throw new Error('HTTP_' + itemsResp.status);
    folderList   = await foldersResp.json();
    const items  = await itemsResp.json();
    renderFolders();
    renderList(items);
    renderMenu();
  } catch {
    setOffline(true);
    folderList = [];
    renderFolders();
    renderList([]);
    renderMenu();
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initShare() {
  const input = document.getElementById('share-input');

  document.getElementById('share-upload-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    uploadFiles(input.files);
    input.value = '';
  });

  document.getElementById('share-back-btn').addEventListener('click', exitFolder);

  document.getElementById('share-menu-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleMenu();
  });
  document.getElementById('share-menu-newfolder').addEventListener('click', createFolderInteractive);
  document.getElementById('share-menu-delfolder').addEventListener('click', deleteFolderInteractive);

  document.addEventListener('click', e => {
    if (!e.target.closest('#share-menu')) closeMenu();
  });

  window.addEventListener('pwa:page', e => {
    if (e.detail === 'share') { invalidateLocal(); load(); }
  });

  window.addEventListener('online', () => { invalidateLocal(); load(); });
}
