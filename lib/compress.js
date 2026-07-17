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

function clampRange(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Largest `ar` (width/height) rectangle that fits inside w x h. Exactly one of
// the returned dims equals a source dim, so a cover-crop to this size never
// upscales - it only trims the longer axis.
function coverRect(w, h, ar) {
  if (w / h > ar) return { w: Math.round(h * ar), h };  // source wider -> limit by height
  return { w, h: Math.round(w / ar) };                  // source taller -> limit by width
}

/**
 * Apply the optional pre-compression edit (rotate / flip / crop / aspect-focus)
 * and return a new buffer. Returns `src` untouched when `edit` is null, so the
 * no-edit path pays nothing.
 *
 * Two-stage on purpose. Stage 1 BAKES EXIF orientation + user rotate/flip into
 * pixels (losslessly, as PNG); stage 2 then crops. This makes the crop
 * coordinates unambiguous - they are in the same oriented pixel space the
 * browser editor measured in. Doing auto-orient and extract in a single sharp
 * pipeline has order-of-operations ambiguity that can silently crop the wrong
 * region on EXIF-rotated phone photos. PNG (not webp) is used for the
 * intermediates because webp caps dimensions at 16383px.
 */
async function applyEdit(src, edit) {
  if (!edit) return src;

  // Stage 1: realize orientation to pixels.
  let s1 = sharp(src, { failOn: 'none' }).rotate();  // EXIF auto-orient
  if (edit.flipH) s1 = s1.flop();
  if (edit.flipV) s1 = s1.flip();
  if (edit.rotate) s1 = s1.rotate(edit.rotate);      // user 90/180/270 on top
  const baked = await s1.png().toBuffer();

  const bmeta = await sharp(baked).metadata();
  const bw = bmeta.width;
  const bh = bmeta.height;
  let pipe = sharp(baked, { failOn: 'none' });

  if (edit.crop) {
    // Explicit rectangle from the manual editor; never trust client bounds -
    // clamp into the (now known) baked pixel dimensions.
    const left   = clampRange(Math.round(edit.crop.x), 0, bw - 1);
    const top    = clampRange(Math.round(edit.crop.y), 0, bh - 1);
    const width  = clampRange(Math.round(edit.crop.w), 1, bw - left);
    const height = clampRange(Math.round(edit.crop.h), 1, bh - top);
    pipe = pipe.extract({ left, top, width, height });
  } else if (edit.aspect) {
    // Cover-crop to an aspect ratio, positioned by an explicit focus point or,
    // failing that, sharp's content-aware attention/entropy strategy. coverRect
    // never upscales, so this only ever trims.
    const { w: cw, h: ch } = coverRect(bw, bh, edit.aspect.ar);
    if (edit.focus) {
      const left = clampRange(Math.round(edit.focus.x * bw - cw / 2), 0, bw - cw);
      const top  = clampRange(Math.round(edit.focus.y * bh - ch / 2), 0, bh - ch);
      pipe = pipe.extract({ left, top, width: cw, height: ch });
    } else {
      const position = edit.smartCrop === 'entropy'
        ? sharp.strategy.entropy : sharp.strategy.attention;
      pipe = pipe.resize({ width: cw, height: ch, fit: 'cover', position });
    }
  }

  return pipe.png().toBuffer();
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

  const { buffer: normalized, convertedFrom } = await normalize(inputBuffer);
  // Apply any pre-compression edit BEFORE reading metadata, so origW/origH, the
  // width ladder and the min-resolution floor are all computed against the
  // edited (cropped/rotated) image and stay coherent.
  const src = await applyEdit(normalized, opts.edit);

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
  // An applied edit means `src` is a re-encoded (PNG) intermediate, not the
  // user's original bytes, so passthrough would be both wrong (huge PNG) and
  // pointless - always run the real encode pipeline to honor the target.
  const normalizedSize = src.length;
  const srcFmt = convertedFrom ? 'jpeg'
    : (meta.format === 'jpg' ? 'jpeg' : (meta.format || 'jpeg'));
  if (!opts.edit && normalizedSize <= target && format === srcFmt) {
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
