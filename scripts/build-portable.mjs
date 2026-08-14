#!/usr/bin/env node
/*
 * Build a 1-click portable bundle of the app.
 *
 *   node scripts/build-portable.mjs                       # bundle for THIS machine
 *   node scripts/build-portable.mjs --zip                 # also produce a .zip
 *   node scripts/build-portable.mjs --target=darwin-arm64 # cross-build for another OS
 *
 * Output: dist/ImageResizer-portable[-<target>]/
 *   Image Resizer.cmd | Image Resizer.command | Image Resizer.sh   <- launcher
 *   README.txt
 *   node(.exe)             <- the bundled Node runtime for the target
 *   app/                   <- server.js, lib, public, node_modules, scripts
 *
 * Two modes:
 *  - Native (default): COPY the already-working node_modules and this machine's
 *    node, so the native sharp + ffmpeg binaries are the exact ones proven here
 *    (no ABI rebuild, no network). Best when you build on the OS you ship to.
 *  - Cross (--target=<os>-<arch>): download the target's Node and resolve a
 *    target-native node_modules via `npm ci --os --cpu`. Used to build a macOS
 *    bundle from Windows, etc. Cross-built bundles are unsigned and carry no
 *    unix exec bits (Windows can't set them), so the macOS README explains the
 *    one-time `xattr`/`chmod` step; after that it is double-click every time.
 *
 * Native binaries are OS+CPU specific: a bundle only runs on its target.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zipSync } from 'fflate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CACHE = path.join(ROOT, 'dist', '.cache');
const WANT_ZIP = process.argv.includes('--zip');
const NPM = os.platform() === 'win32' ? 'npm.cmd' : 'npm';

// --- target resolution -------------------------------------------------------
const HOST_TARGET = `${os.platform()}-${os.arch()}`;
const targetArg = process.argv.find((a) => a.startsWith('--target='));
const TARGET = targetArg ? targetArg.split('=')[1] : HOST_TARGET;
const [TOS, TARCH] = TARGET.split('-');
const CROSS = TARGET !== HOST_TARGET;
const TARGET_IS_WIN = TOS === 'win32';
const NODE_BIN = TARGET_IS_WIN ? 'node.exe' : 'node';

const VALID_OS = ['win32', 'darwin', 'linux'];
const VALID_ARCH = ['x64', 'arm64'];
if (!VALID_OS.includes(TOS) || !VALID_ARCH.includes(TARCH)) {
  console.error(`[portable] invalid --target "${TARGET}". Use <os>-<arch>, os in ${VALID_OS}, arch in ${VALID_ARCH}.`);
  process.exit(1);
}

const OUT = path.join(ROOT, 'dist', CROSS ? `ImageResizer-portable-${TARGET}` : 'ImageResizer-portable');
const APP = path.join(OUT, 'app');

// Packages we never need at runtime (dev/test only) - pruned from a native copy.
const PRUNE = ['playwright', 'playwright-core', '@playwright'];

const log = (m) => console.log('[portable] ' + m);
const rimraf = (p) => fs.rmSync(p, { recursive: true, force: true });
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

function dirSizeMB(p) {
  let bytes = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else try { bytes += fs.statSync(fp).size; } catch { /* transient */ }
    }
  };
  walk(p);
  return (bytes / (1024 * 1024)).toFixed(0);
}

// Download + extract the official Node build for a target and return its binary.
function fetchNode(ver, tos, tarch) {
  const plat = tos === 'win32' ? 'win' : tos;                 // win | darwin | linux
  const ext = tos === 'win32' ? 'zip' : 'tar.gz';
  const stem = `node-${ver}-${plat}-${tarch}`;
  const file = `${stem}.${ext}`;
  const url = `https://nodejs.org/dist/${ver}/${file}`;
  fs.mkdirSync(CACHE, { recursive: true });
  const dl = path.join(CACHE, file);
  if (!fs.existsSync(dl)) { log('downloading ' + url); sh('curl', ['-fsSL', '-o', dl, url]); }
  rimraf(path.join(CACHE, stem));
  log('extracting ' + file);
  // Run from CACHE with a RELATIVE filename: a bare "D:\..." arg makes GNU tar
  // read the drive letter as a remote host ("D:" -> host). cwd + basename
  // sidesteps that and works for both GNU tar and Windows bsdtar.
  sh('tar', ['-xf', file, '-C', '.'], { cwd: CACHE });
  const bin = tos === 'win32'
    ? path.join(CACHE, stem, 'node.exe')
    : path.join(CACHE, stem, 'bin', 'node');
  if (!fs.existsSync(bin)) throw new Error('node binary not found after extract: ' + bin);
  return bin;
}

