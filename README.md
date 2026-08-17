# Image Resizer

A small self-hosted web tool for shrinking images and videos down to a target file size.
Drop in a batch of photos, screenshots, or clips, pick a size budget, and get back files that fit - with no cloud upload and no account required by default.

Images are guaranteed to land at or under the target size.
Video is best-effort, because encoder output size has real variance that quality-based image compression doesn't.

## Why this is interesting

Most "resize my image" tools let you pick a quality slider and hope.
This one works backwards from a byte budget instead:

- **Binary search on JPEG/WebP/PNG quality.**
  For each candidate width, the server binary-searches quality between a perceptual floor and the format's max, encoding at each midpoint until it finds the highest quality that still fits under the target size.
  Two fast-path checks (does max quality already fit, does the floor still not fit) skip the search entirely for the common cases, so most images resolve in one or two encodes instead of the full log(n) passes.
- **Progressive downscale as a second axis.**
  If no quality level at the current width fits, the algorithm steps width down a multiplicative ladder (roughly 85% per step) and re-runs the quality search at the new width.
  It always prefers the largest resolution that can still hit the target, only trading away pixels once quality alone can't get there.
- **A resolution/target conflict is surfaced, not silently resolved.**
  If a minimum-resolution floor (or "banner mode", which pins the original width) makes the target size impossible, the server returns two candidates - the smallest file at the resolution floor, and the smallest resolution that actually hits the target - and lets the user pick.
- **Video bitrate targeting.**
  Video can't be binary-searched the same way (each encode is minutes, not milliseconds), so instead the target byte budget and clip duration are used to compute a starting bitrate directly, encode once, and allow exactly one corrective re-encode if the result overshoots by more than a few percent.
  If even the lowest rung of a resolution/audio-bitrate ladder can't hit the budget without falling below a sane quality floor, it degrades gracefully rather than failing outright.

- **Editing sends geometry, not pixels.**
  The crop/rotate/flip/focus editor is a canvas UI, but it never re-encodes in the browser - it sends only the geometry.
  The server bakes EXIF orientation and the edit into pixels with sharp *before* the target-size search runs, so the resolution ladder and minimum-resolution floor stay coherent against the edited dimensions rather than the original ones.

The core logic for both lives in [`lib/compress.js`](lib/compress.js) (images) and [`lib/video.js`](lib/video.js) (video).
`server.js` is a thin HTTP wrapper around them.

## Features

