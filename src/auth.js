/**
 * auth.js — Two auth flows, switched by ENABLE_TAILSCALE in siteConfig.
 *
 * value == 0 (default): PBKDF2-Gate — passphrase is hashed client-side and
 *   stored as the Bearer token. No server contact needed for auth itself.
 *
 * value == 1 (Tailscale mode): Enrollment — the server issues an opaque token
 *   via POST /api/enroll. Requires home LAN for first-time setup.
 *   On 401 from any server response: clearToken() + location.reload().
 */

import { CONFIG, isTailscaleMode } from './config.js';

// One localStorage key per auth mode. Keeping them separate means a token left
// over from the other mode is never mistaken for a valid one — important when
// ENABLE_TAILSCALE is flipped: the old PBKDF2 hash must NOT pass as an enrolled
// token, otherwise ensureEnrolled() would skip the enrollment screen.
const LEGACY_TOKEN_KEY = 'pwa.auth.token';   // PBKDF2 hash    (ENABLE_TAILSCALE == 0)
const CLIENT_TOKEN_KEY = 'pwa.client.token'; // enrolled token (ENABLE_TAILSCALE == 1)
function tokenKey() { return isTailscaleMode() ? CLIENT_TOKEN_KEY : LEGACY_TOKEN_KEY; }

export function getToken()   { return localStorage.getItem(tokenKey()); }
export function clearToken() { localStorage.removeItem(tokenKey()); }
function saveToken(t)        { localStorage.setItem(tokenKey(), t); }

// ── PBKDF2 flow (ENABLE_TAILSCALE == 0) ───────────────────────────────────────

async function derive(pw) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(CONFIG.AUTH.SALT),
      iterations: CONFIG.AUTH.ITERATIONS, hash: 'SHA-256' },
    key, CONFIG.AUTH.HASH_BITS);
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

function constantTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function ensureAuthenticated() {
  if (getToken()) return;
  const modal = renderPassphraseModal();
  while (true) {
    const pw   = await modal.prompt();
    const hash = await derive(pw);
    if (constantTimeEq(hash, CONFIG.AUTH.EXPECTED_HASH_B64)) {
      saveToken(hash);
      modal.close();
      return;
    }
    modal.error('Falsches Passwort — bitte nochmals versuchen.');
  }
}

function renderPassphraseModal() {
  const root = document.createElement('div');
  root.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.82);display:flex;
                align-items:center;justify-content:center;z-index:9999;
                font:16px system-ui;backdrop-filter:blur(8px)">
      <form id="auth-form" style="background:#111827;padding:2em 2.2em;border-radius:16px;
                min-width:18em;display:flex;flex-direction:column;gap:1em;
                border:1px solid rgba(255,255,255,0.12);box-shadow:0 16px 64px rgba(0,0,0,0.6)">
        <h2 style="margin:0;color:#fff;font-size:1.1rem;letter-spacing:.05em">🔒 Zugang</h2>
        <input id="auth-pw" type="password" autocomplete="current-password" autofocus
               placeholder="Passphrase"
               style="font:16px monospace;padding:.6em .8em;border-radius:8px;
                      border:1px solid rgba(255,255,255,0.18);background:#1f2937;
                      color:#fff;outline:none">
        <button type="submit"
                style="padding:.65em;border-radius:8px;border:none;cursor:pointer;
                       background:#4d88ff;color:#fff;font-size:.95rem;font-weight:600">
          OK
        </button>
        <div id="auth-err" style="color:#ff6b6b;min-height:1.2em;font-size:.85rem"></div>
      </form>
    </div>`;
  document.body.appendChild(root);
  const form = root.querySelector('#auth-form');
  const pwIn = root.querySelector('#auth-pw');
  const err  = root.querySelector('#auth-err');
  return {
    prompt: () => new Promise(res => {
      const h = e => { e.preventDefault(); form.removeEventListener('submit', h); res(pwIn.value); pwIn.value = ''; };
      form.addEventListener('submit', h);
    }),
    error: msg => { err.textContent = msg; pwIn.focus(); },
    close: () => root.remove(),
  };
}

// ── Enrollment flow (ENABLE_TAILSCALE == 1) ───────────────────────────────────

export async function ensureEnrolled() {
  if (getToken()) return;
  await showEnrollmentScreen();
}

async function showEnrollmentScreen() {
  const root = document.createElement('div');
  root.innerHTML = `
    <div style="position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;
                align-items:center;justify-content:center;z-index:9999;
                font:16px system-ui;backdrop-filter:blur(8px)">
      <form id="enroll-form" style="background:#111827;padding:2em 2.2em;border-radius:16px;
                min-width:18em;max-width:22em;display:flex;flex-direction:column;gap:1em;
                border:1px solid rgba(255,255,255,0.12);box-shadow:0 16px 64px rgba(0,0,0,0.6)">
        <h2 style="margin:0;color:#fff;font-size:1.1rem;letter-spacing:.05em">🏠 Erste Einrichtung</h2>
        <p style="margin:0;color:#9ca3af;font-size:.85rem;line-height:1.4">
          Nur im Heim-WLAN möglich. Dieses Gerät wird einmalig registriert.
        </p>
        <input id="enroll-pw" type="password" autocomplete="current-password" autofocus
               placeholder="Server-Passwort"
               style="font:16px monospace;padding:.6em .8em;border-radius:8px;
                      border:1px solid rgba(255,255,255,0.18);background:#1f2937;
                      color:#fff;outline:none">
        <input id="enroll-label" type="text" autocomplete="off"
               placeholder="Geräte-Name (z.B. Nadias iPhone)"
               style="font:16px system-ui;padding:.6em .8em;border-radius:8px;
                      border:1px solid rgba(255,255,255,0.18);background:#1f2937;
                      color:#fff;outline:none">
        <button type="submit"
                style="padding:.65em;border-radius:8px;border:none;cursor:pointer;
                       background:#4d88ff;color:#fff;font-size:.95rem;font-weight:600">
          Registrieren
        </button>
        <div id="enroll-err" style="color:#ff6b6b;min-height:1.2em;font-size:.85rem"></div>
      </form>
    </div>`;
  document.body.appendChild(root);

  const form  = root.querySelector('#enroll-form');
  const pwIn  = root.querySelector('#enroll-pw');
  const lblIn = root.querySelector('#enroll-label');
  const err   = root.querySelector('#enroll-err');

  await new Promise(resolve => {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      err.textContent = '';
      const password     = pwIn.value.trim();
      const device_label = lblIn.value.trim() || 'Unbekanntes Gerät';
      if (!password) { err.textContent = 'Bitte Passwort eingeben.'; pwIn.focus(); return; }
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 8000);
        const r = await fetch(CONFIG.LAN_BASE + '/api/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password, device_label }),
          credentials: 'omit',
          signal: ctrl.signal,
        });
        if (r.ok) {
          const { token } = await r.json();
          saveToken(token);
          root.remove();
          resolve();
        } else if (r.status === 401) {
          err.textContent = 'Falsches Passwort — bitte nochmals versuchen.';
          pwIn.value = '';
          pwIn.focus();
        } else {
          err.textContent = `Server-Fehler (${r.status}) — bitte nochmals versuchen.`;
        }
      } catch {
        err.textContent = 'Nicht im Heim-WLAN — Ersteinrichtung erfordert Heimnetz.';
      }
    });
  });
}
