/**
 * adminboard.js — Admin notes board.
 *
 * Persistent server-stored notes for Admin users. No IndexedDB, no ultrasound,
 * no push. The server is always the source of truth — the module does a fresh
 * GET on every open and polls every POLL_MS milliseconds while the subpage is
 * active.
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, invalidateLocal, authHeaders, getActiveBase } from '../localBridge.js';
import { clearToken } from '../auth.js';

/** Returns the base URL for all admin board requests. */
const boardUrl = () => getActiveBase() + CONFIG.LOCAL_ADMIN_BOARD_PATH;

/** How often (ms) to refresh the board while the subpage is active. */
const POLL_MS = 4000;

// ── In-memory state ───────────────────────────────────────────────────────────
let messages = [];
let cursor   = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Escapes HTML so message text can never inject markup into the DOM. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Sends a request to the admin board API. On HTTP 401 the token is cleared and
 * the page reloads so auth.js prompts for the passphrase again.
 *
 * @param {string} path - Appended to boardUrl(), e.g. '?since=0'.
 * @param {RequestInit & { body?: object }} [opts]
 * @returns {Promise<object>} Parsed JSON response.
 */
async function api(path, opts = {}) {
  const r = await fetch(boardUrl() + path, {
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

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Re-renders the message list into #adminboard-messages.
 * Shows an empty-state hint when there are no notes.
 */
function render() {
  const el = document.getElementById('adminboard-messages');
  if (!el) return;

  if (messages.length === 0) {
    el.innerHTML = '<div class="chat-empty">Noch keine Notizen.</div>';
  } else {
    el.innerHTML = messages
      .slice()
      .sort((a, b) => (a.seq || 0) - (b.seq || 0))
      .map(m => `<div class="chat-msg">` +
        `<span class="chat-author">${esc(m.sender)}</span>` +
        `<span class="chat-bubble">${esc(m.text)}</span>` +
        `<span class="chat-meta">${new Date(m.ts).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}</span>` +
        `</div>`)
      .join('');
  }
  el.scrollTop = el.scrollHeight;
}

// ── Data operations ───────────────────────────────────────────────────────────

/**
 * Loads all notes from the server and re-renders.
 * Returns immediately if the local server is not reachable.
 */
async function load() {
  if (!(await isLocalAvailable())) return;
  try {
    const data = await api('?since=0');
    messages = data.messages || [];
    cursor   = data.cursor   || 0;
    render();
  } catch (e) {
    console.error('[adminboard] load failed:', e.message);
  }
}

/**
 * Reads the text from #adminboard-input, POSTs it to the server, then reloads.
 * Does nothing when the input is empty.
 */
async function send() {
  const input = document.getElementById('adminboard-input');
  const text  = input?.value.trim();
  if (!text) return;
  try {
    await api('', { method: 'POST', body: { text } });
    if (input) input.value = '';
    await load();
  } catch (e) {
    console.error('[adminboard] send failed:', e.message);
  }
}

/**
 * Asks for confirmation, then deletes all notes on the server and reloads.
 */
async function clearAll() {
  if (!confirm('Alle Notizen löschen?')) return;
  try {
    await api('', { method: 'DELETE' });
    await load();
  } catch (e) {
    console.error('[adminboard] clearAll failed:', e.message);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Wires up the Admin-Notizen subpage.
 * Call once from app.js boot().
 */
export function initAdminBoard() {
  document.getElementById('adminboard-send')
    ?.addEventListener('click', send);

  document.getElementById('adminboard-input')
    ?.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });

  document.getElementById('adminboard-clear')
    ?.addEventListener('click', clearAll);

  // Load when the user navigates to this subpage via the menu.
  window.addEventListener('pwa:page', e => {
    if (e.detail === 'adminboard') load();
  });

  // Poll while the subpage is visible.
  setInterval(() => {
    if (document.getElementById('page-adminboard')?.classList.contains('active')) load();
  }, POLL_MS);
}
