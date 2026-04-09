/**
 * content.js — injected into ALL frames (allFrames:true).
 *
 * Recording always runs from the TOP frame (frameId 0) which can call
 * getUserMedia({ chromeMediaSource:'tab' }) reliably.
 *
 * When the video lives in a cross-origin iframe, the popup computes
 * absoluteRect (iframe offset + video offset) and passes it here so the
 * top-frame content script can crop the tab stream without needing to
 * access the video element directly.
 *
 * Same-origin iframes: findBestVideo() recurses into them, so the top
 * frame finds the element and uses getAbsoluteRect() for the crop.
 *
 * A lightweight "monitor" message handler lets iframe content scripts
 * forward video-ended events to trigger auto-stop.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let recorder    = null;
let chunks      = [];
let tabStream   = null;
let recStream   = null;
let animFrame   = null;
let tempVid     = null;
let mimeType    = '';
let capturedStreamUrls = [];

// ── Emeritus CDN map ──────────────────────────────────────────────────────────
const cdnUrlMap = {
  'video-test.emeritus.org':      'https://cdn1-video-stage.emeritus.org',
  'videocast-stage.emeritus.org': 'https://cdn-vc-stage.emeritus.org',
  'videocast.emeritus.org':       'https://cdn.videocast.emeritus.org',
};

window.addEventListener('__vr_stream__', (e) => {
  const url = e.detail?.url;
  if (url && !capturedStreamUrls.includes(url)) capturedStreamUrls.push(url);
});

// ── Video search ──────────────────────────────────────────────────────────────

function collectVideos(doc) {
  const vids = Array.from(doc.querySelectorAll('video'));
  for (const iframe of doc.querySelectorAll('iframe')) {
    try {
      if (iframe.contentDocument) vids.push(...collectVideos(iframe.contentDocument));
    } catch { /* cross-origin */ }
  }
  return vids;
}

function findBestVideo() {
  const all = collectVideos(document);
  if (!all.length) return null;
  const playing = all.filter(v => !v.paused && !v.ended && v.readyState >= 2);
  const pool = playing.length ? playing : all;
  return pool.reduce((best, v) => {
    try {
      const r = v.getBoundingClientRect(), br = best.getBoundingClientRect();
      return r.width * r.height > br.width * br.height ? v : best;
    } catch { return best; }
  });
}

/**
 * Walk up from videoEl to find the nearest positioned ancestor that wraps
 * both the video and any sibling subtitle/overlay divs.
 */
function findPlayerContainer(videoEl) {
  const vr   = videoEl.getBoundingClientRect();
  const area = vr.width * vr.height;
  if (area === 0) return videoEl;

  let best = videoEl;
  let el   = videoEl.parentElement;

  for (let d = 0; el && d < 8; d++, el = el.parentElement) {
    try {
      const pos = getComputedStyle(el).position;
      if (pos === 'static') continue;
      const r   = el.getBoundingClientRect();
      const a   = r.width * r.height;
      if (a === 0 || r.width < vr.width - 2) continue;
      if (a <= area * 3) {
        best = el;
        if (a > area * 1.05) break; // found a meaningfully larger wrapper
      }
    } catch { break; }
  }
  return best;
}

