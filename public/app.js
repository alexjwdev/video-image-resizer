'use strict';

const $ = (sel, root = document) => root.querySelector(sel);

// ── constants ─────────────────────────────────────────────────────────────────
const CONCURRENCY = 5;

// Curated starting points so first-time users get sane settings without
// having to know what to change - selecting one fills the fields below;
// hand-editing any of them afterward switches the selector to Custom.
const PRESETS = [
  { id: 'balanced', label: 'Balanced',     format: 'jpeg', targetKB: 500,  isBanner: false, minWidth: 0, minHeight: 0 },
  { id: 'small',    label: 'Small File',   format: 'jpeg', targetKB: 150,  isBanner: false, minWidth: 0, minHeight: 0 },
  { id: 'banner',   label: 'Banner / Ad',  format: 'jpeg', targetKB: 800,  isBanner: true,  minWidth: 0, minHeight: 0 },
  { id: 'quality',  label: 'High Quality', format: 'webp', targetKB: 1200, isBanner: false, minWidth: 0, minHeight: 0 },
];
const PROFILE_KEY = 'resizer.profile';

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
  editAllBtn:    $('#editAllBtn'),
  editOverlay:   $('#editOverlay'),
  themeToggle:   $('#themeToggle'),
  profileSelect: $('#profileSelect'),
  activeSettingsPill: $('#activeSettingsPill'),
};

// ── helpers ───────────────────────────────────────────────────────────────────
const fmtKB = (b) => (b / 1024).toFixed(b < 10 * 1024 ? 1 : 0) + ' KB';
const pct   = (a, b) => a > 0 ? Math.round((1 - b / a) * 100) : 0;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// The pre-compress editor draws into a <canvas> and can only crop images the
// browser can decode via <img>. GIF is excluded because cropping flattens the
// animation; HEIC/HEIF (including the -sequence burst/Live-Photo variants)
// because most browsers can't decode them in an <img>.
const EDIT_BLOCK = /^image\/(gif|hei[cf](-sequence)?)$/i;
function isEditable(file) {
  return file.type.startsWith('image/') && !EDIT_BLOCK.test(file.type);
}

// An edit only matters if it actually changes pixels. 'free'/'orig' aspect
// strings never match the ratio regex, so they alone are no-ops (as on the
// server). Mirrors server.js parseEdit's "no-op => null" rule.
const ASPECT_RE = /^\d{1,4}:\d{1,4}$/;
function editIsMeaningful(edit) {
  if (!edit) return false;
  return !!(edit.crop || edit.rotate || edit.flipH || edit.flipV ||
    (!edit.crop && edit.aspectStr && ASPECT_RE.test(edit.aspectStr)));
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.hidden      = !msg;
}

function batchLimit() {
  return parseInt(els.batchLimit.value, 10) || config.maxFiles;
}

// ── settings profiles ────────────────────────────────────────────────────────
function currentFormat() {
  return document.querySelector('input[name="format"]:checked').value;
}

function fieldsMatchPreset(preset) {
  return currentFormat() === preset.format &&
    (parseInt(els.targetKB.value, 10)  || 0) === preset.targetKB &&
    els.isBanner.checked                     === preset.isBanner &&
    (parseInt(els.minWidth.value, 10)  || 0) === (preset.minWidth  || 0) &&
    (parseInt(els.minHeight.value, 10) || 0) === (preset.minHeight || 0);
}

function updateSettingsPill() {
  const preset = PRESETS.find((p) => p.id === els.profileSelect.value);
  const label  = preset ? preset.label : 'Custom';
  const targetKB = parseInt(els.targetKB.value, 10) || config.defaultTargetKB;
  els.activeSettingsPill.textContent =
    `${label} · ${targetKB}KB · ${currentFormat().toUpperCase()}${els.isBanner.checked ? ' · Banner' : ''}`;
}

// Applying a preset writes values via .value/.checked, which never fire
// 'input'/'change' - safe to call during page load without falsely tripping
// markCustomIfChanged() below.
function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  const radio = document.querySelector(`input[name="format"][value="${preset.format}"]`);
  if (radio) radio.checked = true;
  els.targetKB.value   = preset.targetKB;
  els.isBanner.checked = preset.isBanner;
  els.minWidth.value   = preset.minWidth  || '';
  els.minHeight.value  = preset.minHeight || '';
  updateSettingsPill();
}

