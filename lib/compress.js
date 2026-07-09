'use strict';

const sharp = require('sharp');
const { normalize } = require('./decode');

const DEFAULT_TARGET = 500 * 1024; // 500 KB
const MIN_DIM = 16;                // absolute floor so we never resize to nothing
const Q_MAX  = { jpeg: 95, webp: 95, png: 100 };
// Perceptual floor: algorithm prefers dimension reduction over going below these.
// At q<30 JPEG/WebP, chroma channels are quantized so aggressively the image
// can appear near-grayscale. PNG quality maps to palette size; 50 = ~128 colors.
const Q_MIN_PREF = { jpeg: 30, webp: 30, png: 50 };
// Hard floor used only in conflict hitTarget paths where target must be met at any cost.
const Q_MIN_HARD = 1;

const FORMATS = new Set(['jpeg', 'webp', 'png']);

function normFormat(fmt) {
  const f = String(fmt || 'jpeg').toLowerCase();
  if (f === 'jpg') return 'jpeg';
  if (!FORMATS.has(f)) throw new Error(`Unsupported output format: ${fmt}`);
  return f;
}

/**
 * Encode `src` at a target display width (aspect ratio preserved) and quality.
 * Returns { buffer, size, width, height }.
 */
async function encode(src, { format, width, quality }) {
  let pipe = sharp(src, { failOn: 'none' }).rotate(); // auto-orient via EXIF
  if (width) pipe = pipe.resize({ width, withoutEnlargement: true });

  if (format === 'jpeg') {
    // chromaSubsampling '4:4:4' retains full colour at every quality level —
    // without it libjpeg defaults to '4:2:0' which loses chroma on large images.
    pipe = pipe.jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' });
  } else if (format === 'webp') {
    pipe = pipe.webp({ quality });
  } else {
    // PERF-09: balanced PNG settings (compressionLevel 6 / effort 4) — half the wall-clock
    // of level 9 / effort 7 with < 2% size difference on typical office images.
    pipe = pipe.png({ palette: true, quality, compressionLevel: 6, effort: 4 });
  }

  const { data, info } = await pipe.toBuffer({ resolveWithObject: true });
  return { buffer: data, size: data.length, width: info.width, height: info.height };
}

/**
 * Highest-quality encode at a given width whose size <= target.
 * Returns the best candidate, or null if even minQ exceeds target.
 *
 * minQ defaults to Q_MIN_PREF (perceptual floor). Pass Q_MIN_HARD when the
 * target must be met regardless of colour fidelity (hitTarget conflict path).
 *
 * PERF-02: two fast-path exits before the binary search:
 *   1. ceiling fits  → return in 1 encode (most common case)
 *   2. floor too big → return null in 2 encodes (skip remaining search)
 */
async function bestQualityUnderTarget(src, { format, width }, target, minQ = Q_MIN_PREF[format]) {
  // Fast path 1: fits at max quality — common for already-small images or wide targets
  const ceil = await encode(src, { format, width, quality: Q_MAX[format] });
  if (ceil.size <= target) return { ...ceil, quality: Q_MAX[format] };

  // Fast path 2: too big even at perceptual floor — skip this width, try narrower
  const floor = await encode(src, { format, width, quality: minQ });
  if (floor.size > target) return null;

  // Binary search between minQ+1 and Q_MAX-1 for highest quality that fits
  let lo = minQ + 1;
  let hi = Q_MAX[format] - 1;
  let best = { ...floor, quality: minQ };

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cand = await encode(src, { format, width, quality: mid });
    if (cand.size <= target) {
      best = { ...cand, quality: mid };
      lo = mid + 1; // fits — try for higher quality
    } else {
      hi = mid - 1; // too big — drop quality
    }
  }
  return best;
}

// Smallest-possible encode at a given width using the hard quality floor. Always returns.
function smallestAtWidth(src, format, width) {
  return encode(src, { format, width, quality: Q_MIN_HARD })
    .then((r) => ({ ...r, quality: Q_MIN_HARD }));
}

/**
 * Oriented (display) dimensions, accounting for EXIF orientation that
 * swaps width/height (values 5–8).
 */
function orientedDims(meta) {
  const swap = meta.orientation && meta.orientation >= 5;
  return {
    width: swap ? meta.height : meta.width,
    height: swap ? meta.width : meta.height,
  };
}

/**
 * PERF-11: multiplicative ladder from `fromW` down to `floor`.
 * Uses a Set to guarantee no duplicates (avoids redundant encodes when
 * floor === fromW or rounding produces the same value twice).
 */
