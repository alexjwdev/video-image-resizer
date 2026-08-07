'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const session = require('express-session');
const { compress } = require('./lib/compress');
const { compressVideo } = require('./lib/video');
const { isHeic, detectVideoType } = require('./lib/decode');
const downloadRegistry = require('./lib/download-registry');
const { isAuthEnabled, createAuthRouter, requireAuth } = require('./lib/auth');

// --- tiny .env loader (no dependency) ----------------------------------------
(function loadEnv() {
  try {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  } catch { /* ignore */ }
})();

const PORT             = parseInt(process.env.PORT, 10) || 3210;
const HOST             = process.env.HOST || '0.0.0.0';
const DEFAULT_TARGET_KB = parseInt(process.env.TARGET_KB, 10) || 500;
const MAX_FILE_MB      = parseInt(process.env.MAX_FILE_MB, 10) || 25;
const MAX_FILES        = parseInt(process.env.MAX_FILES, 10) || 20;   // SEC-03: default 20, not 100
const MAX_CONCURRENT   = parseInt(process.env.MAX_CONCURRENT, 10) || 5;
const MAX_TARGET_KB    = MAX_FILE_MB * 1024;                          // SEC-04: targetKB ceiling

// Video (ffmpeg-based) limits — separate from the image knobs above since
// videos are naturally much larger and far slower to process.
const MAX_VIDEO_MB         = parseInt(process.env.MAX_VIDEO_MB, 10) || 500;
const DEFAULT_VIDEO_TARGET_MB = parseInt(process.env.VIDEO_TARGET_MB, 10) || 50;
const MAX_VIDEO_CONCURRENT = parseInt(process.env.MAX_VIDEO_CONCURRENT, 10) || 1;
const DOWNLOAD_TTL_MS      = 15 * 60 * 1000;

// Branding is entirely optional and env-driven so this stays a generic tool
// by default - no name/colors are hardcoded, a fork can re-skin itself via
// .env alone with zero code changes and nothing brand-specific committed.
const BRAND = {
  name:      process.env.BRAND_NAME           || 'Image Resizer',
  tagline:   process.env.BRAND_TAGLINE        || 'Compress images and videos to your size target - banner-safe, resolution-aware',
  // Monochrome bone default (Dimension-style achromatic dark theme) - a
  // deployment can still re-skin to a chromatic accent via BRAND_ACCENT_COLOR/
  // HIGHLIGHT_COLOR. Kept light (not violet) so runtime overrides driving
  // --accent/--highlight stay a neutral highlight, matching the CSS's own
  // "violet is decoration-only, never a functional accent" rule.
  accent:    process.env.BRAND_ACCENT_COLOR   || '#ededed',
  highlight: process.env.BRAND_HIGHLIGHT_COLOR || process.env.BRAND_ACCENT_COLOR || '#ededed',
};

const VALID_FORMATS = new Set(['jpeg', 'webp', 'png']);
const MIME = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
const VIDEO_MIME = { mp4: 'video/mp4' };

// PERF-12: warn at startup if sharp lacks mozjpeg (Windows prebuilt)
try {
  const sv = require('sharp').versions;
  if (!sv.mozjpeg) {
    console.warn('[perf] sharp built without mozjpeg — JPEG is libjpeg-turbo quality. WebP gives better compression on Windows.');
  }
} catch { /* sharp check is non-fatal */ }

const app = express();

// SEC-01/02: blocked MIME types (SVG enables SSRF via librsvg)
const BLOCKED_MIMES = new Set([
  'image/svg+xml', 'image/svg', 'text/xml', 'application/xml', 'text/html',
]);

// Magic-byte signatures for allowed image formats
const MAGIC_SIGS = [
  [0xFF, 0xD8, 0xFF],           // JPEG
  [0x89, 0x50, 0x4E, 0x47],     // PNG
  [0x47, 0x49, 0x46],           // GIF
  [0x42, 0x4D],                 // BMP
];

