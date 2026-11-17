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
 * Sync rules:
 *  - One load() at a time. A call while one runs only sets a flag; when the
 *    running load ends with the flag set, exactly one more run follows.
 *  - While the queue is not empty (or a load is running) a new change is
 *    queued behind the earlier ones instead of being sent past them, so the
 *    server sees the changes in the order they were made.
 *  - An op the server rejects for good (400, or 404 for an item that is gone)
 *    is dropped; any other HTTP error keeps it; a network error stops the
 *    replay and keeps this op and all later ones.
 *  - After the GET the still-queued changes are re-applied to the fetched
 *    list (applyPending), so an unsynced item never disappears.
 *
 * Display:
 *  Open items are shown above done ones, and the search field narrows the view
 *  by case-insensitive text match. Both are display-only — the stored order
 *  (newest first, as the server keeps it) is never changed.
 *
 * Ultrasound (peer-to-peer over sound):
 *  When ultrasound mode is on, a newly added item is also broadcast as sound
 *  via the shared UltrasoundChannel; nearby devices decode it and add it —
 *  with no server at all. Only adds travel this way; toggle/edit/delete
 *  reconcile via the server, which stays the source of truth.
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, invalidateLocal, authHeaders, getActiveBase } from '../localBridge.js';
import { clearToken } from '../auth.js';
import { UltrasoundChannel } from '../ultrasoundChannel.js';

// localStorage keys
const CACHE_KEY   = 'pwa.todos.cache';   // last known list state
const PENDING_KEY = 'pwa.todos.pending'; // operations waiting to be synced

// Longest item text the server accepts (the add input has the same maxlength).
const MAX_TEXT = 1000;

// Separator between id and text in the ultrasound envelope. A TODO envelope
// has exactly one separator (2 fields) — that field count tells it apart from
// other subapps' payloads on the shared microphone.
const US_SEP = '';

// In-memory state — always kept in sync with localStorage.
let todos        = [];
let pendingQueue = [];
let usChannel    = null;   // UltrasoundChannel — shares new items over sound
let usAvailable  = false;  // whether ggwave/microphone are usable on this device
let query        = '';     // text typed in the search field ('' = show everything)
let emptyDefault = '';     // the "no entries yet" text from index.html, swapped for "Keine Treffer"

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

// Adds whose POST is on the wire: temp id → promise of the real id (null if it
// failed). A delete of such an item waits for the answer, then deletes the real id.
const inflightAdds = new Map();

