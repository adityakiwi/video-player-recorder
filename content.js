/**
 * content.js — injected into ALL frames (allFrames:true).
 *
 * Two auto modes:
 *   Auto Play  — attach 'play' listener; record when video plays, stop on 'ended'
 *   Auto Move  — queue all visible videos on page; record each in sequence
 *
 * Core capture: video.captureStream() + canvas compositing.
 * Subtitles: Chrome textTracks API + DOM overlay element fallback.
 */

// ── State ─────────────────────────────────────────────────────────────────────
let recorder   = null;
let chunks     = [];
let recStream  = null;
let animFrame  = null;
let tempVid    = null;
let mimeType   = '';
let capturedStreamUrls = [];

// Auto-play state
let autoMode        = false;
let autoSubtitles   = false;
let autoPlayHandler = null;

// Auto-move (queue) state
let autoMoveMode  = false;
let videoQueue    = [];
let queueIndex    = 0;

// ── Emeritus CDN ──────────────────────────────────────────────────────────────
window.addEventListener('__vr_stream__', (e) => {
  const url = e.detail?.url;
  if (url && !capturedStreamUrls.includes(url)) capturedStreamUrls.push(url);
});

// ── Video search ──────────────────────────────────────────────────────────────
function collectVideos(doc) {
  const vids = Array.from(doc.querySelectorAll('video'));
  for (const iframe of doc.querySelectorAll('iframe')) {
    try { if (iframe.contentDocument) vids.push(...collectVideos(iframe.contentDocument)); }
    catch { /* cross-origin */ }
  }
  return vids;
}

function visibleVideos() {
  return collectVideos(document).filter(v => {
    const r = v.getBoundingClientRect();
    return r.width > 50 && r.height > 50;
  });
}

function findBestVideo() {
  const all     = collectVideos(document);
  if (!all.length) return null;
  const playing = all.filter(v => !v.paused && !v.ended && v.readyState >= 2);
  const pool    = playing.length ? playing : all;
  return pool.reduce((best, v) => {
    try {
      const r = v.getBoundingClientRect(), br = best.getBoundingClientRect();
      return r.width * r.height > br.width * br.height ? v : best;
    } catch { return best; }
  });
}

function findPlayerContainer(videoEl) {
  const vr = videoEl.getBoundingClientRect();
  const va = vr.width * vr.height;
  if (va === 0) return videoEl;
  let best = videoEl, el = videoEl.parentElement;
  for (let d = 0; el && d < 8; d++, el = el.parentElement) {
    try {
      if (getComputedStyle(el).position === 'static') continue;
      const r = el.getBoundingClientRect(), a = r.width * r.height;
      if (a === 0 || r.width < vr.width - 2) continue;
      if (a <= va * 3) { best = el; if (a > va * 1.05) break; }
    } catch { break; }
  }
  return best;
}

// ── Subtitle detection ────────────────────────────────────────────────────────
const SUBTITLE_SELECTORS = [
  '.playkit-subtitles', '.playkit-captions',
  '[class*="playkit-subtitle"]', '[class*="playkit-caption"]',
  '.jw-text-track-display', '.jw-captions-text', '[class*="jw-captions"]',
  '.vjs-text-track-display', '.vjs-caption-window',
  '.shaka-text-container',
  '.bmpui-ui-subtitle-overlay',
  '[class*="subtitle-text"]', '[class*="caption-text"]',
  '[class*="captions-overlay"]', '[class*="cue-block"]',
  '[class*="subtitles-container"]', '[class*="text-track"]',
];

function getSubtitleText(videoEl) {
  // 1. Native textTracks (Chrome CC — works for HLS CEA-608 / WebVTT)
  const tracks = Array.from(videoEl.textTracks || []);

  for (const track of tracks) {
    if (track.mode === 'disabled') continue;
    if (!track.activeCues?.length) continue;
    const text = Array.from(track.activeCues)
      .map(c => (c.text || '').replace(/<[^>]+>/g, '').trim())
      .filter(Boolean).join('\n');
    if (text) return text;
  }

  // Enable disabled caption tracks so Chrome loads their cues
  for (const track of tracks) {
    if (track.kind !== 'captions' && track.kind !== 'subtitles') continue;
    if (track.mode !== 'disabled') continue;
    try {
      track.mode = 'hidden';
      const cues = track.activeCues;
      if (cues?.length) {
        const text = Array.from(cues)
          .map(c => (c.text || '').replace(/<[^>]+>/g, '').trim())
          .filter(Boolean).join('\n');
        if (text) return text;
      }
    } catch { track.mode = 'disabled'; }
  }

  // 2. DOM overlay elements (custom player renderers)
  const container = findPlayerContainer(videoEl);
  for (const sel of SUBTITLE_SELECTORS) {
    try {
      const el = container.querySelector(sel);
      if (el) {
        const text = el.textContent?.trim();
        if (text) return text;
      }
    } catch { /* bad selector */ }
  }

  return '';
}

