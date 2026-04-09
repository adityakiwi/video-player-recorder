// ── DOM refs ──────────────────────────────────────────────────────────────────
const dot        = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const timerEl    = document.getElementById('timer');
const listEl     = document.getElementById('videoList');
const btnMove    = document.getElementById('btnMove');
const btnStop    = document.getElementById('btnStop');
const msgEl      = document.getElementById('msg');
const modeRow    = document.getElementById('modeRow');

// ── State ─────────────────────────────────────────────────────────────────────
let tabId         = null;
let videoFrameId  = 0;
let videoEntries  = [];   // [{ frameId, localIndex, globalIndex }]
let recordMode    = 'video';
let timerInterval = null;
let elapsed       = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
const pad = n => String(n).padStart(2, '0');
function fmtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function startTimer() {
  elapsed = 0; timerEl.textContent = '00:00'; timerEl.style.display = 'inline';
  timerInterval = setInterval(() => { timerEl.textContent = fmtTime(++elapsed); }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval); timerInterval = null; timerEl.style.display = 'none'; elapsed = 0;
}
function setMsg(t, type = '') {
  msgEl.textContent = t; msgEl.className = 'msg' + (type ? ` ${type}` : '');
}
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
async function injectAll(id) {
  try { await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['content.js'] }); } catch {}
}
function sendToFrame(tid, fid, payload) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tid, payload, { frameId: fid }, resp => {
      resolve(chrome.runtime.lastError ? null : resp);
    });
  });
}

// ── Scan all frames for videos ────────────────────────────────────────────────
async function scanVideos(tid) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tid, allFrames: true },
      func: () => {
        function collectVids(doc) {
          const v = Array.from(doc.querySelectorAll('video'));
          for (const f of doc.querySelectorAll('iframe')) {
            try { if (f.contentDocument) v.push(...collectVids(f.contentDocument)); } catch {}
          }
          return v;
        }
        return { count: collectVids(document).length };
      },
    });
  } catch { return []; }

  const entries = [];
  let gi = 0, bestCount = 0;
  for (const r of results) {
    const count = r.result?.count || 0;
    if (count > bestCount) { bestCount = count; videoFrameId = r.frameId; }
    for (let i = 0; i < count; i++) {
      entries.push({ frameId: r.frameId, localIndex: i, globalIndex: gi++ });
    }
  }
  return entries;
}

// ── Mode pills ────────────────────────────────────────────────────────────────
modeRow.addEventListener('click', e => {
  const pill = e.target.closest('.mode-pill');
  if (!pill) return;
  recordMode = pill.dataset.mode;
  modeRow.querySelectorAll('.mode-pill').forEach(p => p.classList.toggle('active', p === pill));
});

// ── Per-video Record ──────────────────────────────────────────────────────────
async function recordVideo(gi, btn) {
  const entry = videoEntries[gi];
  if (!entry) return;

  btn.disabled = true;
  btn.textContent = '…';

  const result = await sendToFrame(tabId, entry.frameId, {
    action:           'record-video',
    localIndex:       entry.localIndex,
    captureSubtitles: recordMode === 'subtitles',
  });

  if (result?.success) {
    setMsg(`Recording Video ${gi + 1}…`);
  } else {
    btn.disabled = false;
    btn.textContent = '▶ Record';
    setMsg(result?.error || 'Could not start recording.', 'err');
  }
}

// ── Auto Move ─────────────────────────────────────────────────────────────────
btnMove.addEventListener('click', async () => {
  if (btnMove.classList.contains('active')) {
    await sendToFrame(tabId, videoFrameId, { action: 'disable-auto-move' });
    btnMove.classList.remove('active');
    btnMove.textContent = '⟳ Auto Move — Record all in sequence';
    setMsg('');
    return;
  }
  await sendToFrame(tabId, videoFrameId, { action: 'disable-auto' });
  listEl.querySelectorAll('.btn-auto').forEach(b => {
    b.textContent = '▶ Auto Play'; b.classList.remove('active');
    b.closest('.video-row').classList.remove('auto-active');
  });
  const result = await sendToFrame(tabId, videoFrameId, {
    action:           'enable-auto-move',
    captureSubtitles: recordMode === 'subtitles',
  });
  if (result?.success) {
    btnMove.classList.add('active');
    btnMove.textContent = `⟳ Auto Move ON — ${result.total} video${result.total !== 1 ? 's' : ''} queued`;
    setMsg(`Recording ${result.total} videos in sequence…`);
  } else {
    setMsg(result?.error || 'Could not start Auto Move.', 'err');
  }
});

