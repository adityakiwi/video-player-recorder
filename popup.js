// ── DOM refs ──────────────────────────────────────────────────────────────────
const dot             = document.getElementById('dot');
const statusText      = document.getElementById('statusText');
const formatBadge     = document.getElementById('formatBadge');
const timerEl         = document.getElementById('timer');
const btnStart        = document.getElementById('btnStart');
const btnStop         = document.getElementById('btnStop');
const streamSection   = document.getElementById('streamSection');
const streamUrlEl     = document.getElementById('streamUrl');
const msgEl           = document.getElementById('msg');
const modeRow         = document.getElementById('modeRow');
const autoToggle      = document.getElementById('autoToggle');
const autoRow         = document.getElementById('autoRow');
const autoMoveToggle  = document.getElementById('autoMoveToggle');
const autoMoveRow     = document.getElementById('autoMoveRow');

// ── State ─────────────────────────────────────────────────────────────────────
let timerInterval = null;
let elapsed       = 0;
let recordMode    = 'video';   // 'video' | 'subtitles'
let videoFrameId  = 0;         // frameId of the frame that contains the video
let mimeType      = '';

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
function fmtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function setMsg(text, type = '') {
  msgEl.textContent = text;
  msgEl.className   = 'msg' + (type ? ` ${type}` : '');
}
function startTimer() {
  elapsed = 0; timerEl.textContent = '00:00'; timerEl.className = 'timer active';
  timerInterval = setInterval(() => { timerEl.textContent = fmtTime(++elapsed); }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval); timerInterval = null;
  timerEl.textContent = '00:00'; timerEl.className = 'timer';
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ── Inject + detect ───────────────────────────────────────────────────────────

/** Inject content.js into every frame of the tab. */
async function injectAll(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch { /* restricted page or already injected */ }
}

/**
 * Find which frame has a video element.
 * Returns { hasVideo, frameId }.
 * Prefers the top frame (frameId 0) if it has a video; otherwise picks the
 * first sub-frame that has one.
 */
async function detectVideoFrame(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        function collectVids(doc) {
          const v = Array.from(doc.querySelectorAll('video'));
          for (const f of doc.querySelectorAll('iframe')) {
            try { if (f.contentDocument) v.push(...collectVids(f.contentDocument)); } catch {}
          }
          return v;
        }
        const vids = collectVids(document);
        return { hasVideo: vids.length > 0, isTop: window.self === window.top };
      },
    });
  } catch {
    return { hasVideo: false, frameId: 0 };
  }

  const withVideo = results.filter(r => r.result?.hasVideo);
  if (!withVideo.length) return { hasVideo: false, frameId: 0 };

  // Prefer top frame; fall back to first sub-frame
  const chosen = withVideo.find(r => r.result?.isTop) || withVideo[0];
  return { hasVideo: true, frameId: chosen.frameId ?? 0 };
}

/** Send a message to a specific frame and await its response. */
function sendToFrame(tabId, frameId, payload) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, payload, { frameId }, resp => {
      resolve(chrome.runtime.lastError ? null : resp);
    });
  });
}

// ── UI state ──────────────────────────────────────────────────────────────────
function showIdle(hasVideo) {
  dot.className = hasVideo ? 'dot ok' : 'dot warn';
  statusText.textContent = hasVideo ? 'Video player detected' : 'No video found on page';
  formatBadge.style.display = 'none';
  // Hide manual start/stop when auto mode is on
  btnStart.style.display = autoToggle.checked ? 'none' : 'block';
  btnStart.disabled      = !hasVideo;
  btnStop.style.display  = 'none'; btnStop.disabled = false;
  modeRow.style.display  = 'flex';
  stopTimer();
  setMsg(hasVideo
    ? (autoToggle.checked ? 'Watching\u2026 will record when video plays.' : '')
    : 'Navigate to a page with an HTML5 video player.');
}

function showRecording(fmt) {
  if (fmt) mimeType = fmt;
  dot.className = 'dot rec';
  statusText.textContent = 'Recording\u2026';
  const label = fmt || mimeType || 'WebM';
  formatBadge.textContent = label; formatBadge.style.display = 'inline';
  btnStart.style.display = 'none';
  // In auto mode, keep stop button visible so user can force-stop
  btnStop.style.display  = 'block'; btnStop.disabled = false;
  modeRow.style.display  = 'none';
  startTimer();
  setMsg(label + ' \u00B7 ' + (recordMode === 'subtitles' ? 'Video + Subtitles' : 'Video only'));
}

function showStreamUrl(urls) {
  if (!urls?.length) { streamSection.classList.remove('visible'); return; }
  streamSection.classList.add('visible');
  streamUrlEl.textContent = urls[urls.length - 1];
}

// ── Mode toggle ───────────────────────────────────────────────────────────────
modeRow.addEventListener('click', e => {
  const pill = e.target.closest('.mode-pill');
  if (!pill) return;
  recordMode = pill.dataset.mode;
  modeRow.querySelectorAll('.mode-pill').forEach(p => p.classList.toggle('active', p === pill));
});

// ── Copy HLS URL ──────────────────────────────────────────────────────────────
streamUrlEl.addEventListener('click', () => {
  const url = streamUrlEl.textContent;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => {
    const orig = streamUrlEl.textContent;
    streamUrlEl.textContent = 'Copied!';
    setTimeout(() => { streamUrlEl.textContent = orig; }, 1200);
  });
});

