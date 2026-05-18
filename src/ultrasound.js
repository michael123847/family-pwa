/**
 * ultrasound.js — Data-over-sound transport for Hauschat (Phase 2).
 *
 * Wraps the ggwave library (https://github.com/ggerganov/ggwave) so short
 * messages can be sent between devices purely as audio — no network at all.
 * This covers the "no server reachable" cases: a foreign WiFi, or an
 * aeroplane where there is no shared network between the phones.
 *
 * ggwave is a WASM library. Its file (vendor/ggwave/ggwave.js, with the WASM
 * embedded) is NOT in this repository by default — see vendor/ggwave/README.md.
 * Until it is present, isUltrasoundAvailable() resolves false and the feature
 * stays disabled instead of crashing the app.
 *
 * startListening() asks for the microphone FIRST, before loading ggwave, so
 * the browser's permission prompt always appears — even if ggwave were to
 * fail. Receiving auto-detects audible or ultrasound; the "audible" flag only
 * picks the protocol used for SENDING.
 *
 * This is the low-level codec/transport. Subapps normally use the stateful
 * wrapper UltrasoundChannel (ultrasoundChannel.js) instead of these functions
 * directly.
 */

// Path to the vendored ggwave loader (classic script — defines window.ggwave_factory).
const GGWAVE_SCRIPT = './vendor/ggwave/ggwave.js';

let ggwave   = null;  // the ggwave module (after factory init)
let ctx      = null;  // shared AudioContext
let instance = null;  // ggwave instance handle

let listening  = false;
let recorder   = null; // ScriptProcessorNode
let micSource  = null; // MediaStreamAudioSourceNode
let micStream  = null; // MediaStream

/**
 * Reinterprets the bytes of a typed array as another typed-array type.
 * ggwave hands waveforms back as raw bytes that must be viewed as Float32
 * for Web Audio, and microphone Float32 samples must be viewed as bytes for
 * ggwave.decode(). This is the helper from ggwave's own web example.
 */
function convertTypedArray(src, Type) {
  const buffer = new ArrayBuffer(src.byteLength);
  new src.constructor(buffer).set(src);
  return new Type(buffer);
}

/** Loads vendor/ggwave/ggwave.js once (as a classic script). */
function loadScript() {
  return new Promise((resolve, reject) => {
    if (window.ggwave_factory) return resolve();
    const s = document.createElement('script');
    s.src     = GGWAVE_SCRIPT;
    s.onload  = () => resolve();
    s.onerror = () => reject(new Error('ggwave nicht gefunden'));
    document.head.appendChild(s);
  });
}

/**
 * Creates the shared AudioContext if it does not exist yet. Kept synchronous
 * so it can run inside the user gesture that opened ultrasound mode, which
 * keeps the browser autoplay policy happy.
 */
function ensureContext() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
}

/** Loads ggwave and initialises the instance (needs the AudioContext first). */
async function ensureGgwave() {
  if (instance != null) return;
  await loadScript();
  ggwave = await window.ggwave_factory();
  const p = ggwave.getDefaultParameters();
  p.sampleRateInp = ctx.sampleRate;
  p.sampleRateOut = ctx.sampleRate;
  instance = ggwave.init(p);
}

/**
 * Returns true if ultrasound messaging can work here: the browser has the
 * needed audio APIs and the ggwave library file is reachable.
 */
export async function isUltrasoundAvailable() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia ||
      !(window.AudioContext || window.webkitAudioContext)) {
    return false;
  }
  try { await loadScript(); return true; }
  catch { return false; }
}

/** Largest payload ggwave transmits in one burst. */
export const MAX_PAYLOAD_BYTES = 140;

/**
 * Sends a string as sound and resolves when playback has finished.
 *
 * @param {string} text - payload (must fit in MAX_PAYLOAD_BYTES as UTF-8).
 * @param {{ audible?: boolean }} opts - audible vs ultrasound protocol.
 */
export async function transmit(text, { audible = false } = {}) {
  ensureContext();
  await ensureGgwave();
  if (ctx.state === 'suspended') await ctx.resume();

  const protocol = audible
    ? ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST
    : ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST;

  const waveform = ggwave.encode(instance, text, protocol, 10); // 10 = volume
  const samples  = convertTypedArray(waveform, Float32Array);

  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.getChannelData(0).set(samples);

  return new Promise(resolve => {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => resolve();
    src.start();
  });
}

/**
 * Starts listening on the microphone. Every fully decoded message is passed
 * to onMessage(text).
 *
 * The microphone is requested FIRST (before ggwave is loaded), so the
 * browser permission prompt always appears. If the user denies it, this
 * rejects with NotAllowedError; if the device has no microphone, with
 * NotFoundError — the caller maps these to a clear message.
 *
 * @param {(text: string) => void} onMessage
 */
export async function startListening(onMessage) {
  if (listening) return;
  ensureContext();

  // 1. Microphone — this triggers the permission prompt.
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  // 2. ggwave + audio graph. On any failure, release the microphone again.
  try {
    await ensureGgwave();
    if (ctx.state === 'suspended') await ctx.resume();

    micSource = ctx.createMediaStreamSource(micStream);
    recorder  = ctx.createScriptProcessor(1024, 1, 1);
    recorder.onaudioprocess = e => {
      const samples = new Float32Array(e.inputBuffer.getChannelData(0));
      const res = ggwave.decode(instance, convertTypedArray(samples, Int8Array));
      if (res && res.length > 0) {
        try { onMessage(new TextDecoder('utf-8').decode(res)); } catch { /* garbled */ }
      }
    };

    // A ScriptProcessor only runs while connected downstream. Route it through
    // a silent gain node so the microphone is not echoed back to the speakers.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    micSource.connect(recorder);
    recorder.connect(mute);
    mute.connect(ctx.destination);

    listening = true;
  } catch (e) {
    try { micStream.getTracks().forEach(t => t.stop()); } catch { /* already gone */ }
    micStream = micSource = recorder = null;
    throw e;
  }
}

/** Stops listening and releases the microphone. */
export function stopListening() {
  if (!listening) return;
  try { recorder.disconnect(); } catch { /* already gone */ }
  try { micSource.disconnect(); } catch { /* already gone */ }
  try { micStream.getTracks().forEach(t => t.stop()); } catch { /* already gone */ }
  recorder = micSource = micStream = null;
  listening = false;
}

/** Whether the microphone is currently being listened to. */
export function isListening() { return listening; }
