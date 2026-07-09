'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

// ── constants ─────────────────────────────────────────────────────────────────
const CONCURRENCY = 5;

// ── state ─────────────────────────────────────────────────────────────────────
let queueSeq = 0;
const state = {
  queue:     [],   // {id, file, previewUrl, status}
  downloads: [],   // {name, blob} — for ZIP
};
let config = { defaultTargetKB: 500, maxFileMB: 25, maxFiles: 100, defaultVideoTargetMB: 50, maxVideoMB: 500 };

// stores per-card data for overlay; keyed by card element
const cardData = new WeakMap();

// PERF-06: map from queue item id → row element for surgical DOM updates
const queueRowMap = new Map();

// ── element refs ──────────────────────────────────────────────────────────────
const els = {
  dropzone:      $('#dropzone'),
  fileInput:     $('#fileInput'),
  browseBtn:     $('#browseBtn'),
  queueList:     $('#queueList'),
  queueCount:    $('#queueCount'),
  clearBtn:      $('#clearBtn'),
  compressBtn:   $('#compressBtn'),
  zipBtn:        $('#zipBtn'),
  progressWrap:  $('#progressWrap'),
  progressFill:  $('#progressFill'),
  progressText:  $('#progressText'),
  progressCount: $('#progressCount'),
  error:         $('#error'),
  results:       $('#results'),
  resultsHeader: $('#resultsHeader'),
  resultsTitle:  $('#resultsTitle'),
  resultsSummary:$('#resultsSummary'),
  cardTpl:       $('#cardTpl'),
  batchLimit:    $('#batchLimit'),
  targetKB:      $('#targetKB'),
  videoTargetMB: $('#videoTargetMB'),
  isBanner:      $('#isBanner'),
  minWidth:      $('#minWidth'),
  minHeight:     $('#minHeight'),
  formatsHint:   $('#formatsHint'),
  overlay:       $('#overlay'),
  imageSettings: $('#imageSettings'),
  videoSettings: $('#videoSettings'),
};

// ── helpers ───────────────────────────────────────────────────────────────────
const fmtKB = (b) => (b / 1024).toFixed(b < 10 * 1024 ? 1 : 0) + ' KB';
const pct   = (a, b) => a > 0 ? Math.round((1 - b / a) * 100) : 0;

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden      = !msg;
}

function batchLimit() {
  return parseInt(els.batchLimit.value, 10) || config.maxFiles;
}

// PERF-10: single Uint8Array.from call — no char-by-char loop
function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = head.match(/data:([^;]+)/)[1];
  return new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: mime });
}

