/**
 * weather.js — 3-day weather forecast.
 *
 * Data source: open-meteo.com — free, no API key required, CORS-enabled
 * (the browser can call it directly without a proxy).
 *
 * The forecast location comes from the local server's /api/config (see
 * siteConfig.js) and is cached on the device. Until the device has been on
 * the home network once, no location is known and the card shows a hint.
 *
 * Strategy:
 *  1. If a previous forecast is stored in localStorage, render it immediately.
 *  2. Fetch a fresh forecast from the API in the background.
 *  3. If the fetch succeeds, overwrite the cached data and re-render.
 *  4. If the fetch fails and nothing is cached, show an error state.
 *
 * Weather codes follow the WMO (World Meteorological Organization) standard.
 */

import { CONFIG } from '../config.js';
import { getSiteConfig } from '../siteConfig.js';

// Short weekday names used in the forecast rows (index 0 = Sunday).
const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];

const METEOSWISS_WEB = 'https://www.meteoschweiz.admin.ch/lokalprognose/zuerich/8032.html#forecast-tab=detail-view';
const METEOSWISS_APP = 'meteoswiss://';  // iOS MeteoSwiss app URL scheme

/**
 * Opens MeteoSwiss: the native app on mobile (with website fallback if not
 * installed), or the website directly on desktop.
 */
function openMeteoSwiss() {
  const ua       = navigator.userAgent;
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
  if (!isMobile) { window.open(METEOSWISS_WEB, '_blank', 'noopener'); return; }
  // Try to open the app; fall back to the website after 1.5 s if not installed.
  const t = setTimeout(() => window.open(METEOSWISS_WEB, '_blank', 'noopener'), 1500);
  document.addEventListener('visibilitychange', function h() {
    clearTimeout(t);
    document.removeEventListener('visibilitychange', h);
  }, { once: true });
  window.location.href = METEOSWISS_APP;
}

let _weatherListenerAttached = false;

/**
 * Maps WMO weather interpretation codes to an emoji.
 * Full code list: https://open-meteo.com/en/docs#weathervariables
 */
const WMO = {
  0: '☀️',               // clear sky
  1: '🌤️', 2: '⛅', 3: '☁️',  // mainly clear → overcast
  45: '🌫️', 48: '🌫️',   // fog
  51: '🌦️', 53: '🌦️', 55: '🌦️', // drizzle
  56: '🌧️', 57: '🌧️',   // freezing drizzle
  61: '🌧️', 63: '🌧️', 65: '🌧️', // rain
  66: '🌨️', 67: '🌨️',   // freezing rain
  71: '🌨️', 73: '🌨️', 75: '❄️', 77: '🌨️', // snow
  80: '🌧️', 81: '🌧️', 82: '🌧️', // rain showers
  85: '🌨️', 86: '❄️',   // snow showers
  95: '⛈️', 96: '⛈️', 99: '⛈️', // thunderstorms
};

/** Returns the emoji for a WMO code, or a thermometer if the code is unknown. */
function wmoEmoji(code) { return WMO[code] ?? '🌡️'; }

/**
 * Returns the display label for a forecast day.
 * The API returns dates as strings like "2026-05-17".
 * We parse the date at noon (T12:00) to avoid timezone edge cases where
 * a UTC midnight date would shift into the wrong local day.
 *
 * @param {string} dateStr - ISO date string from the API (e.g. "2026-05-17").
 * @param {number} i - Index in the forecast array (0 = today).
 */
function dayLabel(dateStr, i) {
  if (i === 0) return 'Heute';
  return DAYS[new Date(dateStr + 'T12:00:00').getDay()];
}

/**
 * Renders the weather card with the given daily forecast data.
 *
 * @param {object} daily - The "daily" object from the open-meteo API response.
 * @param {boolean} fromCache - If true, shows a small "cached data" banner.
 */
function render(daily, fromCache) {
  const card = document.getElementById('weather-card');
  const n    = Math.min(3, daily.time.length); // show at most 3 days
  card.innerHTML =
    (fromCache ? '<div class="w-cached">📦 Gespeicherte Daten</div>' : '') +
    Array.from({ length: n }, (_, i) => `
      <div class="weather-row ${i === 0 ? 'today' : ''}">
        <span class="w-day">${dayLabel(daily.time[i], i)}</span>
        <span class="w-icon">${wmoEmoji(daily.weathercode[i])}</span>
        <div class="w-temps">
          <span class="t-min">${Math.round(daily.temperature_2m_min[i])}°</span>
          <span class="t-max">${Math.round(daily.temperature_2m_max[i])}°</span>
        </div>
        <div class="w-precip">
          <div class="p-main">${(daily.precipitation_sum[i] ?? 0).toFixed(1)} mm</div>
          <div class="p-range">${daily.precipitation_probability_max[i] ?? 0}%</div>
        </div>
      </div>`).join('');
}

/**
 * Main entry point — called by app.js once the site config has loaded.
 * Shows cached data immediately, then fetches a fresh forecast.
 */
export async function loadWeather() {
  const card   = document.getElementById('weather-card');
  const cached = localStorage.getItem('pwa.weather');
  const loc    = getSiteConfig()?.weather;

  // Attach dblclick handler once — opens MeteoSwiss on double-tap/double-click.
  if (!_weatherListenerAttached) {
    _weatherListenerAttached = true;
    card.addEventListener('dblclick', openMeteoSwiss);
  }

  // Show stale data immediately so the card is never empty.
  if (cached) render(JSON.parse(cached), true);

  // Reflect the configured location name in the section label.
  if (loc?.label) {
    const lbl = document.getElementById('weather-label');
    if (lbl) lbl.textContent = 'Wetter · ' + loc.label;
  }

  // No location yet — the device has not been on the home network. Keep any
  // cached card; otherwise show a hint instead of querying with no coordinates.
  if (!loc) {
    if (!cached) {
      card.innerHTML = `<div class="w-state">Standort noch nicht geladen —
        einmal mit dem Heim-WLAN verbinden.</div>`;
    }
    return;
  }

  // Build the API URL with all required fields.
  const url = `${CONFIG.METEO_BASE}/forecast`
    + `?latitude=${loc.lat}&longitude=${loc.lon}`
    + `&daily=weathercode,temperature_2m_max,temperature_2m_min`
    + `,precipitation_sum,precipitation_probability_max`
    + `&timezone=auto&forecast_days=3`;

  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data?.daily?.time?.length) {
      localStorage.setItem('pwa.weather', JSON.stringify(data.daily));
      render(data.daily, false); // replace cached banner with fresh data
    }
  } catch {
    // Network is offline or API is down — keep the cached data visible.
    // Only show the error state if there is nothing cached at all.
    if (!cached) {
      card.innerHTML = '<div class="w-state">⚠️ Wetter nicht verfügbar</div>';
    }
  }
}