/** Registers the POST of an add; returns `post` unchanged for the caller to await. */
function trackAdd(tempId, post) {
  const tracked = post.then(item => item.id, () => null);
  inflightAdds.set(tempId, tracked);
  tracked.then(() => inflightAdds.delete(tempId));
  return post;
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

// An id on the wire is a client-generated UUID (crypto.randomUUID), with the
// "tmp-" prefix when the sender has not synced the item yet. The sound can come
// from any device in earshot, so anything that is not exactly that is dropped.
const US_ID_RE = /^(tmp-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Handles a payload decoded from the microphone. A TODO envelope has exactly
 * two fields (id + text) — that field count tells it apart from other subapps'
 * payloads on the shared microphone, which are simply ignored here.
 *
 * The payload is untrusted: the id must be a UUID, the text must not be blank,
 * and the whole envelope must fit what this app itself would ever send.
 * Deduplicates by id (also drops a device hearing its own broadcast). The home
 * server stays the source of truth and reconciles the list on the next sync.
 */
function onUltrasoundItem(str) {
  const parts = String(str).split(US_SEP);
  if (parts.length !== 2) return; // not a TODO envelope — ignore
  const id   = parts[0];
  const text = parts[1].trim();
  if (!US_ID_RE.test(id) || !text) return;
  if (new TextEncoder().encode(String(str)).length > usChannel.maxBytes) return;
  if (todos.some(t => t.id === id)) return;

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
  const r = await fetch(getActiveBase() + CONFIG.LOCAL_TODO_PATH, {
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
    if (r.status >= 500) invalidateLocal(); // a 4xx is an answer, not a sign the server is gone
    const err = new Error('HTTP_' + r.status);
    err.status = r.status; // absent on network errors — syncPending() tells them apart
    throw err;
  }

  return method === 'DELETE' ? null : r.json();
}

// ── Render ────────────────────────────────────────────────────────────────────

let renderDue = false; // a render() was skipped because an item text had focus

/**
 * Returns the items to display: open items first, done items below, each group
 * in the stored (newest-first) order, then narrowed by the search text.
 *
 * Display-only — `todos` itself stays in server order, so the cache, the
 * pending queue and every other client are unaffected.
 */
function visibleTodos() {
  const q       = query.trim().toLocaleLowerCase('de');
  const ordered = [...todos.filter(t => !t.done), ...todos.filter(t => t.done)];
  return q ? ordered.filter(t => String(t.text).toLocaleLowerCase('de').includes(q)) : ordered;
}

/**
 * Builds the DOM row for one item.
 *
 * The text is assigned via textContent and the handlers are closures over the
 * item, so neither the text nor the id is ever parsed as HTML or JavaScript.
 * Both can originate on another device (ultrasound) and must stay inert.
 */
function buildItem(item) {
  const row = document.createElement('div');
  row.className = 'todo-item' + (item.done ? ' done' : '') + (isTemp(item.id) ? ' pending' : '');

  const text = document.createElement('span');
  text.className       = 'todo-text';
  text.contentEditable = 'true';
  text.spellcheck      = false;
  text.textContent     = item.text;
  text.addEventListener('blur', () => todoEdit(item.id, text, item.text));
  text.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); text.blur(); }
  });

  const doneBtn = document.createElement('button');
  doneBtn.className   = 'done-btn';
  doneBtn.textContent = item.done ? 'Erledigt' : 'Done';
  doneBtn.addEventListener('click', () => todoToggle(item.id, item.done));

  const delBtn = document.createElement('button');
  delBtn.className   = 'del-btn';
  delBtn.title       = 'Löschen';
  delBtn.textContent = '✕';
  delBtn.addEventListener('click', () => todoDelete(item.id));

  row.append(text, doneBtn, delBtn);
  return row;
}

/**
 * Re-renders the todo list from the current `todos` array (visibleTodos()
 * decides what is shown and in which order).
 *
 * Items with a temporary ID (added offline, not yet synced) get the CSS
 * class "pending" which shows them with a yellow border. The empty-state text
 * reads "Keine Treffer" when entries exist but the search matches none.
 */