function extFor(f) { return f === 'jpeg' ? 'jpg' : f; }
function outName(name, fmt) {
  const stem = name.replace(/\.[^.]+$/, '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return (stem || 'image') + '.' + extFor(fmt);
}

// ── queue ─────────────────────────────────────────────────────────────────────
function addFiles(fileList) {
  showError('');
  const limit = batchLimit();
  for (const f of Array.from(fileList)) {
    if (state.queue.length >= limit) {
      showError(`Limit is ${limit} files - adjust "Max files" in options to add more.`);
      break;
    }
    state.queue.push({ id: ++queueSeq, file: f, previewUrl: URL.createObjectURL(f), status: 'pending' });
  }
  renderQueue();
  refreshActions();
}

function removeFromQueue(id) {
  const idx = state.queue.findIndex((q) => q.id === id);
  if (idx === -1) return;
  URL.revokeObjectURL(state.queue[idx].previewUrl);
  state.queue.splice(idx, 1);
  renderQueue();
  refreshActions();
}

// SEC-08: build status element without innerHTML — avoids XSS via crafted filenames
function buildStatusEl(status, id) {
  if (status === 'done') {
    const s = document.createElement('span');
    s.className = 'qi-status qi-done';
    s.textContent = '✓';
    return s;
  }
  if (status === 'error') {
    const s = document.createElement('span');
    s.className = 'qi-status qi-err';
    s.textContent = '✕';
    return s;
  }
  if (status === 'compressing') {
    const s = document.createElement('span');
    s.className = 'qi-status qi-spin';
    return s;
  }
  // pending — remove button
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'qi-remove';
  btn.setAttribute('aria-label', 'Remove');
  btn.textContent = '✕';
  btn.addEventListener('click', () => removeFromQueue(id));
  return btn;
}

function buildQueueRow(item) {
  const row = document.createElement('div');
  row.className = 'qi qi--' + item.status;

  // An <img> can't decode a video blob URL — it just shows a broken-image
  // icon. Video files get a muted <video> thumb instead so the browser can
  // actually paint a frame.
  const isVideo = item.file.type.startsWith('video/');
  const thumb = document.createElement(isVideo ? 'video' : 'img');
  thumb.className = 'qi-thumb';
  if (isVideo) {
    thumb.muted = true;
    thumb.playsInline = true;
    thumb.preload = 'metadata';
    // Chrome doesn't always paint frame 0 on load — nudging currentTime
    // forces a decode/paint.
    thumb.addEventListener('loadeddata', () => { try { thumb.currentTime = 0.1; } catch { /* ignore */ } }, { once: true });
  } else {
    thumb.alt = '';
  }
  thumb.src = item.previewUrl;                // safe: object URL we created

  const nameSpan = document.createElement('span');
  nameSpan.className = 'qi-name';
  nameSpan.title = item.file.name;            // .title assignment is safe
  nameSpan.textContent = item.file.name;      // textContent never executes HTML

  const sizeSpan = document.createElement('span');
  sizeSpan.className = 'qi-size';
  sizeSpan.textContent = fmtKB(item.file.size);

  row.append(thumb, nameSpan, sizeSpan, buildStatusEl(item.status, item.id));
  return row;
}

// Show only the settings relevant to what's actually queued (images vs.
// video controls are unrelated to each other and showing both regardless
// of what's queued was confusing). Both show when the queue is empty.
function updateSettingsVisibility() {
  if (!state.queue.length) {
    els.imageSettings.hidden = false;
    els.videoSettings.hidden = false;
    return;
  }
  let hasImage = false;
  let hasVideo = false;
  for (const q of state.queue) {
    if (q.file.type.startsWith('video/')) hasVideo = true;
    else hasImage = true; // unknown/empty type defaults to the image bucket
  }
  els.imageSettings.hidden = !hasImage;
  els.videoSettings.hidden = !hasVideo;
}

// PERF-06: surgical DOM updates — only add/remove changed rows, never rebuild the list
function renderQueue() {
  updateSettingsVisibility();
  if (!state.queue.length) {
    els.queueList.hidden = true;
    els.dropzone.classList.remove('has-files');
    queueRowMap.forEach((el) => el.remove());
    queueRowMap.clear();
    return;
  }
  els.queueList.hidden = false;
  els.dropzone.classList.add('has-files');

  // Remove rows for items that left the queue
  const currentIds = new Set(state.queue.map((q) => q.id));
  const toDelete = [];
  for (const id of queueRowMap.keys()) {
    if (!currentIds.has(id)) toDelete.push(id);
  }
  for (const id of toDelete) {
    queueRowMap.get(id).remove();
    queueRowMap.delete(id);
  }

  // Add rows for newly queued items (append keeps natural order)
  for (const item of state.queue) {
    if (!queueRowMap.has(item.id)) {
      const row = buildQueueRow(item);
      els.queueList.appendChild(row);
      queueRowMap.set(item.id, row);
    }
  }
}

// PERF-06: patch only the status cell — no full list rebuild per status change
function setQueueItemStatus(id, status) {
  const item = state.queue.find((q) => q.id === id);
  if (!item) return;
  item.status = status;
  const row = queueRowMap.get(id);
  if (!row) return;
  row.className = 'qi qi--' + status;
  row.lastElementChild.replaceWith(buildStatusEl(status, id));
}

function refreshActions() {
  const n = state.queue.length;
  els.queueCount.textContent   = n ? `${n} file${n > 1 ? 's' : ''} selected` : '';
  els.compressBtn.disabled = n === 0;
  els.clearBtn.disabled    = n === 0;
}

// ── progress ──────────────────────────────────────────────────────────────────
function showProgress(done, total, hasVideo) {
  els.progressWrap.hidden       = false;
  els.progressFill.style.width  = total > 0 ? (done / total * 100) + '%' : '0%';
  els.progressCount.textContent = `${done} / ${total}`;
  if (done === total) {
    els.progressText.textContent = 'Done';
  } else if (hasVideo) {
    els.progressText.textContent = `Compressing… (${total - done} remaining) - video takes longer and is best-effort`;
  } else {
    els.progressText.textContent = `Compressing… (${total - done} remaining)`;
  }
}

function hideProgress() {
  els.progressFill.style.width = '100%';
  els.progressText.textContent = 'Done';
  setTimeout(() => {
    els.progressWrap.hidden      = true;
    els.progressFill.style.width = '0%';
  }, 700);
}

// ── compression (concurrent) ──────────────────────────────────────────────────
async function compress() {
  showError('');
  els.results.innerHTML    = '';
  els.resultsHeader.hidden = true;
  state.downloads          = [];
  els.zipBtn.hidden        = true;

  const items         = [...state.queue];
  const total         = items.length;
  const hasVideo      = items.some((q) => q.file.type.startsWith('video/'));
  const format        = document.querySelector('input[name="format"]:checked').value;
  const targetKB      = parseInt(els.targetKB.value, 10) || config.defaultTargetKB;
  const videoTargetMB = parseInt(els.videoTargetMB.value, 10) || config.defaultVideoTargetMB;

  els.compressBtn.disabled     = true;
  els.clearBtn.disabled        = true;
  els.compressBtn.textContent  = 'Compressing…';
  showProgress(0, total, hasVideo);

  let doneCount  = 0;
  let origTotal  = 0;
  let outTotal   = 0;
  let nextIdx    = 0;          // shared work-stealing index (safe: JS is single-threaded)

  const opts = {
    format,
    targetKB:  String(targetKB),
    isBanner:  els.isBanner.checked  ? 'true' : 'false',
    minWidth:  String(parseInt(els.minWidth.value,  10) || 0),
    minHeight: String(parseInt(els.minHeight.value, 10) || 0),
    // Ignored server-side for images, same pattern as `format` being sent
    // but ignored for video.
    videoTargetMB: String(videoTargetMB),
  };

  async function worker() {
    while (nextIdx < items.length) {
      const item = items[nextIdx++];
      setQueueItemStatus(item.id, 'compressing');

      const fd = new FormData();
      for (const [k, v] of Object.entries(opts)) fd.append(k, v);
      fd.append('files', item.file, item.file.name);

      try {
        const resp = await fetch('/api/compress', { method: 'POST', body: fd });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `Server error ${resp.status}`);
        const r = data.results[0];
        renderCard(r, item);
        setQueueItemStatus(item.id, r.error ? 'error' : 'done');
        if (!r.error) {
          origTotal += r.originalSize || 0;
          const outSize = r.conflict ? r.keepResolution.size : (r.result?.size || 0);
          outTotal  += outSize;
        }
      } catch (err) {
        renderErrorCard(item.file.name, err.message);
        setQueueItemStatus(item.id, 'error');
      }

      doneCount++;
      showProgress(doneCount, total, hasVideo);
    }
  }

  // Launch up to CONCURRENCY workers
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));

  hideProgress();

  els.resultsHeader.hidden  = false;
  els.resultsTitle.textContent = `Results - ${total} file${total > 1 ? 's' : ''}`;
  if (origTotal > 0) {
    els.resultsSummary.textContent =
      `${fmtKB(origTotal)} → ${fmtKB(outTotal)}  ·  ${pct(origTotal, outTotal)}% saved`;
  }

  if (state.downloads.length > 1) els.zipBtn.hidden = false;
  els.compressBtn.disabled    = false;
  els.clearBtn.disabled       = false;
  els.compressBtn.textContent = 'Compress';
}