// ── Canvas / recording helpers ────────────────────────────────────────────────
function pickMimeType() {
  const candidates = [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', 'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm',
  ];
  return candidates.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || 'video/webm';
}

function drawSubtitleText(ctx, canvas, text) {
  const sz = Math.max(16, Math.round(canvas.height * 0.038));
  ctx.save();
  ctx.font = `bold ${sz}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineWidth = Math.max(2, sz * 0.12);
  const baseY = canvas.height - sz * 1.8;
  text.split('\n').forEach((line, i) => {
    const y = baseY + i * (sz + 4);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(line, canvas.width / 2, y);
    ctx.fillStyle   = '#fff';              ctx.fillText(line,   canvas.width / 2, y);
  });
  ctx.restore();
}

function saveBlob(blob, ext) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), {
    href: url,
    download: `recording_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`,
    style: 'display:none',
  });
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
}

function cleanup() {
  if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
  if (tempVid)   { tempVid.srcObject = null; tempVid = null; }
  recStream?.getTracks().forEach(t => t.stop());
  recStream = null;
}

// ── Core recording ────────────────────────────────────────────────────────────
/**
 * @param {boolean} captureSubtitles
 * @param {HTMLVideoElement|null} specificVideo  pass to override findBestVideo()
 */
async function beginRecording(captureSubtitles, specificVideo = null) {
  const videoEl = specificVideo || findBestVideo();
  if (!videoEl) throw new Error('No video element found.');

  let elemStream;
  try { elemStream = videoEl.captureStream(); }
  catch (e) { throw new Error(`captureStream() failed: ${e.message}`); }
  if (!elemStream.getTracks().length)
    throw new Error('captureStream() returned no tracks — video may be DRM-protected.');

  const [videoTrack] = elemStream.getVideoTracks();
  const settings = videoTrack.getSettings();
  const canvas   = document.createElement('canvas');
  canvas.width   = settings.width  || videoEl.videoWidth  || 1280;
  canvas.height  = settings.height || videoEl.videoHeight || 720;
  const ctx      = canvas.getContext('2d');

  tempVid = document.createElement('video');
  tempVid.srcObject = new MediaStream([videoTrack]);
  tempVid.muted = true;
  await tempVid.play();

  function drawFrame() {
    ctx.drawImage(tempVid, 0, 0, canvas.width, canvas.height);
    if (captureSubtitles) {
      const sub = getSubtitleText(videoEl);
      if (sub) drawSubtitleText(ctx, canvas, sub);
    }
    animFrame = requestAnimationFrame(drawFrame);
  }
  drawFrame();

  recStream = canvas.captureStream(30);
  elemStream.getAudioTracks().forEach(t => recStream.addTrack(t));

  mimeType = pickMimeType();
  chunks   = [];
  recorder = new MediaRecorder(recStream, { mimeType });
  recorder.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };

  recorder.onstop = () => {
    saveBlob(new Blob(chunks, { type: mimeType }), mimeType.includes('mp4') ? 'mp4' : 'webm');
    chunks = [];
    cleanup();
    if (autoMoveMode) {
      // Auto-advance to next video in queue after short pause
      setTimeout(playNextInQueue, 1200);
    } else {
      chrome.runtime.sendMessage({ event: 'recording-stopped' }).catch(() => {});
    }
  };

  recorder.start(1000);

  // Auto-stop when this video ends (works for both auto modes and manual)
  videoEl.addEventListener('ended', () => {
    if (recorder?.state === 'recording') recorder.stop();
  }, { once: true });

  return { success: true, mimeType, isMP4: mimeType.includes('mp4') };
}

function stopRecording(cancelAutoMove = false) {
  if (cancelAutoMove) {
    autoMoveMode = false;
    videoQueue   = [];
    queueIndex   = 0;
  }
  if (!recorder || recorder.state === 'inactive') return { success: false, error: 'Not recording.' };
  try { recorder.stop(); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
}

// ── Auto Play ─────────────────────────────────────────────────────────────────
function enableAutoRecord(captureSubtitles, videoIndex = -1) {
  disableAutoRecord();
  disableAutoMove();

  const all   = collectVideos(document);
  const video = (videoIndex >= 0 && videoIndex < all.length)
    ? all[videoIndex]
    : findBestVideo();
  if (!video) return { success: false, error: 'No video found.' };

  autoMode      = true;
  autoSubtitles = captureSubtitles;

  autoPlayHandler = () => {
    if (!recorder || recorder.state === 'inactive') {
      beginRecording(autoSubtitles, video).catch(() => {});
    }
  };
  video.addEventListener('play', autoPlayHandler);

  if (!video.paused && !video.ended) autoPlayHandler();
  return { success: true };
}

function disableAutoRecord() {
  if (!autoMode) return;
  autoMode = false;
  if (autoPlayHandler) {
    findBestVideo()?.removeEventListener('play', autoPlayHandler);
    autoPlayHandler = null;
  }
}

// ── Auto Move (queue) ─────────────────────────────────────────────────────────
function enableAutoMove(captureSubtitles) {
  disableAutoRecord();
  disableAutoMove();

  // Use all videos, not just visually rendered ones — second video may not be
  // at full size yet when Auto Move is triggered.
  const vids = collectVideos(document);
  if (!vids.length) return { success: false, error: 'No videos found on this page.' };

  autoMoveMode  = true;
  autoSubtitles = captureSubtitles;
  videoQueue    = vids;
  queueIndex    = 0;

  playNextInQueue();
  return { success: true, total: vids.length };
}

function disableAutoMove() {
  autoMoveMode = false;
  videoQueue   = [];
  queueIndex   = 0;
}

async function playNextInQueue() {
  if (!autoMoveMode || queueIndex >= videoQueue.length) {
    const total = videoQueue.length;
    autoMoveMode = false;
    videoQueue   = [];
    queueIndex   = 0;
    chrome.runtime.sendMessage({ event: 'queue-complete', total }).catch(() => {});
    return;
  }

  const video   = videoQueue[queueIndex];
  const current = queueIndex + 1;
  const total   = videoQueue.length;
  queueIndex++;

  chrome.runtime.sendMessage({ event: 'queue-progress', current, total }).catch(() => {});

  // Rewind and play the video
  try {
    video.currentTime = 0;
    await video.play();
  } catch (e) {
    console.warn(`[VR] Auto Move: could not play video ${current}/${total}:`, e.message);
    // Skip unplayable video
    setTimeout(playNextInQueue, 500);
    return;
  }

  try {
    await beginRecording(autoSubtitles, video);
  } catch (e) {
    console.warn(`[VR] Auto Move: could not record video ${current}/${total}:`, e.message);
    setTimeout(playNextInQueue, 500);
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'status': {
      const vids = collectVideos(document);
      sendResponse({
        hasVideo:    vids.length > 0,
        videoCount:  vids.length,
        isRecording: recorder?.state === 'recording',
        autoMode,
        autoMoveMode,
        queueIndex,
        queueTotal:  videoQueue.length,
        mimeType,
        streamUrls:  capturedStreamUrls,
      });
      break;
    }
    case 'start':
      beginRecording(msg.captureSubtitles)
        .then(sendResponse).catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'stop':
      sendResponse(stopRecording(true)); // cancel auto modes too
      break;

    case 'enable-auto':
      sendResponse(enableAutoRecord(msg.captureSubtitles, msg.videoIndex ?? -1));
      break;

    case 'disable-auto':
      disableAutoRecord();
      sendResponse({ success: true });
      break;

    case 'enable-auto-move':
      sendResponse(enableAutoMove(msg.captureSubtitles));
      break;

    case 'disable-auto-move':
      disableAutoMove();
      sendResponse({ success: true });
      break;
  }
  return true;
});