// ── Stop ──────────────────────────────────────────────────────────────────────
btnStop.addEventListener('click', async () => {
  await sendToFrame(tabId, videoFrameId, { action: 'stop' });
  btnMove.classList.remove('active');
  btnMove.textContent = '⟳ Auto Move — Record all in sequence';
});

// ── Runtime messages from content ─────────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.event === 'recording-stopped') {
    stopTimer();
    dot.className      = 'dot ok';
    statusText.textContent = 'Saved — ready';
    btnStop.style.display  = 'none';
    setMsg('Saved to Downloads.', 'ok');
  }
  if (msg.event === 'queue-progress') {
    setMsg(`Recording video ${msg.current} of ${msg.total}…`);
  }
  if (msg.event === 'queue-complete') {
    btnMove.classList.remove('active');
    btnMove.textContent    = '⟳ Auto Move — Record all in sequence';
    stopTimer();
    dot.className          = 'dot ok';
    statusText.textContent = 'All done';
    btnStop.style.display  = 'none';
    setMsg(`All ${msg.total} videos saved.`, 'ok');
  }
});

// ── Render ────────────────────────────────────────────────────────────────────
function render(entries, status) {
  videoEntries = entries;

  // Video list
  if (!entries.length) {
    listEl.innerHTML = '<p class="empty">No videos found on this page.</p>';
    btnMove.disabled = true;
  } else {
    btnMove.disabled = false;
    listEl.innerHTML = entries.map(e => `
      <div class="video-row" data-gi="${e.globalIndex}">
        <div class="v-dot"></div>
        <span class="v-label">Video ${e.globalIndex + 1}</span>
        <button class="btn-auto" data-gi="${e.globalIndex}">▶ Record</button>
      </div>`).join('');
    listEl.querySelectorAll('.btn-auto').forEach(btn => {
      btn.addEventListener('click', () => recordVideo(+btn.dataset.gi, btn));
    });
  }

  // Status bar
  if (status?.isRecording) {
    dot.className          = 'dot rec';
    statusText.textContent = status?.autoMoveMode
      ? `Recording video ${status.queueIndex} of ${status.queueTotal}…`
      : 'Recording…';
    btnStop.style.display  = 'block';
    if (!timerInterval) startTimer();
  } else {
    if (!status?.autoMode && timerInterval) stopTimer();
    dot.className          = entries.length ? 'dot ok' : 'dot warn';
    statusText.textContent = entries.length
      ? `${entries.length} video${entries.length !== 1 ? 's' : ''} detected`
      : 'No videos found on this page';
    btnStop.style.display  = 'none';
  }

  // Auto Move button state
  if (status?.autoMoveMode) {
    btnMove.classList.add('active');
    btnMove.textContent = `⟳ Auto Move ON — ${status.queueTotal} video${status.queueTotal !== 1 ? 's' : ''} queued`;
  }
}

// ── Init + poll ───────────────────────────────────────────────────────────────
async function refresh() {
  const entries = await scanVideos(tabId);
  const status  = await sendToFrame(tabId, videoFrameId, { action: 'status' });
  render(entries, status);
}

async function init() {
  const tab = await getActiveTab();
  if (!tab?.id) { listEl.innerHTML = '<p class="empty">Cannot access this tab.</p>'; return; }
  tabId = tab.id;
  await injectAll(tabId);
  await refresh();
  setInterval(refresh, 2000);
}

init();
