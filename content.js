let recorder  = null;
let chunks    = [];
let recStream = null;

function collectVideos(doc) {
  const vids = Array.from(doc.querySelectorAll('video'));
  for (const f of doc.querySelectorAll('iframe')) {
    try { if (f.contentDocument) vids.push(...collectVideos(f.contentDocument)); } catch {}
  }
  return vids;
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, '_').slice(0, 120);
}

// Fully reset a video to the beginning and wait until it can play
async function resetAndLoad(video) {
  try { video.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch {}

  // If the video errored or never loaded, force a full reload
  if (video.error || video.networkState === video.NETWORK_NO_SOURCE) {
    video.load();
  } else {
    // Try seeking to start; if it fails (e.g. not loaded yet), do a full reload
    try { video.currentTime = 0; } catch { video.load(); }
  }

  // Stop any existing playback
  try { video.pause(); } catch {}

  // Wait for the video to have enough data to play
  if (video.readyState < 3) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        // First timeout: force reload and try again
        video.load();
        const timeout2 = setTimeout(() => reject(new Error('Video stuck — could not load.')), 20000);
        video.addEventListener('canplay', () => { clearTimeout(timeout2); resolve(); }, { once: true });
        video.addEventListener('error',   () => { clearTimeout(timeout2); reject(new Error('Video load error.')); }, { once: true });
      }, 10000);
      video.addEventListener('canplay', () => { clearTimeout(timeout); resolve(); }, { once: true });
      video.addEventListener('error',   () => { clearTimeout(timeout); reject(new Error('Video load error.')); }, { once: true });
    });
  }

  // Make sure we're at the very beginning
  try { video.currentTime = 0; } catch {}
  await new Promise(r => setTimeout(r, 200));
}

async function downloadVideo(video, title) {
  // Reset the video fully to the start before recording
  await resetAndLoad(video);

  // Start playback
  try { await video.play(); } catch {}
  await new Promise(r => setTimeout(r, 500));

  // Capture the stream
  let stream;
  try { stream = video.captureStream(); } catch (e) {
    throw new Error('captureStream failed: ' + e.message);
  }
  if (!stream.getTracks().length) {
    await new Promise(r => setTimeout(r, 800));
    try { stream = video.captureStream(); } catch {}
  }
  if (!stream.getTracks().length)
    throw new Error('No stream — video may be DRM-protected.');

  const mimeType = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']
    .find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } })
    || 'video/webm';

  chunks    = [];
  recStream = stream;
  recorder  = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };

  recorder.onstop = () => {
    clearInterval(stallTimer);
    const blob = new Blob(chunks, { type: mimeType });
    const ext  = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const name = sanitize(title || document.title.split(/\s*[|\-–—]\s*/)[0] || 'video');
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob), download: `${name}.${ext}`, style: 'display:none',
    });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 2000);
    chunks = []; recStream = null;
    chrome.runtime.sendMessage({ event: 'recording-stopped' }).catch(() => {});
  };

  recorder.start(1000);

  // Stall detector: if currentTime stops advancing for 5s, nudge the video forward
  let lastTime = video.currentTime;
  let stallCount = 0;
  const stallTimer = setInterval(() => {
    if (recorder?.state !== 'recording') { clearInterval(stallTimer); return; }
    if (!video.paused && !video.ended) {
      if (video.currentTime === lastTime) {
        stallCount++;
        if (stallCount >= 2) {           // stuck for ~5 s
          try { video.currentTime += 0.1; } catch {}   // nudge forward
          stallCount = 0;
        }
      } else {
        stallCount = 0;
      }
    }
    lastTime = video.currentTime;
  }, 2500);

  video.addEventListener('ended', () => {
    if (recorder?.state === 'recording') recorder.stop();
  }, { once: true });

  return { success: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'status') {
    sendResponse({
      isRecording: recorder?.state === 'recording',
      videoCount:  collectVideos(document).length,
    });
    return true;
  }
  if (msg.action === 'record-video') {
    const video = collectVideos(document)[msg.localIndex ?? 0];
    if (!video) { sendResponse({ success: false, error: 'Video not found.' }); return true; }
    downloadVideo(video, msg.title || '')
      .then(sendResponse)
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }
  if (msg.action === 'stop') {
    if (recorder?.state === 'recording') recorder.stop();
    sendResponse({ success: true });
    return true;
  }
  return true;
});