function selectProfile(id) {
  els.profileSelect.value = id;
  applyPreset(id);
  localStorage.setItem(PROFILE_KEY, id);
}

// Any manual edit to a field a preset controls falls back to "Custom" -
// the pill (and the selector) always reflect what will actually be sent.
function markCustomIfChanged() {
  const active = PRESETS.find((p) => p.id === els.profileSelect.value);
  if (active && !fieldsMatchPreset(active)) els.profileSelect.value = 'custom';
  updateSettingsPill();
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
    state.queue.push({ id: ++queueSeq, file: f, previewUrl: URL.createObjectURL(f), status: 'pending', edit: null });
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

  // Indeterminate per-row progress (visible only while compressing, purely
  // via CSS on .qi--compressing). Appended first, never last, so
  // setQueueItemStatus's `row.lastElementChild.replaceWith(...)` keeps
  // targeting the status cell and never clobbers this element.
  const progress = document.createElement('div');
  progress.className = 'qi-progress';
  row.appendChild(progress);

  // An <img> can't decode a video blob URL - it just shows a broken-image
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

  // Editable images get an "Edit" button + an "edited" chip; video/GIF/HEIC
  // don't (see isEditable), so their rows keep the original layout.
  if (isEditable(item.file)) {
    const chip = document.createElement('span');
    chip.className = 'qi-chip';
    chip.textContent = 'edited';
    chip.hidden = !editIsMeaningful(item.edit);

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'qi-edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openEditor(item, false));

    row.append(thumb, nameSpan, chip, sizeSpan, editBtn, buildStatusEl(item.status, item.id));
  } else {
    row.append(thumb, nameSpan, sizeSpan, buildStatusEl(item.status, item.id));
  }
  return row;
}

