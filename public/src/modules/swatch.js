/**
 * swatch.js — Interactive colour picker with harmony palette generator.
 *
 * The user selects a colour via RGB sliders or a HEX input field. Based on
 * that colour, five related colours are calculated using a selected harmony
 * mode and displayed as clickable swatches.
 *
 * Harmony modes describe relationships between hues on the colour wheel:
 *  - Analogous:      colours close together (harmonious, natural look)
 *  - Complementary:  colours across from each other (high contrast)
 *  - Triadic:        three colours evenly spaced (vibrant, balanced)
 *  - Square:         four colours evenly spaced + one accent
 *  - Split:          base + two colours adjacent to its complement
 *
 * All DOM references are created inside initSwatch() and never leak to the
 * global scope, so this module has no side effects until it is initialised.
 *
 * Color model note:
 *  The UI works in RGB (what screens use), but harmony calculations are done
 *  in HSL (Hue, Saturation, Lightness) because rotating the hue wheel by a
 *  fixed offset is the natural way to derive harmonious colours.
 */

// ── Color conversion helpers ──────────────────────────────────────────────────

/**
 * Helper for hslToRgb — interpolates a single channel value.
 * Implements the standard HSL-to-RGB conversion algorithm.
 * @private
 */
function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/**
 * Converts HSL colour values to RGB.
 * @param {number} h - Hue in degrees (0–360).
 * @param {number} s - Saturation as percentage (0–100).
 * @param {number} l - Lightness as percentage (0–100).
 * @returns {[number, number, number]} RGB values in range 0–255.
 */
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v]; // achromatic (grey)
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h)         * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/**
 * Converts RGB colour values to HSL.
 * @param {number} r - Red   (0–255).
 * @param {number} g - Green (0–255).
 * @param {number} b - Blue  (0–255).
 * @returns {[number, number, number]} [hue (0–360), saturation (0–100), lightness (0–100)].
 */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6;                break;
      case b: h = ((r - g) / d + 4) / 6;                break;
    }
  }
  return [h * 360, s * 100, l * 100];
}

/** Clamps a number to the range 0–255 and rounds to the nearest integer. */
function clamp255(v) { return Math.max(0, Math.min(255, Math.round(+v || 0))); }

/** Converts a single 0–255 channel value to a two-digit uppercase hex string. */
function toHex(n) { return clamp255(n).toString(16).padStart(2, '0').toUpperCase(); }

/** Converts RGB channel values to a HEX colour string like "#FF8000". */
function rgbToHex(r, g, b) { return `#${toHex(r)}${toHex(g)}${toHex(b)}`; }

/**
 * Parses a HEX colour string to an [r, g, b] array.
 * Accepts both 3-character (#RGB) and 6-character (#RRGGBB) formats.
 * Returns null if the input is not a valid hex colour.
 *
 * @param {string} hex
 * @returns {[number, number, number] | null}
 */
