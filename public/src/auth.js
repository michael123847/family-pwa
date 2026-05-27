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

const STORAGE_KEY    = 'pwa.auth.token';
const ROLE_KEY       = 'pwa.auth.role';      // cached role for offline-resilient UI
const LABEL_KEY      = 'pwa.auth.label';     // cached device label
// Survives clearToken() so a returning device can silently re-enroll
// without showing the welcome dialog again.
const PREV_LABEL_KEY = 'pwa.auth.prevlabel';

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
  // Preserve the label under a separate key so re-enrollment can reuse it
  // without showing the welcome dialog on what is really a returning device.
  const label = localStorage.getItem(LABEL_KEY);
  if (label) localStorage.setItem(PREV_LABEL_KEY, label);
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
 * One-time welcome modal shown right before the first enrollment.
 * The entered text becomes the device_label on the whitelist row and is
 * what the admin sees in the admin tool (and what other family devices
 * could later show, if we surface it). Empty submission falls back to
 * defaultLabel() — so the user can hit Enter to skip.
 *
 * Returns a Promise that resolves with the chosen label.
 */
function promptDeviceName() {
  return new Promise(resolve => {
    const fallback = defaultLabel();
    const root = document.createElement('div');
    root.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,0.82);display:flex;
                  align-items:center;justify-content:center;z-index:9999;
                  font:16px system-ui;backdrop-filter:blur(8px)">
        <form id="welcome-form" style="background:#111827;padding:1.8em 2em;border-radius:16px;
                  width:min(22em, calc(100vw - 32px));display:flex;flex-direction:column;gap:1em;
                  border:1px solid rgba(255,255,255,0.12);box-shadow:0 16px 64px rgba(0,0,0,0.6)">
          <h2 style="margin:0;color:#fff;font-size:1.15rem">👋 Willkommen!</h2>
          <p style="margin:0;color:#aab;font-size:0.88rem;line-height:1.45">
            Wie heisst du oder wie soll dieses Gerät genannt werden?<br>
            (z. B. „Marcs iPhone" oder „Papa-Laptop")
          </p>
          <input id="welcome-input" type="text" autocomplete="off" autofocus
                 maxlength="40" placeholder="${fallback}"
                 style="font:16px system-ui;padding:.65em .85em;border-radius:9px;
                        border:1px solid rgba(255,255,255,0.18);background:#1f2937;
                        color:#fff;outline:none">
          <button type="submit"
                  style="padding:.7em;border-radius:9px;border:none;cursor:pointer;
                         background:#4d88ff;color:#fff;font-size:.95rem;font-weight:600">
            Weiter
          </button>
          <p style="margin:0;color:#666;font-size:.75rem;text-align:center">
            Leer lassen für „${fallback}" als Standard.
          </p>
        </form>
      </div>`;
    document.body.appendChild(root);

    const form  = root.querySelector('#welcome-form');
    const input = root.querySelector('#welcome-input');
    form.addEventListener('submit', e => {
      e.preventDefault();
      const value = input.value.trim();
      root.remove();
      resolve(value || fallback);
    });
  });
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
 *
 * When the server comes back and explicitly rejects the token (e.g. whitelist
 * was reset while offline), we silently re-enroll using the preserved label
 * instead of leaving the device in a tokenless, "offline" state until the
 * user manually reloads the page.
 */
async function backgroundRetry(delayMs = 5000) {
  while (true) {
    await new Promise(r => setTimeout(r, delayMs));
    const result = await refreshWhoami();
    if (result.status === 'ok') return;
    if (result.status === 'rejected') {
      // clearToken() saves the label to PREV_LABEL_KEY before wiping it.
      clearToken();
      console.warn('Background whoami: token rejected — silently re-enrolling.');
      const label = localStorage.getItem(PREV_LABEL_KEY) || defaultLabel();
      const ok = await enroll(label);
      if (ok) {
        await refreshWhoami(); // refresh role in localStorage
      } else {
        console.warn('Silent re-enrollment failed — reload to retry.');
      }
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
 *
 * @param {string} [label] — explicit device label (from the welcome prompt).
 *                            Falls back to defaultLabel() if not given.
 */
async function enroll(label) {
  try {
    const r = await fetch(getActiveBase() + '/api/enroll-self', {
      method:  'POST',
      cache:   'no-store',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ device_label: label || defaultLabel() }),
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
 *
 * If there is no token (backgroundRetry cleared it after a rejection), we
 * attempt a silent re-enrollment so the device heals without a page reload.
 */
function watchVisibility() {
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (getToken()) {
      refreshWhoami(); // best-effort; fires pwa:role-changed on its own if role updated
    } else {
      // Token was cleared (backgroundRetry or explicit revocation). Re-enroll
      // silently using the label the device had before — no welcome dialog.
      const label = localStorage.getItem(PREV_LABEL_KEY) || defaultLabel();
      const ok = await enroll(label);
      if (ok) refreshWhoami();
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
    // clearToken() saves the label to PREV_LABEL_KEY before wiping everything.
    clearToken();
  }

  // No (valid) token. Check whether this device has enrolled before.
  const prevLabel = localStorage.getItem(PREV_LABEL_KEY);
  if (prevLabel) {
    // Re-enrollment after token eviction (whitelist reset, etc.).  Skip the
    // welcome dialog — the user already gave a name and showing it again is
    // confusing.
    const ok = await enroll(prevLabel);
    if (ok) return;
    // Server unreachable; fall through to the welcome dialog so the user at
    // least knows the app is trying.
  }

  // Truly first install on this browser — show the welcome dialog so the
  // admin tool gets something meaningful instead of just "Android"/"iPhone".
  const label = await promptDeviceName();
  const ok = await enroll(label);
  if (!ok) {
    // Couldn't enroll. UI will load with role="" and most subapps hidden.
    // Wetter / Abfahrten / Farben work without a token (public APIs).
    // Schedule a retry — server may come up shortly. Reuse the label so the
    // user doesn't get re-prompted.
    console.warn('Enrollment failed — running in degraded mode, will retry.');
    setTimeout(() => enroll(label).then(ok => {
      if (!ok) setTimeout(ensureEnrolled, 10_000);
    }), 10_000);
  }
}
