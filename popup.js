const listEl  = document.getElementById('videoList');
const btnStop = document.getElementById('btnStop');

let tabId    = null;
let videoMap = [];  // [{ frameId, localIndex }]

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function inject(id) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, files: ['content.js'] });
  } catch {}
}

function fmtDur(secs) {
  if (!secs) return '';
  const m = Math.floor(secs / 60), s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtElapsed(startMs) {
  if (!startMs) return '';
  const s = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

async function queryVideos(id) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: id, allFrames: true },
      func: () => ({
        videos: Array.from(document.querySelectorAll('video')).map((v, i) => ({
          localIndex: i,
          duration:   isFinite(v.duration) && v.duration > 0 ? Math.round(v.duration) : null,
        })),
        isRecording:    window.__vrRecording      || false,
        recordingIndex: window.__vrRecordingIndex ?? -1,
        recordingStart: window.__vrRecordingStart || 0,
      }),
    });
  } catch { return []; }

  const list = [];
  for (const r of results) {
    for (const v of (r.result?.videos || [])) {
      list.push({
        frameId:        r.frameId,
        localIndex:     v.localIndex,
        duration:       v.duration,
        isRecording:    r.result.isRecording && r.result.recordingIndex === v.localIndex,
        recordingStart: r.result.recordingStart,
      });
    }
  }
  return list;
}

function render(videos) {
  videoMap = videos;
  const anyRec = videos.some(v => v.isRecording);

  if (!videos.length) {
    listEl.innerHTML = '<p class="empty">No videos found on this page.</p>';
    btnStop.style.display = 'none';
    return;
  }

  listEl.innerHTML = videos.map((v, i) => `
    <div class="video-row${v.isRecording ? ' recording' : ''}">
      <div class="dot"></div>
      <div class="info">
        <div class="name">Video ${i + 1}</div>
        ${v.duration ? `<div class="dur">${fmtDur(v.duration)}</div>` : ''}
      </div>
      ${v.isRecording
        ? `<span class="rec-label">● REC ${fmtElapsed(v.recordingStart)}</span>`
        : `<button class="btn-start" data-gi="${i}">▶ Start Rec</button>`}
    </div>`
  ).join('');

  for (const btn of listEl.querySelectorAll('.btn-start')) {
    btn.addEventListener('click', () => recordVideo(+btn.dataset.gi));
  }

  btnStop.style.display = anyRec ? 'block' : 'none';
}

async function recordVideo(gi) {
  const entry = videoMap[gi];
  if (!entry || !tabId) return;
  await chrome.tabs.sendMessage(tabId, { action: 'record-video', localIndex: entry.localIndex }, { frameId: entry.frameId }).catch(() => {});
}

btnStop.addEventListener('click', async () => {
  if (!tabId) return;
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => window.dispatchEvent(new CustomEvent('__vr_stop__')),
  }).catch(() => {});
});

async function init() {
  const tab = await getActiveTab();
  if (!tab?.id) { listEl.innerHTML = '<p class="empty">Cannot access this tab.</p>'; return; }
  tabId = tab.id;
  await inject(tabId);
  render(await queryVideos(tabId));
  setInterval(async () => render(await queryVideos(tabId)), 1000);
}

init();
