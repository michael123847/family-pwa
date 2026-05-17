/**
 * transit.js — Next departures for configured ZVV bus/tram stops.
 *
 * Data source: transport.opendata.ch — free, no API key required, CORS-enabled.
 *
 * All configured stops are fetched in parallel (Promise.allSettled), so a
 * slow or failing stop does not block the others. Each stop group is rendered
 * independently, showing "Keine Abfahrten" or "Fehler" if data is missing.
 *
 * nextStop filter: The Hölderlinstrasse stop is served by buses going in
 * both directions. To show only departures heading towards the city centre,
 * we check whether the *next* stop on the route contains "Römerhof". This
 * filters out buses going the wrong way without needing a separate endpoint.
 */

import { CONFIG } from '../config.js';
import { getSiteConfig } from '../siteConfig.js';

/**
 * Returns the CSS class name for a given line number.
 * Lines 2, 3, and 31 have dedicated colour classes; all others use a default.
 *
 * @param {string|number} num - The line number (e.g. "2", "31").
 */
function lineClass(num) {
  return ['2', '3', '31'].includes(String(num)) ? `line-${num}` : 'line-other';
}

/**
 * Renders all stop groups into the #transit-container element.
 *
 * @param {Array<{label: string, departures: Array, error?: boolean}>} groups
 */
function renderGroups(groups) {
  const container = document.getElementById('transit-container');
  container.innerHTML = groups.map(g => {
    if (!g.departures.length) {
      return `<div class="transit-group">
        <div class="transit-group-header">${g.label}</div>
        <div class="transit-row" style="color:var(--text-dim);font-size:.82rem">
          ${g.error ? 'Fehler beim Laden' : 'Keine Abfahrten'}
        </div>
      </div>`;
    }
    return `<div class="transit-group">
      <div class="transit-group-header">${g.label}</div>
      ${g.departures.map(d => {
        const delayed = d.delay > 0;
        return `<div class="transit-row">
          <span class="transit-line ${lineClass(d.line)}">${d.line}</span>
          <span class="transit-to">${d.to}</span>
          <span class="transit-time"${delayed ? ' style="color:#c0504d"' : ''}>${d.time}</span>
          <span class="transit-delay">${delayed ? '+' + d.delay + '′' : ''}</span>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');
}

/**
 * Fetches departures for a single stop configuration from the API.
 *
 * We request more entries than needed (fetchLimit) to have enough candidates
 * after the nextStop filter removes departures going the wrong direction.
 *
 * @param {{ name: string, limit: number, nextStop?: string }} stop
 * @returns {Promise<Array<{line, to, time, delay}>>}
 */
async function fetchStop(stop) {
  // Request extra entries to compensate for those filtered out by nextStop.
  const fetchLimit = (stop.limit + 3) * (stop.nextStop ? 3 : 1);
  const url = `${CONFIG.ZVV_BASE}/stationboard?limit=${fetchLimit}`
    + `&station=${encodeURIComponent(stop.name)}`;

  // No custom headers — User-Agent is a forbidden header in browsers and
  // causes a TypeError on iOS Safari even though Chrome silently drops it.
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const data = await r.json();

  const nextFilter = (stop.nextStop || '').toLowerCase();

  // A Set is used to de-duplicate entries that appear twice in the API response
  // (this occasionally happens for real-time vs. scheduled departures).
  const seen = new Set();
  const deps = [];

  for (const d of data.stationboard ?? []) {
    const num    = d.number || d.name || '';
    const depStr = d.stop?.departure || '';
    const key    = num + '|' + depStr; // unique key per line + scheduled time
    if (!num || seen.has(key)) continue;
    seen.add(key);

    // Apply the nextStop filter: passList[1] is the stop after the departure stop.
    if (nextFilter) {
      const nextName = (d.passList?.[1]?.station?.name || '').toLowerCase();
      if (!nextName.includes(nextFilter)) continue;
    }

    // Format the raw ISO timestamp to a human-readable HH:MM string.
    let time = depStr;
    try { time = new Date(depStr).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' }); }
    catch {} // keep raw string if parsing fails

    deps.push({ line: num, to: d.to || '', time, delay: d.stop?.delay || 0 });
    if (deps.length >= stop.limit) break;
  }

  return deps;
}

/**
 * Main entry point — called by app.js once the site config has loaded and
 * every 60 seconds afterwards. Fetches all stops in parallel; if one stop
 * fails, the others still render.
 *
 * The stop list comes from the local server's /api/config (see siteConfig.js).
 * Until the device has been on the home network once, no stops are known and
 * a hint is shown instead.
 */
export async function loadTransit() {
  const stops = getSiteConfig()?.stops;
  if (!stops || !stops.length) {
    document.getElementById('transit-container').innerHTML =
      '<div class="w-state" style="padding:16px;background:var(--card);' +
      'border:1px solid var(--card-border);border-radius:18px">' +
      'Haltestellen noch nicht geladen — einmal mit dem Heim-WLAN verbinden.</div>';
    return;
  }

  // Promise.allSettled never rejects — each result is either fulfilled or rejected.
  const results = await Promise.allSettled(
    stops.map(async stop => {
      try {
        return { label: stop.label, departures: await fetchStop(stop) };
      } catch {
        return { label: stop.label, departures: [], error: true };
      }
    })
  );
  renderGroups(results.map(r => r.value));
}