// After the editor writes to item.edit, toggle just that row's "edited" chip
// (renderQueue does surgical add/remove only, never content updates).
function refreshRowEdit(id) {
  const item = state.queue.find((q) => q.id === id);
  const row  = queueRowMap.get(id);
  if (!item || !row) return;
  const chip = row.querySelector('.qi-chip');
  if (chip) chip.hidden = !editIsMeaningful(item.edit);
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
  els.editAllBtn.disabled  = !state.queue.some((q) => isEditable(q.file));
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
      // Per-file edit is additive - global opts stay batch-wide, and the wire
      // is already one file per request, so no protocol change is needed.
      if (isEditable(item.file)) appendEdit(fd, item.edit);

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

// ── pre-compress editor ─────────────────────────────────────────────────────
//
// Client-side crop/rotate/flip/focus editor. It sends only GEOMETRY to the
// server (never re-encoded pixels), matching the existing architecture. The
// canvas is drawn in the SAME "baked" pixel space the server crops in: EXIF
// auto-orient (the browser does this for <img>) + user rotate/flip. So a crop
// rectangle read off the canvas maps 1:1 to the server's extract() rectangle.
// See lib/compress.js applyEdit()'s two-stage bake for the server side.

// Live editor state (one modal, reused across opens).
const ed = {
  item: null, applyAll: false, img: null,
  natW: 0, natH: 0,            // oriented natural dims (browser applies EXIF)
  bakedW: 0, bakedH: 0,        // dims after user rotate (90/270 swap)
  rotate: 0, flipH: false, flipV: false,
  aspect: 'free', ar: null, aspectStr: 'free',
  smartCrop: 'attention',
  crop: null,                  // {x,y,w,h} in baked px (scope 'one')
  focus: null,                 // {x,y} normalized 0..1 baked (scope 'all')
  zoom: 1, k: 1,               // k = css px per baked px (display scale)
  drag: null,
};

// Editor element refs, resolved once at setup.
let ee = null;

// Plain-language, example-led hint per aspect preset (shown in one contextual
// line instead of six always-visible descriptions - keeps the panel uncluttered).
const ASPECT_HINTS = {
  free:   'Free - drag out a box to crop to any shape.',
  '1:1':  '1:1 square - avatars, product tiles, Instagram posts.',
  '4:3':  '4:3 - classic photo shape, good for print.',
  '16:9': '16:9 widescreen - slides, video thumbnails, hero banners.',
  orig:   'Original - keep this image\'s current proportions.',
  custom: 'Custom - type your own width : height (e.g. 3 : 2).',
};

// Largest `ar` rectangle that fits w x h (mirrors compress.js coverRect - so
// the on-canvas preview matches what the server actually extracts).
function coverRect(w, h, ar) {
  if (w / h > ar) return { w: Math.round(h * ar), h };
  return { w, h: Math.round(w / ar) };
}

function bakedDims() {
  return (ed.rotate === 90 || ed.rotate === 270)
    ? { w: ed.natH, h: ed.natW }
    : { w: ed.natW, h: ed.natH };
}

function recomputeBaked() {
  const d = bakedDims();
  ed.bakedW = d.w; ed.bakedH = d.h;
  const maxW = 600, maxH = 460;
  // Fit into the stage; allow modest upscaling for tiny images so they're usable.
  ed.k = Math.min(maxW / ed.bakedW, maxH / ed.bakedH, 4);
}

function clampCrop(c) {
  const w = Math.min(Math.max(8, c.w), ed.bakedW);
  const h = Math.min(Math.max(8, c.h), ed.bakedH);
  const x = Math.max(0, Math.min(c.x, ed.bakedW - w));
  const y = Math.max(0, Math.min(c.y, ed.bakedH - h));
  return { x, y, w, h };
}

// Centered, largest crop of the current aspect (null ar = full image).
function defaultCrop() {
  if (!ed.ar) return { x: 0, y: 0, w: ed.bakedW, h: ed.bakedH };
  const { w, h } = coverRect(ed.bakedW, ed.bakedH, ed.ar);
  return { x: Math.round((ed.bakedW - w) / 2), y: Math.round((ed.bakedH - h) / 2), w, h };
}

// Region the server would keep for an aspect + focus cover-crop (apply-to-all
// preview). With no focus the server uses attention/entropy, so this centered
// guess is only indicative - the dims label says "(smart)" in that case.
function previewRegion() {
  const { w: cw, h: ch } = coverRect(ed.bakedW, ed.bakedH, ed.ar);
  const f = ed.focus || { x: 0.5, y: 0.5 };
  const x = Math.max(0, Math.min(Math.round(f.x * ed.bakedW - cw / 2), ed.bakedW - cw));
  const y = Math.max(0, Math.min(Math.round(f.y * ed.bakedH - ch / 2), ed.bakedH - ch));
  return { x, y, w: cw, h: ch };
}

function drawCanvas() {
  const Wc = ed.bakedW * ed.k, Hc = ed.bakedH * ed.k;
  const dpr = window.devicePixelRatio || 1;
  const canvas = ee.canvas;
  canvas.width  = Math.round(Wc * dpr);
  canvas.height = Math.round(Hc * dpr);
  canvas.style.width  = Wc + 'px';
  canvas.style.height = Hc + 'px';
  ee.stage.style.width = Wc + 'px';

  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, Wc, Hc);
  ctx.save();
  ctx.translate(Wc / 2, Hc / 2);
  ctx.rotate(ed.rotate * Math.PI / 180);
  // Transforms compose right-to-left onto the drawn image: scale (flip) first,
  // then rotate - the SAME order the server bakes them (flip then rotate).
  ctx.scale(ed.flipH ? -1 : 1, ed.flipV ? -1 : 1);
  ctx.drawImage(ed.img, -ed.natW * ed.k / 2, -ed.natH * ed.k / 2, ed.natW * ed.k, ed.natH * ed.k);
  ctx.restore();
}

function showRect(c, preview) {
  const el = ee.cropRect;
  el.hidden = false;
  el.classList.toggle('crop-rect--preview', preview);
  el.style.left   = (c.x * ed.k) + 'px';
  el.style.top    = (c.y * ed.k) + 'px';
  el.style.width  = (c.w * ed.k) + 'px';
  el.style.height = (c.h * ed.k) + 'px';
}