function hexToRgb(hex) {
  hex = (hex || '').trim().replace(/^#/, '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  if (hex.length !== 6 || isNaN(parseInt(hex, 16))) return null;
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// ── Harmony definitions ───────────────────────────────────────────────────────

/**
 * Hue offsets (in degrees) for each harmony mode.
 * The base colour is always at offset 0. The other offsets define the
 * positions of the four companion colours on the colour wheel.
 */
const HARMONY_OFFSETS = {
  analogous:     [-60, -30,   0,  30,  60],
  complementary: [  0,  30, 150, 180, 210],
  triadic:       [  0,  60, 120, 180, 240],
  square:        [  0,  90, 180, 270,  45],
  split:         [  0,  30, 150, 210, 330],
};

// ── Module initialisation ─────────────────────────────────────────────────────

/**
 * Wires up all colour picker controls and renders the initial palette.
 * Called once by app.js during boot.
 */
export function initSwatch() {
  let currentHarmony = 'analogous';
  let rVal = 128, gVal = 0, bVal = 200; // initial colour: purple

  // DOM references — all local to this function.
  const rSlider   = document.getElementById('r');
  const gSlider   = document.getElementById('g');
  const bSlider   = document.getElementById('b');
  const hexOut    = document.getElementById('hex-out');
  const rvIn      = document.getElementById('rv');
  const gvIn      = document.getElementById('gv');
  const bvIn      = document.getElementById('bv');
  const copyBtn   = document.getElementById('copy-btn');
  const colorPage = document.getElementById('page-color');
  const swatchBox = document.getElementById('cp-swatches');

  /**
   * Rebuilds the five harmony swatches based on the current colour and mode.
   * The modulo arithmetic keeps hue values in the 0–360 range even when
   * an offset results in a negative number.
   */
  function renderPalette() {
    const [h, s, l] = rgbToHsl(rVal, gVal, bVal);
    swatchBox.innerHTML = HARMONY_OFFSETS[currentHarmony].map(offset => {
      const hue       = ((h + offset) % 360 + 360) % 360;
      const [r, g, b] = hslToRgb(hue, s, l);
      const hexColor  = rgbToHex(r, g, b);
      const isCurrent = offset === 0; // highlight the base colour swatch
      return `<div class="cp-swatch${isCurrent ? ' cp-swatch-current' : ''}"
                   style="background:${hexColor}" title="${hexColor}"
                   data-r="${r}" data-g="${g}" data-b="${b}">
                <span class="cp-swatch-hex">${hexColor}</span>
              </div>`;
    }).join('');

    // Clicking a swatch sets it as the new base colour.
    swatchBox.querySelectorAll('.cp-swatch').forEach(el => {
      el.addEventListener('click', () => setColor(+el.dataset.r, +el.dataset.g, +el.dataset.b));
    });
  }

  /**
   * Updates the active colour and keeps all UI controls in sync.
   * The skip* flags prevent feedback loops (e.g. updating a slider from its
   * own input event would trigger another update unnecessarily).
   *
   * @param {number} r
   * @param {number} g
   * @param {number} b
   * @param {{ skipSliders?: boolean, skipHex?: boolean, skipRgb?: boolean }} opts
   */
  function setColor(r, g, b, { skipSliders = false, skipHex = false, skipRgb = false } = {}) {
    rVal = clamp255(r); gVal = clamp255(g); bVal = clamp255(b);
    const hex = rgbToHex(rVal, gVal, bVal);

    if (!skipHex)     hexOut.value = hex;
    if (!skipRgb)   { rvIn.value = rVal; gvIn.value = gVal; bvIn.value = bVal; }
    if (!skipSliders) { rSlider.value = rVal; gSlider.value = gVal; bSlider.value = bVal; }

    // Tint the picker page background to the currently selected colour.
    colorPage.style.backgroundColor = `rgb(${rVal},${gVal},${bVal})`;

    renderPalette();
  }

  // ── Event listeners ──────────────────────────────────────────────────

  // Harmony mode selector buttons.
  document.querySelectorAll('.harmony-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.harmony-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentHarmony = btn.dataset.harmony;
      renderPalette();
    });
  });

  // RGB sliders — pass skipSliders to avoid updating the slider that just moved.
  rSlider.addEventListener('input', () => setColor(+rSlider.value, gVal,           bVal,           { skipSliders: true }));
  gSlider.addEventListener('input', () => setColor(rVal,           +gSlider.value, bVal,           { skipSliders: true }));
  bSlider.addEventListener('input', () => setColor(rVal,           gVal,           +bSlider.value, { skipSliders: true }));

  /**
   * Handles changes to one of the three numeric RGB input fields.
   * Clamps the value to 0–255 and updates all other controls.
   */
  function onRgbChange(field) {
    const v = clamp255(+field.value);
    setColor(
      field === rvIn ? v : rVal,
      field === gvIn ? v : gVal,
      field === bvIn ? v : bVal,
      { skipRgb: true }, // don't update the field that just changed
    );
    field.value = v; // show clamped value
  }

  [rvIn, gvIn, bvIn].forEach(el => {
    el.addEventListener('input',   () => onRgbChange(el));
    el.addEventListener('change',  () => onRgbChange(el));
    el.addEventListener('focus',   () => el.select()); // select all on focus for easy replacement
    el.addEventListener('blur',    () => { el.value = clamp255(+el.value || 0); onRgbChange(el); });
    // Only allow numeric keys and navigation keys to prevent invalid input.
    el.addEventListener('keydown', e => {
      const ok = /^[0-9]$/.test(e.key) ||
        ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter'].includes(e.key);
      if (!ok) e.preventDefault();
    });
  });

  // HEX input field — update colour live while the user types.
  hexOut.addEventListener('input',   () => { const rgb = hexToRgb(hexOut.value); if (rgb) setColor(...rgb, { skipHex: true }); });
  hexOut.addEventListener('blur',    () => { const rgb = hexToRgb(hexOut.value); if (rgb) setColor(...rgb); else hexOut.value = rgbToHex(rVal, gVal, bVal); });
  hexOut.addEventListener('keydown', e => { if (e.key === 'Enter') hexOut.blur(); });
  hexOut.addEventListener('focus',   () => hexOut.select());

  // Copy button — writes the current HEX value to the clipboard.
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(hexOut.value).then(() => {
      copyBtn.textContent = '✓ Kopiert!';
      copyBtn.classList.add('copied');
      setTimeout(() => {
        copyBtn.textContent = 'HEX kopieren';
        copyBtn.classList.remove('copied');
      }, 1800);
    });
  });

  // Set the initial colour to trigger the first render.
  setColor(128, 0, 200);
}
