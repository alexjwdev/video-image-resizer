---
name: run-image-resizer
description: Run, start, serve, build, test, or screenshot the image-resizer web app — a Node/Express tool that compresses uploaded images (JPEG/PNG/WebP/GIF/AVIF/BMP/HEIC) to ≤500KB with isBanner and minimum-resolution controls. Use when asked to launch the resizer, drive it, verify a compression/sizing change works, or capture a screenshot.
---

# run-image-resizer

A lightweight internal web app for the company Windows VM. Users upload images of any
common format, pick an output format (JPEG/WebP/PNG), and every image is auto-compressed
to **≤500KB** via a binary-search-on-quality + progressive-downscale loop. Two
quality-of-life controls: **isBanner** (protects full width, drops quality before ever
shrinking dimensions) and **minimum resolution** (a hard floor; if it conflicts with the
size target, the UI offers both results and the user chooses).

- **Backend:** Express + `multer` + `sharp` (libvips), single process. `lib/compress.js` is
  the core; HTTP is a thin wrapper in `server.js`.
- **Frontend:** vanilla `public/` SPA — drag-drop, batch, before/after slider, ZIP via `fflate`.
- **Driver:** [.claude/skills/run-image-resizer/driver.mjs](.claude/skills/run-image-resizer/driver.mjs)
  — lib smoke (default) + Playwright browser/screenshot (`--e2e`).

All paths below are relative to the project root (`<unit>/`, i.e. the `image-resizer` folder).

## Prerequisites

```bash
npm install                                          # express, multer, sharp, heic-convert, helmet, fflate
npm install -D playwright@^1.49.0 && npx playwright install chromium   # only for --e2e screenshots
```

`sharp` installs prebuilt libvips binaries on Windows x64 + Node ≥20 — no compiler needed.
Verify it loaded:

```bash
node -e "const s=require('sharp'); console.log('sharp', s.versions.sharp, 'libvips', s.versions.vips)"
```

## Run (agent path) — drive it without a human

**1. Lib smoke (primary — fast, no browser).** Runs every sample through `compress()` for
each format and asserts each output is ≤500KB (or that a min-resolution conflict is
correctly surfaced). Exits non-zero on any violation.

```bash
node .claude/skills/run-image-resizer/driver.mjs
```

Expected tail: `ALL PASS`. Sample output line:
`PASS  photo.jpg -> jpeg {}   2400x1600 2907 KB -> 2400x1600 481 KB q26 jpeg`.

**2. Browser e2e + screenshot.** Launches the server on port 3299, uploads a sample
through the real file input, asserts a rendered result ≤500KB, and writes a screenshot:

```bash
node .claude/skills/run-image-resizer/driver.mjs --e2e
```

Screenshot lands at `.claude/skills/run-image-resizer/result.png`. Open it to confirm the
UI rendered (dropzone, options, result card with before/after slider) — not a blank/error page.

**3. Direct invocation — exercise the core without the server.** Most logic lives in
`lib/compress.js`; import and call it:

```bash
node -e "const fs=require('fs');const {compress}=require('./lib/compress');compress(fs.readFileSync('.claude/skills/run-image-resizer/samples/banner.jpg'),{format:'jpeg',isBanner:true}).then(r=>console.log(r.result.width+'x'+r.result.height,(r.result.size/1024|0)+'KB q'+r.result.quality))"
```

**4. Hit the API directly** (server must be running — see human path):

```bash
curl -s -F "format=jpeg" -F "isBanner=true" -F "files=@.claude/skills/run-image-resizer/samples/banner.jpg" http://127.0.0.1:3210/api/compress
```

Returns JSON per file: original size/dims, a `result` (base64 data URL + size/dims/quality),
or a `conflict` with `keepResolution` and `hitTarget` variants.

## Run (human path)

```bash
npm start            # = node server.js ; listens on http://0.0.0.0:3210 (override with PORT/HOST)
```

Then browse `http://localhost:3210`, drop images, choose options, click **Compress**.
Useless headless — this path needs a browser. Ctrl-C to stop. Copy `.env.example` to `.env`
to change `PORT`, `HOST`, `TARGET_KB`, or upload limits.

## Deployment on the Windows VM (recipe — run on the VM, not in this session)

Run the app as a PM2-managed Windows service so it survives reboots:

```powershell
npm install -g pm2
# one-time: register PM2 as a Windows service via https://github.com/jessety/pm2-installer
#   (elevated) npm run configure ; npm run setup
cd C:\apps\image-resizer
npm install --omit=dev
pm2 start server.js --name image-resizer
pm2 save
New-NetFirewallRule -DisplayName "ImageResizer" -Direction Inbound -Protocol TCP -LocalPort 3210 -Action Allow
```

Update: replace files, then (elevated) `pm2 restart image-resizer`.

## Gotchas

- **HEIC needs a pre-step.** sharp's prebuilt Windows binary has no libheif, so HEIC/HEIF is
  detected by `ftyp` brand in `lib/decode.js` and transcoded via `heic-convert` before sharp.
- **PNG is lossless** — there's no quality knob. `compress()` uses palette quantization
  (`png({palette:true, quality, compressionLevel:9})`) as the searchable size knob. Encoding
  a *photographic/noisy* image to PNG at high effort is very slow (seconds per pass × the
  search); real graphics/screenshots are fast. Prefer JPEG/WebP for photos.
- **JPEG almost always fits 500KB**, even at 4000px, because q1 mozjpeg is tiny. Size/resolution
  **conflicts** therefore show up mainly with PNG output or a large `minWidth/minHeight`.
- **helmet CSP must allow `img-src data: blob:`** — compressed results and previews are
  delivered as data URLs. The CSP is set explicitly in `server.js`; loosening `imgSrc` breaks previews.
- **base64 responses inflate ~33%.** We return results in-memory as data URLs (no temp-file
  lifecycle on Windows). Fine for ≤500KB results; the conflict `keepResolution` variant can be
  larger — acceptable for an internal tool.
- **Don't add the `canvas` npm package** to this process — sharp + canvas in one Node process
  crashes on Windows ("specified procedure could not be found").
- **multer must be 2.x** — 1.x has known vulnerabilities.

## Troubleshooting

- **`preview_screenshot` / Claude Preview MCP hangs** — it timed out reliably in this
  environment even though `preview_eval` worked. Use the Playwright `--e2e` path for
  screenshots; it's self-contained and doesn't depend on the MCP.
- **`--e2e` errors with "Executable doesn't exist"** — run `npx playwright install chromium`.
- **Port already in use** — the server uses 3210, `--e2e` uses 3299. Stop the stray process or
  set `PORT`. The default human server and the e2e harness won't collide.
- **HEIC upload fails** — confirm `heic-convert` is installed (`npm ls heic-convert`); it's a
  pure-JS dependency, no native build.