// ── grid card rendering ────────────────────────────────────────────────────────
function renderErrorCard(name, msg) {
  const node = els.cardTpl.content.firstElementChild.cloneNode(true);
  node.classList.add('card--error');
  $('.fname',      node).textContent = name;
  $('.card-sizes', node).textContent = 'Error: ' + msg;
  $('.badge',      node).remove();
  els.results.appendChild(node);
}

function renderCard(r, queueItem) {
  if (r.error) { renderErrorCard(r.name, r.error); return; }

  const node       = els.cardTpl.content.firstElementChild.cloneNode(true);
  const thumb      = $('.card-thumb', node);
  const video      = $('.card-video', node);
  const badge      = $('.badge',      node);
  const fname      = $('.fname',      node);
  const sizesText  = $('.card-sizes-text', node);
  const formatChip = $('.card-format', node);

  // Always show the ACTUAL output name/format, not the originally uploaded
  // one — a webp converted to png must read "photo.png", not "photo.webp".
  const dlName = outName(r.name, r.format);
  fname.textContent = dlName;
  fname.title = `${r.name} → ${dlName}`;
  formatChip.textContent = r.format.toUpperCase();

  const isVideo  = r.format === 'mp4';
  // Determine primary payload for thumbnail + initial download
  const payload  = r.conflict ? r.keepResolution : r.result;
  if (isVideo) {
    thumb.hidden = true;
    video.hidden = false;
    video.src    = payload.downloadUrl;
    if (payload.posterDataUrl) video.poster = payload.posterDataUrl;
  } else {
    thumb.src = payload.dataUrl;
  }

  if (r.passthrough) {
    badge.textContent = 'Already fits';
    badge.classList.add('badge--pass');
  } else if (r.conflict) {
    badge.textContent = '⚠ Choose';
    badge.classList.add('over');
  } else {
    const saved = pct(r.originalSize, payload.size);
    badge.textContent = saved > 0 ? saved + '% smaller' : 'No change';
    if (payload.size > r.target || payload.overTarget) badge.classList.add('over');
  }

  sizesText.textContent = `${fmtKB(r.originalSize)} → ${fmtKB(payload.size)}`;

  // Store data for overlay. Blob is always a Promise — dataUrlToBlob for
  // images resolves synchronously, video fetches its download URL.
  const blob   = isVideo
    ? fetch(payload.downloadUrl).then((res) => res.blob())
    : Promise.resolve(dataUrlToBlob(payload.dataUrl));
  const entry  = { name: dlName, blob };
  state.downloads.push(entry);
  cardData.set(node, { r, queueItem, entry });

  node.addEventListener('click', () => openOverlay(node));
  node.style.cursor = 'pointer';
  node.title = 'Click to compare before / after';

  els.results.appendChild(node);
}