function render() {
  const list  = document.getElementById('todo-list');
  // Never rebuild the rows under a half-typed edit: remember it and render on blur.
  if (document.activeElement?.classList?.contains('todo-text') && list.contains(document.activeElement)) {
    renderDue = true;
    return;
  }
  renderDue = false;
  const empty = document.getElementById('todo-empty');
  const shown = visibleTodos();

  const rows = document.createDocumentFragment();
  shown.forEach(item => rows.append(buildItem(item)));
  list.replaceChildren(rows);

  empty.textContent   = todos.length ? 'Keine Treffer' : emptyDefault;
  empty.style.display = shown.length ? 'none' : 'block';
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/** Removes one operation (by identity) from the pending queue and persists it. */
function removeOp(op) {
  pendingQueue = pendingQueue.filter(o => o !== op);
  savePending();
}

/**
 * True when an op the server answered with `status` can never succeed and is
 * dropped: 400 (rejected input), or 404 for a change to an item that no
 * longer exists (deleted on another device). An add that gets 404 is kept —
 * that is a routing problem, not a verdict on the item.
 */
function isPoison(op, status) {
  return status === 400 || (status === 404 && op.op !== 'add');
}

/**
 * Re-applies the still-queued changes to a list fetched from the server, so
 * unsynced work stays visible (and in the cache) after the GET replaced the
 * list. Pure: returns a new array, `list` and `queue` are not modified.
 *
 *  add    → the item (temporary id) goes back on top
 *  toggle → done flag, edit → text
 *  delete → the item is removed
 */
function applyPending(list, queue) {
  let out = list.map(t => ({ ...t }));
  for (const op of queue) {
    if (op.op === 'add') {
      if (!out.some(t => t.id === op.id)) out.unshift({ id: op.id, text: op.text, done: false });
    } else if (op.op === 'toggle') {
      out = out.map(t => t.id === op.id ? { ...t, done: op.done } : t);
    } else if (op.op === 'edit') {
      out = out.map(t => t.id === op.id ? { ...t, text: op.text } : t);
    } else if (op.op === 'delete') {
      out = out.filter(t => t.id !== op.id);
    }
  }
  return out;
}

/**
 * Replays the pending operations against the server in order.
 *
 * ID mapping: when an "add" succeeds the server returns a real UUID, which
 * replaces the temporary id in the local list and in every queued op that
 * refers to it.
 *
 * The queue is worked off in place (not on a copy) so changes that are queued
 * while the replay runs are picked up in order. Per op:
 *  - success             → removed
 *  - 400 / 404 (poison)  → removed (see isPoison); a rejected add also takes
 *                          its queued follow-ups and the local item with it
 *  - other HTTP status   → kept, the replay goes on
 *  - network error       → this op and all later ones are kept, the replay
 *                          stops, so the order of the queue is preserved
 *  - op on a temp id whose add is still queued (it failed) → kept; with no
 *    add left it can never succeed and is dropped
 */
async function syncPending() {
  const seen = new Set();
  for (;;) {
    const op = pendingQueue.find(o => !seen.has(o));
    if (!op) break;
    seen.add(op);

    if (isTemp(op.id) && op.op !== 'add') {
      if (!pendingQueue.some(o => o.op === 'add' && o.id === op.id)) removeOp(op);
      continue;
    }

    try {
      if (op.op === 'add') {
        const item = await trackAdd(op.id, apiRaw('POST', { text: op.text }));
        pendingQueue = pendingQueue
          .filter(o => o !== op)
          .map(o => o.id === op.id ? { ...o, id: item.id } : o);
        savePending();
        todos = todos.map(t => t.id === op.id ? { ...t, id: item.id } : t);
        saveCache();
      } else {
        if (op.op === 'toggle')      await apiRaw('PUT', { id: op.id, done: op.done });
        else if (op.op === 'edit')   await apiRaw('PUT', { id: op.id, text: op.text });
        else if (op.op === 'delete') await apiRaw('DELETE', { id: op.id });
        removeOp(op);
      }
    } catch (e) {
      if (e.status === undefined) return;          // network error: stop, keep the order
      if (!isPoison(op, e.status)) continue;       // other HTTP error: keep, try later
      if (op.op === 'add') {
        pendingQueue = pendingQueue.filter(o => o.id !== op.id);
        savePending();
        todos = todos.filter(t => t.id !== op.id);
        saveCache();
      } else {
        removeOp(op);
      }
    }
  }
}

// ── Load ──────────────────────────────────────────────────────────────────────

let loading     = null;   // promise of the running load(), null when idle
let reloadAgain = false;  // a load() was requested while one was running

/**
 * One pass: render the cache, sync the queue, fetch the list, render it.
 *
 *  1. Render the cached list immediately so the screen is never empty.
 *  2. If the local server is reachable: sync pending ops, then fetch fresh
 *     data and lay the still-queued changes over it.
 *  3. If the server is not reachable: keep the cached list, show the banner.
 */
async function loadOnce() {
  // Show the cache immediately — avoids a blank list while the health check runs.
  todos = readCache();
  render();

  if (await isLocalAvailable()) {
    await syncPending();
    try {
      todos = applyPending(await apiRaw('GET'), pendingQueue);
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

/**
 * Loads the todo list. Called on startup, on every switch to the TODO tab and
 * when the device comes back online — so calls overlap. Only one pass runs at
 * a time (two would POST the same queued add twice); a call while one runs
 * sets a flag and exactly one more pass follows it.
 */
function load() {
  if (loading) { reloadAgain = true; return loading; }
  loading = (async () => {
    try {
      do { reloadAgain = false; await loadOnce(); } while (reloadAgain);
    } finally {
      loading = null;
    }
  })();
  return loading;
}

// ── Mutations ─────────────────────────────────────────────────────────────────

/**
 * Sends one change to the server now, or queues it.
 *
 * It goes out directly only when nothing is queued and no load is running;
 * otherwise (or when the send fails) it is queued behind the earlier changes
 * and a load is triggered, which replays the queue in order.
 *
 * @param {object}   op   - the queue entry ({op, id, ...})
 * @param {Function} send - performs the direct request; throws on failure
 */
async function commit(op, send) {
  const idle = () => !pendingQueue.length && !loading;
  if (idle() && await isLocalAvailable() && idle()) {
    try { await send(); return; } catch { /* queue it below */ }
  }
  if (op.op === 'add' && !todos.some(t => t.id === op.id)) return; // deleted meanwhile
  enqueue(op);
  load(); // syncs when the server is reachable, otherwise shows the offline banner
}

/**
 * Toggles the done state of a todo item.
 * Updates locally first, then sends it (or queues it, see commit()).
 */
async function todoToggle(id, wasDone) {
  const newDone = !wasDone;
  todos = todos.map(t => t.id === id ? { ...t, done: newDone } : t);
  saveCache();
  render();
  await commit({ op: 'toggle', id, done: newDone }, () => apiRaw('PUT', { id, done: newDone }));
}

/**
 * Deletes a todo item.
 * If the item was added offline and has a temp ID, it is simply removed from
 * the local state and the queue — no server call is needed.
 */
async function todoDelete(id) {
  todos = todos.filter(t => t.id !== id);
  saveCache();
  render();

  if (isTemp(id)) {
    // The item was never saved to the server — remove all queued ops for it.
    pendingQueue = pendingQueue.filter(op => op.id !== id);
    savePending();
    // Unless its POST is already on the wire: that one will create it, so the
    // real id is deleted once the answer is in.
    const realId = await inflightAdds.get(id);
    if (!realId) return;
    todos = todos.filter(t => t.id !== realId);
    saveCache();
    render();
    await commit({ op: 'delete', id: realId }, () => apiRaw('DELETE', { id: realId }));
    return;
  }

  await commit({ op: 'delete', id }, () => apiRaw('DELETE', { id }));
}

/**
 * Saves an inline edit of a todo item's text.
 * The contenteditable span calls this on blur (when the user clicks away).
 * If the user clears the text entirely, the item's current text is restored
 * (from the state, not from what was captured when the row was rendered —
 * the text may have been edited since).
 */
async function todoEdit(id, el, original) {
  const text = el.textContent.trim().slice(0, MAX_TEXT);
  if (text !== el.textContent) el.textContent = text; // local and server agree on the cut
  if (!text) { el.textContent = todos.find(t => t.id === id)?.text ?? original; return; }
  todos = todos.map(t => t.id === id ? { ...t, text } : t);
  saveCache();
  await commit({ op: 'edit', id, text }, () => apiRaw('PUT', { id, text }));
}

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

  await commit({ op: 'add', id: tempId, text }, async () => {
    const created = await trackAdd(tempId, apiRaw('POST', { text }));
    // Replace the temporary ID with the real server-assigned UUID.
    todos = todos.map(t => t.id === tempId ? { ...t, id: created.id } : t);
    saveCache();
    render();
  });
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

  // A render skipped during an inline edit runs once the edit is committed
  // (the item's own blur handler has already stored the text by then).
  // If the blur came from tapping a button on a row, the render waits for that
  // click to land (its handler runs first); with no click it runs after 300 ms.
  const todoListEl = document.getElementById('todo-list');
  let renderTimer = null;
  const flushRender = () => { clearTimeout(renderTimer); renderTimer = null; if (renderDue) render(); };
  todoListEl.addEventListener('focusout', () => {
    if (renderDue) { clearTimeout(renderTimer); renderTimer = setTimeout(flushRender, 300); }
  });
  todoListEl.addEventListener('click', () => { if (renderDue && renderTimer) setTimeout(flushRender, 0); });

  // Search: filters the displayed list as the user types (display-only).
  const search = document.getElementById('todo-search');
  search.addEventListener('input', () => { query = search.value; render(); });
  emptyDefault = document.getElementById('todo-empty').textContent;

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
