/**
 * main.js — Application entry point.
 *
 * Reads ENABLE_TAILSCALE from the cached siteConfig (localStorage) to decide
 * which auth flow to use:
 *
 *  value == 0 (default): PBKDF2 passphrase gate — no server contact needed.
 *  value == 1:           Server-issued token via enrollment — requires LAN
 *                        on first setup, then works over LAN or Tailscale.
 *
 * The flag is server-controlled (config.json) and takes effect on the next
 * app load after siteConfig has been refreshed from the server.
 */

import { ensureAuthenticated, ensureEnrolled } from './auth.js';
import { isTailscaleMode } from './config.js';
import { boot } from './app.js';

(async () => {
  if (isTailscaleMode()) {
    await ensureEnrolled();
  } else {
    await ensureAuthenticated();
  }
  await boot();
})();
