# Image / Video Resizer - Overview and Usage Guide

A single-purpose web tool that compresses any common image or video down to a target file size.
Images are guaranteed to land at or under the target; videos are a best-effort conversion to a size-capped MP4.
This guide covers the technology stack, how the compression actually works, and how to use and operate the tool.

---

## 1. What it does

You upload one or more files, pick a target size and a few options, and the tool returns compressed versions you can download individually or as a ZIP.

- **Images** are re-encoded (and resized if needed) so the output is always at or under the target byte size, while keeping the largest resolution that still fits.
- **Videos** are transcoded to MP4 aimed at a target size, best-effort (encoders vary, so the result lands close to, not exactly on, the target).
- **No accounts, no database, nothing stored permanently.** Results live in memory or a short-lived temp file and are swept automatically.

---

## 2. Technology stack and tools

| Layer | Tool | Why it is used |
|---|---|---|
| Runtime | **Node.js 20+** | Single process, no build step |
| HTTP server | **Express 4** | Minimal routing and middleware |
| Image processing | **sharp** (libvips) | Fast JPEG/PNG/WebP encode, resize, EXIF-orient |
| HEIC/HEIF decode | **heic-convert** | sharp's Windows build lacks libheif, so HEIC is transcoded to JPEG first |
| Video processing | **ffmpeg + ffprobe** (bundled via `@ffmpeg-installer` / `@ffprobe-installer`) | Transcode, scale, bitrate control, poster frame. No system install needed |
| Security headers | **helmet** | Content Security Policy, clickjacking and MIME protections |
| Rate limiting | **express-rate-limit** | Caps requests per minute on the compress endpoint |
| Upload handling | **multer** (2.x) | Multipart parsing with size and count limits |
| Optional SSO | **@azure/msal-node** + **express-session** | Microsoft Entra ID login, only when configured |
| Client-side ZIP | **fflate** | Bundles multiple results into one download in the browser |
| Frontend | **Vanilla JS + CSS** | No framework, no build tooling |
| Testing | **Playwright** + a custom driver | End-to-end browser test and a direct library smoke test |

There is no framework, no bundler, and no database.
The frontend is plain static files served by the same Express process.

---

## 3. How it works (the processes)

### Request flow

1. The browser (static UI in `public/`) posts a multipart batch to `POST /api/compress`.
2. The server validates each file, then routes it to an image or a video worker based on its real file signature (magic bytes), never the client-declared type.
3. Images and videos run in **two independent worker pools** at the same time, because video encoding is slow and CPU-heavy while image encoding is cheap.
4. Image results come back inline as base64 data URLs; video results are too large for that, so they are stored server-side and returned as a `/api/download/:id` link.

### Image pipeline (guaranteed at or under target)

The image compressor searches two dimensions to find the best result that fits the target:

- **Quality:** at a given width it runs a binary search for the highest quality whose encoded size is still under the target, with fast-path exits for the common cases ("already fits at max quality" and "too big even at the floor").
- **Resolution:** it walks a width ladder, stepping down by roughly 15% at a time, and prefers the **largest** width that can still meet the target.

If the target simply cannot be met without shrinking below your minimum-resolution floor (or below a protected banner width), it does not silently pick one for you.
It returns a **conflict** with two candidates and lets you choose:

- **Keep resolution** - stays at your minimum size, may exceed the target.
- **Hit target** - shrinks past the floor until it fits.

A **passthrough** short-circuit skips re-encoding entirely when the input already fits the target and is already in the requested format, because re-encoding an already-compressed file usually makes it bigger.

> Note on formats: JPEG and WebP have a real quality knob, so they almost always meet the target.
> PNG is lossless with no quality knob, so the tool uses palette (color count) reduction instead; PNG-encoding a photo is slow, so prefer JPEG or WebP for photographic images.

### Video pipeline (best-effort target)

Video size cannot be binary-searched the way image quality can, because encodes are slow and the size-versus-bitrate relationship varies.
So the tool:

1. Reads duration and dimensions with ffprobe.
2. Predicts a bitrate from the target size and duration.
3. Encodes once, and allows exactly **one** corrective re-encode if the first attempt overshoots.
4. Walks a height ladder (1080 -> 720 -> 480 -> 360) against audio tiers (128 -> 64 -> 0 kbps) until it fits within sensible quality floors.
5. Generates a small JPEG poster frame for the preview.

Output is always MP4 (H.264 + AAC).
A source that is already a compatible MP4 and already under target is passed through unchanged.

### Cleanup

Video download files are held in an in-memory registry keyed by a random ID (never a file path, so there is no path-traversal risk) and are automatically deleted on a 15-minute timer.

---

## 4. How to use it (end user)

### Step 1 - Open the app

Go to the tool's URL in a browser.
If Microsoft sign-in is enabled for your deployment, log in first.

### Step 2 - Add files

- Drag and drop files onto the drop zone, or click **browse files**.
- You can queue several at once (up to the batch limit).
- Supported input: **JPG, PNG, WebP, GIF, AVIF, BMP, HEIC** for images and **MP4, MOV, WebM, AVI** for video.

### Step 3 - Set options

**Image settings**

| Option | What it does |
|---|---|
| **Output format** | JPEG, WebP, or PNG. WebP usually gives the smallest files for photos |
| **Target size (KB)** | The size ceiling the result must meet |
| **Banner mode** | Protects the full width; the tool lowers quality before it ever shrinks dimensions |
| **Minimum resolution (px)** | The tool will not go below this; if the target cannot be met, it asks you to choose (see conflicts) |

**Video settings**

| Option | What it does |
|---|---|
| **Target size (MB)** | The size the MP4 aims for (best-effort, usually within about 5%) |

**Max files per batch** controls how many files you can queue at once; larger batches use more memory and take longer.

### Step 4 - Compress

Click **Compress**.
A progress bar shows how many files are done.
Videos take noticeably longer than images.

### Step 5 - Review results

Each result appears as a card showing the before and after size and the percentage saved.

- **Click a card** to open a before/after compare view (drag the slider for images, or play the video).
- A red badge means the result could not get under the target (rare, mostly with strict PNG or minimum-resolution settings).
- **Conflicts** open a chooser: pick **Keep resolution** or **Hit target** as described in section 3.

### Step 6 - Download

- Download each result from its card or the compare view.
- If you compressed several files, use **Download all (ZIP)** to get them in one archive (zipped in your browser).

---

## 5. Running and operating it

### Local / server

```bash
npm install        # first time
npm start          # serves on http://0.0.0.0:3210 by default
```

Configuration is entirely via environment variables (copy `.env.example` to `.env`).
Common knobs:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3210` / `0.0.0.0` | Listen address |
| `TARGET_KB` | `500` | Default image target |
| `MAX_FILE_MB` | `25` | Max image upload size |
| `MAX_FILES` | `20` | Max files per batch |
| `MAX_CONCURRENT` | `5` | Max in-flight compress requests |
| `VIDEO_TARGET_MB` / `MAX_VIDEO_MB` | `50` / `500` | Default and max video sizes |
| `MAX_VIDEO_CONCURRENT` | `1` | Simultaneous video encodes (CPU guard) |

Optional, off by default:

- **Branding** (`BRAND_*`) - rename and recolor the UI without code changes.
- **Microsoft SSO** (`MS_*` + `SESSION_SECRET`) - require Entra ID login for every route.

### Docker

```bash
docker compose up -d      # builds and runs, reads .env
```

The container runs as a non-root user and exposes port 3210.

---

## 6. Testing

```bash
npm test                    # smoke: runs sample files through the real compressor, asserts they hit target
node test/driver.mjs --e2e  # launches the server and drives the real UI in a headless browser
npx playwright install chromium   # one-time, only needed for --e2e
```

The smoke test is the fast default and covers the library layer that most changes touch.
Both modes exit non-zero on any failure.

---

## 7. Related documents

- [../README.md](../README.md) - project readme and full configuration reference.