function renderOverlay() {
  if (ed.applyAll) {
    ee.focusMarker.hidden = !ed.ar;
    if (ed.ar) {
      showRect(previewRegion(), true);
      const f = ed.focus || { x: 0.5, y: 0.5 };
      ee.focusMarker.style.left = (f.x * ed.bakedW * ed.k) + 'px';
      ee.focusMarker.style.top  = (f.y * ed.bakedH * ed.k) + 'px';
      ee.dims.textContent = `Each image cropped to ${ed.aspectStr}` +
        (ed.focus ? ' at focus point' : ' (smart)');
    } else {
      ee.cropRect.hidden = true;
      ee.dims.textContent = (ed.rotate || ed.flipH || ed.flipV)
        ? 'Rotate / flip applied to all images'
        : 'Pick a ratio to crop all images';
    }
  } else {
    ee.focusMarker.hidden = true;
    if (ed.crop) {
      showRect(ed.crop, false);
      ee.dims.textContent = `${Math.round(ed.crop.w)} × ${Math.round(ed.crop.h)} px`;
    } else {
      ee.cropRect.hidden = true;
      ee.dims.textContent = `${ed.bakedW} × ${ed.bakedH} px (full)`;
    }
  }
}

// zoom (scope 'one', aspect-locked): shrink the crop around its center.
function applyZoom() {
  if (!ed.ar || ed.applyAll) return;
  const base = coverRect(ed.bakedW, ed.bakedH, ed.ar);
  const w = Math.max(8, Math.round(base.w / ed.zoom));
  const h = Math.max(8, Math.round(base.h / ed.zoom));
  const cx = ed.crop ? ed.crop.x + ed.crop.w / 2 : ed.bakedW / 2;
  const cy = ed.crop ? ed.crop.y + ed.crop.h / 2 : ed.bakedH / 2;
  ed.crop = clampCrop({ x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h });
}

// ── editor pointer logic (mirrors setupCompare's drag pattern) ───────────────
function stagePoint(e) {
  const rect = ee.stage.getBoundingClientRect();
  return { bx: (e.clientX - rect.left) / ed.k, by: (e.clientY - rect.top) / ed.k };
}

function onEdPointerDown(e) {
  const { bx, by } = stagePoint(e);
  if (ed.applyAll) {
    if (!ed.ar) return;               // free + apply-to-all has no focus target
    ed.focus = { x: clamp01(bx / ed.bakedW), y: clamp01(by / ed.bakedH) };
    ed.drag = { mode: 'focus' };
  } else {
    const h = e.target && e.target.dataset ? e.target.dataset.h : null;
    if (h && ed.crop) {
      ed.drag = { mode: 'resize', h, start: { ...ed.crop } };
    } else if (ed.crop && bx >= ed.crop.x && bx <= ed.crop.x + ed.crop.w &&
               by >= ed.crop.y && by <= ed.crop.y + ed.crop.h) {
      ed.drag = { mode: 'move', start: { ...ed.crop }, bx, by };
    } else if (ed.ar) {
      // aspect-locked: a click recenters the fixed-size crop on that point
      const c = ed.crop || defaultCrop();
      ed.crop = clampCrop({ x: Math.round(bx - c.w / 2), y: Math.round(by - c.h / 2), w: c.w, h: c.h });
      ed.drag = { mode: 'move', start: { ...ed.crop }, bx, by };
    } else {
      // free: drag out a new rectangle from here
      ed.crop = { x: bx, y: by, w: 8, h: 8 };
      ed.drag = { mode: 'new', bx, by };
    }
  }
  renderOverlay();
  window.addEventListener('pointermove', onEdPointerMove);
  window.addEventListener('pointerup', onEdPointerUp);
  e.preventDefault();
}

