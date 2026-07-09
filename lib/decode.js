'use strict';

const heicConvert = require('heic-convert');

// HEIC/HEIF brands found in the ISO-BMFF `ftyp` box (bytes 8..12).
const HEIC_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis',
  'hevm', 'hevs', 'mif1', 'msf1', 'heif',
]);

/**
 * Detect HEIC/HEIF by sniffing the `ftyp` box brand. sharp's prebuilt
 * Windows binary has no libheif, so we must convert these before sharp.
 */
function isHeic(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12).toLowerCase();
  return HEIC_BRANDS.has(brand);
}

/**
 * Return a buffer sharp can read. HEIC/HEIF is transcoded to a
 * high-quality JPEG buffer first; everything else passes through.
 * @returns {Promise<{buffer: Buffer, convertedFrom: string|null}>}
 */
async function normalize(buf) {
  if (isHeic(buf)) {
    const out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 1 });
    return { buffer: Buffer.from(out), convertedFrom: 'heic' };
  }
  return { buffer: buf, convertedFrom: null };
}

// MP4/MOV/QuickTime `ftyp` brands. Disjoint from HEIC_BRANDS above even
// though both containers share the same ISO-BMFF `ftyp` box structure.
const VIDEO_ISO_BRANDS = new Set([
  'isom', 'iso2', 'mp41', 'mp42', 'mp4v', 'avc1',
  'm4v ', 'qt  ', '3gp4', '3gp5', 'dash',
]);

function isMp4OrMov(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (buf.toString('ascii', 4, 8) !== 'ftyp') return false;
  const brand = buf.toString('ascii', 8, 12).toLowerCase();
  return VIDEO_ISO_BRANDS.has(brand);
}

// WebM/Matroska EBML header.
function isWebm(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 4 &&
    buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
}

// AVI: RIFF....AVI  (same RIFF wrapper as WebP, different fourCC).
function isAvi(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'AVI ';
}

/**
 * Detect video containers by magic bytes, independent of client-supplied
 * MIME type. Returns 'mp4' | 'webm' | 'avi' | null.
 */
function detectVideoType(buf) {
  if (isMp4OrMov(buf)) return 'mp4';
  if (isWebm(buf)) return 'webm';
  if (isAvi(buf)) return 'avi';
  return null;
}

module.exports = { normalize, isHeic, detectVideoType };
