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

async function downloadVideo(video, title) {
  // Scroll into view so the player initialises (lazy iframes)
  try { video.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch {}
  try { video.currentTime = 0; } catch {}

  // Wait until the video has data
  if (video.readyState < 2) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Video did not load in time.')), 15000);
      const done = () => { clearTimeout(t); resolve(); };
      video.addEventListener('canplay',    done, { once: true });
      video.addEventListener('loadeddata', done, { once: true });
    });
  }

  // Play it
  try { await video.play(); } catch {}
  await new Promise(r => setTimeout(r, 500));

  // Grab the stream
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

  chunks   = [];
  recStream = stream;
  recorder  = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };

  recorder.onstop = () => {
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
