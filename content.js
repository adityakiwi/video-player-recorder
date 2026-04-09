/**
 * content.js — injected into every frame independently (allFrames: true).
 *
 * Each frame manages its own <video> elements.
 * Popup can trigger recording of a specific video by local index.
 */

let recorder       = null;
let chunks         = [];
let mimeType       = '';
let recordingIndex = -1;   // local index of the video currently being recorded

window.__vrRecording      = false;
window.__vrRecordingIndex = -1;

// ── Helpers ───────────────────────────────────────────────────────────────────

// Only direct videos in THIS frame — each frame manages its own.
const getVideos = () => Array.from(document.querySelectorAll('video'));

function bestMime() {
  for (const t of ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'video/webm';
}

function saveFile() {
  if (!chunks.length) return;
  const blob = new Blob(chunks, { type: mimeType });
  const ext  = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const name = `recording_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  chunks                    = [];
  recorder                  = null;
  recordingIndex            = -1;
  window.__vrRecording      = false;
  window.__vrRecordingIndex = -1;
}

// ── Recording ─────────────────────────────────────────────────────────────────

function startRecording(video) {
  if (recorder && recorder.state === 'recording') return;
  if (!video.captureStream) return;

  try {
    mimeType                  = bestMime();
    chunks                    = [];
    recordingIndex            = getVideos().indexOf(video);
    window.__vrRecording      = true;
    window.__vrRecordingIndex = recordingIndex;

    const stream = video.captureStream();
    recorder = new MediaRecorder(stream, { mimeType });
    recorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
    recorder.onstop = saveFile;
    recorder.start(1000);

    video.addEventListener('ended',   stopRecording, { once: true });
    video.addEventListener('emptied', stopRecording, { once: true });
  } catch (e) {
    console.warn('[VR] Could not start recording:', e.message);
    recorder                  = null;
    recordingIndex            = -1;
    window.__vrRecording      = false;
    window.__vrRecordingIndex = -1;
  }
}

function stopRecording() {
  if (recorder && recorder.state === 'recording') recorder.stop();
}

// ── Auto-attach play listeners ────────────────────────────────────────────────

function attachListeners() {
  for (const v of getVideos()) {
    if (v.__vrAttached) continue;
    v.__vrAttached = true;
    v.addEventListener('play', () => startRecording(v));
    if (!v.paused && !v.ended && v.readyState >= 2) startRecording(v);
  }
}

attachListeners();
new MutationObserver(attachListeners)
  .observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('__vr_stop__', stopRecording);

// ── Popup message handler ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'status') {
    sendResponse({
      videoCount:     getVideos().length,
      isRecording:    recorder?.state === 'recording',
      recordingIndex,
    });
    return true;
  }

  if (msg.action === 'record-video') {
    const video = getVideos()[msg.localIndex];
    if (!video) { sendResponse({ success: false, error: 'Video not found' }); return true; }

    // Rewind and play, then record
    video.currentTime = 0;
    video.play()
      .catch(() => {}) // if autoplay blocked, the play listener will still fire
      .finally(() => startRecording(video));
    sendResponse({ success: true });
    return true;
  }

  if (msg.action === 'stop') {
    stopRecording();
    sendResponse({ success: true });
    return true;
  }

  return true;
});
