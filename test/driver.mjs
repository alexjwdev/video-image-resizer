#!/usr/bin/env node
/**
 * Driver / harness for the image-resizer app.
 *
 *   node test/driver.mjs           # lib smoke (default)
 *   node test/driver.mjs --e2e     # browser + screenshot
 *
 * Smoke mode (primary): imports lib/compress.js directly and runs every sample
 * through it for several formats, ASSERTING the output is <=500KB (or that a
 * minimum-resolution conflict is correctly surfaced). This is the layer most
 * changes touch, so it's the default. Also runs lib/video.js against a
 * generated synthetic clip (best-effort target, see lib/video.js — allows a
 * 5% tolerance instead of a hard <=). Exits non-zero on any violation.
 *
 * E2E mode (--e2e): launches the real server, drives the page with Playwright,
 * uploads a sample through the actual UI, asserts a result rendered <=500KB,
 * and writes a screenshot to result.png next to this driver. Needs:
 *   npm install -D playwright && npx playwright install chromium
 * NOTE: image-only for now - a video-upload e2e assertion would need its
 * own wait condition (video results render via <video>/download link, not
 * a data-URL <img>).
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // test/ -> project root
const SAMPLES = path.join(__dirname, 'samples');
const TARGET = 500 * 1024;

const { compress } = require(path.join(ROOT, 'lib', 'compress.js'));
const { compressVideo } = require(path.join(ROOT, 'lib', 'video.js'));

const kb = (b) => (b / 1024).toFixed(b < 1024 * 10 ? 1 : 0).padStart(6) + ' KB';

// Generates a small synthetic test clip on first run (not committed — real
// video content, not a fixture we need to check in). Uses a noisy/high-
// entropy source (mandelbrot) rather than a flat test pattern so it doesn't
// compress trivially, which would never exercise the resolution ladder.
async function ensureTestClip() {
  const clip = path.join(SAMPLES, 'testclip.mp4');
  if (fs.existsSync(clip)) return clip;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const { path: ffmpegPath } = require(path.join(ROOT, 'node_modules', '@ffmpeg-installer', 'ffmpeg'));
  await execFileAsync(ffmpegPath, [
    '-y',
    '-f', 'lavfi', '-i', 'mandelbrot=size=854x480:rate=24',
    '-t', '4',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=4',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-c:a', 'aac', '-shortest',
    clip,
  ]);
  return clip;
}

// ---------------------------------------------------------------- smoke mode
async function smoke() {
  const cases = [
    { file: 'photo.jpg', format: 'jpeg', opts: {} },
    { file: 'photo.jpg', format: 'webp', opts: {} },
    { file: 'banner.jpg', format: 'jpeg', opts: { isBanner: true } },
    { file: 'graphic.png', format: 'png', opts: {} },
    { file: 'graphic.png', format: 'webp', opts: {} },
    // conflict: protected banner width + a tiny target it cannot meet at full width
    { file: 'banner.jpg', format: 'jpeg', opts: { isBanner: true, targetBytes: 2 * 1024 }, expectConflict: true },
    // --- pre-compression edit (crop / aspect / rotate) ---
    // explicit crop rect: 4:3 region; aspect must survive the downscale ladder
    { file: 'photo.jpg', format: 'jpeg', opts: { edit: { crop: { x: 0, y: 0, w: 400, h: 300 } } },
      check: (r) => arOk(r, 4 / 3) },
    // aspect cover-crop with content-aware attention (no focus point)
    { file: 'photo.jpg', format: 'jpeg', opts: { edit: { aspect: { ar: 16 / 9 }, smartCrop: 'attention' } },
      check: (r) => arOk(r, 16 / 9) },
    // 90-degree rotate: a landscape sample must come out portrait
    { file: 'photo.jpg', format: 'webp', opts: { edit: { rotate: 90 } },
      check: (r) => r.original.height > r.original.width },
    // out-of-bounds crop: must clamp (not throw) and still meet target
    { file: 'photo.jpg', format: 'jpeg', opts: { edit: { crop: { x: 999999, y: 0, w: 400, h: 300 } } },
      check: (r) => !!r.result && r.result.size > 0 },
  ];

  // Aspect-ratio check with tolerance (integer rounding through the ladder).
  const arOk = (r, ar) => Math.abs((r.result.width / r.result.height) - ar) < 0.03;

  console.log(`\nimage-resizer smoke — target ${TARGET / 1024} KB (unless noted)\n`);
  let failures = 0;

  for (const c of cases) {
    const buf = fs.readFileSync(path.join(SAMPLES, c.file));
    const target = c.opts.targetBytes || TARGET;
    const r = await compress(buf, { format: c.format, targetBytes: target, ...c.opts });
    const tag = `${c.file} -> ${c.format} ${JSON.stringify(c.opts)}`;

    if (r.conflict) {
      const okKeep = r.keepResolution && r.keepResolution.size > 0;
      const okHit = r.hitTarget && r.hitTarget.size <= target;
      const pass = c.expectConflict && okKeep && okHit;
      if (!pass) failures++;
      console.log(`${pass ? 'PASS' : 'FAIL'}  CONFLICT  ${tag}`);
      console.log(`        keepResolution ${kb(r.keepResolution.size)}  ${r.keepResolution.width}x${r.keepResolution.height}`);
      console.log(`        hitTarget      ${kb(r.hitTarget.size)}  ${r.hitTarget.width}x${r.hitTarget.height}  (<= target: ${okHit})`);
    } else {
      const under = r.result.size <= target;
      const checkOk = c.check ? c.check(r) : true;
      const pass = under && checkOk && !c.expectConflict;
      if (!pass) failures++;
      console.log(`${pass ? 'PASS' : 'FAIL'}  ${tag}${c.check ? (checkOk ? '  [check ok]' : '  [CHECK FAILED]') : ''}`);
      console.log(`        ${r.original.width}x${r.original.height} ${kb(r.original.size)}  ->  ${r.result.width}x${r.result.height} ${kb(r.result.size)} q${r.result.quality} ${r.format}`);
    }
  }

  console.log('\nvideo (best-effort — allow 5% tolerance over target, see lib/video.js)\n');
  const clip = await ensureTestClip();
  const clipBuf = fs.readFileSync(clip);
  const videoCases = [
    { label: 'generous target, expect original resolution kept', targetBytes: 3 * 1024 * 1024, expectHeightDrop: false },
    { label: 'tight target, expect resolution-ladder fallback', targetBytes: 100 * 1024, expectHeightDrop: true },
  ];
  for (const c of videoCases) {
    const r = await compressVideo(clipBuf, { targetBytes: c.targetBytes });
    const withinTolerance = r.result.size <= c.targetBytes * 1.05;
    const heightDropped = r.result.height < r.original.height;
    const pass = withinTolerance && heightDropped === c.expectHeightDrop;
    if (!pass) failures++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${c.label}`);
    console.log(`        ${r.original.width}x${r.original.height} ${kb(r.original.size)}  ->  ` +
      `${r.result.width}x${r.result.height} ${kb(r.result.size)} ` +
      `${r.result.videoBitrateKbps}kbps/${r.result.audioBitrateKbps}kbps  overTarget:${r.result.overTarget}`);
  }

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

// ------------------------------------------------------------------ e2e mode
function waitForServer(url, ms = 15000) {
  const t0 = Date.now();
  return (async () => {
    while (Date.now() - t0 < ms) {
      try { const r = await fetch(url); if (r.ok) return; } catch {}
      await new Promise((res) => setTimeout(res, 300));
    }
    throw new Error('server did not become ready');
  })();
}

async function e2e() {
  const PORT = 3299; // dedicated test port
  const base = `http://127.0.0.1:${PORT}`;
  const shot = path.join(__dirname, 'result.png');

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'inherit',
  });

  let exitCode = 1;
  try {
    await waitForServer(`${base}/api/config`);
    const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1100, height: 1400 } });
    await page.goto(base, { waitUntil: 'networkidle' });

    // upload a real sample through the actual file input
    await page.setInputFiles('#fileInput', path.join(SAMPLES, 'banner.jpg'));
    await page.check('#isBanner');
    await page.click('#compressBtn');

    await page.waitForFunction(() => {
      const s = document.querySelector('#results .card .card-sizes-text');
      return s && s.textContent.includes('→');
    }, { timeout: 30000 });

    const info = await page.evaluate(() => {
      const card = document.querySelector('#results .card');
      const txt = card.querySelector('.card-sizes-text').textContent;
      // e.g. "1235 KB → 494 KB" - the size after the arrow is the result.
      const m = txt.match(/→\s*([\d.]+)\s*KB/);
      return { stats: txt, resultKB: m ? parseFloat(m[1]) : null, badge: card.querySelector('.badge')?.textContent };
    });

    await page.screenshot({ path: shot, fullPage: true });
    await browser.close();

    console.log('\n[e2e] ' + info.stats);
    console.log('[e2e] badge: ' + info.badge);
    console.log('[e2e] screenshot: ' + shot);
    const ok = info.resultKB !== null && info.resultKB <= 500;
    console.log('[e2e] result <= 500 KB: ' + ok + '\n');
    exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error('[e2e] FAILED:', err.message);
  } finally {
    server.kill();
  }
  process.exit(exitCode);
}

// --------------------------------------------------------------------- entry
if (process.argv.includes('--e2e')) e2e();
else smoke();
