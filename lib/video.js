'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const { path: ffmpegPath } = require('@ffmpeg-installer/ffmpeg');
const { path: ffprobePath } = require('@ffprobe-installer/ffprobe');

const DEFAULT_TARGET = 50 * 1024 * 1024; // 50 MB
const MARGIN = 0.92;                     // encode under target to leave headroom for variance
const OVERSHOOT_TOLERANCE = 1.03;        // trigger one corrective re-encode above this
const AUDIO_TIERS_KBPS = [128, 64, 0];   // 0 means no audio track at all
// Heuristic starting points, not authoritative encoding science — tune
// against real footage once this is live. Below these, video at that
// resolution would look unacceptably blocky regardless of target size.
const MIN_BITRATE_KBPS = { 1080: 1500, 720: 800, 480: 500, 360: 300 };
const HEIGHT_LADDER = [1080, 720, 480, 360];
const PRESET = 'veryfast';
const ENCODE_TIMEOUT_MS = 5 * 60 * 1000;

async function probe(inPath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inPath,
  ], { timeout: ENCODE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });

  const meta = JSON.parse(stdout);
  const video = (meta.streams || []).find((s) => s.codec_type === 'video');
  const audio = (meta.streams || []).find((s) => s.codec_type === 'audio');
  if (!video) throw new Error('No video stream found.');

  const durationSec = Number(meta.format?.duration || video.duration) || 0;
  if (!durationSec) throw new Error('Could not read video duration.');

  return {
    durationSec,
    width: video.width,
    height: video.height,
    videoCodec: video.codec_name || null,
    hasAudio: !!audio,
    audioCodec: audio ? (audio.codec_name || null) : null,
  };
}

function buildArgs(inPath, outPath, { height, origHeight, videoBitrateKbps, audioBitrateKbps }) {
  const args = ['-y', '-i', inPath];
  if (height < origHeight) args.push('-vf', `scale=-2:${height}`);
  args.push(
    '-c:v', 'libx264',
    '-preset', PRESET,
    '-b:v', `${videoBitrateKbps}k`,
    '-maxrate', `${Math.round(videoBitrateKbps * 1.45)}k`,
    '-bufsize', `${videoBitrateKbps * 2}k`,
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  );
  if (audioBitrateKbps > 0) {
    args.push('-c:a', 'aac', '-b:a', `${audioBitrateKbps}k`);
  } else {
    args.push('-an');
  }
  args.push(outPath);
  return args;
}

// Real poster frame, generated server-side — more robust than relying on
// client-side <video preload+seek> tricks to paint a thumbnail, and works
// before the browser has fetched any video bytes at all.
async function generatePoster(inPath, outPath, durationSec) {
  const seekTo = Math.min(0.5, durationSec / 2);
  await execFileAsync(ffmpegPath, [
    '-y', '-ss', String(seekTo), '-i', inPath,
    '-vframes', '1', '-vf', 'scale=480:-2', '-q:v', '4',
    outPath,
  ], { timeout: ENCODE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 });
  return fs.promises.readFile(outPath);
}

