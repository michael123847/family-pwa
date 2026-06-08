/**
 * adminboard.js — Admin notes board.
 *
 * Persistent server-stored notes for Admin users. Two transports:
 *  - Server relay: GET/POST to /api/admin/board, polled every POLL_MS.
 *  - Ultrasound (Lite): sender is the constant "Admin"; notes received via
 *    sound are ephemeral — the next server poll replaces the in-memory list
 *    (no IndexedDB, no name-setup screen). Hidden unless the server is offline.
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, invalidateLocal, authHeaders, getActiveBase } from '../localBridge.js';
import { clearToken } from '../auth.js';
import { UltrasoundChannel } from '../ultrasoundChannel.js';

/** Returns the base URL for all admin board requests. */
const boardUrl = () => getActiveBase() + CONFIG.LOCAL_ADMIN_BOARD_PATH;

/** How often (ms) to refresh the board while the subpage is active. */
const POLL_MS = 4000;

const US_SEP = '\x1F'; // Unit Separator — same delimiter as Hauschat

// ── In-memory state ───────────────────────────────────────────────────────────
let messages = [];
let cursor   = 0;
let lastSig  = ''; // signature of the last rendered server state

let channel     = null;  // UltrasoundChannel
let usAvailable = false; // whether ggwave/microphone are usable on this device

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

// ── Ultrasound helpers ────────────────────────────────────────────────────────

/** Shows a short ultrasound status message; pass '' to clear it. */
function setUsStatus(text, isError = false) {
  const el = document.getElementById('adminboard-us-status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

/** Packs a note into the compact wire format sent over sound. */
function encodeEnvelope(m) {
  return [m.id, 'Admin', m.text].join(US_SEP);
}

/** Parses a received envelope back into its parts, or null if malformed. */
function decodeEnvelope(str) {
  const parts = String(str).split(US_SEP);
  if (parts.length !== 3) return null;
  return { id: parts[0], text: parts[2] };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Re-renders the message list into #adminboard-messages.
 * Shows an empty-state hint when there are no notes.
 * Always called only when data has actually changed (scroll is intentional).
 */
function render() {
  const el = document.getElementById('adminboard-messages');
  if (!el) return;

  if (messages.length === 0) {
    el.innerHTML = '<div class="chat-empty">Noch keine Notizen.</div>';
  } else {
    const sorted = messages.slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
    el.innerHTML = sorted.map((m, i) =>
      `<div class="chat-msg">` +
      `<span class="chat-author">${esc(m.sender)}</span>` +
      `<span class="chat-bubble">${esc(m.text)}</span>` +
      `<span class="chat-meta">` +
        `${new Date(m.ts).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}` +
        `${m.via === 'ultrasound' ? ' 📡' : ''}` +
      `</span>` +
      `<button class="chat-copy-btn" data-idx="${i}" title="Kopieren">⎘</button>` +
      `</div>`
    ).join('');

    el.querySelectorAll('.chat-copy-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = sorted[Number(btn.dataset.idx)]?.text ?? '';
        navigator.clipboard.writeText(text).then(() => {
          btn.textContent = '✓';
          setTimeout(() => btn.textContent = '⎘', 1200);
        });
      });
    });
  }
  el.scrollTop = el.scrollHeight;
}

// ── Data operations ───────────────────────────────────────────────────────────

/**
 * Loads all notes from the server and re-renders only when the data changed.
 * Returns immediately if the local server is not reachable.
 */
async function load() {
  if (!(await isLocalAvailable())) return;
  try {
    const data = await api('?since=0');
    const sig  = (data.cursor ?? 0) + ':' + (data.messages?.length ?? 0);
    if (sig === lastSig) return; // no change — skip re-render and scroll
    lastSig  = sig;
    messages = data.messages || [];
    cursor   = data.cursor   || 0;
    render();
  } catch (e) {
    console.error('[adminboard] load failed:', e.message);
  }
}

/**
 * Broadcasts a note as sound (fire-and-forget; the server POST already queued it).
 */
async function transmitMessage(msg) {
  const envelope = encodeEnvelope(msg);
  if (new TextEncoder().encode(envelope).length > channel.maxBytes) {
    setUsStatus('⚠️ Zu lang für Ultraschall', true);
    return;
  }
  await channel.send(envelope);
}

/**
 * Handles a note decoded from the microphone. Ephemeral: a later load() will
 * replace messages with the server state and these in-memory notes drop.
 */
function onUltrasoundMessage(str) {
  const env = decodeEnvelope(str);
  if (!env || !env.id || !env.text) return;
  if (messages.some(m => m.id === env.id)) return; // dedup
  messages.push({ id: env.id, sender: 'Admin', text: env.text, ts: Date.now(), via: 'ultrasound' });
  render();
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
    const res = await api('', { method: 'POST', body: { text } });
    if (input) input.value = '';
    lastSig = ''; // force re-render on next load
    if (channel?.enabled) transmitMessage({ id: res.id, text });
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
    lastSig = ''; // force re-render
    await load();
  } catch (e) {
    console.error('[adminboard] clearAll failed:', e.message);
  }
}

// ── Ultrasound UI ─────────────────────────────────────────────────────────────

/** Updates the ultrasound buttons to reflect the channel's current state. */
function syncUsUi() {
  const btn  = document.getElementById('adminboard-us-toggle');
  const freq = document.getElementById('adminboard-us-freq');
  if (!btn || !freq) return;
  btn.classList.toggle('active', channel.enabled);
  btn.textContent  = channel.enabled ? '📡 Ultraschall an' : '📡 Ultraschall';
  freq.hidden      = !channel.enabled;
  freq.textContent = channel.audible ? 'Modus: hörbar' : 'Modus: Ultraschall';
}

/** Switches ultrasound messaging on or off. */
async function toggleUltrasound() {
  await channel.toggle();
  syncUsUi();
}

/** Flips the send protocol between ultrasound and audible. */
function toggleFreq() {
  channel.setMode(!channel.audible);
  syncUsUi();
}

/**
 * Shows the ultrasound bar only when ggwave is available AND the home server
 * is unreachable — ultrasound is the no-server fallback.
 */
function applyUsVisibility(serverOnline) {
  const bar = document.getElementById('adminboard-us-bar');
  if (!bar) return;
  if (usAvailable && !serverOnline) {
    bar.hidden = false;
  } else {
    if (channel?.enabled) { channel.disable(); syncUsUi(); }
    bar.hidden = true;
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

  // Ultrasound — create the reusable channel; bar shown only while server is offline.
  channel = new UltrasoundChannel({
    name:      'adminboard',
    onMessage: onUltrasoundMessage,
    onStatus:  setUsStatus,
  });
  channel.available().then(avail => {
    usAvailable = avail;
    if (avail) {
      document.getElementById('adminboard-us-toggle')?.addEventListener('click', toggleUltrasound);
      document.getElementById('adminboard-us-freq')?.addEventListener('click', toggleFreq);
      syncUsUi();
    }
  });
  const usBar = document.getElementById('adminboard-us-bar');
  if (usBar) usBar.hidden = true;
  window.addEventListener('pwa:server', e => applyUsVisibility(e.detail));
  isLocalAvailable().then(online => applyUsVisibility(online));

  // Load when the user navigates to this subpage via the menu.
  window.addEventListener('pwa:page', e => {
    if (e.detail === 'adminboard') load();
  });

  // Poll while the subpage is visible.
  setInterval(() => {
    if (document.getElementById('page-adminboard')?.classList.contains('active')) load();
  }, POLL_MS);
}