function resizeCrop(d, bx, by) {
  const s = d.h, st = d.start;
  let left = st.x, top = st.y, right = st.x + st.w, bottom = st.y + st.h;
  if (s.includes('w')) left = bx;
  if (s.includes('e')) right = bx;
  if (s.includes('n')) top = by;
  if (s.includes('s')) bottom = by;
  let x = Math.min(left, right), y = Math.min(top, bottom);
  let w = Math.max(8, Math.abs(right - left)), h = Math.max(8, Math.abs(bottom - top));

  if (ed.ar) {
    // Keep the ratio, anchored on the edge/corner opposite the dragged handle.
    const anchorX = s.includes('w') ? st.x + st.w : st.x;
    const anchorY = s.includes('n') ? st.y + st.h : st.y;
    if (s === 'n' || s === 's') { w = Math.round(h * ed.ar); x = st.x + (st.w - w) / 2; }
    else                        { h = Math.round(w / ed.ar); }
    if (s.includes('w')) x = anchorX - w; else if (s !== 'n' && s !== 's') x = anchorX;
    if (s === 'e' || s === 'w') y = st.y + (st.h - h) / 2;
    else if (s.includes('n'))   y = anchorY - h; else y = anchorY;
  }
  return clampCrop({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
}

function onEdPointerMove(e) {
  const d = ed.drag;
  if (!d) return;
  const { bx, by } = stagePoint(e);
  if (d.mode === 'focus') {
    ed.focus = { x: clamp01(bx / ed.bakedW), y: clamp01(by / ed.bakedH) };
  } else if (d.mode === 'move') {
    ed.crop = clampCrop({ x: Math.round(d.start.x + (bx - d.bx)), y: Math.round(d.start.y + (by - d.by)), w: d.start.w, h: d.start.h });
  } else if (d.mode === 'new') {
    ed.crop = clampCrop({ x: Math.min(d.bx, bx), y: Math.min(d.by, by), w: Math.abs(bx - d.bx), h: Math.abs(by - d.by) });
  } else if (d.mode === 'resize') {
    ed.crop = resizeCrop(d, bx, by);
  }
  renderOverlay();
}

function onEdPointerUp() {
  ed.drag = null;
  window.removeEventListener('pointermove', onEdPointerMove);
  window.removeEventListener('pointerup', onEdPointerUp);
}

// ── editor control state ─────────────────────────────────────────────────────
function setAspect(val) {
  ed.aspect = val;
  ee.custom.hidden = val !== 'custom';
  if (val === 'free')      { ed.ar = null; ed.aspectStr = 'free'; ed.crop = null; }
  else if (val === 'orig') { ed.ar = ed.bakedW / ed.bakedH; ed.aspectStr = 'orig'; ed.crop = ed.applyAll ? null : defaultCrop(); }
  else if (val === 'custom') {
    const w = parseInt(ee.customW.value, 10), h = parseInt(ee.customH.value, 10);
    if (w > 0 && h > 0) { ed.ar = w / h; ed.aspectStr = `${w}:${h}`; ed.crop = ed.applyAll ? null : defaultCrop(); }
  } else {
    const [w, h] = val.split(':').map(Number);
    ed.ar = w / h; ed.aspectStr = val; ed.crop = ed.applyAll ? null : defaultCrop();
  }
  ed.zoom = 1;
  syncControlsUI();
  renderOverlay();
}

// Reflect ed.* into the control widgets (active chips, groups, zoom, flips).
function syncControlsUI() {
  ee.aspectChips.forEach((b) => b.classList.toggle('active', b.dataset.aspect === ed.aspect));
  ee.smartChips.forEach((b) => b.classList.toggle('active', b.dataset.smart === ed.smartCrop));
  ee.scopeChoices.forEach((b) => b.classList.toggle('active', (b.dataset.scope === 'all') === ed.applyAll));
  ee.flipHBtn.classList.toggle('active', ed.flipH);
  ee.flipVBtn.classList.toggle('active', ed.flipV);
  ee.custom.hidden = ed.aspect !== 'custom';
  ee.zoomGroup.hidden  = ed.applyAll || !ed.ar;
  ee.smartGroup.hidden = !ed.applyAll || !ed.ar;
  ee.zoomRange.value = Math.round(ed.zoom * 100);
  ee.zoomVal.textContent = ed.zoom.toFixed(1) + '×';
  ee.aspectHint.textContent = ASPECT_HINTS[ed.aspect] || '';
  ee.scopeHint.textContent = ed.applyAll
    ? (ed.ar
        ? 'Click the image to set the focus point kept in every crop.'
        : 'Pick an aspect ratio above to crop all images (Free has nothing to apply per-image).')
    : 'Drag the box or its handles to frame just this image.';
}

// ── open / save / close ──────────────────────────────────────────────────────
function openEditor(item, applyAll) {
  if (!isEditable(item.file)) return;
  setupEditorOnce();
  ed.item = item;
  ed.applyAll = !!applyAll;

  const e = item.edit || {};
  ed.rotate = e.rotate || 0;
  ed.flipH  = !!e.flipH;
  ed.flipV  = !!e.flipV;
  // Map a saved ratio back to its chip; a non-preset ratio (e.g. "3:2") is "custom".
  const PRESETS = ['free', '1:1', '4:3', '16:9', 'orig'];
  ed.aspectStr = e.aspectStr || 'free';
  ed.aspect = PRESETS.includes(ed.aspectStr) ? ed.aspectStr : 'custom';
  ed.ar     = e.ar || null;
  ed.smartCrop = e.smartCrop || 'attention';
  ed.focus  = e.focus || null;
  ed.crop   = applyAll ? null : (e.crop || null);
  ed.zoom   = 1;
  ee.fname.textContent = applyAll
    ? `Edit all - ${state.queue.filter((q) => isEditable(q.file)).length} images`
    : item.file.name;

  // Not usable until the preview actually decodes; saveEditor bails while false
  // so a load failure can never persist an edit built from zero dimensions.
  ed.ready = false;
  ed.natW = ed.natH = ed.bakedW = ed.bakedH = 0;
  ed.img = new Image();
  ed.img.onload = () => {
    ed.natW = ed.img.naturalWidth;
    ed.natH = ed.img.naturalHeight;
    if (!ed.natW || !ed.natH) return ed.img.onerror();
    ed.ready = true;
    recomputeBaked();
    if (!ed.applyAll && ed.ar && !ed.crop) ed.crop = defaultCrop();
    if (ed.aspect === 'custom' && ed.aspectStr.includes(':')) {
      const [cw, ch] = ed.aspectStr.split(':');
      ee.customW.value = cw; ee.customH.value = ch;
    }
    syncControlsUI();
    drawCanvas();
    renderOverlay();
  };
  ed.img.onerror = () => {
    closeEditor();
    showError(`Couldn't open "${item.file.name}" in the editor - the browser can't decode this image.`);
  };
  ed.img.src = item.previewUrl;

  els.editOverlay.hidden = false;
  document.body.classList.add('overlay-open');
  els.editOverlay.focus();
}

// Snapshot the live state into a serialisable edit. A crop that covers the full
// baked image is dropped to null (so 'orig'/'free' with no transform is a true
// no-op, matching the server).
function snapshotEdit() {
  let crop = ed.crop;
  if (crop && crop.x <= 0 && crop.y <= 0 && crop.w >= ed.bakedW && crop.h >= ed.bakedH) crop = null;
  return {
    crop, aspectStr: ed.aspectStr, ar: ed.ar,
    rotate: ed.rotate, flipH: ed.flipH, flipV: ed.flipV,
    focus: ed.focus, smartCrop: ed.smartCrop,
  };
}

function saveEditor() {
  if (!ed.ready) return closeEditor();   // image never decoded - nothing to save
  if (ed.applyAll) {
    // Per-image server cover-crop: one ratio + shared normalized focus, no
    // explicit rectangle (images differ in size). Focus is size-independent.
    const tmpl = {
      crop: null, aspectStr: ed.aspectStr, ar: ed.ar,
      rotate: ed.rotate, flipH: ed.flipH, flipV: ed.flipV,
      focus: ed.ar ? ed.focus : null, smartCrop: ed.smartCrop,
    };
    for (const it of state.queue) {
      if (!isEditable(it.file)) continue;
      it.edit = { ...tmpl };
      refreshRowEdit(it.id);
    }
  } else {
    ed.item.edit = snapshotEdit();
    refreshRowEdit(ed.item.id);
  }
  closeEditor();
}

function resetEditor() {
  ed.rotate = 0; ed.flipH = false; ed.flipV = false;
  ed.aspect = 'free'; ed.ar = null; ed.aspectStr = 'free';
  ed.smartCrop = 'attention'; ed.crop = null; ed.focus = null; ed.zoom = 1;
  recomputeBaked();
  syncControlsUI();
  drawCanvas();
  renderOverlay();
}

function closeEditor() {
  onEdPointerUp();                    // drop any in-flight drag listeners
  els.editOverlay.hidden = true;
  document.body.classList.remove('overlay-open');
  ed.img = null;
}

// One-time listener wiring for the editor controls.
let editorReady = false;
function setupEditorOnce() {
  if (editorReady) return;
  editorReady = true;
  const ov = els.editOverlay;
  ee = {
    stage:  $('#editStage', ov),
    canvas: $('#editCanvas', ov),
    cropRect: $('#cropRect', ov),
    focusMarker: $('#focusMarker', ov),
    dims: $('#editDims', ov),
    fname: $('#editFname', ov),
    custom: $('#editCustom', ov),
    customW: $('#customW', ov),
    customH: $('#customH', ov),
    zoomGroup: $('#zoomGroup', ov),
    zoomRange: $('#zoomRange', ov),
    zoomVal: $('#zoomVal', ov),
    smartGroup: $('#smartGroup', ov),
    scopeHint: $('#scopeHint', ov),
    aspectHint: $('#aspectHint', ov),
    aspectChips: Array.from(ov.querySelectorAll('#aspectChips .edit-chip')),
    smartChips:  Array.from(ov.querySelectorAll('#smartChips .edit-chip')),
    scopeChoices: Array.from(ov.querySelectorAll('#editScope .choice')),
    flipHBtn: $('#flipHBtn', ov),
    flipVBtn: $('#flipVBtn', ov),
  };

  ee.stage.addEventListener('pointerdown', onEdPointerDown);

  ee.aspectChips.forEach((b) => {
    b.addEventListener('click', () => setAspect(b.dataset.aspect));
    // Hover previews that ratio's hint, reverting to the selected one on leave.
    b.addEventListener('mouseenter', () => { ee.aspectHint.textContent = ASPECT_HINTS[b.dataset.aspect] || ''; });
    b.addEventListener('mouseleave', () => { ee.aspectHint.textContent = ASPECT_HINTS[ed.aspect] || ''; });
  });
  $('#customApply', ov).addEventListener('click', () => setAspect('custom'));

  ee.smartChips.forEach((b) => b.addEventListener('click', () => {
    ed.smartCrop = b.dataset.smart; syncControlsUI(); renderOverlay();
  }));

  ee.scopeChoices.forEach((b) => b.addEventListener('click', () => {
    ed.applyAll = b.dataset.scope === 'all';
    // Scope 'one' needs an explicit crop for a locked ratio; 'all' uses focus.
    ed.crop = (!ed.applyAll && ed.ar) ? defaultCrop() : null;
    if (ed.applyAll && ed.ar && !ed.focus) ed.focus = { x: 0.5, y: 0.5 };
    syncControlsUI(); renderOverlay();
  }));

  $('#rotateBtn', ov).addEventListener('click', () => {
    ed.rotate = (ed.rotate + 90) % 360;
    recomputeBaked();
    ed.crop = (!ed.applyAll && ed.ar) ? defaultCrop() : null;
    drawCanvas(); renderOverlay();
  });
  ee.flipHBtn.addEventListener('click', () => {
    ed.flipH = !ed.flipH;
    if (ed.crop) ed.crop.x = ed.bakedW - (ed.crop.x + ed.crop.w);  // mirror framing
    syncControlsUI(); drawCanvas(); renderOverlay();
  });
  ee.flipVBtn.addEventListener('click', () => {
    ed.flipV = !ed.flipV;
    if (ed.crop) ed.crop.y = ed.bakedH - (ed.crop.y + ed.crop.h);
    syncControlsUI(); drawCanvas(); renderOverlay();
  });

  ee.zoomRange.addEventListener('input', () => {
    ed.zoom = Math.max(1, parseInt(ee.zoomRange.value, 10) / 100);
    ee.zoomVal.textContent = ed.zoom.toFixed(1) + '×';
    applyZoom(); renderOverlay();
  });

  $('#editReset', ov).addEventListener('click', resetEditor);
  $('#editSave', ov).addEventListener('click', saveEditor);
  $('#editClose', ov).addEventListener('click', closeEditor);
  $('.overlay-bg', ov).addEventListener('click', closeEditor);
}

// Translate the stored edit into the server's per-file form fields. Crop wins
// over aspect (as in parseEdit); focus/smartCrop only ride along with aspect.
function appendEdit(fd, edit) {
  if (!editIsMeaningful(edit)) return;
  if (edit.rotate) fd.append('rotate', String(edit.rotate));
  if (edit.flipH)  fd.append('flipH', '1');
  if (edit.flipV)  fd.append('flipV', '1');
  if (edit.crop) {
    fd.append('cropX', String(Math.round(edit.crop.x)));
    fd.append('cropY', String(Math.round(edit.crop.y)));
    fd.append('cropW', String(Math.round(edit.crop.w)));
    fd.append('cropH', String(Math.round(edit.crop.h)));
  } else if (edit.aspectStr && ASPECT_RE.test(edit.aspectStr)) {
    fd.append('aspect', edit.aspectStr);
    fd.append('smartCrop', edit.smartCrop || 'attention');
    if (edit.focus) {
      fd.append('focusX', edit.focus.x.toFixed(4));
      fd.append('focusY', edit.focus.y.toFixed(4));
    }
  }
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

// ── settings profiles ────────────────────────────────────────────────────────
els.profileSelect.addEventListener('change', () => {
  if (els.profileSelect.value === 'custom') { updateSettingsPill(); return; }
  selectProfile(els.profileSelect.value);
});
document.querySelectorAll('input[name="format"]').forEach((r) => r.addEventListener('change', markCustomIfChanged));
els.targetKB.addEventListener('input',   markCustomIfChanged);
els.isBanner.addEventListener('change',  markCustomIfChanged);
els.minWidth.addEventListener('input',   markCustomIfChanged);
els.minHeight.addEventListener('input',  markCustomIfChanged);

// Edit all: open the editor on the first editable image in apply-to-all mode.
els.editAllBtn.addEventListener('click', () => {
  const first = state.queue.find((q) => isEditable(q.file));
  if (first) openEditor(first, true);
});

// Overlay close: button, backdrop click, Escape key
$('#overlayClose').addEventListener('click', closeOverlay);
$('.overlay-bg', els.overlay).addEventListener('click', closeOverlay);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!els.editOverlay.hidden) closeEditor();
  else if (!els.overlay.hidden) closeOverlay();
});