function isAllowedMagic(buf) {
  for (const sig of MAGIC_SIGS) {
    if (sig.every((b, i) => buf[i] === b)) return true;
  }
  // WebP: RIFF????WEBP
  if (buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  // HEIC / HEIF (detected by decode.js)
  if (isHeic(buf)) return true;
  // AVIF: ftyp box with avif/avis brand
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return true;
  }
  return false;
}

// PERF-03: gzip response compression (text assets + JSON compress well)
app.use(compression({ threshold: 2 * 1024 }));

// SEC-07/10: hardened helmet — HSTS off (plain HTTP), CSP + form-action locked
app.use(
  helmet({
    strictTransportSecurity: false,  // SEC-10: no TLS — don't send HSTS
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'self'"],
        scriptSrc:      ["'self'"],
        styleSrc:       ["'self'"],
        imgSrc:         ["'self'", 'data:', 'blob:'],
        mediaSrc:       ["'self'", 'blob:', 'data:'],
        connectSrc:     ["'self'"],
        objectSrc:      ["'none'"],
        formAction:     ["'none'"],     // SEC-07: no external form submissions
        frameAncestors: ["'none'"],     // SEC-07: clickjacking protection
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// Optional Microsoft Entra ID (Azure AD) SSO - only wired up when all the
// required env vars are set; otherwise the app behaves exactly as before
// (no session, no login, everything public on the network it's bound to).
if (isAuthEnabled()) {
  app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // Only mark the cookie secure if this deployment is actually behind
      // TLS (either directly or via a reverse proxy) - forcing this on
      // unconditionally would silently break login on a plain-HTTP setup.
      secure: process.env.SESSION_COOKIE_SECURE === 'true',
    },
  }));
  app.use('/auth', createAuthRouter());
  app.use(requireAuth);
  console.log('[auth] Microsoft SSO enabled - login required for all routes.');
} else {
  console.log('[auth] MS_CLIENT_ID not set - running with no login (internal-tool default).');
}

// PERF-05: static assets with cache headers, before API routes
app.use(
  '/vendor',
  express.static(path.join(__dirname, 'public', 'vendor'), {
    maxAge: '365d',
    immutable: true,
  })
);
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

// SEC-05: rate limit on the compress endpoint only
const compressLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please slow down.' },
});

// SEC-01/02: fileFilter blocks SVG and non-image/video MIME types before buffering.
// multer's fileSize limit isn't type-conditional, so it's set to the larger
// of the two caps here; the real per-type cap is enforced after buffering,
// in processFiles(), the same place magic-byte sniffing already happens.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.max(MAX_FILE_MB, MAX_VIDEO_MB) * 1024 * 1024, files: MAX_FILES },
  fileFilter(req, file, cb) {
    if (BLOCKED_MIMES.has(file.mimetype) || /\.svgz?$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('SVG and XML files are not permitted.'), { status: 415 }));
    }
    if (!file.mimetype.startsWith('image/') && !file.mimetype.startsWith('video/')) {
      return cb(Object.assign(new Error('Only image or video files are accepted.'), { status: 415 }));
    }
    cb(null, true);
  },
});

function toPayload(cand) {
  return {
    dataUrl: `data:${MIME[cand.format]};base64,${cand.buffer.toString('base64')}`,
    size: cand.size,
    width: cand.width,
    height: cand.height,
    quality: cand.quality,
  };
}

function buildResult(f, r, opts) {
  const base = {
    name: f.originalname,
    originalSize: r.original.size,
    originalWidth: r.original.width,
    originalHeight: r.original.height,
    convertedFrom: r.original.convertedFrom,
    format: r.format,
    target: opts.targetBytes,
    passthrough: !!r.passthrough,
  };
  if (r.conflict) {
    return {
      ...base,
      conflict: true,
      keepResolution: toPayload(r.keepResolution),
      hitTarget:      toPayload(r.hitTarget),
    };
  }
  return { ...base, result: toPayload(r.result) };
}

