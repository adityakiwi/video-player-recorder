/**
 * content.js — injected on demand by the popup via chrome.scripting.executeScript.
 *
 * Strategy: chrome.tabCapture stream (full tab) → canvas crop to video element bounds.
 * This captures the exact visual render of the player including custom subtitle overlays.
 * Audio comes from the tab capture stream (not video.captureStream) for full fidelity.
 *
 * Falls back to video.captureStream() if tabCapture stream ID is not provided.
 */

// ── State ────────────────────────────────────────────────────────────────────
let recorder    = null;
let chunks      = [];
let tabStream   = null;
let recStream   = null;   // canvas + audio stream fed into MediaRecorder
let animFrame   = null;
let tempVid     = null;
let mimeType    = '';
let capturedStreamUrls = []; // HLS .m3u8 URLs from interceptor.js

// ── Emeritus CDN map (mirrors interceptor.js for status display) ──────────
const cdnUrlMap = {
  'video-test.emeritus.org':      'https://cdn1-video-stage.emeritus.org',
  'videocast-stage.emeritus.org': 'https://cdn-vc-stage.emeritus.org',
  'videocast.emeritus.org':       'https://cdn.videocast.emeritus.org',
};

// Collect M3U8 URLs bubbled up from interceptor.js (MAIN world → ISOLATED world)
window.addEventListener('__vr_stream__', (e) => {
  const url = e.detail?.url;
  if (url && !capturedStreamUrls.includes(url)) capturedStreamUrls.push(url);
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function findBestVideo() {
  const all = Array.from(document.querySelectorAll('video'));
  if (!all.length) return null;
  const playing = all.filter(v => !v.paused && !v.ended && v.readyState >= 2);
  const pool = playing.length ? playing : all;
  return pool.reduce((best, v) => {
    const r  = v.getBoundingClientRect();
    const br = best.getBoundingClientRect();
    return r.width * r.height > br.width * br.height ? v : best;
  });
}

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

/** Read active WebVTT/SRT cue text (strips HTML tags). */
function getSubtitleText(videoEl) {
  const tracks = Array.from(videoEl.textTracks || []);
  for (const track of tracks) {
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
  const a = document.createElement('a');
  a.style.display = 'none';
  a.href = url;
  a.download = `recording_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
}

function cleanup() {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  if (tempVid)   { tempVid.srcObject = null; tempVid = null; }
  tabStream?.getTracks().forEach(t => t.stop());
  tabStream  = null;
  recStream  = null;
}

// ── Core recording ────────────────────────────────────────────────────────────

/**
 * Tab-capture path (preferred):
 *   Uses a streamId from chrome.tabCapture.getMediaStreamId().
 *   Feeds the full-tab video into a canvas, cropped to the video element bounds.
 *   Subtitles rendered by the browser (including custom player overlays) are captured.
 */
async function startViaTabCapture(streamId, videoEl) {
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

  // Hidden video element to render the captured tab stream
  tempVid = document.createElement('video');
  tempVid.srcObject = new MediaStream(tabStream.getVideoTracks());
  tempVid.muted = true;
  await tempVid.play();
  await new Promise(r => { tempVid.onloadedmetadata = r; setTimeout(r, 2000); });

  const tabW = tempVid.videoWidth  || screen.width;
  const tabH = tempVid.videoHeight || screen.height;

  // Canvas sized to the video element's CSS dimensions
  const initRect = videoEl.getBoundingClientRect();
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(initRect.width)  || 1280;
  canvas.height = Math.round(initRect.height) || 720;
  const ctx = canvas.getContext('2d');

  function drawFrame() {
    const rect = videoEl.getBoundingClientRect();

    // Map CSS rect → tab stream pixel space
    const sx = (rect.left / window.innerWidth)  * tabW;
    const sy = (rect.top  / window.innerHeight) * tabH;
    const sw = (rect.width  / window.innerWidth)  * tabW;
    const sh = (rect.height / window.innerHeight) * tabH;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempVid, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

    // Overlay WebVTT subtitles (handles <track> elements; custom overlays are
    // already baked in by the canvas crop from the tab capture)
    const sub = getSubtitleText(videoEl);
    if (sub) {
      const fontSize = Math.max(16, Math.round(canvas.height * 0.038));
      ctx.font = `bold ${fontSize}px 'Arial', sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = Math.max(2, fontSize * 0.12);
      const y = canvas.height - fontSize * 2.2;
      sub.split('\n').forEach((line, i) => {
        const ly = y + i * (fontSize + 5);
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.strokeText(line, canvas.width / 2, ly);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(line, canvas.width / 2, ly);
      });
    }

    animFrame = requestAnimationFrame(drawFrame);
  }

  drawFrame();

  // Combine canvas stream (video) with tab audio tracks
  recStream = canvas.captureStream(30);
  tabStream.getAudioTracks().forEach(t => recStream.addTrack(t));

  return recStream;
}

/**
 * Fallback path: video.captureStream()
 * Does NOT capture custom player subtitle overlays, but works without tabCapture.
 * WebVTT <track> subtitles are drawn manually via canvas.
 */
async function startViaElementCapture(videoEl) {
  const elemStream = videoEl.captureStream();
  if (!elemStream.getTracks().length) {
    throw new Error('captureStream() returned no tracks (DRM or CORS restriction).');
  }

  const [videoTrack] = elemStream.getVideoTracks();
  const settings = videoTrack.getSettings();
  const canvas = document.createElement('canvas');
  canvas.width  = settings.width  || videoEl.videoWidth  || 1280;
  canvas.height = settings.height || videoEl.videoHeight || 720;
  const ctx = canvas.getContext('2d');

  tempVid = document.createElement('video');
  tempVid.srcObject = new MediaStream([videoTrack]);
  tempVid.muted = true;
  await tempVid.play();

  function drawFrame() {
    ctx.drawImage(tempVid, 0, 0, canvas.width, canvas.height);
    const sub = getSubtitleText(videoEl);
    if (sub) {
      const fontSize = Math.max(16, Math.round(canvas.height * 0.038));
      ctx.font = `bold ${fontSize}px 'Arial', sans-serif`;
      ctx.textAlign = 'center';
      ctx.lineWidth = Math.max(2, fontSize * 0.12);
      const y = canvas.height - fontSize * 2.2;
      sub.split('\n').forEach((line, i) => {
        const ly = y + i * (fontSize + 5);
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.strokeText(line, canvas.width / 2, ly);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(line, canvas.width / 2, ly);
      });
    }
    animFrame = requestAnimationFrame(drawFrame);
  }
  drawFrame();

  recStream = canvas.captureStream(30);
  elemStream.getAudioTracks().forEach(t => recStream.addTrack(t));
  return recStream;
}

async function beginRecording(streamId) {
  const videoEl = findBestVideo();
  if (!videoEl) throw new Error('No video element found on this page.');

  let stream;
  let mode;

  if (streamId) {
    try {
      stream = await startViaTabCapture(streamId, videoEl);
      mode = 'tab-capture';
    } catch (e) {
      console.warn('[VR] Tab capture failed, falling back to captureStream():', e);
      stream = await startViaElementCapture(videoEl);
      mode = 'element-capture';
    }
  } else {
    stream = await startViaElementCapture(videoEl);
    mode = 'element-capture';
  }

  mimeType = pickMimeType();
  chunks   = [];
  recorder = new MediaRecorder(stream, { mimeType });

  recorder.ondataavailable = (e) => {
    if (e.data?.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    const isMP4 = mimeType.includes('mp4');
    saveBlob(new Blob(chunks, { type: mimeType }), isMP4 ? 'mp4' : 'webm');
    chunks = [];
    cleanup();
    // Notify popup that recording stopped (auto-stop on video end)
    chrome.runtime.sendMessage({ event: 'recording-stopped' }).catch(() => {});
  };

  recorder.start(1000); // 1-second chunks for resilience

  // ── Auto-stop when the video finishes playing ────────────────────────────
  const onEnded = () => stopRecording();
  videoEl.addEventListener('ended', onEnded, { once: true });

  return { success: true, mimeType, isMP4: mimeType.includes('mp4'), mode };
}

function stopRecording() {
  if (!recorder || recorder.state === 'inactive') {
    return { success: false, error: 'Not currently recording.' };
  }
  try {
    recorder.stop(); // triggers onstop → saveBlob → cleanup
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
      beginRecording(msg.streamId)
        .then(sendResponse)
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true; // async

    case 'stop':
      sendResponse(stopRecording());
      break;
  }
  return true;
});
