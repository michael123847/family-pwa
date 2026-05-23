/**
 * todo.js — Shopping / TODO list with full offline support.
 *
 * Architecture — three layers:
 *
 *  1. Local state (in-memory array `todos`)
 *     Every change is applied here immediately so the UI always feels instant.
 *
 *  2. localStorage cache (`pwa.todos.cache`)
 *     The local state is written to localStorage after every change. This
 *     makes the list available the next time the app opens, even offline.
 *
 *  3. Pending queue (`pwa.todos.pending`)
 *     When the local server is not reachable, changes are recorded in a queue
 *     instead of being discarded. On the next successful connection the queue
 *     is replayed against the server in order.
 *
 * Offline item IDs:
 *  Items added while offline are assigned a temporary ID with the prefix
 *  "tmp-" (e.g. "tmp-3f2a..."). When the item is synced to the server the
 *  real UUID returned by the server replaces the temporary ID everywhere —
 *  both in the local state and in any pending operations that reference it.
 *
 * Optimistic UI:
 *  All mutations (add, toggle, delete, edit) update the local state and
 *  re-render immediately, without waiting for the server. If the server call
 *  fails, the change is added to the pending queue for later sync.
 *
 * Ultrasound (peer-to-peer over sound):
 *  When ultrasound mode is on, a newly added item is also broadcast as sound
 *  via the shared UltrasoundChannel; nearby devices decode it and add it —
 *  with no server at all. Only adds travel this way; toggle/edit/delete
 *  reconcile via the server, which stays the source of truth.
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, invalidateLocal, authHeaders, getBaseUrl } from '../localBridge.js';
import { clearToken } from '../auth.js';
import { UltrasoundChannel } from '../ultrasoundChannel.js';

// localStorage keys
const CACHE_KEY   = 'pwa.todos.cache';   // last known list state
const PENDING_KEY = 'pwa.todos.pending'; // operations waiting to be synced

// Separator between id and text in the ultrasound envelope. A TODO envelope
// has exactly one separator (2 fields) — that field count tells it apart from
// other subapps' payloads on the shared microphone.
const US_SEP = '';

// In-memory state — always kept in sync with localStorage.
let todos        = [];
let pendingQueue = [];
let usChannel    = null;   // UltrasoundChannel — shares new items over sound
let usAvailable  = false;  // whether ggwave/microphone are usable on this device

// ── Persistence ───────────────────────────────────────────────────────────────

/** Saves the current todo array to localStorage. */
function saveCache()   { localStorage.setItem(CACHE_KEY,   JSON.stringify(todos)); }

/** Reads the cached todo array from localStorage. Returns [] if nothing is stored. */
function readCache()   { try { return JSON.parse(localStorage.getItem(CACHE_KEY)   || '[]'); } catch { return []; } }

/** Saves the current pending queue to localStorage. */
function savePending() { localStorage.setItem(PENDING_KEY, JSON.stringify(pendingQueue)); }

/** Reads the pending queue from localStorage. Returns [] if nothing is stored. */
function readPending() { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; } }

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Escapes HTML special characters to prevent XSS attacks.
 * User-supplied text (todo labels) must never be inserted into the DOM as raw
 * HTML — always escape first.
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Returns true for items that have not yet been synced to the server. */
function isTemp(id) { return String(id).startsWith('tmp-'); }

/** Adds an operation to the pending queue and persists it immediately. */
function enqueue(op) { pendingQueue.push(op); savePending(); }

/**
 * Shows or hides the offline banner below the add-input field.
 * When there are pending operations, the banner text shows how many changes
 * are waiting to be synced.
 */
function setOffline(offline) {
  const banner = document.getElementById('offline-banner');
  banner.classList.toggle('visible', offline);
  if (offline) {
    banner.textContent = pendingQueue.length
      ? `📵 Offline — ${pendingQueue.length} Änderung${pendingQueue.length !== 1 ? 'en' : ''} wird synchronisiert`
      : '📵 Nicht im Heim-WLAN — Änderungen werden synchronisiert';
  }
}

