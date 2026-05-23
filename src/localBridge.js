/**
 * localBridge.js — Connection bridge to the local server (LAN or Tailscale).
 *
 * Dual-URL logic:
 *  1. Always tries LAN_BASE first (short timeout).
 *  2. Falls back to TS_BASE only when ENABLE_TAILSCALE=1 (isTailscaleMode()).
 *  3. The chosen base URL is cached for TTL ms and re-evaluated on every
 *     `online` event or explicit invalidateLocal() call.
 *
 * Enrollment: the /api/enroll endpoint is LAN-only — the server rejects
 * Tailscale IPs with 403, so auth.js always uses CONFIG.LAN_BASE directly.
 */

import { CONFIG, isTailscaleMode } from './config.js';
import { getToken, clearToken } from './auth.js';

// Which base URL the local server was last reached on:
//   'lan' | 'tailscale' — reachable there;  null — unreachable / not checked.
let _baseUrl = null;

// Timestamp (ms) of the last COMPLETED detection; 0 = never checked (or just
// invalidated). The detection result is cached for TTL ms — INCLUDING a
// negative result, so a server that is offline is not re-probed on every call.
let _lastCheck = 0;

const TTL = 30_000; // 30 seconds

// Re-check on every reconnect.
window.addEventListener('online', () => invalidateLocal());

/**
 * Detects which base URL the local server is reachable on — LAN preferred,
 * Tailscale as fallback. The outcome (reachable or not) is cached for TTL ms.
 */
async function detectBaseUrl() {
  const now = Date.now();
  // A completed check (success OR failure) is still fresh — reuse it.
  if (_lastCheck !== 0 && now - _lastCheck < TTL) return;

  try {
    // ── Try LAN first ──────────────────────────────────────────────────
    try {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), CONFIG.HEALTH_TIMEOUT_MS);
      const r = await fetch(CONFIG.LAN_BASE + CONFIG.LOCAL_HEALTH_PATH, {
        signal: ctrl.signal, cache: 'no-store', credentials: 'omit',
        headers: authHeaders(),
      });
      if (r.status === 401) { clearToken(); location.reload(); return; }
      if (r.ok) { _baseUrl = 'lan'; return; }
    } catch { /* fall through */ }

    // ── Tailscale fallback (only when ENABLE_TAILSCALE = 1) ────────────
    if (isTailscaleMode()) {
      try {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(CONFIG.TS_BASE + CONFIG.LOCAL_HEALTH_PATH, {
          signal: ctrl.signal, cache: 'no-store', credentials: 'omit',
          headers: authHeaders(),
        });
        if (r.status === 401) { clearToken(); location.reload(); return; }
        if (r.ok) { _baseUrl = 'tailscale'; return; }
      } catch { /* fall through */ }
    }

    _baseUrl = null; // checked — server is currently unreachable
  } finally {
    // Stamp the completion time on every exit path (success, failure, or the
    // early returns above) so the result — positive or negative — is cached.
    _lastCheck = Date.now();
  }
}

/**
 * Returns the active base URL (LAN preferred, Tailscale as fallback).
 * Always call this inside a request function — never cache at module level.
 */
export function getBaseUrl() {
  if (_baseUrl === 'tailscale') return CONFIG.TS_BASE;
  return CONFIG.LAN_BASE; // 'lan' or null (first call before check)
}

/** @returns {{ Authorization: string } | {}} */
export function authHeaders() {
  const t = getToken();
  return t ? { Authorization: 'Bearer ' + t } : {};
}

/** @returns {Promise<boolean>} */
export async function isLocalAvailable() {
  await detectBaseUrl();
  return _baseUrl !== null;
}

export function invalidateLocal() { _baseUrl = null; _lastCheck = 0; }