// Zip a directory with POSIX (forward-slash) entry names and unix permissions.
// Used for non-Windows targets because Windows PowerShell's Compress-Archive
// writes BACKSLASH separators (breaks the folder structure when unzipped on
// macOS/Linux) and cannot set the executable bit. fflate does both, host-
// independently, so a Mac bundle cross-built on Windows extracts correctly.
function zipWithPerms(srcDir, zipPath) {
  const root = path.basename(srcDir);
  const isExec = (rel, name) =>
    name === NODE_BIN || rel.endsWith('.command') || rel.endsWith('.sh') ||
    name === 'ffmpeg' || name === 'ffprobe';
  const files = {};
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else {
        const mode = isExec(r, e.name) ? 0o755 : 0o644;
        // os:3 (Unix) + external attrs high 16 bits = unix mode (fflate contract).
        files[root + '/' + r] = [new Uint8Array(fs.readFileSync(abs)),
          { level: 6, os: 3, attrs: ((mode << 16) >>> 0) }];
      }
    }
  };
  walk(srcDir, '');
  fs.writeFileSync(zipPath, zipSync(files, {}));
}

// Resolve a target-native node_modules (prod only) via npm's cross-install.
function crossInstallModules(tos, tarch) {
  const stage = path.join(CACHE, `nm-${TARGET}`);
  rimraf(stage);
  fs.mkdirSync(stage, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
  log(`cross-installing node_modules for ${TARGET}`);
  // shell:true is required on Windows to spawn npm.cmd (Node refuses .cmd
  // via execFile without it since v18.20/20/22 - the EINVAL fix).
  sh(NPM, ['ci', '--omit=dev', `--os=${tos}`, `--cpu=${tarch}`, '--no-audit', '--no-fund'],
    { cwd: stage, shell: os.platform() === 'win32' });
  return path.join(stage, 'node_modules');
}

// --- build -------------------------------------------------------------------
log(`building a ${TARGET} bundle` + (CROSS ? ` (cross-build from ${HOST_TARGET})` : ''));
log('cleaning ' + path.relative(ROOT, OUT));
rimraf(OUT);
fs.mkdirSync(APP, { recursive: true });

// 1. App source (platform-neutral).
log('copying app source');
for (const f of ['server.js', 'package.json', 'package-lock.json', '.env.example']) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(APP, f));
}
for (const d of ['lib', 'public']) fs.cpSync(path.join(ROOT, d), path.join(APP, d), { recursive: true });
fs.mkdirSync(path.join(APP, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'scripts', 'portable-launch.js'), path.join(APP, 'scripts', 'portable-launch.js'));

// 2. node_modules (native copy, or cross-install for a foreign target).
if (!CROSS) {
  log('copying node_modules (this is the slow part)');
  fs.cpSync(path.join(ROOT, 'node_modules'), path.join(APP, 'node_modules'), { recursive: true });
  for (const pkg of PRUNE) {
    const p = path.join(APP, 'node_modules', pkg);
    if (fs.existsSync(p)) { rimraf(p); log('pruned ' + pkg); }
  }
  rimraf(path.join(APP, 'node_modules', '.cache'));
} else {
  const nm = crossInstallModules(TOS, TARCH);
  log('copying cross-installed node_modules');
  fs.cpSync(nm, path.join(APP, 'node_modules'), { recursive: true });
}

