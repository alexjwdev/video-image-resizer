'use strict';
/*
 * Portable launcher.
 *
 * Run by the bundled node.exe from "Image Resizer.cmd" in a portable build.
 * It picks a free localhost port, starts the normal server.js as a child
 * process, waits until it actually responds, then opens the default browser.
 * Closing the launcher window stops the server too (portable = no leftovers).
 *
 * This file is app-relative only, so the whole folder can be moved or run from
 * a USB stick with no install and no absolute paths baked in.
 */
const { spawn, exec } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');

// portable-launch.js lives in <app>/scripts, so the app root is one level up.
const APP_DIR = path.basename(__dirname) === 'scripts' ? path.join(__dirname, '..') : __dirname;

// On macOS/Linux the bundled ffmpeg/ffprobe can arrive without the execute bit
// (a bundle cross-built on Windows, or unzipped by a tool that drops perms).
// node itself is already running, so restore +x on those two before the server
// needs to spawn them. Best-effort - ignore anything missing.
function ensureExecutable() {
  if (process.platform === 'win32') return;
  for (const scope of ['@ffmpeg-installer', '@ffprobe-installer']) {
    const base = path.join(APP_DIR, 'node_modules', scope);
    let subdirs = [];
    try { subdirs = fs.readdirSync(base); } catch { continue; }
    for (const d of subdirs) {
      for (const bin of ['ffmpeg', 'ffprobe']) {
        const p = path.join(base, d, bin);
        try { if (fs.existsSync(p)) fs.chmodSync(p, 0o755); } catch { /* ignore */ }
      }
    }
  }
}

// Ask the OS for an unused port so we never collide with another instance or a
// dev server already on 3210.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Poll /api/config until the server answers (or give up after timeoutMs).
function waitReady(port, timeoutMs = 20000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const retry = (why) => {
      if (Date.now() - t0 > timeoutMs) reject(new Error(why || 'server did not start in time'));
      else setTimeout(tick, 300);
    };
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/config', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry('bad status ' + res.statusCode);
      });
      req.once('error', () => retry('connect error'));
      req.once('timeout', () => { req.destroy(); retry('timeout'); });
    };
    tick();
  });
}

(async () => {
  ensureExecutable();
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : await freePort();
  const url = `http://127.0.0.1:${port}`;

  // Reuse the SAME node.exe that is running this launcher (the bundled one).
  const child = spawn(process.execPath, ['server.js'], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'inherit',
  });

  const shutdown = () => { try { child.kill(); } catch { /* already gone */ } };
  process.on('SIGINT',  () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });
  process.on('exit', shutdown);
  child.on('exit', (code) => process.exit(code == null ? 0 : code));

  console.log('\n  Image Resizer is starting...');
  try {
    await waitReady(port);
  } catch (err) {
    console.error('  Failed to start:', err.message);
    shutdown();
    process.exit(1);
  }

  console.log(`  Ready. Opening ${url}`);
  console.log('  Keep this window open while you use the app. Close it to stop.\n');
  // Open the default browser on whatever platform this bundle was built for.
  if (process.platform === 'win32')      exec(`cmd /c start "" "${url}"`);  // "" is start's title arg
  else if (process.platform === 'darwin') exec(`open "${url}"`);
  else                                    exec(`xdg-open "${url}"`);
})();