async function encodeAttempt(inPath, outPath, opts) {
  await execFileAsync(ffmpegPath, buildArgs(inPath, outPath, opts), {
    timeout: ENCODE_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  const { size } = await fs.promises.stat(outPath);
  return { size, ...opts };
}

/**
 * Compress a video to <= targetBytes (best effort — see module notes).
 * Unlike lib/compress.js's guaranteed <=target (quality is a cheap,
 * monotonic, binary-searchable knob), video bitrate-vs-actual-size has
 * real encoder variance. We predict a workable bitrate from duration,
 * encode once, and allow exactly one corrective re-encode — video encodes
 * are too slow to binary-search the way image quality does.
 *
 * @param {Buffer} inputBuffer
 * @param {object} opts
 * @param {number} [opts.targetBytes=DEFAULT_TARGET]
 * @param {string} [opts.sourceType] 'mp4'|'webm'|'avi' from detectVideoType() —
 *   used to gate the passthrough below (only a true MP4/H.264 source can be
 *   served back unchanged; other containers must always be transcoded).
 */
async function compressVideo(inputBuffer, opts = {}) {
  const target = Number(opts.targetBytes) > 0 ? Number(opts.targetBytes) : DEFAULT_TARGET;

  const scratchDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'imgrsz-vid-'));
  // ffmpeg demuxes by sniffing content, not extension, so a generic
  // extension here is fine for any of our supported input containers.
  const inPath = path.join(scratchDir, 'in.bin');
  const attempts = []; // {path, size, height, videoBitrateKbps, audioBitrateKbps}

  try {
    await fs.promises.writeFile(inPath, inputBuffer);
    const meta = await probe(inPath);

    const original = {
      width: meta.width,
      height: meta.height,
      size: inputBuffer.length,
      durationSec: meta.durationSec,
    };

    const posterPath = path.join(scratchDir, 'poster.jpg');
    const posterBuffer = await generatePoster(inPath, posterPath, meta.durationSec).catch(() => null);

    // Already within budget — pass through unchanged rather than
    // re-encoding, but ONLY when the source is already a real MP4/H.264(+AAC)
    // file. Output is always claimed as video/mp4; serving back a MOV/WebM/
    // AVI (or an MP4 with an incompatible codec like HEVC) unchanged under
    // that label breaks playback for anything that doesn't happen to sniff
    // bytes over the declared Content-Type.
    const isAlreadyCompatible = opts.sourceType === 'mp4' && meta.videoCodec === 'h264' &&
      (!meta.hasAudio || meta.audioCodec === 'aac');
    if (inputBuffer.length <= target && isAlreadyCompatible) {
      return {
        ok: true,
        format: 'mp4',
        original,
        passthrough: true,
        result: {
          buffer: inputBuffer,
          size: inputBuffer.length,
          width: meta.width,
          height: meta.height,
          videoBitrateKbps: null,
          audioBitrateKbps: null,
          overTarget: false,
          posterBuffer,
        },
      };
    }

    const heightLadder = [...new Set([meta.height, ...HEIGHT_LADDER])]
      .filter((h) => h <= meta.height)
      .sort((a, b) => b - a);

    // If the source already fits the target and only needs re-encoding for
    // MP4/H.264 compatibility (not for size), aim the bitrate at matching
    // the source's own size rather than the full user target — otherwise a
    // small, already-efficient AVI/WebM would get needlessly inflated
    // toward a much larger budget just because the target allows it.
    const needsRecodeOnly = inputBuffer.length <= target;
    const bitrateBudgetBytes = needsRecodeOnly ? inputBuffer.length : target;
    const budgetKbps = Math.floor((bitrateBudgetBytes * 8 * MARGIN) / 1000 / meta.durationSec);

    let best = null;

    for (const height of heightLadder) {
      const floor = MIN_BITRATE_KBPS[height] || MIN_BITRATE_KBPS[360];
      const audioTiers = meta.hasAudio ? AUDIO_TIERS_KBPS : [0];

      for (const audioBitrateKbps of audioTiers) {
        const videoBitrateKbps = budgetKbps - audioBitrateKbps;
        if (videoBitrateKbps < floor) continue; // try a lighter audio tier

        const outPath = path.join(scratchDir, `try-${attempts.length}.mp4`);
        const first = await encodeAttempt(inPath, outPath, {
          height, origHeight: meta.height, videoBitrateKbps, audioBitrateKbps,
        });
        attempts.push({ path: outPath, ...first });

        let candidate = first;
        let candidatePath = outPath;

        if (first.size > target * OVERSHOOT_TOLERANCE) {
          const correctedKbps = Math.max(
            floor,
            Math.floor(videoBitrateKbps * (target * MARGIN) / first.size)
          );
          const outPath2 = path.join(scratchDir, `try-${attempts.length}.mp4`);
          const second = await encodeAttempt(inPath, outPath2, {
            height, origHeight: meta.height, videoBitrateKbps: correctedKbps, audioBitrateKbps,
          });
          attempts.push({ path: outPath2, ...second });
          if (second.size < first.size) { candidate = second; candidatePath = outPath2; }
        }

        if (candidate.size <= target) { best = { ...candidate, path: candidatePath }; break; }
        if (!best || candidate.size < best.size) best = { ...candidate, path: candidatePath };
      }

      if (best && best.size <= target) break;
    }

    // Desperate fallback: the budget was too tight for even the smallest
    // rung's quality floor with no audio. Ignore the floor and encode at
    // whatever bitrate the byte budget actually implies — this will look
    // poor, but it respects the user's target over an arbitrary quality
    // floor, and the result is flagged overTarget/degraded either way.
    if (!best) {
      const height = heightLadder[heightLadder.length - 1];
      const videoBitrateKbps = Math.max(budgetKbps, 50);
      const outPath = path.join(scratchDir, `try-${attempts.length}.mp4`);
      const fallback = await encodeAttempt(inPath, outPath, {
        height, origHeight: meta.height, videoBitrateKbps, audioBitrateKbps: 0,
      });
      attempts.push({ path: outPath, ...fallback });
      best = { ...fallback, path: outPath };
    }

    const buffer = await fs.promises.readFile(best.path);
    return {
      ok: true,
      format: 'mp4',
      original,
      result: {
        buffer,
        size: buffer.length,
        width: best.height < meta.height ? Math.round(meta.width * best.height / meta.height) : meta.width,
        height: best.height,
        videoBitrateKbps: best.videoBitrateKbps,
        audioBitrateKbps: best.audioBitrateKbps,
        overTarget: buffer.length > target,
        posterBuffer,
      },
    };
  } finally {
    for (const a of attempts) await fs.promises.rm(a.path, { force: true }).catch(() => {});
    await fs.promises.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { compressVideo, DEFAULT_TARGET };
