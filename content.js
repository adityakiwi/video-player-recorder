/**
 * content.js — injected into every frame.
 *
 * Behaviour:
 *   • Finds all <video> elements (including same-origin iframes).
 *   • When a video starts playing → start recording via captureStream().
 *   • When the video ends → stop recording and download the file.
 *   • Works autonomously; popup only reads status.
 */

let recorder    = null;
let chunks      = [];
let mimeType    = '';

// Expose recording flag so popup can read it via executeScript
window.__vrRecording = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectVideos(doc) {
  const vids = Array.from(doc.querySelectorAll('video'));
  for (const f of doc.querySelectorAll('iframe')) {
    try { if (f.contentDocument) vids.push(...collectVideos(f.contentDocument)); } catch {}
  }
  return vids;
}

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
  const name = `recording_${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.${ext}`;
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
  chunks   = [];
  recorder = null;
  window.__vrRecording = false;
}

// ── Recording ─────────────────────────────────────────────────────────────────

function startRecording(video) {
  if (recorder && recorder.state === 'recording') return; // already recording
  if (!video.captureStream) return;

  try {
    mimeType = bestMime();
    chunks   = [];
    const stream = video.captureStream();
    recorder = new MediaRecorder(stream, { mimeType });
    window.__vrRecording = true;

    recorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };
    recorder.onstop = saveFile;
    recorder.start(1000);

    // Auto-stop when the video ends
    video.addEventListener('ended', stopRecording, { once: true });
    // Also stop if the video is removed from DOM
    video.addEventListener('emptied', stopRecording, { once: true });
  } catch (e) {
    console.warn('[VR] Could not start recording:', e.message);
    recorder = null;
    window.__vrRecording = false;
  }
}

function stopRecording() {
  if (recorder && recorder.state === 'recording') {
    recorder.stop();
  }
}

// ── Attach listeners to every video ──────────────────────────────────────────

function attachListeners() {
  for (const v of collectVideos(document)) {
    if (v.__vrAttached) continue;
    v.__vrAttached = true;

    v.addEventListener('play', () => startRecording(v));

    // Already playing when extension loads (e.g. autoplay pages)
    if (!v.paused && !v.ended && v.readyState >= 2) startRecording(v);
  }
}

attachListeners();

// Watch for videos added dynamically (SPAs, lazy-loaded players)
new MutationObserver(attachListeners)
  .observe(document.documentElement, { childList: true, subtree: true });

// Stop triggered from popup button
window.addEventListener('__vr_stop__', stopRecording);

// ── Popup message handler ─────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'status') {
    sendResponse({
      videoCount:  collectVideos(document).length,
      isRecording: recorder?.state === 'recording',
    });
  }
  if (msg.action === 'stop') {
    stopRecording();
    sendResponse({ success: true });
  }
  return true;
});