- **Images in:** JPEG, PNG, WebP, GIF, AVIF, BMP, HEIC/HEIF
- **Images out:** JPEG, WebP, or PNG, guaranteed to be at or under the target size (default 500 KB)
- **Image controls:** banner mode (never shrinks width, only quality), minimum-resolution floor with a conflict UI when the floor and the target disagree
- **Pre-compression editor:** crop, aspect presets (1:1 / 4:3 / 16:9 / original / custom), rotate, flip, zoom, and a focus point - applied to one image or across the whole batch.
  Only geometry is sent to the server; the original bytes still go through the quality pipeline.
  Not offered for GIF (a crop would flatten the animation) or HEIC/HEIF (browsers can't decode those onto a canvas)
- **Video in:** MP4, MOV, WebM, AVI
- **Video out:** MP4 (H.264), best-effort target size (default 50 MB, typically within about 5%)
- **Batch processing:** drop a mix of images and videos at once, download results individually or as a single ZIP
- **No database, no cloud storage.** Everything happens in memory or in a short-lived temp directory for the duration of a request.

## Tech stack

- **Server:** Node.js + Express
- **Image processing:** [`sharp`](https://sharp.pixelplumbing.com/) (libvips), with `heic-convert` as a pre-decode step for HEIC/HEIF input
- **Video processing:** bundled [ffmpeg](https://www.npmjs.com/package/@ffmpeg-installer/ffmpeg) and [ffprobe](https://www.npmjs.com/package/@ffprobe-installer/ffprobe) binaries, so nothing needs to be installed system-wide
- **Frontend:** a plain HTML/CSS/vanilla-JS single-page app, no framework and no build step
- **Zipping:** [`fflate`](https://github.com/101arrowz/fflate) in the browser, for client-side ZIP downloads
- **Testing:** a Node driver script plus Playwright for browser end-to-end screenshots

## Quick start

```bash
npm install
npm start
```

Then open `http://localhost:3210`.
That's it - with no `.env` file at all, the app runs with no login and default branding.

Copy `.env.example` to `.env` if you want to change the port, upload limits, or the two optional features described below.

### Or run it with Docker

No Node.js install needed - the image bundles everything, including sharp/libvips and ffmpeg.

```bash
cp .env.example .env    # optional - only needed to change defaults or enable SSO/branding
docker compose up --build
```

Or without Compose:

```bash
docker build -t image-resizer .
docker run -p 3210:3210 --env-file .env image-resizer
```

Then open `http://localhost:3210`. The container is stateless (everything lives in memory or a
short-lived temp directory for the duration of a request), so it can be killed and restarted
freely with no volume to manage.
Video encoding is CPU-heavy - if this shares a host with other services, set resource limits
(see the commented-out `deploy.resources` block in `docker-compose.yml`, or `docker run --cpus`/`--memory`).

### Or build a 1-click portable app (Windows or macOS)

If you want to hand someone a folder they can double-click - no Node install, no command line - build a portable bundle:

```bash
npm install
npm run build:portable          # add -- --zip to also produce a .zip
```

On Windows this writes `dist/ImageResizer-portable/`:

```
Image Resizer.cmd      double-click to start   (macOS: "Image Resizer.command")
README.txt
node.exe               the bundled Node runtime  (macOS: "node")
app/                   server.js, lib, public, and production node_modules
```

Double-clicking the launcher starts a local server on a free `127.0.0.1` port and opens the app in the default browser; closing the small window stops it.
Nothing is installed and nothing leaves the machine.
Copy the whole folder to a USB stick or another machine of the same OS and it just runs.

How it is built (see [`scripts/build-portable.mjs`](scripts/build-portable.mjs)): it bundles the Node runtime the build was run with and **copies** the already-working `node_modules`, so the native `sharp` and bundled `ffmpeg` binaries are the exact ones proven on the build machine - no ABI rebuild and no network install.
Dev-only packages are pruned.
The bundle is around 250 MB, most of which is `ffmpeg` and `libvips` - drop `@ffmpeg-installer`/`@ffprobe-installer` from `dependencies` and rebuild if you want an images-only build about 80 MB smaller.

**Building for another OS (cross-build).** Native binaries are OS- and CPU-specific, so a bundle only runs on the platform it targets.
By default the script builds for the current machine; pass `--target` to build for another:

```bash
npm run build:portable -- --target=darwin-arm64   # Apple Silicon macOS (M1-M4)
npm run build:portable -- --target=darwin-x64     # Intel macOS
```

A cross-build downloads the target's Node from nodejs.org and resolves target-native `node_modules` via `npm ci --os --cpu`, then emits the matching launcher (`.cmd` / `.command` / `.sh`) and a ready-to-ship `dist/ImageResizer-portable-<target>.zip` (POSIX paths and executable bits preserved).
Building **on** the target OS is still the most robust option when you have access to it.

**macOS first run.** A cross-built bundle is unsigned, so macOS quarantines it after download.
The bundle's `README.txt` carries the one-time command to clear it (`xattr -dr com.apple.quarantine . && chmod +x node "Image Resizer.command"`); after that, double-click `Image Resizer.command` any time.
Signing it away entirely needs an Apple Developer certificate and a Mac.

## Configuration

All configuration is via environment variables, loaded from a `.env` file in the project root if one exists.
Nothing here is required; every variable has a sane default and the app is fully usable with zero configuration.

### Core server and limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3210` | Port the web server listens on |
| `HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to restrict to localhost only |
| `TARGET_KB` | `500` | Default image target size in KB (overridable per job in the UI) |
| `MAX_FILE_MB` | `25` | Max size of a single uploaded image, in MB |
| `MAX_FILES` | `20` | Max number of files per batch upload |
| `ENCODE_PROFILE` | `max` | JPEG/WebP encoder tuning: `max`, `balanced`, or `fast`. See below |
| `MAX_CONCURRENT` | `5` | Max number of `/api/compress` requests processed at once (excess requests get a 503) |
| `MAX_VIDEO_MB` | `500` | Max size of a single uploaded video, in MB |
| `VIDEO_TARGET_MB` | `50` | Default video target size in MB |
| `MAX_VIDEO_CONCURRENT` | `1` | Max number of videos encoded at once (video encodes are CPU-heavy, so this is intentionally low) |

#### Encoder profiles

The target-size search runs a lot of encodes, so the per-encode cost dominates total runtime.
`ENCODE_PROFILE` picks that trade-off.
Measured on `test/samples/photo.jpg` (2400x1600, 2.9MB) to a 500KB JPEG target:

| Profile | Encoder | CPU per image | Result |
| --- | --- | --- | --- |
| `max` (default) | mozjpeg, 4:4:4 chroma | ~12.7s | 1734px, 482KB, q34 |
| `balanced` | mozjpeg, 4:2:0 chroma | ~7.9s | 2040px, 486KB, q40 |
| `fast` | libjpeg-turbo, 4:2:0 chroma | ~1.3s | 1734px, 491KB, q45 |

`max` is the default so nothing changes for anyone self-hosting or running the portable build.
It is the right choice when you own the machine and care most about colour fidelity on flat-colour graphics, where 4:2:0 chroma subsampling is visible.

`balanced` is worth knowing about: mozjpeg's trellis quantization produces smaller files, which lets the resolution ladder stop at a *wider* width, so it often returns a higher-resolution image than `max` for ~60% of the CPU.

`fast` is roughly 10x cheaper per encode and is intended for a deployment serving many people at once, where sustained throughput matters more than chroma resolution.

### Optional feature 1: Microsoft Entra ID (Azure AD) SSO

By default the app has no authentication at all - anyone who can reach the port can use it.
This is intentional, so cloning and running the project locally has zero setup.

If you want to require Microsoft sign-in before the app (or its API) will respond, set all five of these:

| Variable | Meaning |
| --- | --- |
| `MS_CLIENT_ID` | Application (client) ID of your Azure AD App Registration |
| `MS_CLIENT_SECRET` | A client secret created for that App Registration |
| `MS_TENANT_ID` | Directory (tenant) ID of your Azure AD tenant |
| `MS_REDIRECT_URI` | Must match the redirect URI configured on the App Registration, e.g. `http://localhost:3210/auth/callback` |
| `SESSION_SECRET` | Random string used to sign the login session cookie |

When all five are present, the app requires a Microsoft login before serving the app or its API routes, via `GET /auth/login`, `GET /auth/callback`, and `GET /auth/logout`.
When `MS_CLIENT_ID` is unset, auth is skipped entirely regardless of the other variables.

To set up your own App Registration:

1. Go to the [Azure Portal](https://portal.azure.com) -> App registrations -> New registration.
2. Give it any name, and for local testing set the redirect URI to `http://localhost:3210/auth/callback`.
3. After creation, copy the **Application (client) ID** and **Directory (tenant) ID** from the Overview page into `MS_CLIENT_ID` and `MS_TENANT_ID`.
4. Go to **Certificates & secrets** -> New client secret, and copy its value into `MS_CLIENT_SECRET` immediately (Azure only shows it once).
5. Generate any random string for `SESSION_SECRET`, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
6. Put all five values in your `.env` file. Never commit `.env` - it's already listed in `.gitignore`.

Auth is implemented with [`@azure/msal-node`](https://www.npmjs.com/package/@azure/msal-node).

### Optional feature 2: branding

If you fork this project and want to re-skin it without touching any code, set any of these:

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRAND_NAME` | `Image Resizer` | Name shown in the page title and header |
| `BRAND_TAGLINE` | a generic description | Subtitle shown under the name |
| `BRAND_ACCENT_COLOR` | a neutral blue hex value | Primary accent color |
| `BRAND_HIGHLIGHT_COLOR` | (unset) | Optional secondary accent color |

These are read server-side and exposed to the browser via `GET /api/config`, then applied at runtime in the page.
No rebuild is required to change branding - editing `.env` and restarting the server is enough.

## Project layout

```
server.js            Express app: serves the SPA + POST /api/compress + GET /api/download/:id
lib/
  decode.js             input normalization (HEIC -> JPEG) + image/video magic-byte detection
  compress.js           image target-size search, banner mode, min-resolution conflict handling
  video.js              video bitrate targeting, resolution/audio ladder, poster frame generation
  download-registry.js  short-lived in-memory registry backing video downloads
  auth.js               optional Microsoft SSO (env-gated, see Configuration below)
public/              vanilla single-page app (index.html, app.js, style.css, vendor/fflate)
test/                test driver (driver.mjs) and sample fixtures (samples/)
```

## Running tests

The project has no unit-test framework; instead there's a driver script that exercises the real compression pipeline against sample files and asserts the results actually hit their targets.

```bash
node test/driver.mjs          # fast: runs samples through the compressor directly, no browser
node test/driver.mjs --e2e    # slower: launches the server, drives the real UI in a browser, saves a screenshot
```

The `--e2e` variant needs Playwright's Chromium build installed once:

```bash
npx playwright install chromium
```

`--e2e` runs the server on port 3299 specifically so it never collides with a `npm start` instance on the default 3210.

## Development notes

A few non-obvious things worth knowing before touching the code:

- **HEIC needs a pre-step.** sharp's prebuilt binaries generally ship without libheif, so HEIC/HEIF input is detected by its `ftyp` brand in `lib/decode.js` and transcoded via `heic-convert` before it ever reaches sharp.
- **PNG is lossless** - there's no quality knob the way JPEG/WebP have one. `compress()` uses palette quantization as the searchable size knob instead. Encoding a photographic/noisy image to PNG at high effort is slow (each search step is a full re-quantization); real graphics/screenshots are fast. Prefer JPEG/WebP for photos.
- **JPEG almost always fits the target**, even at large dimensions, because the lowest quality setting compresses very aggressively. Size/resolution conflicts mostly show up with PNG output or a large minimum-resolution floor.
- **The CSP intentionally allows `data:`/`blob:` for images and media.** Compressed results and previews are delivered as data URLs and object URLs; tightening `imgSrc`/`mediaSrc` in `server.js` will break previews.
- **Don't add the `canvas` npm package to this process.** sharp and canvas loaded in the same Node process are known to crash on Windows. (The pre-compression editor uses a client-side `<canvas>` in the browser, which is unrelated and safe.)
- **Editor crop coordinates live in "baked" pixel space.** The browser canvas draws the image already EXIF-oriented (browsers do this for `<img>` automatically) plus any user rotate/flip, and sends crop rectangles measured in that space. The server mirrors it exactly in `lib/compress.js applyEdit()`: a two-stage bake (auto-orient, then flip/rotate to pixels, then extract or cover-crop) that runs before metadata is read. If you change the transform order on one side, change it on the other, or EXIF-rotated phone photos will crop the wrong region.
- **`multer` must stay on the 2.x line** - 1.x has known vulnerabilities.

## License

MIT. See [LICENSE](LICENSE).