// ── overlay ───────────────────────────────────────────────────────────────────
function openOverlay(card) {
  const data = cardData.get(card);
  if (!data) return;
  const { r, queueItem, entry } = data;
  const ov = els.overlay;

  $('.overlay-fname',    ov).textContent = entry.name;
  $('.overlay-stats',    ov).innerHTML   = '';
  $('.overlay-conflict', ov).hidden      = true;
  $('.overlay-actions',  ov).innerHTML   = '';

  // Fresh compare stage (cloning removes stale event listeners)
  const oldStage = $('.compare-stage', ov);
  const stage    = oldStage.cloneNode(true);
  oldStage.replaceWith(stage);

  const overlayVideo = $('.overlay-video', ov);
  const overlayCompare = $('.overlay-compare', ov);

  if (r.format === 'mp4') {
    // No before/after slider for video in this pass — just playback + stats.
    overlayCompare.hidden = true;
    overlayVideo.hidden   = false;
    overlayVideo.src      = r.result.downloadUrl;
    if (r.result.posterDataUrl) overlayVideo.poster = r.result.posterDataUrl;
    setOverlayStats(ov, r, r.result);
    addOverlayDownload(ov, entry.blob, entry.name);
    ov.hidden = false;
    document.body.classList.add('overlay-open');
    ov.focus();
    return;
  }
  overlayCompare.hidden = false;
  overlayVideo.hidden   = true;
  overlayVideo.removeAttribute('src');
  overlayVideo.load();   // drop the previously decoded frame, not just the src attribute

  const before = $('.img-before', stage);
  const after  = $('.img-after',  stage);
  const slider = $('.slider',     ov);
  before.src = queueItem.previewUrl;

  if (r.conflict) {
    renderConflictInOverlay(ov, stage, slider, r, entry);
  } else {
    after.src = r.result.dataUrl;
    setupCompare(stage, slider);
    setOverlayStats(ov, r, r.result);
    addOverlayDownload(ov, entry.blob, entry.name);
  }

  ov.hidden = false;
  document.body.classList.add('overlay-open');
  ov.focus();
}

function closeOverlay() {
  els.overlay.hidden = true;
  document.body.classList.remove('overlay-open');
  $('.overlay-video', els.overlay).pause();   // don't keep playing/audible once closed
}