/** Element rect in top-level window coordinates (walks same-origin frame chain). */
function getAbsoluteRect(el) {
  let rect = { ...el.getBoundingClientRect() };
  let win  = el.ownerDocument?.defaultView;
  while (win && win !== window.top) {
    try {
      const fe = win.frameElement;
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      rect = { left: fr.left + rect.left, top: fr.top + rect.top, width: rect.width, height: rect.height };
      win  = fe.ownerDocument?.defaultView;
    } catch { break; }
  }
  return rect;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function pickMimeType() {
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  return candidates.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || 'video/webm';
}

function getSubtitleText(el) {
  const vid = el?.tagName === 'VIDEO' ? el : el?.querySelector('video');
  if (!vid) return '';
  for (const track of Array.from(vid.textTracks || [])) {
    if (track.mode === 'showing' && track.activeCues?.length) {
      return Array.from(track.activeCues)
        .map(c => (c.text || '').replace(/<[^>]+>/g, '').trim())
        .filter(Boolean).join('\n');
    }
  }
  return '';
}

function drawSubtitle(ctx, canvas, text) {
  const sz = Math.max(16, Math.round(canvas.height * 0.038));
  ctx.font = `bold ${sz}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineWidth = Math.max(2, sz * 0.12);
  const y = canvas.height - sz * 2.2;
  text.split('\n').forEach((line, i) => {
    const ly = y + i * (sz + 5);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.strokeText(line, canvas.width / 2, ly);
    ctx.fillStyle   = '#fff';            ctx.fillText(line,   canvas.width / 2, ly);
  });
}

function saveBlob(blob, ext) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none'; a.href = url;
  a.download = `recording_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
}

function cleanup() {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  if (tempVid)   { tempVid.srcObject = null; tempVid = null; }
  tabStream?.getTracks().forEach(t => t.stop());
  tabStream = null; recStream = null;
}

// ── Tab capture (always called from top frame) ────────────────────────────────
/**
 * @param streamId   chrome.tabCapture stream ID
 * @param cropEl     element to crop to (null when using fixedRect for cross-origin iframe)
 * @param fixedRect  pre-computed absolute rect from popup (cross-origin iframes)
 */
async function startViaTabCapture(streamId, cropEl, fixedRect) {
  tabStream = await navigator.mediaDevices.getUserMedia({
    video: {
      mandatory: {
        chromeMediaSource:   'tab',
        chromeMediaSourceId: streamId,
        maxWidth:            screen.width  * (window.devicePixelRatio || 1),
        maxHeight:           screen.height * (window.devicePixelRatio || 1),
        maxFrameRate:        60,
      },
    },
    audio: {
      mandatory: {
        chromeMediaSource:   'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  tempVid = document.createElement('video');
  tempVid.srcObject = new MediaStream(tabStream.getVideoTracks());
  tempVid.muted = true;
  await tempVid.play();
  await new Promise(r => { tempVid.onloadedmetadata = r; setTimeout(r, 2000); });

  const tabW = tempVid.videoWidth  || screen.width;
  const tabH = tempVid.videoHeight || screen.height;

  // Use fixedRect (cross-origin iframe) or calculate from cropEl position
  const initRect = fixedRect || getAbsoluteRect(cropEl);
  const canvas   = document.createElement('canvas');
  canvas.width   = Math.round(initRect.width)  || 1280;
  canvas.height  = Math.round(initRect.height) || 720;
  const ctx = canvas.getContext('2d');

  function drawFrame() {
    const rect = fixedRect || getAbsoluteRect(cropEl);
    const sx = (rect.left  / window.innerWidth)  * tabW;
    const sy = (rect.top   / window.innerHeight) * tabH;
    const sw = (rect.width  / window.innerWidth)  * tabW;
    const sh = (rect.height / window.innerHeight) * tabH;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempVid, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    // WebVTT cues as text overlay; custom overlays are baked in by the crop
    const sub = cropEl ? getSubtitleText(cropEl) : '';
    if (sub) drawSubtitle(ctx, canvas, sub);

    animFrame = requestAnimationFrame(drawFrame);
  }
  drawFrame();

  recStream = canvas.captureStream(30);
  tabStream.getAudioTracks().forEach(t => recStream.addTrack(t));
  return recStream;
}

// ── Element captureStream fallback ────────────────────────────────────────────
async function startViaElementCapture(videoEl) {
  const elemStream = videoEl.captureStream();
  if (!elemStream.getTracks().length) throw new Error('captureStream() returned no tracks (DRM or CORS restriction).');

  const [vt]   = elemStream.getVideoTracks();
  const s      = vt.getSettings();
  const canvas = document.createElement('canvas');
  canvas.width  = s.width  || videoEl.videoWidth  || 1280;
  canvas.height = s.height || videoEl.videoHeight || 720;
  const ctx = canvas.getContext('2d');

  tempVid = document.createElement('video');
  tempVid.srcObject = new MediaStream([vt]);
  tempVid.muted = true;
  await tempVid.play();

  function drawFrame() {
    ctx.drawImage(tempVid, 0, 0, canvas.width, canvas.height);
    const sub = getSubtitleText(videoEl);
    if (sub) drawSubtitle(ctx, canvas, sub);
    animFrame = requestAnimationFrame(drawFrame);
  }
  drawFrame();

  recStream = canvas.captureStream(30);
  elemStream.getAudioTracks().forEach(t => recStream.addTrack(t));
  return recStream;
}

// ── Main orchestrator ─────────────────────────────────────────────────────────
async function beginRecording(streamId, absoluteRect, captureSubtitles) {
  // Try to find the video element (works for top-frame + same-origin iframes)
  const videoEl = findBestVideo();

  // For cross-origin iframes, absoluteRect is provided; videoEl may be null here
  if (!videoEl && !absoluteRect) {
    throw new Error('No video found. If the player is in a cross-origin iframe the tab may need a refresh.');
  }

  let stream, mode;

  if (streamId) {
    // Determine the crop element (only when we have the video element)
    const cropEl = videoEl
      ? (captureSubtitles ? findPlayerContainer(videoEl) : videoEl)
      : null;  // null = use fixedRect

    try {
      stream = await startViaTabCapture(streamId, cropEl, absoluteRect || null);
      mode   = 'tab-capture';
    } catch (e) {
      console.warn('[VR] Tab capture failed:', e.message);
      if (!videoEl) throw new Error('Tab capture failed and no direct video access available.');
      stream = await startViaElementCapture(videoEl);
      mode   = 'element-capture';
    }
  } else {
    if (!videoEl) throw new Error('No video element accessible for direct capture.');
    stream = await startViaElementCapture(videoEl);
    mode   = 'element-capture';
  }

  mimeType = pickMimeType();
  chunks   = [];
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    saveBlob(new Blob(chunks, { type: mimeType }), mimeType.includes('mp4') ? 'mp4' : 'webm');
    chunks = [];
    cleanup();
    chrome.runtime.sendMessage({ event: 'recording-stopped' }).catch(() => {});
  };
  recorder.start(1000);

  // Auto-stop when video ends (only if we have access to the element)
  if (videoEl) videoEl.addEventListener('ended', () => stopRecording(), { once: true });

  return { success: true, mimeType, isMP4: mimeType.includes('mp4'), mode };
}

function stopRecording() {
  if (!recorder || recorder.state === 'inactive') return { success: false, error: 'Not recording.' };
  try { recorder.stop(); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'status': {
      const video = findBestVideo();
      sendResponse({ hasVideo: !!video, isRecording: !!(recorder?.state === 'recording'), mimeType, streamUrls: capturedStreamUrls });
      break;
    }
    case 'start':
      beginRecording(msg.streamId, msg.absoluteRect, msg.captureSubtitles)
        .then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'stop':
      sendResponse(stopRecording());
      break;

    // Forwarded from iframe content scripts for auto-stop in cross-origin iframes
    case 'video-ended':
      stopRecording();
      sendResponse({ ok: true });
      break;
  }
  return true;
});

// ── Iframe video monitor (runs in every frame) ────────────────────────────────
// If this content script is running inside an iframe and finds a video,
// set up an 'ended' listener that notifies the top-frame content script.
if (window.self !== window.top) {
  const monitorVideo = () => {
    const v = document.querySelector('video');
    if (!v) return;
    v.addEventListener('ended', () => {
      // Send to frameId 0 (top frame content script)
      chrome.runtime.sendMessage({ action: 'video-ended' }).catch(() => {});
    }, { once: true });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', monitorVideo);
  } else {
    monitorVideo();
  }
}
