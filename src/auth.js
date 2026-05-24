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

import { getActiveBase } from './localBridge.js';

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
 * Calls /api/whoami and updates the cached role + label. Returns one of:
 *  - { status: 'ok',       role }     — server validated the token, role cached
 *  - { status: 'rejected'           } — server returned 401 (token not in whitelist)
 *  - { status: 'soft-fail', detail } — network error, timeout, 5xx, or non-JSON
 *
 * The 'rejected' vs 'soft-fail' distinction matters: rejected = we must
 * re-enroll (and lose the device's role assignment); soft-fail = the server is
 * just temporarily unreachable (Tailscale handshake, weak Wi-Fi, etc.) and the
 * token is probably still valid — we keep it.
 */
async function refreshWhoami() {
  const t = getToken();
  if (!t) return { status: 'no-token' };
  try {
    const r = await fetch(getActiveBase() + '/api/whoami', {
      cache:       'no-store',
      credentials: 'omit',
      headers:     { Authorization: 'Bearer ' + t },
    });
    if (r.status === 401) return { status: 'rejected' };
    if (!r.ok)            return { status: 'soft-fail', detail: 'HTTP_' + r.status };
    const body = await r.json();
    localStorage.setItem(ROLE_KEY,  body.role  ?? '');
    localStorage.setItem(LABEL_KEY, body.device_label ?? '');
    // Tell the app the role might have changed — applyRoleVisibility() listens
    // for this and re-applies the hidden state on tabs/menu entries.
    window.dispatchEvent(new CustomEvent('pwa:role-changed', { detail: body.role }));
    return { status: 'ok', role: body.role };
  } catch (e) {
    return { status: 'soft-fail', detail: e.message };
  }
}

/**
 * Background retry: keeps trying /api/whoami until it succeeds (or the token
 * is rejected). Used after a cold-start soft-fail so the PWA doesn't stay
 * stuck with a stale cached role for an entire session.
 */
async function backgroundRetry(delayMs = 5000) {
  while (true) {
    await new Promise(r => setTimeout(r, delayMs));
    const result = await refreshWhoami();
    if (result.status === 'ok')        return;
    if (result.status === 'rejected') {
      // Token's actually gone — clear and let the next reload re-enroll.
      clearToken();
      console.warn('Background whoami: token rejected, cleared. Reload to re-enroll.');
      return;
    }
    // Still failing — back off a bit, max 60s between retries.
    delayMs = Math.min(delayMs * 1.5, 60_000);
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
    const r = await fetch(getActiveBase() + '/api/enroll-self', {
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
 * Re-runs /api/whoami when the page comes back to the foreground. Picks up
 * an admin promotion (or demotion) without the user having to fully relaunch
 * the PWA — just switching away + back is enough.
 */
function watchVisibility() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && getToken()) {
      refreshWhoami(); // best-effort; fires pwa:role-changed on its own if role updated
    }
  });
}

/**
 * Top-level entry point called by main.js before boot().
 * Ensures the device has a whitelist token and a fresh role assignment.
 *
 *  - If a token already exists: refresh role via /api/whoami.
 *      - ok       → happy path, role updated
 *      - rejected → server says the token is unknown; clear it and re-enroll
 *      - soft-fail → server unreachable (e.g. Tailscale not ready yet);
 *                    keep the token, use cached role, retry in background
 *  - If no token: enroll as Visitor.
 *
 * The function never throws — at worst it returns with no token cached, and
 * the rest of the app falls back to its offline / read-only state.
 */
export async function ensureEnrolled() {
  watchVisibility();
  if (getToken()) {
    const result = await refreshWhoami();
    if (result.status === 'ok')        return; // happy path
    if (result.status === 'soft-fail') {
      // Network not ready / server temporarily down. KEEP the token — the
      // most common case is a cold start before Tailscale has finished its
      // handshake, where the token is still perfectly valid. Background
      // retry will update the cached role once the network catches up.
      console.warn('whoami soft-failed at boot:', result.detail, '— keeping token, retrying in background.');
      backgroundRetry();
      return;
    }
    // status === 'rejected' → server explicitly said the token is unknown.
    clearToken();
  }
  const ok = await enroll();
  if (!ok) {
    // Couldn't enroll. UI will load with role="" and most subapps hidden.
    // Wetter / Abfahrten / Farben work without a token (public APIs).
    // Schedule a retry — server may come up shortly.
    console.warn('Enrollment failed — running in degraded mode, will retry.');
    setTimeout(ensureEnrolled, 10_000);
  }
}
