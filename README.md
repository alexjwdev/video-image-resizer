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

The core logic for both lives in [`lib/compress.js`](lib/compress.js) (images) and [`lib/video.js`](lib/video.js) (video).
`server.js` is a thin HTTP wrapper around them.

## Features

- **Images in:** JPEG, PNG, WebP, GIF, AVIF, BMP, HEIC/HEIF
- **Images out:** JPEG, WebP, or PNG, guaranteed to be at or under the target size (default 500 KB)
- **Image controls:** banner mode (never shrinks width, only quality), minimum-resolution floor with a conflict UI when the floor and the target disagree
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
| `MAX_CONCURRENT` | `5` | Max number of `/api/compress` requests processed at once (excess requests get a 503) |
| `MAX_VIDEO_MB` | `500` | Max size of a single uploaded video, in MB |
| `VIDEO_TARGET_MB` | `50` | Default video target size in MB |
| `MAX_VIDEO_CONCURRENT` | `1` | Max number of videos encoded at once (video encodes are CPU-heavy, so this is intentionally low) |

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
.claude/skills/run-image-resizer/   test driver and sample fixtures
```

## Running tests

The project has no unit-test framework; instead there's a driver script that exercises the real compression pipeline against sample files and asserts the results actually hit their targets.

```bash
node .claude/skills/run-image-resizer/driver.mjs          # fast: runs samples through the compressor directly, no browser
node .claude/skills/run-image-resizer/driver.mjs --e2e    # slower: launches the server, drives the real UI in a browser, saves a screenshot
```

The `--e2e` variant needs Playwright's Chromium build installed once:

```bash
npx playwright install chromium
```

## License

MIT. See [LICENSE](LICENSE).
