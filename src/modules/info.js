/**
 * info.js — "Info" subapp: a small diagnostics page under Diverses.
 *
 * Shows which client build is really running (CONFIG.APP_VERSION — part of
 * the loaded code, so it cannot lie), the Service Worker cache version,
 * whether an update is waiting, server reachability, ultrasound support and
 * the device platform. Also offers a hard reload that clears all caches —
 * handy when a deploy does not seem to arrive.
 */

import { CONFIG } from '../config.js';
import { isLocalAvailable, getActiveBase } from '../localBridge.js';
import { isUltrasoundAvailable } from '../ultrasound.js';

/** Human-readable label for the currently-active server base URL. */
function connectionPath() {
  const base = getActiveBase();
  if (base === CONFIG.LAN_BASE)    return 'Heim-LAN (mDNS)';
  if (base === CONFIG.LAN_IP_BASE) return 'Heim-LAN (IP)';
  if (base === CONFIG.TS_BASE)     return 'Tailnet';
  return base; // fallback — shows the raw URL if it's something else
}

/** Compact "OS · Browser" label derived from the user agent. */
function platformLabel() {
  const ua = navigator.userAgent;
  let os = 'Unbekannt';
  if (/iPhone|iPad|iPod/.test(ua))      os = 'iOS';
  else if (/Android/.test(ua))          os = 'Android';
  else if (/Windows/.test(ua))          os = 'Windows';
  else if (/Macintosh|Mac OS/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua))            os = 'Linux';

  let br = 'Browser';
  if (/Edg\//.test(ua))                 br = 'Edge';
  else if (/CriOS|Chrome\//.test(ua))   br = 'Chrome';
  else if (/Firefox\//.test(ua))        br = 'Firefox';
  else if (/Safari\//.test(ua))         br = 'Safari';

  return os + ' · ' + br;
}

/** The version embedded in the Service Worker's shell cache (e.g. "v14"). */
async function swCacheVersion() {
  try {
    const shell = (await caches.keys()).find(k => k.startsWith('shell-'));
    return shell ? shell.replace('shell-', '') : '—';
  } catch {
    return '—';
  }
}

/** True if a newer Service Worker is installed and waiting to take over. */
async function updateWaiting() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(reg && reg.waiting);
  } catch {
    return false;
  }
}

/** Builds one label/value row. tone: 'good' | 'warn' | undefined. */
function row(label, value, tone) {
  const cls = tone ? ' ' + tone : '';
  return `<div class="info-row">
    <span class="info-label">${label}</span>
    <span class="info-value${cls}">${value}</span>
  </div>`;
}

/** Gathers the current state and (re-)renders the info list. */
async function render() {
  const box = document.getElementById('info-content');
  if (!box) return;

  const [server, ultrasound, swVer, waiting] = await Promise.all([
    isLocalAvailable(),
    isUltrasoundAvailable(),
    swCacheVersion(),
    updateWaiting(),
  ]);

  box.innerHTML = [
    row('App-Version',   CONFIG.APP_VERSION,
        CONFIG.APP_VERSION === swVer ? 'good' : 'warn'),
    row('Service Worker', waiting ? swVer + ' · Update bereit' : swVer,
        waiting ? 'warn' : undefined),
    row('Heim-Server',   server ? 'Online' : 'Offline', server ? 'good' : undefined),
    // Which route are we using right now — LAN_BASE, LAN_IP_BASE, or TS_BASE?
    // Tone "good" when on a LAN path (faster, no Tailscale hop); plain
    // otherwise. Useful for spotting unexpected Tailscale fallback at home.
    row('Verbindung',    connectionPath(),
        getActiveBase().includes('.local') || getActiveBase().includes('192.168') ? 'good' : undefined),
    row('Ultraschall',   ultrasound ? 'Verfügbar' : 'Nicht verfügbar',
        ultrasound ? 'good' : undefined),
    row('Netzwerk',      navigator.onLine ? 'Online' : 'Offline'),
    row('Gerät',         platformLabel()),
  ].join('');
}

/**
 * Unregisters the Service Worker, clears every cache and reloads — forces a
 * completely fresh copy of the app. Useful when a deploy seems stuck.
 */
async function hardReload() {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(r => r.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
  } catch { /* best effort — reload anyway */ }
  location.reload();
}

/**
 * Wires the Info subapp. Called once by app.js during boot. The list is
 * re-rendered every time the user opens the Info subpage.
 */
export function initInfo() {
  if (!document.getElementById('info-content')) return;

  document.getElementById('info-refresh')?.addEventListener('click', render);
  document.getElementById('info-reload')?.addEventListener('click', hardReload);
  document.querySelector('[data-subpage="info"]')?.addEventListener('click', render);

  render();
}