// ── theme toggle ────────────────────────────────────────────────────────────
// The initial [data-theme] (stored choice, or system preference as a
// fallback) is already set by theme-init.js before this script ever runs -
// this handler only needs to flip it and persist the explicit choice.
els.themeToggle.addEventListener('click', () => {
  const goingLight = document.documentElement.getAttribute('data-theme') !== 'light';
  if (goingLight) document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
  els.themeToggle.setAttribute('aria-label', goingLight ? 'Switch to dark theme' : 'Switch to light theme');
  try { localStorage.setItem('theme', goingLight ? 'light' : 'dark'); } catch (e) { /* storage unavailable */ }
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
  els.videoTargetMB.value = c.defaultVideoTargetMB;
  els.formatsHint.textContent =
    `JPG · PNG · WebP · GIF · AVIF · BMP · HEIC (max ${c.maxFileMB} MB) · ` +
    `MP4 · MOV · WebM · AVI, always converted to MP4 (max ${c.maxVideoMB} MB)`;

  // Keep the Balanced preset in sync with the server-configured default
  // (TARGET_KB env var) rather than a hardcoded 500 - a deployment that
  // re-tunes its default shouldn't have the "Balanced" profile disagree with it.
  const balanced = PRESETS.find((p) => p.id === 'balanced');
  if (balanced) balanced.targetKB = c.defaultTargetKB;

  PRESETS.forEach((p) => els.profileSelect.appendChild(Object.assign(document.createElement('option'), {
    value: p.id, textContent: p.label,
  })));
  els.profileSelect.appendChild(Object.assign(document.createElement('option'), {
    value: 'custom', textContent: 'Custom',
  }));
  const savedProfile = localStorage.getItem(PROFILE_KEY);
  selectProfile(PRESETS.some((p) => p.id === savedProfile) ? savedProfile : PRESETS[0].id);

  const steps       = [5, 10, 20, 50, 100].filter((n) => n <= c.maxFiles);
  if (!steps.includes(c.maxFiles)) steps.push(c.maxFiles);
  const defaultStep = steps.reduce((p, n) => n <= 20 ? n : p);
  steps.forEach((n) => {
    els.batchLimit.appendChild(Object.assign(document.createElement('option'), {
      value: n, textContent: n + (n === c.maxFiles ? ' (max)' : ''), selected: n === defaultStep,
    }));
  });
}).catch(() => {});
