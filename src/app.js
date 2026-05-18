/**
 * app.js — Application bootstrap.
 *
 * boot() is called once by main.js after authentication succeeds.
 * It wires up the tab navigation, registers the Service Worker, and
 * kicks off all feature modules in parallel (weather, transit, background
 * image, todo list, colour picker).
 *
 * updateLocalStatus() polls the local server every 30 seconds and updates
 * the green/grey status dot in the top-right corner of the home screen.
 */

import { loadWeather }         from './modules/weather.js';
import { loadTransit }         from './modules/transit.js';
import { setFamilyBackground } from './modules/background.js';
import { initTodo }            from './modules/todo.js';
import { initSwatch }          from './modules/swatch.js';
import { initPhotos }          from './modules/photos.js';
import { initHauschat }        from './modules/hauschat.js';
import { initInfo }            from './modules/info.js';
import { initAudiotest }       from './modules/audiotest.js';
import { loadSiteConfig, getSiteConfig } from './siteConfig.js';
import { isLocalAvailable }    from './localBridge.js';

export async function boot() {
  initTabs();

  // Register the Service Worker for offline caching of the app shell.
  // Errors are silently ignored — the app works without a SW.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

  // Weather and departures need the location config from the local server.
  // Fetch it (cached after the first home-network visit), then start them.
  loadSiteConfig().then(() => { loadWeather(); loadTransit(); });
  setInterval(locationTick, 60_000); // refresh config + departures every minute

  setFamilyBackground(document.getElementById('family-bg'));
  initTodo();
  initSwatch();
  initPhotos();
  initHauschat();
  initInfo();
  initAudiotest();

  // Show initial server status, then refresh every 30 s (matches health-check TTL).
  updateLocalStatus();
  setInterval(updateLocalStatus, 30_000);
}

/**
 * Runs every 60 seconds: refreshes the site config so weather and departures
 * start working as soon as the device reaches the home network, then reloads
 * the departures. Weather is reloaded only when the config first arrives.
 */
async function locationTick() {
  const hadConfig = !!getSiteConfig();
  await loadSiteConfig();
  if (!hadConfig && getSiteConfig()) loadWeather();
  loadTransit();
}

/**
 * Checks whether the local WLAN server is reachable and updates the
 * status dot (#local-status) with CSS classes 'online' or 'offline'.
 */
async function updateLocalStatus() {
  const el = document.getElementById('local-status');
  if (!el) return;
  const online = await isLocalAvailable();
  el.classList.toggle('online',  online);
  el.classList.toggle('offline', !online);
  el.title = online ? 'Local server: Online' : 'Local server: Offline';
}

// Subpages are opened from a menu rather than the tab bar (the colour picker
// and Hauschat, from the "Diverses" menu). The value is the tab that stays
// highlighted while the subpage is open.
const SUBPAGE_OWNER = {
  color: 'diverses', hauschat: 'diverses', info: 'diverses', audiotest: 'diverses',
};

/**
 * Sets up the bottom tab bar and the subpage navigation.
 *
 * Tab buttons (.tab-btn[data-page]) switch between the top-level pages.
 * Menu items ([data-subpage]) open a subpage. Back buttons ([data-back])
 * return from a subpage to its owning tab page. The current page — tab OR
 * subpage — is stored in localStorage, so a reload restores exactly where
 * the user was (e.g. inside the colour picker, not the Diverses menu).
 */
function initTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const pages   = document.querySelectorAll('.page');

  /** Shows the given page, highlights its owning tab, and remembers it. */
  function show(name) {
    pages.forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
    const ownerTab = SUBPAGE_OWNER[name] ?? name;
    tabBtns.forEach(t => t.classList.toggle('active', t.dataset.page === ownerTab));
    localStorage.setItem('pwa.page', name);
  }

  // Restore the page the user last had open (tab or subpage). 'pwa.tab' is
  // the older key, kept so existing installs migrate cleanly. Falls back to
  // "home" if the stored page no longer exists.
  let saved = localStorage.getItem('pwa.page') || localStorage.getItem('pwa.tab') || 'home';
  if (!document.getElementById('page-' + saved)) saved = 'home';
  show(saved);

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => show(btn.dataset.page));
  });

  // Menu items open a subpage; back buttons return to a tab page.
  document.querySelectorAll('[data-subpage]').forEach(el => {
    el.addEventListener('click', () => show(el.dataset.subpage));
  });
  document.querySelectorAll('[data-back]').forEach(el => {
    el.addEventListener('click', () => show(el.dataset.back));
  });
}
