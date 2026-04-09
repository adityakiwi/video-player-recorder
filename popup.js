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
let recordMode    = 'tab';
let videoFrameId  = 0;   // frameId of the frame that contains the video

// ── Helpers ───────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }
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

// ── Frame-aware injection & detection ─────────────────────────────────────────

/** Inject content.js into ALL frames of the tab. */
async function injectAll(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] });
  } catch { /* restricted page or already injected */ }
}

/**
 * Uses executeScript across all frames to find which one has a video.
 * Returns { hasVideo, frameId, absoluteRect }.
 * absoluteRect is the video's position in top-level window coordinates — needed
 * for the canvas crop when the video lives inside a sub-frame.
 */
async function detectVideoAcrossFrames(tabId) {
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
        if (!vids.length) return { hasVideo: false };

        const playing = vids.filter(v => !v.paused && !v.ended && v.readyState >= 2);
        const pool    = playing.length ? playing : vids;
        const best    = pool.reduce((b, v) => {
          try {
            const r = v.getBoundingClientRect(), br = b.getBoundingClientRect();
            return r.width * r.height > br.width * br.height ? v : b;
          } catch { return b; }
        });

        const r = best.getBoundingClientRect();
        return {
          hasVideo:   true,
          isTopFrame: window.self === window.top,
          frameUrl:   location.href,
          rect:       { left: r.left, top: r.top, width: r.width, height: r.height },
        };
      },
    });
  } catch {
    return { hasVideo: false };
  }

  const withVideo = results.filter(r => r.result?.hasVideo);
  if (!withVideo.length) return { hasVideo: false };

  // Prefer the top frame if it found one; otherwise use the first sub-frame
  const preferred = withVideo.find(r => r.result?.isTopFrame) || withVideo[0];
  const frameId   = preferred.frameId;
  const isTop     = preferred.result.isTopFrame;

  // For sub-frames: compute absolute rect = iframe element rect + video rect within iframe
  let absoluteRect = null;
  if (!isTop) {
    try {
      const iframeUrl  = preferred.result.frameUrl;
      const [topResult] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: (url) => {
          for (const f of document.querySelectorAll('iframe')) {
            try {
              const resolved = new URL(f.src || '', location.href).href;
              if (resolved === url || url.startsWith(resolved.replace(/\/$/, ''))) {
                const r = f.getBoundingClientRect();
                return { left: r.left, top: r.top, width: r.width, height: r.height };
              }
            } catch {}
          }
          // Fallback: first sizeable iframe on the page
          for (const f of document.querySelectorAll('iframe')) {
            const r = f.getBoundingClientRect();
            if (r.width > 100 && r.height > 100) {
              return { left: r.left, top: r.top, width: r.width, height: r.height };
            }
          }
          return null;
        },
        args: [iframeUrl],
      });

      const iframeRect = topResult?.result;
      const videoRect  = preferred.result.rect;
      if (iframeRect && videoRect) {
        absoluteRect = {
          left:   iframeRect.left + videoRect.left,
          top:    iframeRect.top  + videoRect.top,
          width:  videoRect.width,
          height: videoRect.height,
        };
      }
    } catch { /* best-effort */ }
  }

  return { hasVideo: true, frameId, absoluteRect };
}

/** Send a message to a specific frame. */
function sendToFrame(tabId, frameId, payload) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tabId, payload, { frameId }, resp => {
      resolve(chrome.runtime.lastError ? null : resp);
    });
  });
}

async function getTabStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, id => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(id);
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

function showRecording(fmt, mode) {
  dot.className = 'dot rec';
  statusText.textContent = 'Recording\u2026';
  formatBadge.textContent = fmt; formatBadge.style.display = 'inline';
  btnStart.style.display = 'none';
  btnStop.style.display  = 'block'; btnStop.disabled = false;
  modeRow.style.display  = 'none';
  startTimer();
  setMsg(fmt + ' \u00B7 ' + (mode === 'tab-capture' ? 'Screen crop' : 'Player stream'));
}

function showStreamUrl(urls) {
  if (!urls?.length) { streamSection.classList.remove('visible'); return; }
  streamSection.classList.add('visible');
  streamUrlEl.textContent = urls[urls.length - 1];
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
  setMsg('Scanning all frames\u2026');
  const tab = await getActiveTab();
  if (!tab?.id) { setMsg('Cannot access this tab.', 'err'); return; }

  await injectAll(tab.id);

  const detection = await detectVideoAcrossFrames(tab.id);
  videoFrameId = detection.frameId ?? 0;

  if (detection.hasVideo) {
    const status = await sendToFrame(tab.id, videoFrameId, { action: 'status' });
    showStreamUrl(status?.streamUrls);
    if (status?.isRecording) {
      showRecording(status.mimeType?.includes('mp4') ? 'MP4' : 'WebM', 'tab-capture');
      setMsg('Recording in progress\u2026');
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
  setMsg('Initialising\u2026');

  const tab = await getActiveTab();
  await injectAll(tab.id);

  // Re-detect in case page content changed since popup opened
  const detection = await detectVideoAcrossFrames(tab.id);
  videoFrameId = detection.frameId ?? 0;

  if (!detection.hasVideo) {
    setMsg('No video found — try refreshing the page.', 'err');
    btnStart.disabled = false;
    return;
  }

  let streamId = null;
  if (recordMode === 'tab') {
    try {
      streamId = await getTabStreamId(tab.id);
    } catch {
      setMsg('Tab capture unavailable — using player stream fallback.');
    }
  }

  const result = await sendToFrame(tab.id, videoFrameId, {
    action:       'start',
    streamId,
    absoluteRect: detection.absoluteRect || null,
  });

  if (result?.success) {
    showRecording(result.isMP4 ? 'MP4' : 'WebM', result.mode);
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

// ── Auto-stop notification from content script ────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.event === 'recording-stopped') {
    showIdle(true);
    setMsg('Video ended \u2014 saved to Downloads.', 'ok');
  }
});

// Poll for HLS stream URLs while popup is open
setInterval(async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  const status = await sendToFrame(tab.id, videoFrameId, { action: 'status' });
  if (status?.streamUrls?.length) showStreamUrl(status.streamUrls);
}, 2000);

init();