// 3. The Node runtime for the target.
if (!CROSS) {
  log('bundling node runtime (' + process.version + ' ' + process.arch + ')');
  fs.copyFileSync(process.execPath, path.join(OUT, NODE_BIN));
} else {
  log('fetching node runtime ' + process.version + ' for ' + TARGET);
  fs.copyFileSync(fetchNode(process.version, TOS, TARCH), path.join(OUT, NODE_BIN));
}

// 4. Launcher + README, keyed to the TARGET os (not the host).
log('writing launcher and README');
let launcherName;
if (TARGET_IS_WIN) {
  launcherName = 'Image Resizer.cmd';
  fs.writeFileSync(path.join(OUT, launcherName), [
    '@echo off',
    'cd /d "%~dp0"',
    'title Image Resizer',
    '"%~dp0node.exe" "%~dp0app\\scripts\\portable-launch.js"',
    '',
  ].join('\r\n'));
} else {
  launcherName = TOS === 'darwin' ? 'Image Resizer.command' : 'Image Resizer.sh';
  const launcherPath = path.join(OUT, launcherName);
  fs.writeFileSync(launcherPath, [
    '#!/bin/bash',
    'cd "$(dirname "$0")"',
    './' + NODE_BIN + ' app/scripts/portable-launch.js',
    '',
  ].join('\n'));
  try { fs.chmodSync(launcherPath, 0o755); fs.chmodSync(path.join(OUT, NODE_BIN), 0o755); } catch { /* no-op on NTFS */ }
}

const macSetup = TOS === 'darwin' ? [
  'FIRST-TIME SETUP ON macOS (once)',
  '--------------------------------',
  'This bundle was built off-Mac and is not code-signed, so macOS quarantines',
  'it. Do this one time after unzipping:',
  '',
  '  1. Move the unzipped folder somewhere permanent (Applications, Desktop...).',
  '  2. Open Terminal, type "cd " (with the trailing space), drag the folder',
  '     onto the Terminal window so its path appears, then press Enter.',
  '  3. Paste this line and press Enter:',
  '',
  '       xattr -dr com.apple.quarantine . && chmod +x node "Image Resizer.command"',
  '',
  'After that, just double-click "Image Resizer.command" any time. If Finder',
  'still warns on the very first open, right-click it and choose Open once.',
  '',
] : [];

const readme = [
  'Image Resizer - portable (' + TARGET + ')',
  '========================',
  '',
  ...macSetup,
  'Double-click "' + launcherName + '" to start.',
  'A small window opens and your browser loads the app automatically.',
  'Keep that window open while you use it; closing it stops the app.',
  '',
  'Nothing is installed and nothing leaves your machine. It runs a local',
  'server on 127.0.0.1 (localhost only) using the bundled Node runtime.',
  '',
  'This bundle is built for ' + TARGET + ' only. Copy the whole folder to',
  'another ' + TARGET + ' machine and it runs; build separately per OS/CPU.',
  '',
  'Optional settings: in the "app" folder, copy ".env.example" to ".env" to',
  'change defaults (target size, upload limits, branding, optional sign-in).',
  '',
].join('\n');
fs.writeFileSync(path.join(OUT, 'README.txt'), readme);

log('built ' + path.relative(ROOT, OUT) + '  (' + dirSizeMB(OUT) + ' MB)');

// 5. Zip. Always for a cross-build (the folder is the transfer unit), or on
//    --zip. Windows targets use Compress-Archive (backslash entries are fine on
//    Windows); every other target uses fflate for POSIX names + exec bits.
if (WANT_ZIP || CROSS) {
  const zip = path.join(ROOT, 'dist', path.basename(OUT) + '.zip');
  rimraf(zip);
  log('zipping ' + path.basename(zip));
  if (TARGET_IS_WIN) {
    sh('powershell', ['-NoProfile', '-Command',
      `Compress-Archive -Path "${OUT}" -DestinationPath "${zip}" -CompressionLevel Optimal`]);
  } else {
    zipWithPerms(OUT, zip);
  }
  log('zipped ' + path.relative(ROOT, zip));
}

log('done. Launcher in the bundle: "' + launcherName + '".');
