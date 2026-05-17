/**
 * hauschat.js — "Hauschat", a small family messenger (Phase 1: server relay).
 *
 * One shared message thread for all family devices. Messages are exchanged
 * through the local WLAN server, which keeps them for 48 hours. There is no
 * background delivery: the chat syncs while the Hauschat subpage is open
 * (an immediate sync on open, then a poll every few seconds).
 *
 * Local storage (IndexedDB, database "hauschat"):
 *   messages — full chat history, kept on the device beyond the server's 48 h.
 *   meta     — { k:'device', id, name }  the device's long-term identity
 *              { k:'cursor', seq }       highest server seq already fetched
 *
 * Sending:
 *   A new message is stored locally with status 'pending' and rendered
 *   immediately. sync() uploads pending messages; on success the status
 *   becomes 'delivered_relay'. If the server is unreachable the message
 *   stays 'pending' and is retried on the next sync.
 *
 * Sync cursor:
 *   The server assigns every message a monotonic 'seq'. The client fetches
 *   with ?since=<cursor> and advances the cursor from GET responses only,
 *   so no message can be skipped. Display order is by timestamp.
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, invalidateLocal, authHeaders } from '../localBridge.js';
import { clearToken } from '../auth.js';

const CHAT_URL = CONFIG.LOCAL_BASE + CONFIG.LOCAL_CHAT_PATH;
const DB_NAME  = 'hauschat';
const POLL_MS  = 4000; // poll interval while the subpage is open

// ── Module state ──────────────────────────────────────────────────────────────

let db       = null;  // IndexedDB handle, or null if IndexedDB is unavailable
let device   = null;  // { id, name } — set after the name has been chosen
let messages = [];     // in-memory copy of all known messages
let cursor   = 0;      // highest server seq fetched so far
let syncing  = false;  // guard against overlapping sync() calls

// ── IndexedDB helpers ─────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('messages')) d.createObjectStore('messages', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta'))     d.createObjectStore('meta',     { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror   = () => reject(r.error);
  });
}

function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(store, 'readonly').objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror   = () => reject(r.error);
  });
}

function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(value);
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Escapes HTML so message text can never inject markup into the DOM. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Sends a request to the chat API. On HTTP 401 the token is cleared and the
 * page reloads so auth.js prompts for the passphrase again.
 *
 * @param {string} path - Appended to CHAT_URL, e.g. '/messages?since=3'.
 * @param {RequestInit & { body?: object }} [opts]
 * @returns {Promise<object>} Parsed JSON response.
 */
