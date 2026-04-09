// ── DOM refs ──────────────────────────────────────────────────────────────────
const dot           = document.getElementById('dot');
const statusText    = document.getElementById('statusText');
const formatBadge   = document.getElementById('formatBadge');
const timerEl       = document.getElementById('timer');
const btnStart      = document.getElementById('btnStart');
const btnStop       = document.getElementById('btnStop');
const streamSection = document.getElementById('streamSection');
const streamUrlEl   = document.getElementById('streamUrl');
const msgEl         = document.getElementById('msg');
const modeRow       = document.getElementById('modeRow');

// ── State ─────────────────────────────────────────────────────────────────────
let timerInterval = null;
let elapsed       = 0;
let recordMode    = 'video';   // 'video' | 'subtitles'
let videoFrameId  = 0;         // frameId of the frame that contains the video

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
  btnStart.style.display = 'block'; btnStart.disabled = !hasVideo;
  btnStop.style.display  = 'none';  btnStop.disabled  = false;
  modeRow.style.display  = 'flex';
  stopTimer();
  setMsg(hasVideo ? '' : 'Navigate to a page with an HTML5 video player.');
}

function showRecording(fmt) {
  dot.className = 'dot rec';
  statusText.textContent = 'Recording\u2026';
  formatBadge.textContent = fmt; formatBadge.style.display = 'inline';
  btnStart.style.display = 'none';
  btnStop.style.display  = 'block'; btnStop.disabled = false;
  modeRow.style.display  = 'none';
  startTimer();
  setMsg(fmt + ' \u00B7 ' + (recordMode === 'subtitles' ? 'Video + Subtitles' : 'Video only'));
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
    if (status?.isRecording) {
      showRecording(status.mimeType?.includes('mp4') ? 'MP4' : 'WebM');
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

// ── Auto-stop from content script ────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.event === 'recording-stopped') {
    showIdle(true);
    setMsg('Video ended \u2014 saved to Downloads.', 'ok');
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
