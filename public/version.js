/**
 * version.js — SINGLE SOURCE OF TRUTH for the app version.
 *
 * Loaded by BOTH runtime scopes as a classic script:
 *   - sw.js via importScripts('./version.js')  (service-worker scope)
 *   - index.html via <script src="version.js"> before the module bundle;
 *     src/config.js reads globalThis.__APP_VERSION (window scope)
 *
 * Bump ONLY this file on deploy. Chrome ≥68 includes importScripts'd files
 * in the service-worker byte-diff update check, so changing this file alone
 * triggers the new-shell rollout on the target platform (Android Chrome).
 */
self.__APP_VERSION = 'v1.2.13';
