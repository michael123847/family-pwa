/**
 * ultrasoundChannel.js — reusable P2P "channel" over sound.
 *
 * A self-contained unit that any subapp can use to exchange short text
 * payloads between nearby devices with no network at all — over the
 * microphone and speaker. It wraps the low-level ggwave codec (ultrasound.js)
 * and adds the stateful session logic: on/off, audible vs ultrasound mode
 * (persisted), error-to-message mapping, and releasing the microphone while
 * the app is backgrounded.
 *
 * It is deliberately UI-agnostic — it never touches the DOM. The consumer
 * supplies two callbacks and wires its own buttons to the channel methods:
 *
 *   const ch = new UltrasoundChannel({
 *     name:      'hauschat',                  // namespaces the saved mode
 *     onMessage: text => { ... },             // a payload was decoded
 *     onStatus:  (text, isError) => { ... },  // show this status in your UI
 *   });
 *   if (await ch.available()) { ...wire buttons to ch.toggle()/ch.setMode()... }
 *   await ch.toggle();        // turn listening on/off
 *   await ch.send('hello');   // emit a payload as sound
 *
 * The payload format is the consumer's concern — the channel transports
 * plain strings (up to ch.maxBytes UTF-8 bytes per transmission).
 */

import {
  transmit, startListening, stopListening,
  isUltrasoundAvailable, MAX_PAYLOAD_BYTES,
} from './ultrasound.js';

/** Maps a startListening error to a clear German status message. */
function errorText(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return '⚠️ Mikrofon-Zugriff verweigert — im Browser/System erlauben';
  if (name === 'NotFoundError')
    return '⚠️ Kein Mikrofon gefunden';
  if (name === 'NotReadableError')
    return '⚠️ Mikrofon belegt oder vom System blockiert';
  if (name === 'OverconstrainedError')
    return '⚠️ Mikrofon nicht nutzbar';
  if (e && /ggwave/i.test(e.message || ''))
    return '⚠️ Ultraschall-Bibliothek nicht geladen';
  return '⚠️ Ultraschall: ' + ((e && e.message) || e);
}

export class UltrasoundChannel {
  /**
   * @param {object}   opts
   * @param {string}   opts.name      - namespace for the saved mode (per subapp)
   * @param {Function} opts.onMessage - called with each decoded payload string
   * @param {Function} opts.onStatus  - called with (text, isError) to show status
   */
  constructor({ name = 'ultrasound', onMessage, onStatus } = {}) {
    this._name      = name;
    this._onMessage = onMessage || (() => {});
    this._onStatus  = onStatus  || (() => {});
    this._onVis     = this._handleVisibility.bind(this);
    this._listener  = null; // handle from startListening(), null when off

    /** Whether the channel is currently listening. */
    this.enabled = false;
    /** false = ultrasound protocol (discreet), true = audible (reliable). */
    this.audible = localStorage.getItem(name + '.audible') === '1';
  }

  /** Largest payload that fits in one transmission, in UTF-8 bytes. */
  get maxBytes() { return MAX_PAYLOAD_BYTES; }

  /** Resolves true if ultrasound can work on this device/browser. */
  available() { return isUltrasoundAvailable(); }

  /** Turns the channel on (if off) or off (if on). */
  async toggle() {
    if (this.enabled) this.disable();
    else              await this.enable();
  }

  /**
   * Starts listening on the microphone. Problems (denied permission, no
   * microphone, missing library) are reported via onStatus; on failure the
   * channel simply stays disabled.
   */
  async enable() {
    if (this.enabled) return;
    this._onStatus('⏳ Mikrofon…', false);
    try {
      // disableProcessing: open the mic without echo cancellation / noise
      // suppression / auto gain. Those filter out the data-over-sound signal —
      // verified via the Audiotest subapp: with them ON, ultrasound reception
      // fails on most devices; with them OFF it works on Chrome, Android, iOS.
      this._listener = await startListening(text => this._onMessage(text), { disableProcessing: true });
    } catch (e) {
      console.error('[UltrasoundChannel] enable failed:', e);
      this._onStatus(errorText(e), true);
      return;
    }
    this.enabled = true;
    document.addEventListener('visibilitychange', this._onVis);
    this._idleStatus();
  }

  /** Stops listening and releases the microphone. */
  disable() {
    if (!this.enabled) return;
    stopListening(this._listener);
    this._listener = null;
    this.enabled = false;
    document.removeEventListener('visibilitychange', this._onVis);
    this._onStatus('', false);
  }

  /** Sets the send mode (true = audible, false = ultrasound) and persists it. */
  setMode(audible) {
    this.audible = !!audible;
    localStorage.setItem(this._name + '.audible', this.audible ? '1' : '0');
    this._idleStatus();
  }

  /**
   * Transmits a text payload as sound. Returns true on success. Oversize
   * payloads are rejected up front (reported via onStatus).
   *
   * @param {string} text
   * @returns {Promise<boolean>}
   */
  async send(text) {
    if (new TextEncoder().encode(text).length > MAX_PAYLOAD_BYTES) {
      this._onStatus('⚠️ Zu lang für Ultraschall', true);
      return false;
    }
    this._onStatus('🔊 sende…', false);
    try {
      await transmit(text, { audible: this.audible });
    } catch (e) {
      console.error('[UltrasoundChannel] send failed:', e);
      this._onStatus('⚠️ Senden fehlgeschlagen', true);
      return false;
    }
    this._idleStatus();
    return true;
  }

  // ── internal ────────────────────────────────────────────────────────────

  /** Reports the resting status (listening hint, or blank when off). */
  _idleStatus() {
    this._onStatus(
      this.enabled ? (this.audible ? '🔊 hörbar · hört zu' : '📡 hört zu') : '',
      false,
    );
  }

  /** Releases the microphone while the app is backgrounded; resumes on return. */
  _handleVisibility() {
    if (!this.enabled) return;
    if (document.hidden) {
      if (this._listener) { stopListening(this._listener); this._listener = null; }
    } else if (!this._listener) {
      startListening(text => this._onMessage(text), { disableProcessing: true })
        .then(l => { this._listener = l; })
        .catch(() => { /* mic unavailable — stays off until next toggle */ });
    }
  }
}