function setupCompare(stage, slider) {
  const after  = $('.img-after',      stage);
  const handle = $('.divider-handle', stage);
  let dragging = false;

  function setPos(v) {
    v = Math.max(0, Math.min(100, v));
    after.style.clipPath = `inset(0 ${100 - v}% 0 0)`;
    handle.style.left    = v + '%';
    slider.value         = v;
  }
  slider.value  = 50;
  slider.oninput = () => setPos(+slider.value);
  setPos(50);

  stage.addEventListener('mousedown',  (e) => { dragging = true; e.preventDefault(); });
  stage.addEventListener('touchstart', ()  => { dragging = true; }, { passive: true });
  stage.addEventListener('mousemove',  (e) => {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    setPos((e.clientX - rect.left) / rect.width * 100);
  });
  stage.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    const rect = stage.getBoundingClientRect();
    setPos((e.touches[0].clientX - rect.left) / rect.width * 100);
  }, { passive: true });
  stage.addEventListener('mouseup',    () => { dragging = false; });
  stage.addEventListener('mouseleave', () => { dragging = false; });
  stage.addEventListener('touchend',   () => { dragging = false; });
}

function setOverlayStats(ov, r, payload) {
  const conv  = r.convertedFrom ? ` · from ${r.convertedFrom.toUpperCase()}` : '';
  const extra = r.passthrough   ? ' · <em>already within target - no re-encode</em>' :
                payload.overTarget ? ' · <em>couldn’t fully reach target</em>' : '';
  const bitrate = payload.videoBitrateKbps != null
    ? ` · ${payload.videoBitrateKbps}kbps video${payload.audioBitrateKbps ? ` + ${payload.audioBitrateKbps}kbps audio` : ' (no audio)'}`
    : '';
  $('.overlay-stats', ov).innerHTML =
    `<span>Before: <b>${r.originalWidth}×${r.originalHeight}</b> · <b>${fmtKB(r.originalSize)}</b>${conv}</span>` +
    `<span>After: <b>${payload.width}×${payload.height}</b> · <b>${fmtKB(payload.size)}</b> · ${r.format.toUpperCase()}${payload.quality != null ? ' q' + payload.quality : ''}${bitrate}${extra}</span>`;
}

function addOverlayDownload(ov, blobPromise, name) {
  const a = Object.assign(document.createElement('a'), {
    className: 'dl', textContent: 'Download', download: name,
  });
  $('.overlay-actions', ov).appendChild(a);
  Promise.resolve(blobPromise).then((blob) => { a.href = URL.createObjectURL(blob); });
}

function renderConflictInOverlay(ov, stage, slider, r, entry) {
  const after     = $('.img-after', stage);
  const conflictEl = $('.overlay-conflict', ov);
  conflictEl.hidden = false;
  const targetKB = Math.round(r.target / 1024);

  conflictEl.innerHTML =
    `<h4>Can't reach ${targetKB} KB without dropping below your minimum resolution</h4>` +
    `<p>Pick which constraint wins:</p>` +
    `<div class="conflict-choices">` +
      `<button type="button" class="choice active" data-which="keep">` +
        `<span class="ctitle">Keep resolution</span>` +
        `<span class="cmeta">${r.keepResolution.width}×${r.keepResolution.height} · ${fmtKB(r.keepResolution.size)}</span>` +
      `</button>` +
      `<button type="button" class="choice" data-which="hit">` +
        `<span class="ctitle">Hit ${targetKB} KB</span>` +
        `<span class="cmeta">${r.hitTarget.width}×${r.hitTarget.height} · ${fmtKB(r.hitTarget.size)}</span>` +
      `</button>` +
    `</div>`;

  function choose(which) {
    const payload = which === 'keep' ? r.keepResolution : r.hitTarget;
    after.src = payload.dataUrl;
    setOverlayStats(ov, r, payload);
    entry.blob = Promise.resolve(dataUrlToBlob(payload.dataUrl));
    entry.name = outName(r.name, r.format);
    $('.overlay-actions', ov).innerHTML = '';
    addOverlayDownload(ov, entry.blob, entry.name);
    conflictEl.querySelectorAll('.choice').forEach((b) =>
      b.classList.toggle('active', b.dataset.which === which));
  }

  conflictEl.querySelectorAll('.choice').forEach((b) =>
    b.addEventListener('click', () => choose(b.dataset.which)));

  after.src = r.keepResolution.dataUrl;
  setupCompare(stage, slider);
  choose('keep');
}

