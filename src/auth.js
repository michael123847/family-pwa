/**
 * auth.js — Password gate using PBKDF2 key derivation.
 *
 * How it works:
 *  1. The user types a passphrase into the modal.
 *  2. PBKDF2 (a standard cryptographic algorithm) derives a 256-bit hash
 *     from the passphrase + a fixed salt, using 200 000 iterations.
 *     The high iteration count makes automated guessing attacks very slow.
 *  3. The derived hash is compared to the expected hash stored in config.js.
 *  4. If they match, the hash is saved to localStorage as the Bearer token.
 *     This token is attached to every request to the local server.
 *  5. On the next visit the token is already in localStorage, so the modal
 *     is skipped — the user only has to type the passphrase once per device.
 *
 * The comparison uses constantTimeEq() to prevent timing-based attacks where
 * an attacker could guess characters by measuring how long the comparison takes.
 */

import { CONFIG } from './config.js';

// localStorage key under which the derived token is persisted.
const STORAGE_KEY = 'pwa.auth.token';

/**
 * Derives a Base64-encoded PBKDF2 hash from the given passphrase.
 * Uses the Web Crypto API which is built into all modern browsers.
 *
 * @param {string} pw - The passphrase entered by the user.
 * @returns {Promise<string>} Base64-encoded hash.
 */
async function derive(pw) {
  const enc = new TextEncoder(); // converts a JS string to raw bytes (UTF-8)
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2',
      salt:       enc.encode(CONFIG.AUTH.SALT),
      iterations: CONFIG.AUTH.ITERATIONS,
      hash:       'SHA-256' },
    key, CONFIG.AUTH.HASH_BITS);
  // Convert the raw bytes to a Base64 string for easy storage and comparison.
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

/**
 * Compares two strings in constant time.
 * A normal === comparison can leak timing information (it stops at the first
 * different character). This function always runs through all characters,
 * so the time taken does not reveal how many characters matched.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function constantTimeEq(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  // XOR each pair of characters. If any differ, r becomes non-zero.
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Returns the stored token, or null if the user has not authenticated yet. */
export function getToken()   { return localStorage.getItem(STORAGE_KEY); }

/** Removes the stored token — triggers re-authentication on next load. */
export function clearToken() { localStorage.removeItem(STORAGE_KEY); }

/**
 * Blocks execution until the user has entered the correct passphrase.
 * If a valid token is already in localStorage, returns immediately.
 * Otherwise, shows the password modal and loops until the hash matches.
 */
export async function ensureAuthenticated() {
  if (getToken()) return; // already authenticated on a previous visit

  const modal = renderModal();
  while (true) {
    const pw   = await modal.prompt();      // wait for the user to submit the form
    const hash = await derive(pw);          // compute PBKDF2 hash
    if (constantTimeEq(hash, CONFIG.AUTH.EXPECTED_HASH_B64)) {
      localStorage.setItem(STORAGE_KEY, hash); // save hash as Bearer token
      modal.close();
      return;
    }
    modal.error('Falsches Passwort — bitte nochmals versuchen.');
  }
}

/**
 * Creates and mounts a full-screen password modal.
 * Returns an object with three methods:
 *   prompt() — returns a Promise that resolves with the submitted password.
 *   error(msg) — shows an error message below the input field.
 *   close() — removes the modal from the DOM.
 */
function renderModal() {
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
    // Returns a Promise that resolves once the form is submitted.
    // The event listener is removed after each submission so it doesn't
    // accumulate on repeated wrong-password attempts.
    prompt: () => new Promise(res => {
      const h = e => {
        e.preventDefault();
        form.removeEventListener('submit', h);
        res(pwIn.value);
        pwIn.value = ''; // clear field for security
      };
      form.addEventListener('submit', h);
    }),
    error: msg => { err.textContent = msg; pwIn.focus(); },
    close: () => root.remove(),
  };
}
