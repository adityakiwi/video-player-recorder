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
let recordMode    = 'tab';   // 'tab' | 'element'

// ── Helpers ───────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

function fmtTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

function setMsg(text, type = '') {
  msgEl.textContent = text;
  msgEl.className   = 'msg' + (type ? ` ${type}` : '');
}

function startTimer() {
  elapsed = 0;
  timerEl.textContent = '00:00';
  timerEl.className   = 'timer active';
  timerInterval = setInterval(() => { timerEl.textContent = fmtTime(++elapsed); }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval       = null;
  timerEl.textContent = '00:00';
  timerEl.className   = 'timer';
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function injectContent(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch { /* already injected or restricted page */ }
}

async function sendToContent(tabId, payload) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, payload, resp => {
      resolve(chrome.runtime.lastError ? null : resp);
    });
  });
}

/** Gets a tabCapture stream ID from the background API. */
async function getTabStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
    });
  });
}

// ── UI state helpers ──────────────────────────────────────────────────────────
function showIdle(hasVideo) {
  dot.className   = hasVideo ? 'dot ok' : 'dot warn';
  statusText.textContent = hasVideo ? 'Video player detected' : 'No video found on page';
  formatBadge.style.display = 'none';
  btnStart.style.display = 'block';
  btnStart.disabled      = !hasVideo;
  btnStop.style.display  = 'none';
  btnStop.disabled       = false;
  modeRow.style.display  = 'flex';
  stopTimer();
  if (!hasVideo) setMsg('Open a page with an HTML5 video player.');
  else           setMsg('');
}

function showRecording(fmt, mode) {
  dot.className   = 'dot rec';
  statusText.textContent = 'Recording…';
  formatBadge.textContent = fmt;
  formatBadge.style.display = 'inline';
  btnStart.style.display = 'none';
  btnStop.style.display  = 'block';
  btnStop.disabled       = false;
  modeRow.style.display  = 'none';
  startTimer();
  const modeLabel = mode === 'tab-capture' ? 'Screen crop (subtitles baked in)' : 'Player stream (WebVTT subtitles)';
  setMsg(fmt + ' · ' + modeLabel);
}

function showStreamUrl(urls) {
  if (!urls?.length) { streamSection.classList.remove('visible'); return; }
  streamSection.classList.add('visible');
  streamUrlEl.textContent = urls[urls.length - 1]; // show most recent
}

// ── Mode toggle ───────────────────────────────────────────────────────────────
modeRow.addEventListener('click', (e) => {
  const pill = e.target.closest('.mode-pill');
  if (!pill) return;
  recordMode = pill.dataset.mode;
  modeRow.querySelectorAll('.mode-pill').forEach(p => p.classList.toggle('active', p === pill));
});

// ── Copy stream URL ───────────────────────────────────────────────────────────
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
  setMsg('Scanning…');
  const tab = await getActiveTab();
  if (!tab?.id) { setMsg('Cannot access this tab.', 'err'); return; }

  await injectContent(tab.id);

  const status = await sendToContent(tab.id, { action: 'status' });
  if (!status) {
    dot.className = 'dot';
    statusText.textContent = 'Cannot access this page';
    setMsg('Extension cannot run on browser system pages.', 'err');
    return;
  }

  showStreamUrl(status.streamUrls);

  if (status.isRecording) {
    const fmt = status.mimeType?.includes('mp4') ? 'MP4' : 'WebM';
    showRecording(fmt, 'tab-capture');
    setMsg('Recording in progress…');
  } else {
    showIdle(status.hasVideo);
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  setMsg('Initialising…');

  const tab = await getActiveTab();
  await injectContent(tab.id);

  let streamId = null;

  if (recordMode === 'tab') {
    try {
      streamId = await getTabStreamId(tab.id);
    } catch (e) {
      // Tab capture unavailable — fall back to element capture
      setMsg('Tab capture unavailable, using player stream.', 'err');
    }
  }

  const result = await sendToContent(tab.id, { action: 'start', streamId });

  if (result?.success) {
    const fmt = result.isMP4 ? 'MP4' : 'WebM';
    showRecording(fmt, result.mode);
  } else {
    setMsg(result?.error || 'Failed to start recording.', 'err');
    btnStart.disabled = false;
  }
});

// ── Stop ──────────────────────────────────────────────────────────────────────
btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  setMsg('Saving…');

  const tab = await getActiveTab();
  const result = await sendToContent(tab.id, { action: 'stop' });

  if (result?.success) {
    showIdle(true);
    setMsg('Saved to Downloads folder.', 'ok');
  } else {
    setMsg(result?.error || 'Failed to stop.', 'err');
    btnStop.disabled = false;
  }
});

// ── Auto-stop notification from content script ────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.event === 'recording-stopped') {
    showIdle(true);
    setMsg('Video ended — saved to Downloads.', 'ok');
  }
});

// Poll for HLS stream URLs while popup is open
setInterval(async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const status = await sendToContent(tab.id, { action: 'status' });
  if (status?.streamUrls?.length) showStreamUrl(status.streamUrls);
}, 2000);

init();