// ── ZIP ───────────────────────────────────────────────────────────────────────
async function downloadZip() {
  if (!state.downloads.length || typeof fflate === 'undefined') return;
  const entries = {};
  const used    = {};
  for (const d of state.downloads) {
    let name = d.name;
    if (used[name]) name = name.replace(/(\.[^.]+)$/, `-${used[d.name]}$1`);
    used[d.name] = (used[d.name] || 0) + 1;
    entries[name] = new Uint8Array(await (await d.blob).arrayBuffer());
  }
  const blob = new Blob([fflate.zipSync(entries, { level: 0 })], { type: 'application/zip' });
  Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: 'compressed-images.zip',
  }).click();
}

// ── clear ─────────────────────────────────────────────────────────────────────
function clearAll() {
  state.queue.forEach((q) => URL.revokeObjectURL(q.previewUrl));
  state.queue          = [];
  state.downloads      = [];
  // Don't clear queueRowMap here — renderQueue() below removes each row's
  // element from the DOM before clearing the map. Clearing it early orphans
  // the DOM rows (they stay hidden-but-present, then reappear once the
  // queue list is un-hidden by the next addFiles()).
  els.results.innerHTML    = '';
  els.resultsHeader.hidden = true;
  els.zipBtn.hidden        = true;
  els.fileInput.value      = '';
  showError('');
  renderQueue();
  refreshActions();
}

// ── events ────────────────────────────────────────────────────────────────────
els.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); els.fileInput.click(); });
els.dropzone.addEventListener('click',  () => els.fileInput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});
els.fileInput.addEventListener('change', (e) => addFiles(e.target.files));

['dragenter','dragover'].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('drag'); }));
['dragleave','drop'].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove('drag'); }));
els.dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
});

els.compressBtn.addEventListener('click', compress);
els.clearBtn.addEventListener('click',    clearAll);
els.zipBtn.addEventListener('click',      downloadZip);

// Overlay close: button, backdrop click, Escape key
$('#overlayClose').addEventListener('click', closeOverlay);
$('.overlay-bg', els.overlay).addEventListener('click', closeOverlay);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.overlay.hidden) closeOverlay();
});

// ── branding (env-driven server-side, applied client-side at runtime) ─────────
// Darkens a #rrggbb hex color for the button hover state, so a custom
// BRAND_ACCENT_COLOR still gets a matching hover shade without needing a
// second env var just for that.
function darken(hex, factor) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return hex;
  const [r, g, b] = m.slice(1).map((h) => Math.round(parseInt(h, 16) * factor));
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function applyBrand(brand) {
  if (!brand) return;
  document.title = brand.name;
  const nameEl = $('#brandName');
  const tagEl  = $('#brandTagline');
  if (nameEl) nameEl.textContent = brand.name;
  if (tagEl && brand.tagline) tagEl.textContent = brand.tagline;
  const root = document.documentElement.style;
  if (brand.accent) {
    root.setProperty('--accent', brand.accent);
    root.setProperty('--accent-2', darken(brand.accent, 0.8));
  }
  if (brand.highlight) root.setProperty('--highlight', brand.highlight);
}

// ── init ──────────────────────────────────────────────────────────────────────
fetch('/api/config').then((r) => r.json()).then((c) => {
  config = c;
  applyBrand(c.brand);
  if (c.authEnabled && c.user) {
    $('#authUser').textContent = `Signed in as ${c.user.name || c.user.username}`;
    $('#authStatus').hidden = false;
  }
  els.targetKB.value = c.defaultTargetKB;
  els.videoTargetMB.value = c.defaultVideoTargetMB;
  els.formatsHint.textContent =
    `JPG · PNG · WebP · GIF · AVIF · BMP · HEIC (max ${c.maxFileMB} MB) · ` +
    `MP4 · MOV · WebM · AVI, always converted to MP4 (max ${c.maxVideoMB} MB)`;

  const steps       = [5, 10, 20, 50, 100].filter((n) => n <= c.maxFiles);
  if (!steps.includes(c.maxFiles)) steps.push(c.maxFiles);
  const defaultStep = steps.reduce((p, n) => n <= 20 ? n : p);
  steps.forEach((n) => {
    els.batchLimit.appendChild(Object.assign(document.createElement('option'), {
      value: n, textContent: n + (n === c.maxFiles ? ' (max)' : ''), selected: n === defaultStep,
    }));
  });
}).catch(() => {});
