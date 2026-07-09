# Project State — Image Resizer

Internal web tool for the company Windows VM.
Upload images or videos of any common format; the app compresses them to a target size.
This file is a running log of architecture decisions and session history.
For usage instructions see [README.md](README.md); for run/test/deploy details see
[.claude/skills/run-image-resizer/SKILL.md](.claude/skills/run-image-resizer/SKILL.md).

## Architecture snapshot

Node + Express server, vanilla JS SPA frontend, no database, no auth (internal LAN only).

- `server.js` — thin HTTP wrapper.
  Serves the SPA, `POST /api/compress`, `GET /api/download/:id` (video only), `GET /api/config`.
- `lib/compress.js` — image pipeline.
  Binary-search on quality, then progressive downscale, to hit a target size.
  Guarantees output ≤ target (or returns a `keepResolution`/`hitTarget` conflict for the user to
  choose between, when a minimum-resolution floor can't be met at the target size).
- `lib/video.js` — video pipeline.
  Computes a bitrate from ffprobe'd duration and the byte budget, encodes once, allows one
  corrective re-encode, and falls back through a resolution/audio-bitrate ladder if the target
  is too tight.
  Best-effort only (~±5% of target), not a hard guarantee — video bitrate-vs-size has real
  encoder variance that a quality-based image search doesn't.
- `lib/decode.js` — format detection.
  HEIC normalization (via `heic-convert`) and magic-byte detection for both image formats and
  video containers (mp4/mov, webm, avi), independent of client-supplied MIME type.
- `lib/download-registry.js` — short-lived in-memory file registry backing video downloads
  (base64-JSON doesn't scale to 50MB+ video the way it does for small images).
- `public/` — vanilla SPA (`index.html`, `app.js`, `style.css`), client-side ZIP via `fflate`.
- `.claude/skills/run-image-resizer/` — run-skill, smoke-test driver, Playwright e2e driver.

Dependencies worth knowing about: `sharp` (libvips) for images, bundled
`@ffmpeg-installer/ffmpeg` + `@ffprobe-installer/ffprobe` binaries for video (no system ffmpeg
needed on the VM), `multer` for uploads, `helmet` for security headers, `fflate` for client-side
ZIP.

## Session log

### 2026-06-22 — initial build

Built the image-only version of the tool.
Input: JPEG/PNG/WebP/GIF/AVIF/BMP/HEIC.
Output: JPEG/WebP/PNG, guaranteed ≤ target size.
Quality-of-life features: banner mode (protects full width), minimum-resolution floor with a
conflict UI when it can't be met, batch upload with ZIP download.

### 2026-07-08 (morning) — launcher fix, image bug fix, video feature added

Three pieces of work, in order:

1. Replaced the non-working silent `.vbs` + tray launcher with `Start Image Resizer.cmd`, a
   visible console window that shows startup and stops the server when closed.
   The original silent launcher is kept as an alternative, documented in the README.
2. Fixed a bug in `lib/compress.js`: if the source already fit the target size, the app used to
   skip format conversion entirely and silently keep the original format, even when a different
   output format was explicitly requested.
   Now it always re-encodes to the requested format in that case.
3. Added video compression/conversion (input MP4/MOV/WebM/AVI, output MP4/H.264, default target
   50MB).
   Full design rationale (bitrate strategy, why it's best-effort, download delivery via a
   registry instead of base64) is in the approved plan and in Claude's project memory —
   see `lib/video.js` and `lib/download-registry.js` for the implementation.

### 2026-07-08 (afternoon) — video preview bug, format-display bug, settings UX pass

User reported: videos erroring on preview, results showing the pre-conversion format, and the
settings panel feeling cluttered.
Reproduced both bugs end-to-end before fixing (uploaded real MP4/MOV/WebM/AVI files and a WEBP
image through the actual running app) and researched UI/UX patterns from Squoosh, TinyPNG,
CloudConvert, Compressor.io, FreeConvert, and HandBrake before touching the settings panel.

**Bugs found and fixed:**

- Video preview error, root cause: `lib/video.js`'s "already fits target, skip re-encoding"
  passthrough returned the original file bytes unchanged for *any* small-enough video, but the
  app always serves/labels video downloads as `video/mp4`.
  A small AVI (or any MOV/WebM, or an MP4 with an incompatible codec like HEVC) got served back
  byte-identical but mislabeled as MP4, and browsers failed to play it
  (`DEMUXER_ERROR_COULD_NOT_OPEN` in Chrome for the AVI case).
  Fix: passthrough now requires the source to already be real MP4/H.264(+AAC); everything else
  always transcodes, even if already small.
  To avoid needlessly inflating an already-small file that only needs re-encoding for
  compatibility (not size), that case targets a bitrate matching the source's own size rather
  than the full user target.
- Results showing the old format, root cause: the grid card and overlay both displayed the
  original uploaded filename (e.g. `photo.webp`), never updated to reflect the real output
  format, even though the correctly-renamed name already existed internally for the download
  blob.
  Fix: both now show the real output name, and the grid card gained an explicit format chip so
  format is never implied by filename alone.
- Bonus bug found while testing the above (unrelated to what was reported): clicking "Clear all"
  didn't actually remove queue rows from the DOM — it emptied the tracking map before
  `renderQueue()` could use it to remove the rows, so old rows reappeared, stale, the next time
  files were added.
  Fixed by not clearing the map early.

**Settings UX redesign**, informed by the competitor research above: the options panel now
splits into labeled "Image settings" and "Video settings" groups that show or hide based on
what's actually in the upload queue (both shown when the queue is empty), instead of always
showing every control regardless of relevance.
Video-specific progress copy was added ("takes longer and is best-effort") when a compress run
includes video.
Explicitly deferred to a future pass: named presets, a live settings preview, and a real
ffmpeg-progress percentage bar — all patterns the research surfaced, but bigger than what was
asked for this round.

### 2026-07-08 (evening) — preview/overlay CSS bug, video queue thumbnail bug

User reported: previews broken for both images and videos in the results grid and the
pre-compress queue thumbnail, plus overflow and "double preview" (image and video panes both
showing at once) in the expanded compare overlay.
Reproduced via a real Playwright session driving the actual server (not the stale `--e2e`
driver) — uploaded a real image + video, inspected computed `display` values and `hidden`
attributes directly in the DOM rather than trusting screenshots alone.

**Root cause (both the grid-card and overlay double-preview symptoms):** `.card-thumb`,
`.card-video`, and `.overlay-video` in `style.css` each had an unconditional `display: block`
rule. Since `[hidden] { display: none }` (browser default stylesheet) has the same CSS
specificity as those author class rules, the *author* rule silently won and JS setting
`element.hidden = true` had no visual effect — the video pane stayed rendered underneath/next to
the image compare pane. Fixed by adding `[hidden] { display: none; }` overrides for each of the
three selectors (the codebase already used this exact pattern correctly for `.opt-group[hidden]`
— just hadn't been applied to these three).

**Second, independent bug:** the pre-compress queue thumbnail used an `<img>` tag for every
queued file, including video — an `<img>` can't decode a video blob URL, so video files showed a
broken/blank thumbnail. Fixed by rendering a muted `<video preload="metadata">` for video files
instead, seeking to `currentTime = 0.1` on `loadeddata` since Chrome doesn't reliably paint frame
0 without a nudge.

Also cleaned up along the way: closing the overlay now pauses the video (previously kept playing
audibly in the background after close), and switching from a video overlay to an image overlay
now calls `.load()` on the video element so the previously-decoded frame doesn't linger visually
even after it's hidden.

### 2026-07-09 — one-off brand skin, then made branding env-configurable

Did a one-off visual rebrand to match a specific company's marketing site (sampled real brand
colors and fonts from the live site via a headless-browser session rather than guessing, since a
plain curl/WebFetch got blocked by the site's bot protection).
That one-off skin (a two-tone wordmark, a specific accent color pair, a specific font stack) is
no longer hardcoded in this repo - see the later entry below.
Also fixed several em dashes in user-facing copy (tagline, option help text, a few app.js status
strings) to plain dashes per a standing writing-style preference - cosmetic, no behavior change.

Verified via a real Playwright-driven session: uploaded, compressed, and opened both overlays,
confirmed no console/page errors and correct colors. One false alarm along the way: a scripted
`page.click()` on a video card timed out opening the overlay - traced to Chromium's native
`<video controls>` "big play button" not bubbling a click to ancestors when the click lands
exactly on it, not a real regression (confirmed by dispatching a real click on the card's text
instead, and by a programmatic `.click()` call, both of which opened the overlay correctly).
Worth remembering for any future e2e work: don't `page.click()` dead-center on a `<video>`
thumbnail; target text/body elements instead.

### 2026-07-09 (later) — de-branded for open-source release, branding made env-configurable

This project is being published as a public, generic open-source tool, so anything tying it to a
specific company or client had to come out first (see the audit note under "Known limitations"
below for what was found and removed).
Rather than leave the visual identity hardcoded again after removing the one-off skin above,
branding is now driven entirely by optional environment variables read server-side and exposed
via `GET /api/config`: `BRAND_NAME`, `BRAND_TAGLINE`, `BRAND_ACCENT_COLOR`, `BRAND_HIGHLIGHT_COLOR`.
Unset, the app ships with a neutral generic identity ("Image Resizer", neutral blue).
Any fork - including a re-skinned internal deployment - can change its look via `.env` alone,
with zero code changes and nothing brand-specific ever committed to source control.

## Known limitations / open follow-ups

- **Sanitized for open-source release (2026-07-09):** this file previously named a specific
  real client and referenced that client's proprietary files by path, and an earlier entry above
  named the specific company this tool was built for and rebranded to match.
  Both have been removed/genericized so this repo can be published publicly without tying it to
  either the company or any of its clients.
  If you're reading this as the internal/company maintainer: nothing about the app's actual
  behavior changed, only this narrative log and the (now env-configurable, see above) branding.
- TIFF input likely already works (sharp handles it natively and the file input accepts
  `image/*`) but is unverified against real proprietary files, which weren't safe to test with
  outside their owner's sign-off.
- RAW image input would need a separate converter; not implemented.
- AVIF output is out of scope so far.
- Optional Microsoft Entra ID (Azure AD) SSO login is available (env-gated, off by default - see
  the auth section once implemented) as an alternative to running with no auth at all.
- The Playwright `--e2e` driver only covers images.
  Its `#results .card .stats` selector is stale and doesn't match the current DOM
  (`.card-sizes` is the real class) — this predates the video work and should be fixed before
  extending e2e coverage to video.
- Video size targeting is best-effort (~±5%), not a hard guarantee like images — this is a
  deliberate, permanent architectural tradeoff, not a bug to eventually fix.
- A server restart between compressing a video and clicking its download link loses the file
  (the download registry is in-memory only) — accepted for an internal tool.
- Settings UX follow-ups noted above (presets, live preview, real video progress percentage) are
  intentionally not done yet.

## How to verify a change

```bash
node .claude/skills/run-image-resizer/driver.mjs          # smoke: image + video compress, asserts target
node .claude/skills/run-image-resizer/driver.mjs --e2e    # browser flow + screenshot (images only)
npm start                                                  # manual check at http://localhost:3210
```

For anything touching video playback or the results display, verify against a real running
browser session (upload, compress, click play, open the compare overlay) rather than trusting a
headless screenshot alone — headless Chromium has been observed to not paint a `<video poster>`
in `page.screenshot()` even when everything is correctly wired, which can look like a bug when
it isn't.