async function api(path, opts = {}) {
  const r = await fetch(CHAT_URL + path, {
    credentials: 'omit',
    method:      opts.method || 'GET',
    headers:     { 'Content-Type': 'application/json', ...authHeaders() },
    body:        opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (r.status === 401) {
    clearToken();
    location.reload();
  }
  if (!r.ok) {
    invalidateLocal();
    throw new Error('HTTP_' + r.status);
  }
  return r.json();
}

/** Shows or hides the "server unreachable" banner. */
function setOffline(off) {
  document.getElementById('chat-offline')?.classList.toggle('visible', off);
}

// ── Render ────────────────────────────────────────────────────────────────────

/**
 * Re-renders the message list, sorted by timestamp. Own messages are aligned
 * right with a delivery tick; messages from others show the sender name.
 */
function render() {
  const box = document.getElementById('chat-messages');
  if (!box) return;

  if (!messages.length) {
    box.innerHTML = '<div class="chat-empty">Noch keine Nachrichten.</div>';
    return;
  }

  messages.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  box.innerHTML = messages.map(m => {
    const mine = m.sender === device?.id;
    const time = new Date(m.ts).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
    const tick = !mine ? '' : (m.status === 'pending' ? '🕓' : '✓');
    return `<div class="chat-msg ${mine ? 'mine' : 'theirs'}">
      ${mine ? '' : `<span class="chat-author">${esc(m.senderName || '?')}</span>`}
      <span class="chat-bubble">${esc(m.text)}</span>
      <span class="chat-meta">${time}${mine ? ' ' + tick : ''}</span>
    </div>`;
  }).join('');

  box.scrollTop = box.scrollHeight; // keep the newest message in view
}

// ── Sync ──────────────────────────────────────────────────────────────────────

/**
 * Synchronises with the server: uploads pending messages, then fetches any
 * newer messages. Safe to call repeatedly; overlapping calls are ignored.
 */
async function sync() {
  if (syncing || !device) return;
  syncing = true;
  try {
    if (!(await isLocalAvailable())) { setOffline(true); return; }
    setOffline(false);

    // 1. Upload messages that have not reached the server yet.
    for (const m of messages.filter(x => x.status === 'pending')) {
      try {
        const res = await api('/messages', {
          method: 'POST',
          body:   { id: m.id, sender: m.sender, senderName: m.senderName, text: m.text, ts: m.ts },
        });
        m.status = 'delivered_relay';
        m.seq    = res.seq;
        await idbPut('messages', m);
      } catch {
        // Leave as 'pending' — it will be retried on the next sync.
      }
    }

    // 2. Fetch messages newer than the cursor and merge them in.
    const data    = await api('/messages?since=' + cursor);
    let   changed = false;
    for (const m of data.messages) {
      if (m.seq > cursor) cursor = m.seq;
      if (messages.some(x => x.id === m.id)) continue; // dedup by message id
      const stored = { ...m, status: 'delivered_relay' };
      messages.push(stored);
      await idbPut('messages', stored);
      changed = true;
    }
    if (data.messages.length) await idbPut('meta', { k: 'cursor', seq: cursor });
    if (changed) render();
  } catch {
    setOffline(true);
  } finally {
    syncing = false;
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

/** Creates a new message, stores it locally, and triggers a sync. */
async function send() {
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text || !device) return;

  const msg = {
    id:         Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 8),
    sender:     device.id,
    senderName: device.name,
    text,
    ts:         Date.now(),
    status:     'pending',
  };
  messages.push(msg);
  await idbPut('messages', msg);
  input.value = '';
  render();
  sync();
}

/** Saves the chosen display name, creates the device identity, shows the chat. */
async function saveName() {
  const name = document.getElementById('chat-name-input').value.trim().slice(0, 24);
  if (!name) return;

  device = { id: crypto.randomUUID(), name };
  await idbPut('meta', { k: 'device', id: device.id, name: device.name });

  if (await isLocalAvailable()) {
    try { await api('/register', { method: 'POST', body: { id: device.id, name: device.name } }); }
    catch { /* registration is best-effort — the name also travels with messages */ }
  }
  showChat();
  sync();
}

// ── View toggle ───────────────────────────────────────────────────────────────

function showSetup() {
  document.getElementById('chat-setup').style.display = 'block';
  document.getElementById('chat-view').style.display  = 'none';
  document.getElementById('chat-name-input').focus();
}

function showChat() {
  document.getElementById('chat-setup').style.display = 'none';
  document.getElementById('chat-view').style.display  = 'flex';
  render();
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Opens the database, restores state, wires up the UI, and starts the poll.
 * Called once by app.js during boot. If IndexedDB is unavailable the chat
 * stays disabled rather than crashing the rest of the app.
 */
export async function initHauschat() {
  try { db = await openDB(); }
  catch { return; }

  device   = await idbGet('meta', 'device').then(d => d ? { id: d.id, name: d.name } : null);
  cursor   = await idbGet('meta', 'cursor').then(c => c?.seq ?? 0);
  messages = await idbGetAll('messages');

  document.getElementById('chat-send').addEventListener('click', send);
  document.getElementById('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') send();
  });
  document.getElementById('chat-name-save').addEventListener('click', saveName);
  document.getElementById('chat-name-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveName();
  });

  if (device) showChat();
  else        showSetup();

  // Sync immediately when the user opens the Hauschat subpage.
  document.querySelector('[data-subpage="hauschat"]')
    ?.addEventListener('click', () => { if (device) sync(); });

  // Poll only while the Hauschat subpage is actually visible.
  setInterval(() => {
    if (device && document.getElementById('page-hauschat').classList.contains('active')) sync();
  }, POLL_MS);

  // Sync when the device comes back onto the home network.
  window.addEventListener('online', () => { invalidateLocal(); if (device) sync(); });
}
