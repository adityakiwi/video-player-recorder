/**
 * content.js — injected into every frame (allFrames: true) by the popup.
 *
 * Strategy: chrome.tabCapture stream (full tab) → canvas crop to video element bounds.
 * This captures the exact visual render of the player including custom subtitle overlays.
 *
 * Supports videos inside same-origin iframes (recursive search + iframe-offset-aware
 * coordinate calculation). For cross-origin iframes, the popup passes in a pre-computed
 * absoluteRect so canvas crop still works correctly.
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

/**
 * Recursively collects all <video> elements in this document and any accessible
 * (same-origin) nested iframes.
 */
function collectVideos(doc) {
  const vids = Array.from(doc.querySelectorAll('video'));
  for (const iframe of doc.querySelectorAll('iframe')) {
    try {
      if (iframe.contentDocument) vids.push(...collectVideos(iframe.contentDocument));
    } catch { /* cross-origin — skip */ }
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
      const r  = v.getBoundingClientRect();
      const br = best.getBoundingClientRect();
      return r.width * r.height > br.width * br.height ? v : best;
    } catch { return best; }
  });
}

/**
 * Walks up from the <video> element to find the player container —
 * the nearest ancestor that wraps both the video and its subtitle/overlay divs.
 *
 * Most players look like:
 *   <div class="player" style="position:relative">   ← player container
 *     <video>...</video>
 *     <div class="subtitles">...</div>               ← sibling overlay
 *   </div>
 *
 * We walk up until we find a positioned ancestor whose area is ≤ 2× the video's
 * area (so we don't accidentally grab the full page wrapper).
 */
function findPlayerContainer(videoEl) {
  const videoRect = videoEl.getBoundingClientRect();
  const videoArea = videoRect.width * videoRect.height;
  if (videoArea === 0) return videoEl;

  let el = videoEl.parentElement;
  let best = videoEl;

  for (let depth = 0; el && depth < 8; depth++, el = el.parentElement) {
    try {
      const style = getComputedStyle(el);
      const pos   = style.position;
      // Only consider positioned containers (subtitle overlays need a positioned parent)
      if (pos !== 'relative' && pos !== 'absolute' && pos !== 'fixed' && pos !== 'sticky') continue;

      const r    = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area === 0) continue;

      // Accept if it's close in size to the video (≤3× area) and covers the video
      if (area <= videoArea * 3 && r.width >= videoRect.width - 2 && r.height >= videoRect.height - 2) {
        best = el;
        // Keep going up to catch a slightly larger container that holds the subtitle layer
        if (area > videoArea * 1.05) break; // found a meaningfully larger wrapper — stop here
      }
    } catch { break; }
  }

  return best;
}

/**
 * Returns an element's bounding rect in top-level window coordinates,
 * walking up the frame chain for same-origin iframes.
 */
