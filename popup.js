const listEl  = document.getElementById('videoList');
const btnStop = document.getElementById('btnStop');

let tabId    = null;
let videoMap = [];   // [{ frameId, localIndex }] — one entry per detected video

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function inject(id) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: id, allFrames: true },
      files: ['content.js'],
    });
  } catch {}
}

/**
 * Query all frames for their videos.
 * Returns a flat list: [{ frameId, localIndex, isRecording }]
 */
async function queryVideos(id) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: id, allFrames: true },
      func: () => ({
        count:          document.querySelectorAll('video').length,
        recording:      window.__vrRecording      || false,
        recordingIndex: window.__vrRecordingIndex ?? -1,
      }),
    });
  } catch { return []; }

  const list = [];
  for (const r of results) {
    const count    = r.result?.count          || 0;
    const recIdx   = r.result?.recordingIndex ?? -1;
    const isRecAny = r.result?.recording      || false;
    for (let i = 0; i < count; i++) {
      list.push({
        frameId:     r.frameId,
        localIndex:  i,
        isRecording: isRecAny && recIdx === i,
      });
    }
  }
  return list;
}

function render(videos) {
  videoMap = videos;

  if (!videos.length) {
    listEl.innerHTML = '<p class="empty">No videos found on this page.</p>';
    btnStop.style.display = 'none';
    return;
  }

  const anyRecording = videos.some(v => v.isRecording);

  listEl.innerHTML = videos.map((v, i) => `
    <div class="video-row${v.isRecording ? ' recording' : ''}">
      <div class="check">${v.isRecording ? '●' : '✓'}</div>
      <span class="video-label">Video ${i + 1}</span>
      ${v.isRecording
        ? '<span class="rec-badge">● REC</span>'
        : `<button class="btn-record" data-gi="${i}">▶ Record</button>`}
    </div>`
  ).join('');

  // Wire up per-video record buttons
  for (const btn of listEl.querySelectorAll('.btn-record')) {
    btn.addEventListener('click', () => recordVideo(Number(btn.dataset.gi)));
  }

  btnStop.style.display = anyRecording ? 'block' : 'none';
}

async function recordVideo(globalIndex) {
  const entry = videoMap[globalIndex];
  if (!entry || !tabId) return;
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { action: 'record-video', localIndex: entry.localIndex },
      { frameId: entry.frameId }
    );
  } catch (e) {
    console.warn('[VR popup] record-video error:', e.message);
  }
}

btnStop.addEventListener('click', async () => {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => window.dispatchEvent(new CustomEvent('__vr_stop__')),
    });
  } catch {}
});

async function init() {
  const tab = await getActiveTab();
  if (!tab?.id) { listEl.innerHTML = '<p class="empty">Cannot access this tab.</p>'; return; }
  tabId = tab.id;

  await inject(tabId);
  render(await queryVideos(tabId));

  setInterval(async () => render(await queryVideos(tabId)), 1500);
}

init();
