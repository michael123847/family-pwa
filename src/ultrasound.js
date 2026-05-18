/**
 * ultrasound.js — Data-over-sound transport (low-level codec).
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
 * Shared microphone: there is only one microphone, but several subapps
 * (Hauschat, the TODO list, the Audiotest) may want to listen at the same
 * time. startListening() therefore registers a *listener*; the microphone is
 * opened on the first listener and torn down when the last one leaves. Every
 * decoded message is delivered to all current listeners — each consumer
 * ignores payloads in a format it does not recognise.
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

let recorder  = null; // ScriptProcessorNode
let micSource = null; // MediaStreamAudioSourceNode
let micStream = null; // MediaStream
let micOpen   = false; // whether the microphone graph is currently running
let opening   = null;  // Promise while the microphone is being opened (race guard)

// Active listeners — each is { onMessage, onLevel }. The microphone is opened
// on the first listener and released when the last one is removed.
const listeners = new Set();

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
 * Opens the microphone + decode graph once. Concurrent calls share the same
 * in-flight promise so the microphone is never opened twice.
 */
function openMic(disableProcessing) {
  if (micOpen)  return Promise.resolve();
  if (opening)  return opening;

  opening = (async () => {
    ensureContext();

    // disableProcessing turns off echo cancellation / noise suppression /
    // auto gain — those filter out a data-over-sound signal.
    const audio = disableProcessing
      ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      : true;
    micStream = await navigator.mediaDevices.getUserMedia({ audio });

    try {
      await ensureGgwave();
      if (ctx.state === 'suspended') await ctx.resume();

      micSource = ctx.createMediaStreamSource(micStream);
      // ScriptProcessorNode is deprecated (browsers log a warning) — used here
      // deliberately: it is far simpler than an AudioWorklet, which would need
      // a separate worklet file and cross-thread messaging to reach the ggwave
      // decoder. It works in all current browsers; ggwave's examples use it.
      recorder = ctx.createScriptProcessor(1024, 1, 1);
      recorder.onaudioprocess = e => {
        const samples = new Float32Array(e.inputBuffer.getChannelData(0));

        let peak = 0;
        for (let i = 0; i < samples.length; i++) {
          const a = Math.abs(samples[i]);
          if (a > peak) peak = a;
        }

        const res = ggwave.decode(instance, convertTypedArray(samples, Int8Array));
        let text = null;
        if (res && res.length > 0) {
          try { text = new TextDecoder('utf-8').decode(res); } catch { /* garbled */ }
        }

        // Fan out to every listener. Each consumer ignores formats it does
        // not recognise, so several subapps can share the microphone.
        for (const l of listeners) {
          if (l.onLevel) l.onLevel(peak);
          if (text !== null) l.onMessage(text);
        }
      };

      // A ScriptProcessor only runs while connected downstream. Route it
      // through a silent gain node so the mic is not echoed to the speakers.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      micSource.connect(recorder);
      recorder.connect(mute);
      mute.connect(ctx.destination);

      micOpen = true;
    } catch (e) {
      try { micStream.getTracks().forEach(t => t.stop()); } catch { /* already gone */ }
      micStream = micSource = recorder = null;
      throw e;
    } finally {
      opening = null;
    }
  })();

  return opening;
}

/** Stops and releases the microphone graph. */
function closeMic() {
  if (!micOpen) return;
  try { recorder.disconnect(); } catch { /* already gone */ }
  try { micSource.disconnect(); } catch { /* already gone */ }
  try { micStream.getTracks().forEach(t => t.stop()); } catch { /* already gone */ }
  recorder = micSource = micStream = null;
  micOpen = false;
}

/**
 * Registers a listener and opens the microphone if it is not running yet.
 * Returns a listener handle — pass it to stopListening() to remove just this
 * listener. Decoded messages and (optionally) the input level are delivered
 * to every registered listener.
 *
 * The microphone is requested as part of this call, so the browser permission
 * prompt appears. On denial it rejects with NotAllowedError, on a missing
 * microphone with NotFoundError — the caller maps these to a clear message.
 *
 * @param {(text: string) => void} onMessage
 * @param {object}   [opts]
 * @param {(level: number) => void} [opts.onLevel] - called every audio frame
 *        with the peak amplitude (0..1) of that frame — for a level meter.
 * @param {boolean}  [opts.disableProcessing] - open the microphone with echo
 *        cancellation / noise suppression / auto gain OFF. Only honoured for
 *        the listener that actually opens the microphone.
 * @returns {Promise<object>} the listener handle.
 */
export async function startListening(onMessage, { onLevel, disableProcessing = false } = {}) {
  const listener = { onMessage: onMessage || (() => {}), onLevel: onLevel || null };
  listeners.add(listener);
  try {
    await openMic(disableProcessing);
  } catch (e) {
    listeners.delete(listener);
    throw e;
  }
  return listener;
}

/**
 * Removes a listener. Pass the handle returned by startListening() to remove
 * just that one; pass nothing to remove all. The microphone is released once
 * no listeners remain.
 *
 * @param {object} [listener] - handle from startListening().
 */
export function stopListening(listener) {
  if (listener) listeners.delete(listener);
  else          listeners.clear();
  if (listeners.size === 0) closeMic();
}

/** Whether the microphone is currently capturing. */
export function isListening() { return micOpen; }
