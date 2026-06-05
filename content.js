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

// Fully reset a video to the beginning, ready to capture from frame 0.
// Returns only after the seek is confirmed (seeked event) so captureStream()
// gets live frames instead of a stale/ended stream.
async function resetToStart(video) {
  try { video.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch {}

  // Pause first so the player is in a stable state
  try { video.pause(); } catch {}

  // If the video errored or has no source loaded, force a full reload
  if (video.error || video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE || video.readyState === 0) {
    video.load();
  }

  // Wait until there is enough data to seek
  if (video.readyState < 2) {
    await new Promise((resolve, reject) => {
      const t1 = setTimeout(() => {
        video.load();   // force reload on first timeout
        const t2 = setTimeout(() => reject(new Error('Video stuck — could not load.')), 20000);
        video.addEventListener('canplay', () => { clearTimeout(t2); resolve(); }, { once: true });
        video.addEventListener('error',   () => { clearTimeout(t2); reject(new Error('Video load error.')); }, { once: true });
      }, 10000);
      video.addEventListener('canplay', () => { clearTimeout(t1); resolve(); }, { once: true });
      video.addEventListener('error',   () => { clearTimeout(t1); reject(new Error('Video load error.')); }, { once: true });
    });
  }

  // Seek to the very beginning and wait for the browser to confirm the seek.
  // This is critical: after a video has been watched (ended state), seeking
  // triggers the player to re-buffer from segment 0. We must wait for `seeked`
  // before calling captureStream() or we'll get a dead video track.
  await new Promise(resolve => {
    const done = () => resolve();
    video.addEventListener('seeked', done, { once: true });
    try { video.currentTime = 0; }
    catch { resolve(); }   // if seek throws, continue anyway
    // Safety: if seeked never fires (already at 0), resolve after 1s
    setTimeout(resolve, 1000);
  });
}

async function downloadVideo(video, title) {
  await resetToStart(video);

  // captureStream() is called HERE — before play() — so the stream is attached
  // while the video is at frame 0 and about to start. Calling it after play()
  // on a previously-watched video risks getting only audio (video track stale).
  let stream;
  try { stream = video.captureStream(); } catch (e) {
    throw new Error('captureStream failed: ' + e.message);
  }

  // Now start playback
  try { await video.play(); } catch {}

  // Wait for the first timeupdate — confirms frames are actually advancing
  await new Promise(resolve => {
    video.addEventListener('timeupdate', resolve, { once: true });
    setTimeout(resolve, 2000);   // fallback: don't wait forever
  });

  // Verify we have tracks (retry once if stream was grabbed too early)
  if (!stream.getTracks().length) {
    await new Promise(r => setTimeout(r, 600));
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
