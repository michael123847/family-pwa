/**
 * main.js — Application entry point.
 *
 * This is the first JavaScript file the browser executes (loaded via
 * <script type="module"> in index.html). It runs two steps in order:
 *
 *  1. ensureEnrolled() — gets (or refreshes) the device's whitelist token
 *     from the local server. On a first visit the device is auto-enrolled
 *     as a Visitor; the token + role are stored in localStorage so the
 *     enrollment only happens once. The token is sent as Authorization:
 *     Bearer with every subsequent request.
 *
 *  2. boot() — initialises all app modules (weather, transit, todos, etc.)
 *     and registers the Service Worker. Boot is non-blocking on enrollment
 *     failure — Wetter / Abfahrten / Farben work without a token.
 *
 * The `async IIFE` (immediately invoked function expression) wrapper is
 * needed because top-level await is not supported in all browsers.
 */

import { ensureEnrolled } from './auth.js';
import { boot }           from './app.js';

(async () => {
  await ensureEnrolled();
  await boot();
})();