// Output is always MP4 regardless of source container, so the downloaded
// filename must carry that extension too - otherwise Content-Disposition
// hands back e.g. "clip.mkv" for a file that is actually a valid MP4,
// which then reads as broken/unrecognized to the OS and media players.
function mp4Name(originalName) {
  const stem = originalName.replace(/\.[^.]+$/, '');
  return (stem || 'video') + '.mp4';
}

function buildVideoResult(f, r, opts) {
  const id = downloadRegistry.putBuffer(r.result.buffer, {
    name: mp4Name(f.originalname),
    mime: VIDEO_MIME[r.format],
    ext: '.mp4',
  });
  return {
    name: f.originalname,
    originalSize: r.original.size,
    originalWidth: r.original.width,
    originalHeight: r.original.height,
    durationSec: r.original.durationSec,
    format: r.format,
    target: opts.targetBytes,
    passthrough: !!r.passthrough,
    result: {
      downloadUrl: `/api/download/${id}`,
      size: r.result.size,
      width: r.result.width,
      height: r.result.height,
      videoBitrateKbps: r.result.videoBitrateKbps,
      audioBitrateKbps: r.result.audioBitrateKbps,
      overTarget: r.result.overTarget,
      // Small (few-KB) poster frame — fine to embed directly, unlike the
      // full video buffer which goes through the download registry instead.
      posterDataUrl: r.result.posterBuffer
        ? `data:image/jpeg;base64,${r.result.posterBuffer.toString('base64')}`
        : null,
    },
  };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// SEC: validate the optional pre-compression edit from the request body into a
// clean shape (or null). Shape/type only here - crop-rectangle BOUNDS are
// clamped in lib/compress.js where the real (post-rotate) dimensions are known,
// so client-supplied coordinates are never trusted. Absent/no-op => null =>
// the pipeline behaves exactly as before.
function parseEdit(body) {
  const rot = parseInt(body.rotate, 10);
  const rotate = [90, 180, 270].includes(rot) ? rot : 0;
  const flipH = body.flipH === '1' || body.flipH === 'true';
  const flipV = body.flipV === '1' || body.flipV === 'true';

  let crop = null;
  const cx = parseInt(body.cropX, 10), cy = parseInt(body.cropY, 10);
  const cw = parseInt(body.cropW, 10), ch = parseInt(body.cropH, 10);
  if ([cx, cy, cw, ch].every(Number.isFinite) && cw > 0 && ch > 0 && cx >= 0 && cy >= 0) {
    crop = { x: cx, y: cy, w: cw, h: ch };
  }

  // Aspect only applies when there's no explicit rectangle. 'free'/'orig' (and
  // anything unrecognised) leave aspect null. '1:1' etc. match the regex.
  let aspect = null;
  if (!crop && typeof body.aspect === 'string') {
    const m = /^(\d{1,4}):(\d{1,4})$/.exec(body.aspect);
    if (m) {
      const aw = parseInt(m[1], 10), ah = parseInt(m[2], 10);
      if (aw > 0 && ah > 0) aspect = { ar: aw / ah };
    }
  }

  let focus = null;
  const fx = parseFloat(body.focusX), fy = parseFloat(body.focusY);
  if (Number.isFinite(fx) && Number.isFinite(fy)) focus = { x: clamp01(fx), y: clamp01(fy) };

  const smartCrop = body.smartCrop === 'entropy' ? 'entropy' : 'attention';

  // No-op edit (nothing that changes pixels) => null, so passthrough stays live.
  if (!crop && !rotate && !flipH && !flipV && !aspect) return null;
  // Focus is only meaningful for an aspect cover-crop; drop it otherwise.
  return { crop, rotate, flipH, flipV, aspect, focus: aspect ? focus : null, smartCrop };
}

// PERF-01: bounded concurrent processing within a single request.
// Images and videos run in independent worker pools concurrently - video
// encodes are slow and CPU-heavy (libx264 already threads across cores),
// so they get a much smaller pool than the cheap-per-call image pipeline.
async function processFiles(files, opts, videoOpts) {
  const results = new Array(files.length).fill(null);

  async function imageWorker(indices) {
    let i;
    while ((i = indices.next()) !== undefined) {
      const f = files[i];
      // SEC-01: magic-byte check after buffering (guards against MIME spoofing)
      if (!isAllowedMagic(f.buffer)) {
        results[i] = { name: f.originalname, error: 'Unsupported or non-image file.' };
        continue;
      }
      if (f.buffer.length > MAX_FILE_MB * 1024 * 1024) {
        results[i] = { name: f.originalname, error: `Image too large (max ${MAX_FILE_MB} MB).` };
        continue;
      }
      try {
        const r = await compress(f.buffer, opts);
        results[i] = buildResult(f, r, opts);
      } catch (err) {
        console.error(`[compress] ${f.originalname}:`, err);  // SEC-06: full error server-side only
        results[i] = { name: f.originalname, error: 'Failed to process image.' };
      }
    }
  }

  async function videoWorker(indices) {
    let i;
    while ((i = indices.next()) !== undefined) {
      const f = files[i];
      if (f.buffer.length > MAX_VIDEO_MB * 1024 * 1024) {
        results[i] = { name: f.originalname, error: `Video too large (max ${MAX_VIDEO_MB} MB).` };
        continue;
      }
      try {
        // Re-detect (cheap: magic-byte check) rather than thread the value
        // through from the dispatch loop below — keeps this worker self-contained.
        const sourceType = detectVideoType(f.buffer);
        const r = await compressVideo(f.buffer, { ...videoOpts, sourceType });
        results[i] = buildVideoResult(f, r, videoOpts);
      } catch (err) {
        console.error(`[compress-video] ${f.originalname}:`, err);  // SEC-06: full error server-side only
        results[i] = { name: f.originalname, error: 'Failed to process video.' };
      }
    }
  }

  const imageIdx = [];
  const videoIdx = [];
  files.forEach((f, i) => {
    const vtype = detectVideoType(f.buffer);
    if (vtype) videoIdx.push(i);
    else imageIdx.push(i); // isAllowedMagic (inside imageWorker) rejects true non-images
  });

  // Cursor over a fixed list of file indices, shared across a worker pool.
  function makeIndexCursor(idxList) {
    let n = 0;
    return { next: () => (n < idxList.length ? idxList[n++] : undefined) };
  }

  const imageCursor = makeIndexCursor(imageIdx);
  const videoCursor = makeIndexCursor(videoIdx);

  const imagePool = Math.max(1, Math.min(os.cpus().length - 1, imageIdx.length));
  const videoPool = Math.max(1, Math.min(MAX_VIDEO_CONCURRENT, videoIdx.length));

  await Promise.all([
    ...Array.from({ length: imagePool }, () => imageWorker(imageCursor)),
    ...Array.from({ length: videoPool }, () => videoWorker(videoCursor)),
  ]);

  return results;
}

// SEC-03: concurrent-request semaphore — hard cap on in-flight compress requests
let activeRequests = 0;

function concurrentGuard(req, res, next) {
  if (activeRequests >= MAX_CONCURRENT) {
    return res.status(503).json({ error: 'Server busy — please retry shortly.' });
  }
  activeRequests++;
  let done = false;
  const release = () => { if (!done) { done = true; activeRequests--; } };
  res.on('finish', release);
  res.on('close',  release);
  next();
}

app.post(
  '/api/compress',
  concurrentGuard,
  compressLimiter,
  upload.array('files', MAX_FILES),
  async (req, res) => {
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files uploaded.' });

    const opts = {
      // Whitelist format to prevent unknown strings reaching sharp
      format: VALID_FORMATS.has(req.body.format) ? req.body.format : 'jpeg',
      // SEC-04: cap targetKB — prevents response-amplification attack
      targetBytes: Math.min(
        parseInt(req.body.targetKB, 10) || DEFAULT_TARGET_KB,
        MAX_TARGET_KB
      ) * 1024,
      isBanner:  req.body.isBanner === 'true' || req.body.isBanner === '1',
      minWidth:  parseInt(req.body.minWidth,  10) || 0,
      minHeight: parseInt(req.body.minHeight, 10) || 0,
      // Optional pre-compression edit (crop/rotate/flip/aspect-focus); null when absent.
      edit:      parseEdit(req.body),
    };

    const videoOpts = {
      // SEC-04 equivalent: cap videoTargetMB — prevents response-amplification attack
      targetBytes: Math.min(
        parseInt(req.body.videoTargetMB, 10) || DEFAULT_VIDEO_TARGET_MB,
        MAX_VIDEO_MB
      ) * 1024 * 1024,
    };

    const results = await processFiles(files, opts, videoOpts);
    res.json({ results });
  }
);

// config endpoint — exposes limits for UI display
app.get('/api/config', (req, res) => {
  res.json({
    defaultTargetKB: DEFAULT_TARGET_KB,
    maxFileMB: MAX_FILE_MB,
    maxFiles: MAX_FILES,
    defaultVideoTargetMB: DEFAULT_VIDEO_TARGET_MB,
    maxVideoMB: MAX_VIDEO_MB,
    brand: BRAND,
    authEnabled: isAuthEnabled(),
    user: isAuthEnabled() ? (req.session.account || null) : null,
  });
});

// Video download route — id is a registry key (crypto.randomUUID()), never
// a filesystem path, so there's no traversal surface here. Supports HTTP
// Range requests: <video> scrubbing/seeking on a large file needs partial
// content, not a full re-download every time the user drags the seek bar.
app.get('/api/download/:id', (req, res) => {
  const entry = downloadRegistry.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Link expired or not found.' });

  fs.stat(entry.path, (err, stat) => {
    if (err) return res.status(404).json({ error: 'Link expired or not found.' });

    res.setHeader('Content-Type', entry.mime);
    res.setHeader('Content-Disposition', `attachment; filename="${entry.name.replace(/"/g, '')}"`);
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      res.setHeader('Content-Length', stat.size);
      return fs.createReadStream(entry.path).on('error', () => res.destroy()).pipe(res);
    }

    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end   = match[2] ? parseInt(match[2], 10) : stat.size - 1;
    if (start >= stat.size || end >= stat.size || start > end) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(entry.path, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
});

// Multer / payload error handler
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'  ? `File too large (max ${MAX_FILE_MB} MB for images, ${MAX_VIDEO_MB} MB for video).` :
      err.code === 'LIMIT_FILE_COUNT' ? `Too many files (max ${MAX_FILES}).`      :
      'Upload error.';  // SEC-06: don't expose raw MulterError message
    return res.status(413).json({ error: msg });
  }
  if (err) {
    console.error('[server error]', err);
    const status = err.status || 500;
    // Only forward message for errors we explicitly tagged with a status (user-facing)
    const msg = err.status ? err.message : 'Internal server error.';
    return res.status(status).json({ error: msg });
  }
  next();
});

const server = app.listen(PORT, HOST, () => {
  console.log(`image-resizer listening on http://${HOST}:${PORT}`);
});

// SEC-09: socket timeouts — prevent indefinitely hung connections.
// Bumped from the original 2 min: video encodes can legitimately run
// several minutes per file, and a batch (processed serially, one ffmpeg at
// a time) can take much longer — see MAX_VIDEO_CONCURRENT.
server.timeout          = 30 * 60_000; // 30 min socket inactivity
server.keepAliveTimeout = 10_000;

// Periodic sweep of expired video download files.
setInterval(() => downloadRegistry.sweep(DOWNLOAD_TTL_MS), 5 * 60_000).unref();

module.exports = { app, server };
