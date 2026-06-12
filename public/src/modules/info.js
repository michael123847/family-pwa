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
import { getCachedBases } from '../siteConfig.js';
import { isUltrasoundAvailable } from '../ultrasound.js';

/** Human-readable label for the currently-active server base URL. */
function connectionPath() {
  const base  = getActiveBase();
  const bases = getCachedBases();
  if (base === CONFIG.LAN_BASE) return 'Heim-LAN (mDNS)';
  if (base === bases.lan_ip)    return 'Heim-LAN (IP)';
  if (base === bases.ts)        return 'Tailnet';
  // Heuristic fallback when nothing exact matches (e.g. base from a previous
  // session with an old cached URL): classify by URL shape rather than
  // showing the raw URL, which would leak it into screenshots.
  if (/^https?:\/\/[^/]+\.local/.test(base))   return 'Heim-LAN (mDNS)';
  if (/^https?:\/\/192\.168\./.test(base))     return 'Heim-LAN (IP)';
  if (/^https?:\/\/[^/]+\.ts\.net/.test(base)) return 'Tailnet';
  return 'Unbekannt';
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
    const shell = (await caches.keys()).find(k => k.startsWith('fpwa-shell-'));
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
        CONFIG.APP_VERSION === swVer.replace(/^fpwa-/, '') ? 'good' : 'warn'),
    row('Service Worker', waiting ? swVer + ' · Update bereit' : swVer,
        waiting ? 'warn' : undefined),
    row('Heim-Server',   server ? 'Online' : 'Offline', server ? 'good' : undefined),
    // Which route are we using right now — LAN_BASE, cached LAN-IP, or
    // Tailscale? "good" tone when on a LAN path (faster, no Tailscale hop).
    row('Verbindung',    connectionPath(),
        /\.local|192\.168\./.test(getActiveBase()) ? 'good' : undefined),
    row('Ultraschall',   ultrasound ? 'Verfügbar' : 'Nicht verfügbar',
        ultrasound ? 'good' : undefined),
    row('Netzwerk',      navigator.onLine ? 'Online' : 'Offline'),
    row('Gerät',         platformLabel()),
  ].join('') + `
    <div class="info-attrib">
      Wetterdaten: <a href="https://open-meteo.com/" rel="noopener" target="_blank">Open-Meteo</a> (CC&nbsp;BY&nbsp;4.0).
      Abfahrten: <a href="https://transport.opendata.ch/" rel="noopener" target="_blank">transport.opendata.ch</a>.
    </div>`;
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
 * Applies a UI scale value: sets the root dataset attribute (used by CSS),
 * persists to localStorage, and marks the matching scale button as active.
 * Passing 'mittel' (or an empty/falsy value) is the default — it clears the
 * attribute so CSS falls back to its base sizing.
 */
function applyScale(v) {
  if (!v || v === 'mittel') {
    delete document.documentElement.dataset.scale;
    v = 'mittel';
  } else {
    document.documentElement.dataset.scale = v;
  }
  try { localStorage.setItem('pwa.ui.scale', v); } catch { /* storage unavailable */ }
  document.querySelectorAll('#scale-control [data-scale]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.scale === v);
  });
}

/**
 * Wires the Info subapp. Called once by app.js during boot. The list is
 * re-rendered every time the user opens the Info subpage.
 */
export function initInfo() {
  if (!document.getElementById('info-content')) return;

  // Restore persisted scale on boot and mark the active button.
  const savedScale = localStorage.getItem('pwa.ui.scale') || 'mittel';
  applyScale(savedScale);

  // Wire scale buttons.
  document.querySelectorAll('#scale-control [data-scale]').forEach(btn => {
    btn.addEventListener('click', () => applyScale(btn.dataset.scale));
  });

  document.getElementById('info-refresh')?.addEventListener('click', render);
  document.getElementById('info-reload')?.addEventListener('click', hardReload);
  document.querySelector('[data-subpage="info"]')?.addEventListener('click', render);

  render();
}