function widthLadder(fromW, minW, factor = 0.85) {
  const floor = Math.max(MIN_DIM, Math.round(minW));
  const seen = new Set();
  const widths = [];
  let w = fromW;
  while (w > floor) {
    const rw = Math.round(w);
    if (!seen.has(rw)) { seen.add(rw); widths.push(rw); }
    w = Math.floor(w * factor);
  }
  if (!seen.has(floor)) widths.push(floor);
  return widths;
}

/**
 * Compress an image to <= target bytes, honoring a minimum-resolution floor
 * and an isBanner flag (width is protected — never shrunk below original).
 *
 * Resolution policy: prefer the LARGEST size that meets the target. If the
 * target cannot be met without dropping below the floor, return a `conflict`
 * with two candidates so the caller (and ultimately the user) can choose:
 *   - keepResolution: best we can do at the floor (may exceed target)
 *   - hitTarget: downscaled below the floor until it fits
 *
 * @param {Buffer} inputBuffer
 * @param {object} opts
 * @param {string} [opts.format='jpeg']  jpeg | webp | png
 * @param {number} [opts.targetBytes=512000]
 * @param {boolean} [opts.isBanner=false]
 * @param {number} [opts.minWidth=0]
 * @param {number} [opts.minHeight=0]
 */
async function compress(inputBuffer, opts = {}) {
  const format = normFormat(opts.format);
  const target = Number(opts.targetBytes) > 0 ? Number(opts.targetBytes) : DEFAULT_TARGET;
  const isBanner = !!opts.isBanner;
  const minWidth = Math.max(0, Number(opts.minWidth) || 0);
  const minHeight = Math.max(0, Number(opts.minHeight) || 0);

  const { buffer: src, convertedFrom } = await normalize(inputBuffer);

  const meta = await sharp(src, { failOn: 'none' }).metadata();
  const { width: origW, height: origH } = orientedDims(meta);
  if (!origW || !origH) throw new Error('Could not read image dimensions');

  const original = {
    width: origW,
    height: origH,
    size: inputBuffer.length,
    format: meta.format,
    convertedFrom,
  };

  // Early exit: source is already within the target budget AND no format
  // conversion was requested. Re-encoding at high quality almost always
  // inflates an already-compressed image, so we pass it through unchanged.
  // If a different output format was requested, fall through to the normal
  // pipeline below so the file is actually converted (even if the converted
  // size grows a bit) instead of silently being left in its original format.
  const normalizedSize = src.length;
  const srcFmt = convertedFrom ? 'jpeg'
    : (meta.format === 'jpg' ? 'jpeg' : (meta.format || 'jpeg'));
  if (normalizedSize <= target && format === srcFmt) {
    const passResult = { buffer: src, size: normalizedSize, width: origW, height: origH, quality: null };
    return { ok: true, format, original, passthrough: true, result: { ...passResult, format } };
  }

  // Floor width: the smallest width we are allowed to use for the *primary*
  // result. Derived from min-resolution (honoring BOTH min dims via aspect
  // ratio) and clamped so we never upscale. isBanner protects full width.
  let floorW = MIN_DIM;
  if (minWidth) floorW = Math.max(floorW, Math.min(origW, minWidth));
  if (minHeight) {
    const wForMinH = Math.min(origW, Math.round((minHeight / origH) * origW));
    floorW = Math.max(floorW, wForMinH);
  }
  if (isBanner) floorW = origW; // never shrink a banner's width

  // 1) Find the largest width (>= floor) that meets the target at some quality.
  for (const w of widthLadder(origW, floorW)) {
    const best = await bestQualityUnderTarget(src, { format, width: w }, target);
    if (best) {
      return {
        ok: true,
        format,
        original,
        result: { ...best, format, target },
      };
    }
  }

  // 2) Conflict: even at the floor width, lowest quality exceeds the target.
  const keepResolution = { ...(await smallestAtWidth(src, format, floorW)), format };

  // hitTarget: keep shrinking below the floor until it fits (or hit MIN_DIM).
  // Uses Q_MIN_HARD so the target is met regardless of colour quality.
  let hitTarget = null;
  for (const w of widthLadder(Math.floor(floorW * 0.85), MIN_DIM)) {
    const best = await bestQualityUnderTarget(src, { format, width: w }, target, Q_MIN_HARD);
    if (best) { hitTarget = { ...best, format }; break; }
  }
  if (!hitTarget) {
    hitTarget = { ...(await smallestAtWidth(src, format, MIN_DIM)), format };
  }

  return {
    ok: true,
    format,
    original,
    conflict: true,
    target,
    keepResolution, // may exceed target
    hitTarget,      // <= target (or absolute smallest if truly impossible)
  };
}

module.exports = { compress, DEFAULT_TARGET };