// ── Ultrasound (peer-to-peer over sound) ──────────────────────────────────────

/**
 * Shows/hides the ultrasound bar based on server availability.
 * Ultrasound is the no-server fallback, so the bar is only visible when the
 * server is unreachable. If the server comes back, ultrasound is disabled.
 */
function applyTodoUsVisibility(serverOnline) {
  const bar = document.getElementById('todo-us-bar');
  if (!bar) return;
  if (usAvailable && !serverOnline) {
    bar.hidden = false;
  } else {
    if (usChannel?.enabled) { usChannel.disable(); syncTodoUsUi(); }
    bar.hidden = true;
  }
}

/** Shows a short status message in the TODO ultrasound bar. */
function setTodoUsStatus(text, isError = false) {
  const el = document.getElementById('todo-us-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

/** Updates the ultrasound buttons to reflect the channel's current state. */
function syncTodoUsUi() {
  const btn  = document.getElementById('todo-us-toggle');
  const freq = document.getElementById('todo-us-freq');
  btn.classList.toggle('active', usChannel.enabled);
  btn.textContent  = usChannel.enabled ? '📡 Ultraschall an' : '📡 Ultraschall';
  freq.hidden      = !usChannel.enabled;
  freq.textContent = usChannel.audible ? 'Modus: hörbar' : 'Modus: Ultraschall';
}

/** Switches ultrasound mode on/off (microphone listening + broadcasting adds). */
async function toggleTodoUltrasound() {
  await usChannel.toggle();
  syncTodoUsUi();
}

/** Flips the send protocol between ultrasound and audible. */
function toggleTodoFreq() {
  usChannel.setMode(!usChannel.audible);
  syncTodoUsUi();
}

/**
 * Broadcasts a newly added item as sound. The item also follows the normal
 * server path — ultrasound is just an extra hop so nearby devices see it even
 * with no server. Oversized items are skipped (they still reach the server).
 */
function broadcastItem(item) {
  const envelope = item.id + US_SEP + item.text;
  if (new TextEncoder().encode(envelope).length > usChannel.maxBytes) {
    setTodoUsStatus('⚠️ Eintrag zu lang für Ultraschall — nur über Server', true);
    return;
  }
  usChannel.send(envelope); // the channel reports its own status
}

/**
 * Handles a payload decoded from the microphone. A TODO envelope has exactly
 * two fields (id + text) — that field count tells it apart from other subapps'
 * payloads on the shared microphone, which are simply ignored here.
 *
 * Deduplicates by id (also drops a device hearing its own broadcast). The home
 * server stays the source of truth and reconciles the list on the next sync.
 */
function onUltrasoundItem(str) {
  const parts = String(str).split(US_SEP);
  if (parts.length !== 2) return; // not a TODO envelope — ignore
  const [id, text] = parts;
  if (!id || !text || todos.some(t => t.id === id)) return;

  todos.unshift({ id, text, done: false });
  saveCache();
  render();
}

// ── Raw API ───────────────────────────────────────────────────────────────────

/**
 * Sends a single HTTP request to the todo API endpoint.
 * Does NOT fall back to offline — throws on failure so callers can decide
 * whether to enqueue the operation.
 *
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {object} [body] - Request body (omitted for GET).
 * @returns {Promise<object|null>} Parsed JSON response, or null for DELETE.
 */
async function apiRaw(method, body) {
  const r = await fetch(getBaseUrl() + CONFIG.LOCAL_TODO_PATH, {
    method,
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body:    body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'omit', // never send cookies to the local server
  });

  if (r.status === 401) {
    // Token was rejected — clear it and reload so auth.js prompts again.
    clearToken();
    location.reload();
  }

  if (!r.ok) {
    invalidateLocal(); // force a fresh health check on the next call
    throw new Error('HTTP_' + r.status);
  }

  return method === 'DELETE' ? null : r.json();
}

// ── Render ────────────────────────────────────────────────────────────────────

/**
 * Re-renders the entire todo list from the current `todos` array.
 *
 * Items with a temporary ID (added offline, not yet synced) get the CSS
 * class "pending" which shows them with a yellow border.
 *
 * Event handlers for toggle, delete, and edit are attached via global
 * window.__todo* functions because the items are rendered as an innerHTML
 * string, not as live DOM nodes with addEventListener.
 */
function render() {
  const list  = document.getElementById('todo-list');
  const empty = document.getElementById('todo-empty');

  if (!todos.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = todos.map(item => `
    <div class="todo-item${item.done ? ' done' : ''}${isTemp(item.id) ? ' pending' : ''}">
      <span class="todo-text"
            contenteditable="true" spellcheck="false"
            onblur="window.__todoEdit('${item.id}',this,'${esc(item.text)}')"
            onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}"
      >${esc(item.text)}</span>
      <button class="done-btn" onclick="window.__todoToggle('${item.id}',${item.done})">
        ${item.done ? 'Erledigt' : 'Done'}
      </button>
      <button class="del-btn" onclick="window.__todoDelete('${item.id}')" title="Löschen">✕</button>
    </div>`).join('');
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * Replays all pending operations against the server in order.
 *
 * ID mapping: when an "add" operation succeeds, the server returns a real UUID.
 * That UUID is stored in idMap so that subsequent operations on the same item
 * (toggle, edit, delete) can be sent with the correct ID.
 *
 * Operations that fail are kept in the queue for the next sync attempt.
 * Operations on items with temporary IDs that were never successfully created
 * are skipped (the server would not know them).
 */
async function syncPending() {
  if (!pendingQueue.length) return;

  const idMap  = {}; // maps tempId → real server-assigned UUID
  const failed = []; // operations that could not be synced this time

  for (const op of pendingQueue) {
    // Resolve the ID: if a previous "add" op mapped this temp ID, use the real ID.
    const id = idMap[op.id] ?? op.id;
    try {
      if (op.op === 'add') {
        const item    = await apiRaw('POST', { text: op.text });
        idMap[op.id]  = item.id; // remember the mapping for subsequent ops
        // Update the in-memory list so the temp ID is replaced with the real one.
        todos = todos.map(t => t.id === op.id ? { ...t, id: item.id } : t);
        saveCache();

      } else if (op.op === 'toggle') {
        // Skip if the item still has a temp ID (the add must have failed earlier).
        if (!isTemp(id)) await apiRaw('PUT', { id, done: op.done });

      } else if (op.op === 'edit') {
        if (!isTemp(id)) await apiRaw('PUT', { id, text: op.text });

      } else if (op.op === 'delete') {
        if (!isTemp(id)) await apiRaw('DELETE', { id });
      }
    } catch {
      // Keep the operation with the resolved ID so it can be retried later.
      failed.push({ ...op, id });
    }
  }

  pendingQueue = failed;
  savePending();
}

// ── Load ──────────────────────────────────────────────────────────────────────

/**
 * Loads the todo list. Always called on startup and when the device comes
 * back online.
 *
 * Flow:
 *  1. Render the cached list immediately so the screen is never empty.
 *  2. If the local server is reachable: sync pending ops, then fetch fresh data.
 *  3. If the server is not reachable: show the cached list with the offline banner.
 */
async function load() {
  // Show the cache immediately — avoids a blank list while the health check runs.
  todos = readCache();
  render();

  if (await isLocalAvailable()) {
    await syncPending();
    try {
      todos = await apiRaw('GET');
      saveCache();
      setOffline(false);
    } catch {
      setOffline(true);
    }
  } else {
    setOffline(true);
  }
  render();
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Toggles the done state of a todo item.
 * Updates locally first, then tries the server. If the server is offline,
 * the operation is enqueued.
 */
window.__todoToggle = async (id, wasDone) => {
  const newDone = !wasDone;
  todos = todos.map(t => t.id === id ? { ...t, done: newDone } : t);
  saveCache();
  render();
  if (await isLocalAvailable()) {
    try { await apiRaw('PUT', { id, done: newDone }); return; } catch {}
  }
  enqueue({ op: 'toggle', id, done: newDone });
  setOffline(true);
};

/**
 * Deletes a todo item.
 * If the item was added offline and has a temp ID, it is simply removed from
 * the local state and the queue — no server call is needed.
 */
window.__todoDelete = async (id) => {
  todos = todos.filter(t => t.id !== id);
  saveCache();
  render();

  if (isTemp(id)) {
    // The item was never saved to the server — remove all queued ops for it.
    pendingQueue = pendingQueue.filter(op => op.id !== id);
    savePending();
    return;
  }

  if (await isLocalAvailable()) {
    try { await apiRaw('DELETE', { id }); return; } catch {}
  }
  enqueue({ op: 'delete', id });
};

/**
 * Saves an inline edit of a todo item's text.
 * The contenteditable span calls this on blur (when the user clicks away).
 * If the user clears the text entirely, the original text is restored.
 */
window.__todoEdit = async (id, el, original) => {
  const text = el.textContent.trim();
  if (!text) { el.textContent = original; return; }
  todos = todos.map(t => t.id === id ? { ...t, text } : t);
  saveCache();
  if (await isLocalAvailable()) {
    try { await apiRaw('PUT', { id, text }); return; } catch {}
  }
  enqueue({ op: 'edit', id, text });
};

/**
 * Adds a new todo item.
 * A temporary ID is assigned immediately so the item can be rendered and
 * referenced by subsequent offline operations before the server responds.
 */
async function doAdd(text) {
  text = text.trim();
  if (!text) return;

  const tempId = 'tmp-' + crypto.randomUUID();
  const item   = { id: tempId, text, done: false };
  todos.unshift(item);
  saveCache();
  render();

  if (usChannel?.enabled) broadcastItem(item); // also emit over sound

  if (await isLocalAvailable()) {
    try {
      const created = await apiRaw('POST', { text });
      // Replace the temporary ID with the real server-assigned UUID.
      todos = todos.map(t => t.id === tempId ? { ...t, id: created.id } : t);
      saveCache();
      render();
      return;
    } catch {}
  }
  enqueue({ op: 'add', id: tempId, text });
  setOffline(true);
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Wires up the add-button and input field, then loads the initial list.
 * Called once by app.js during boot.
 */
export async function initTodo() {
  // Restore any pending operations that survived a page reload.
  pendingQueue = readPending();

  const input = document.getElementById('todo-input');
  document.getElementById('add-btn').addEventListener('click', () => {
    doAdd(input.value); input.value = ''; input.focus();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { doAdd(input.value); input.value = ''; }
  });

  // Ultrasound — the TODO list reuses the shared UltrasoundChannel so new
  // items can spread between devices with no server. The bar is hidden if
  // the ggwave library is unavailable.
  usChannel = new UltrasoundChannel({
    name:      'todo',
    onMessage: onUltrasoundItem,
    onStatus:  setTodoUsStatus,
  });
  usAvailable = await usChannel.available();
  if (usAvailable) {
    document.getElementById('todo-us-toggle').addEventListener('click', toggleTodoUltrasound);
    document.getElementById('todo-us-freq').addEventListener('click', toggleTodoFreq);
    syncTodoUsUi();
  }
  document.getElementById('todo-us-bar').hidden = true; // hidden until server status known
  window.addEventListener('pwa:server', e => applyTodoUsVisibility(e.detail));
  // updateLocalStatus() may have already fired before this listener was registered;
  // apply the cached result immediately so the bar never flickers visible.
  isLocalAvailable().then(online => applyTodoUsVisibility(online));

  // Refresh the list whenever the user navigates to the TODO tab — forces a
  // fresh health-check so the list appears immediately after joining home WiFi.
  window.addEventListener('pwa:page', e => {
    if (e.detail === 'todo') { invalidateLocal(); load(); }
  });

  // When the browser reports it is back online, invalidate the health-check
  // cache and reload — this triggers a sync of any pending operations.
  window.addEventListener('online', () => { invalidateLocal(); load(); });

  load();
}
