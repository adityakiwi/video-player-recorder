const listEl  = document.getElementById('videoList');
const btnStop = document.getElementById('btnStop');

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Inject content.js into all frames (no-op if already injected). */
async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content.js'],
    });
  } catch {}
}

/**
 * Query every frame for video count + recording state.
 * Returns { videoCount, isRecording }.
 */
async function getStatus(tabId) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        count:      document.querySelectorAll('video').length,
        recording:  window.__vrRecording || false,
      }),
    });
  } catch {
    return { videoCount: 0, isRecording: false };
  }
  const videoCount  = results.reduce((s, r) => s + (r.result?.count     || 0), 0);
  const isRecording = results.some(r => r.result?.recording);
  return { videoCount, isRecording };
}

function render({ videoCount, isRecording }) {
  if (videoCount === 0) {
    listEl.innerHTML = '<p class="empty">No videos found on this page.</p>';
    btnStop.style.display = 'none';
    return;
  }

  listEl.innerHTML = Array.from({ length: videoCount }, (_, i) => {
    const isRec = isRecording && i === 0; // first video shown as recording
    return `
      <div class="video-row${isRec ? ' recording' : ''}">
        <div class="check">${isRec ? '●' : '✓'}</div>
        <span class="video-label">Video ${i + 1}</span>
        ${isRec ? '<span class="rec-badge">REC</span>' : ''}
      </div>`;
  }).join('');

  btnStop.style.display = isRecording ? 'block' : 'none';
}

btnStop.addEventListener('click', async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        if (window.__vrRecorder?.state === 'recording') window.__vrRecorder.stop();
        // Also trigger via custom event content.js listens for
        window.dispatchEvent(new CustomEvent('__vr_stop__'));
      },
    });
  } catch {}
});

async function init() {
  const tab = await getActiveTab();
  if (!tab?.id) {
    listEl.innerHTML = '<p class="empty">Cannot access this tab.</p>';
    return;
  }

  await inject(tab.id);
  render(await getStatus(tab.id));

  // Poll every 1.5 s to keep status fresh
  setInterval(async () => render(await getStatus(tab.id)), 1500);
}

init();
