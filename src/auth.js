/**
 * auth.js — Auto-enrollment client + role tracking.
 *
 * Replaces the old PBKDF2 passphrase gate: there is no shared secret anymore.
 * The first time a device opens the PWA, it asks the server to enroll it
 * (POST /api/enroll-self). The server creates a whitelist entry with role
 * "Visitor" and returns a long random token. The token lives in localStorage
 * and is sent as Authorization: Bearer with every request.
 *
 * Admin promotes the device to Family / Power / Admin via tools/admin.html.
 *
 * Role is fetched via GET /api/whoami right after enrollment (and every page
 * load). It drives UI visibility: the menu hides subapps the current role
 * cannot use.
 *
 * Tailscale (or LAN) is the actual perimeter — anyone who can reach the
 * enrollment endpoint is already "in the building" and gets Visitor by default.
 */

import { CONFIG } from './config.js';

const STORAGE_KEY = 'pwa.auth.token';
const ROLE_KEY    = 'pwa.auth.role';    // cached role for offline-resilient UI
const LABEL_KEY   = 'pwa.auth.label';   // cached device label

// Role hierarchy — kept in sync with server.js ROLES.
export const ROLES = ['Visitor', 'Family', 'Power', 'Admin'];

/** Numeric level for a role name; -1 if no role yet. */
export function roleLevel(role) {
  const i = ROLES.indexOf(role);
  return i < 0 ? -1 : i;
}

/** True iff the current user has at least the given role. */
export function hasRole(min) {
  return roleLevel(getRole()) >= roleLevel(min);
}

export function getToken() { return localStorage.getItem(STORAGE_KEY); }
export function getRole()  { return localStorage.getItem(ROLE_KEY) ?? ''; }
export function getLabel() { return localStorage.getItem(LABEL_KEY) ?? ''; }

export function clearToken() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(ROLE_KEY);
  localStorage.removeItem(LABEL_KEY);
}

/** Picks a reasonable default device label so admin sees something useful. */
function defaultLabel() {
  // Best-effort guess at platform; not security-sensitive, just a hint.
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua))       return 'iPhone';
  if (/iPad/.test(ua))         return 'iPad';
  if (/Android/.test(ua))      return 'Android';
  if (/Windows/.test(ua))      return 'Windows';
  if (/Macintosh/.test(ua))    return 'Mac';
  if (/Linux/.test(ua))        return 'Linux';
  return 'Gerät';
}

/**
 * Calls /api/whoami and updates the cached role + label. Returns the role on
 * success, or null if the call failed (network/401/etc).
 */
async function refreshWhoami() {
  const t = getToken();
  if (!t) return null;
  try {
    const r = await fetch(CONFIG.LOCAL_BASE + '/api/whoami', {
      cache:       'no-store',
      credentials: 'omit',
      headers:     { Authorization: 'Bearer ' + t },
    });
    if (!r.ok) return null;
    const body = await r.json();
    localStorage.setItem(ROLE_KEY,  body.role  ?? '');
    localStorage.setItem(LABEL_KEY, body.device_label ?? '');
    return body.role;
  } catch {
    return null;
  }
}

/**
 * Enrolls this device as a Visitor. Stores the returned token + role in
 * localStorage. Returns true on success, false on failure (which usually
 * means the server is unreachable — the PWA should fall back to its
 * read-only public-API features in that case).
 */
async function enroll() {
  try {
    const r = await fetch(CONFIG.LOCAL_BASE + '/api/enroll-self', {
      method:  'POST',
      cache:   'no-store',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ device_label: defaultLabel() }),
    });
    if (!r.ok) return false;
    const body = await r.json();
    localStorage.setItem(STORAGE_KEY, body.token);
    localStorage.setItem(ROLE_KEY,    body.role  ?? 'Visitor');
    localStorage.setItem(LABEL_KEY,   body.device_label ?? '');
    return true;
  } catch {
    return false;
  }
}

/**
 * Top-level entry point called by main.js before boot().
 * Ensures the device has a whitelist token and a fresh role assignment.
 *
 *  - If a token already exists: refresh role via /api/whoami.
 *      - If that succeeds, done.
 *      - If 401 (token revoked or whitelist wiped): clear and re-enroll.
 *  - If no token: enroll as Visitor.
 *
 * The function never throws — at worst it returns with no token cached, and
 * the rest of the app falls back to its offline / read-only state.
 */
export async function ensureEnrolled() {
  if (getToken()) {
    const role = await refreshWhoami();
    if (role) return; // happy path
    // Token didn't validate — clear and try enroll-self
    clearToken();
  }
  const ok = await enroll();
  if (!ok) {
    // Couldn't enroll. UI will load with role="" and most subapps hidden.
    // Wetter / Abfahrten / Farben work without a token (public APIs).
    console.warn('Enrollment failed — running in degraded mode.');
  }
}
