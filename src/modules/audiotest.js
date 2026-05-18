/**
 * audiotest.js — "Audiotest" subapp: an ultrasound loopback self-test.
 *
 * Plays a known test payload through the speaker and tries to decode it back
 * through the SAME device's microphone. Reports what was received and how
 * loud the microphone heard it. A quick check whether a device can do
 * data-over-sound at all — and in which mode (ultrasound vs audible).
 *
 * The microphone is opened with echo cancellation / noise suppression / auto
 * gain OFF (disableProcessing) — otherwise the browser would actively cancel
 * the loopback signal and the test could never succeed.
 */

import { transmit, startListening, stopListening, isUltrasoundAvailable } from '../ultrasound.js';

let audible  = false;  // false = ultrasound protocol, true = audible
let running  = false;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Shows the result/progress text. tone: 'ok' | 'warn' | 'error' | undefined. */
function setStatus(text, tone) {
  const el = document.getElementById('audiotest-status');
  if (!el) return;
  el.textContent = text;
  el.className = 'audiotest-status' + (tone ? ' ' + tone : '');
}

/** Sets the level-meter bar; level is a 0..1 amplitude. */
function setMeter(level) {
  const fill = document.getElementById('audiotest-meter-fill');
  if (fill) fill.style.width = Math.min(100, Math.round(level * 100)) + '%';
}

/**
 * Runs one loopback test: open mic → play test signal → wait for the decode →
 * report the result and the peak microphone level.
 */
async function runTest() {
  if (running) return;
  running = true;
  const runBtn = document.getElementById('audiotest-run');
  runBtn.disabled = true;

  const expected = 'TEST-' + Math.random().toString(36).slice(2, 7).toUpperCase();
  let decoded  = null;
  let peak     = 0;
  let listener = null; // own microphone listener — removed again at the end

  try {
    setStatus('⏳ Mikrofon wird geöffnet…');
    listener = await startListening(
      text => { decoded = text; },
      {
        disableProcessing: true,
        onLevel: lvl => { if (lvl > peak) peak = lvl; setMeter(lvl); },
      },
    );

    setStatus('🔊 Testsignal wird abgespielt…');
    await transmit(expected, { audible });

    setStatus('🎤 Warte auf Empfang…');
    const t0 = Date.now();
    while (!decoded && Date.now() - t0 < 5000) await sleep(150);
  } catch (e) {
    if (listener) stopListening(listener);
    setStatus('⚠️ Test fehlgeschlagen: ' + ((e && e.name) || e), 'error');
    running = false;
    runBtn.disabled = false;
    return;
  }

  stopListening(listener);
  setMeter(peak);
  const pct  = Math.round(peak * 100);
  const mode = audible ? 'hörbar' : 'Ultraschall';

  if (decoded === expected) {
    setStatus(`✅ ${mode}: empfangen „${decoded}" · Spitzenpegel ${pct}%`, 'ok');
  } else if (decoded) {
    setStatus(`⚠️ ${mode}: empfangen, aber abweichend — „${decoded}" `
      + `(gesendet „${expected}") · Spitzenpegel ${pct}%`, 'warn');
  } else if (pct < 3) {
    setStatus(`❌ ${mode}: nichts empfangen · Spitzenpegel nur ${pct}% — das `
      + `Mikrofon hat das Signal kaum gehört (Lautstärke zu leise, oder die `
      + `Ultraschall-Frequenz liegt ausserhalb der Geräte-Reichweite).`, 'error');
  } else {
    setStatus(`❌ ${mode}: nichts dekodiert · Spitzenpegel ${pct}% — das Signal `
      + `kam an, war aber nicht lesbar. Zum Vergleich mit „hörbar" testen.`, 'error');
  }

  running = false;
  runBtn.disabled = false;
}

/** Switches the test protocol between ultrasound and audible. */
function toggleMode() {
  audible = !audible;
  document.getElementById('audiotest-mode').textContent =
    audible ? 'Modus: hörbar' : 'Modus: Ultraschall';
  setStatus('Bereit.');
}

/**
 * Wires the Audiotest subapp. Called once by app.js during boot. If the
 * ggwave library is unavailable the test button stays disabled.
 */
export async function initAudiotest() {
  const runBtn = document.getElementById('audiotest-run');
  if (!runBtn) return;

  if (!(await isUltrasoundAvailable())) {
    runBtn.disabled = true;
    setStatus('Ultraschall-Bibliothek nicht verfügbar.', 'error');
    return;
  }
  runBtn.addEventListener('click', runTest);
  document.getElementById('audiotest-mode').addEventListener('click', toggleMode);
}
