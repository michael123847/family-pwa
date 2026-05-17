/**
 * main.js — Application entry point.
 *
 * This is the first JavaScript file the browser executes (loaded via
 * <script type="module"> in index.html). It runs two steps in order:
 *
 *  1. ensureAuthenticated() — shows a password modal and blocks until the
 *     correct passphrase is entered. The derived hash is saved to
 *     localStorage and reused on subsequent visits so the modal only
 *     appears once per device.
 *
 *  2. boot() — initialises all app modules (weather, transit, todos, etc.)
 *     and registers the Service Worker.
 *
 * The `async IIFE` (immediately invoked function expression) wrapper is
 * needed because top-level await is not supported in all browsers.
 */

import { ensureAuthenticated } from './auth.js';
import { boot }                from './app.js';

(async () => {
  await ensureAuthenticated();
  await boot();
})();