function getAbsoluteRect(el) {
  let rect = { ...el.getBoundingClientRect() };
  let win  = el.ownerDocument?.defaultView;

  while (win && win !== window.top) {
    try {
      const frameEl   = win.frameElement;
      if (!frameEl) break;
      const frameRect = frameEl.getBoundingClientRect();
      rect = {
        left:   frameRect.left + rect.left,
        top:    frameRect.top  + rect.top,
        width:  rect.width,
        height: rect.height,
      };
      win = frameEl.ownerDocument?.defaultView;
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
  return candidates.find(t => {
    try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
  }) || 'video/webm';
}

function getSubtitleText(videoEl) {
  for (const track of Array.from(videoEl.textTracks || [])) {
    if (track.mode === 'showing' && track.activeCues?.length) {
      return Array.from(track.activeCues)
        .map(c => (c.text || '').replace(/<[^>]+>/g, '').trim())
        .filter(Boolean)
        .join('\n');
    }
  }
  return '';
}

function saveBlob(blob, ext) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.style.display = 'none';
  a.href     = url;
  a.download = `recording_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
}

function cleanup() {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  if (tempVid)   { tempVid.srcObject = null; tempVid = null; }
  tabStream?.getTracks().forEach(t => t.stop());
  tabStream = null;
  recStream = null;
}

// ── Tab-capture path (preferred) ──────────────────────────────────────────────
/**
 * @param streamId    — from chrome.tabCapture.getMediaStreamId()
 * @param videoEl     — the video element
 * @param fixedRect   — pre-computed absolute rect (used when video is in cross-origin iframe)
 */
async function startViaTabCapture(streamId, videoEl, fixedRect) {
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

  // Crop to the player container (wraps video + subtitle overlay divs), not bare <video>
  const cropEl   = findPlayerContainer(videoEl);
  const initRect = fixedRect || getAbsoluteRect(cropEl);
  const canvas   = document.createElement('canvas');
  canvas.width   = Math.round(initRect.width)  || 1280;
  canvas.height  = Math.round(initRect.height) || 720;
  const ctx = canvas.getContext('2d');

  function drawFrame() {
    // Recalculate each frame in case player moved / resized
    const rect = fixedRect || getAbsoluteRect(cropEl);

    const sx = (rect.left  / window.innerWidth)  * tabW;
    const sy = (rect.top   / window.innerHeight) * tabH;
    const sw = (rect.width  / window.innerWidth)  * tabW;
    const sh = (rect.height / window.innerHeight) * tabH;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempVid, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    // WebVTT subtitle overlay (custom overlays already baked in via canvas crop)
    const sub = getSubtitleText(videoEl);
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
  if (!elemStream.getTracks().length) {
    throw new Error('captureStream() returned no tracks (DRM or CORS restriction).');
  }

  const [videoTrack] = elemStream.getVideoTracks();
  const settings = videoTrack.getSettings();
  const canvas   = document.createElement('canvas');
  canvas.width   = settings.width  || videoEl.videoWidth  || 1280;
  canvas.height  = settings.height || videoEl.videoHeight || 720;
  const ctx = canvas.getContext('2d');

  tempVid = document.createElement('video');
  tempVid.srcObject = new MediaStream([videoTrack]);
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

function drawSubtitle(ctx, canvas, text) {
  const fontSize = Math.max(16, Math.round(canvas.height * 0.038));
  ctx.font      = `bold ${fontSize}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineWidth = Math.max(2, fontSize * 0.12);
  const y = canvas.height - fontSize * 2.2;
  text.split('\n').forEach((line, i) => {
    const ly = y + i * (fontSize + 5);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(line, canvas.width / 2, ly);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(line, canvas.width / 2, ly);
  });
}

// ── Main recording orchestrator ───────────────────────────────────────────────
async function beginRecording(streamId, absoluteRect) {
  const videoEl = findBestVideo();
  if (!videoEl) throw new Error('No video element found on this page or its iframes.');

  let stream, mode;

  if (streamId) {
    try {
      stream = await startViaTabCapture(streamId, videoEl, absoluteRect || null);
      mode   = 'tab-capture';
    } catch (e) {
      console.warn('[VR] Tab capture failed, falling back to captureStream():', e.message);
      stream = await startViaElementCapture(videoEl);
      mode   = 'element-capture';
    }
  } else {
    stream = await startViaElementCapture(videoEl);
    mode   = 'element-capture';
  }

  mimeType = pickMimeType();
  chunks   = [];
  recorder = new MediaRecorder(stream, { mimeType });

  recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const isMP4 = mimeType.includes('mp4');
    saveBlob(new Blob(chunks, { type: mimeType }), isMP4 ? 'mp4' : 'webm');
    chunks = [];
    cleanup();
    chrome.runtime.sendMessage({ event: 'recording-stopped' }).catch(() => {});
  };

  recorder.start(1000);
  videoEl.addEventListener('ended', () => stopRecording(), { once: true });

  return { success: true, mimeType, isMP4: mimeType.includes('mp4'), mode };
}

function stopRecording() {
  if (!recorder || recorder.state === 'inactive') {
    return { success: false, error: 'Not currently recording.' };
  }
  try {
    recorder.stop();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'status': {
      const video = findBestVideo();
      sendResponse({
        hasVideo:    !!video,
        isRecording: !!(recorder && recorder.state === 'recording'),
        mimeType,
        streamUrls:  capturedStreamUrls,
      });
      break;
    }
    case 'start':
      beginRecording(msg.streamId, msg.absoluteRect)
        .then(sendResponse)
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'stop':
      sendResponse(stopRecording());
      break;
  }
  return true;
});