// ── Auto Play toggle ──────────────────────────────────────────────────────────
autoToggle.addEventListener('change', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  await injectAll(tab.id);
  const detection = await detectVideoFrame(tab.id);
  videoFrameId = detection.frameId;

  if (autoToggle.checked) {
    // Disable Auto Move if active
    if (autoMoveToggle.checked) {
      autoMoveToggle.checked = false;
      await sendToFrame(tab.id, videoFrameId, { action: 'disable-auto-move' });
    }
    const result = await sendToFrame(tab.id, videoFrameId, {
      action:           'enable-auto',
      captureSubtitles: recordMode === 'subtitles',
    });
    if (result?.success) {
      showIdle(detection.hasVideo);
    } else {
      autoToggle.checked = false;
      setMsg(result?.error || 'Could not enable auto mode.', 'err');
    }
  } else {
    await sendToFrame(tab.id, videoFrameId, { action: 'disable-auto' });
    showIdle(detection.hasVideo);
  }
});

// ── Auto Move toggle ──────────────────────────────────────────────────────────
autoMoveToggle.addEventListener('change', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  await injectAll(tab.id);
  const detection = await detectVideoFrame(tab.id);
  videoFrameId = detection.frameId;

  if (autoMoveToggle.checked) {
    // Disable Auto Play if active
    if (autoToggle.checked) {
      autoToggle.checked = false;
      await sendToFrame(tab.id, videoFrameId, { action: 'disable-auto' });
    }
    const result = await sendToFrame(tab.id, videoFrameId, {
      action:           'enable-auto-move',
      captureSubtitles: recordMode === 'subtitles',
    });
    if (result?.success) {
      btnStart.style.display = 'none';
      btnStop.style.display  = 'block';
      modeRow.style.display  = 'none';
      setMsg(`Found ${result.total} video${result.total !== 1 ? 's' : ''} — recording in sequence\u2026`);
    } else {
      autoMoveToggle.checked = false;
      setMsg(result?.error || 'Could not start Auto Move.', 'err');
    }
  } else {
    await sendToFrame(tab.id, videoFrameId, { action: 'disable-auto-move' });
    showIdle(detection.hasVideo);
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  setMsg('Scanning\u2026');
  const tab = await getActiveTab();
  if (!tab?.id) { setMsg('Cannot access this tab.', 'err'); return; }

  await injectAll(tab.id);

  const detection = await detectVideoFrame(tab.id);
  videoFrameId = detection.frameId;

  if (detection.hasVideo) {
    const status = await sendToFrame(tab.id, videoFrameId, { action: 'status' });
    showStreamUrl(status?.streamUrls);
    // Reflect auto mode that was already set in the content script
    if (status?.autoMode)     autoToggle.checked = true;
    if (status?.autoMoveMode) autoMoveToggle.checked = true;
    if (status?.isRecording) {
      showRecording(status.mimeType?.includes('mp4') ? 'MP4' : 'WebM');
      if (status?.autoMoveMode) {
        setMsg(`Video ${status.queueIndex} of ${status.queueTotal} \u2014 recording\u2026`);
      }
    } else {
      showIdle(true);
    }
  } else {
    showIdle(false);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  setMsg('Starting\u2026');

  const tab = await getActiveTab();
  await injectAll(tab.id);

  const detection = await detectVideoFrame(tab.id);
  videoFrameId = detection.frameId;

  if (!detection.hasVideo) {
    setMsg('No video found \u2014 try refreshing the page.', 'err');
    btnStart.disabled = false;
    return;
  }

  const result = await sendToFrame(tab.id, videoFrameId, {
    action:           'start',
    captureSubtitles: recordMode === 'subtitles',
  });

  if (result?.success) {
    showRecording(result.isMP4 ? 'MP4' : 'WebM');
  } else {
    setMsg(result?.error || 'Failed to start recording.', 'err');
    btnStart.disabled = false;
  }
});

// ── Stop ──────────────────────────────────────────────────────────────────────
btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  setMsg('Saving\u2026');
  const tab    = await getActiveTab();
  const result = await sendToFrame(tab.id, videoFrameId, { action: 'stop' });
  if (result?.success) {
    showIdle(true);
    setMsg('Saved to Downloads folder.', 'ok');
  } else {
    setMsg(result?.error || 'Failed to stop.', 'err');
    btnStop.disabled = false;
  }
});

// ── Messages from content script ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.event === 'recording-stopped') {
    showIdle(true);
    setMsg('Video ended \u2014 saved to Downloads.', 'ok');
  }
  if (msg.event === 'queue-progress') {
    showRecording(mimeType?.includes('mp4') ? 'MP4' : 'WebM');
    setMsg(`Video ${msg.current} of ${msg.total} \u2014 recording\u2026`);
  }
  if (msg.event === 'queue-complete') {
    autoMoveToggle.checked = false;
    showIdle(true);
    setMsg(`All ${msg.total} video${msg.total !== 1 ? 's' : ''} saved to Downloads.`, 'ok');
  }
});

// Poll for HLS stream URLs every 2s
setInterval(async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const status = await sendToFrame(tab.id, videoFrameId, { action: 'status' });
  if (status?.streamUrls?.length) showStreamUrl(status.streamUrls);
}, 2000);

init();
