/**
 * content.js — injected into ALL frames (allFrames:true).
 *
 * Strategy: video.captureStream() for the raw video + audio stream, then
 * canvas compositing to add subtitle text drawn from DOM reading.
 *
 * This avoids getUserMedia(chromeMediaSource:'tab') which is unreliable
 * from content scripts (MV3 intends it for offscreen documents).
 *
 * "Video only"        → captureStream, no subtitle overlay
 * "Video + Subtitles" → captureStream + reads subtitle text from textTracks
 *                       AND from common player overlay DOM elements (Kaltura,
 *                       JW Player, VideoJS, etc.) and draws them on canvas
 */

// ── State ─────────────────────────────────────────────────────────────────────
let recorder   = null;
let chunks     = [];
let recStream  = null;
let animFrame  = null;
let tempVid    = null;
let mimeType   = '';
let capturedStreamUrls = [];

// Auto-record state
let autoMode         = false;
let autoSubtitles    = false;
let autoPlayHandler  = null;   // bound listener so we can remove it

// ── Emeritus CDN map ──────────────────────────────────────────────────────────
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

/** Nearest positioned ancestor that wraps the video + any overlay sibling divs. */
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

// DOM overlay selectors for common players (searched in player container)
const SUBTITLE_SELECTORS = [
  // Kaltura PlayKit (Emeritus)
  '.playkit-subtitles',
  '.playkit-captions',
  '[class*="playkit-subtitle"]',
  '[class*="playkit-caption"]',
  // JW Player
  '.jw-text-track-display',
  '.jw-captions-text',
  '[class*="jw-captions"]',
  // Video.js
  '.vjs-text-track-display',
  '.vjs-caption-window',
  // Shaka Player
  '.shaka-text-container',
  // Bitmovin
  '.bmpui-ui-subtitle-overlay',
  // Generic
  '[class*="subtitle-text"]',
  '[class*="caption-text"]',
  '[class*="captions-overlay"]',
  '[class*="cue-block"]',
  '[class*="subtitles-container"]',
  '[class*="text-track"]',
];

/**
 * Reads the current subtitle/CC text via two strategies:
 *
 * 1. Chrome's native textTracks API — works for HLS/DASH embedded CC (CEA-608,
 *    WebVTT in stream). Checks 'showing' tracks first, then briefly enables
 *    'disabled' caption/subtitle tracks to read their activeCues.
 *
 * 2. DOM overlay elements — covers custom player renderers (Kaltura, JW Player…)
 *    that draw their own subtitle divs on top of the video.
 */
function getSubtitleText(videoEl) {
  // ── Strategy 1: textTracks (Chrome CC) ──────────────────────────────────
  const tracks = Array.from(videoEl.textTracks || []);

  // First pass: tracks already showing or hidden (cues already loaded)
  for (const track of tracks) {
    if (track.mode === 'disabled') continue;
    if (!track.activeCues?.length) continue;
    const text = Array.from(track.activeCues)
      .map(c => (c.text || '').replace(/<[^>]+>/g, '').trim())
      .filter(Boolean).join('\n');
    if (text) return text;
  }

  // Second pass: try enabling any caption/subtitle track that's still disabled
  // so Chrome loads its cues. We flip it to 'hidden' (invisible but active).
  for (const track of tracks) {
    if (track.kind !== 'captions' && track.kind !== 'subtitles') continue;
    if (track.mode !== 'disabled') continue;
    try {
      track.mode = 'hidden';               // ask Chrome to load cues
      const cues = track.activeCues;
      if (cues?.length) {
        const text = Array.from(cues)
          .map(c => (c.text || '').replace(/<[^>]+>/g, '').trim())
          .filter(Boolean).join('\n');
        if (text) return text;
      }
      // Leave as 'hidden' so future frames can read it without re-enabling
    } catch { track.mode = 'disabled'; }
  }

  // ── Strategy 2: DOM overlay elements ────────────────────────────────────
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

// ── Canvas helpers ────────────────────────────────────────────────────────────
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

function drawSubtitleText(ctx, canvas, text) {
  const sz = Math.max(16, Math.round(canvas.height * 0.038));
  ctx.save();
  ctx.font      = `bold ${sz}px Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineWidth = Math.max(2, sz * 0.12);
  const baseY = canvas.height - sz * 1.8;
  text.split('\n').forEach((line, i) => {
    const y = baseY + i * (sz + 4);
    ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.strokeText(line, canvas.width / 2, y);
    ctx.fillStyle   = '#ffffff';           ctx.fillText(line,   canvas.width / 2, y);
  });
  ctx.restore();
}

function saveBlob(blob, ext) {
  const url = URL.createObjectURL(blob);
  const a   = Object.assign(document.createElement('a'), { href: url, download: `recording_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}` });
  a.style.display = 'none';
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
async function beginRecording(captureSubtitles) {
  const videoEl = findBestVideo();
  if (!videoEl) throw new Error('No video element found on this page or its accessible iframes.');

  // Get the raw stream from the video element
  let elemStream;
  try {
    elemStream = videoEl.captureStream();
  } catch (e) {
    throw new Error(`captureStream() failed: ${e.message}`);
  }
  if (!elemStream.getTracks().length) {
    throw new Error('captureStream() returned no tracks — the video may be DRM-protected.');
  }

  const [videoTrack] = elemStream.getVideoTracks();
  const settings = videoTrack.getSettings();

  const canvas = document.createElement('canvas');
  canvas.width  = settings.width  || videoEl.videoWidth  || 1280;
  canvas.height = settings.height || videoEl.videoHeight || 720;
  const ctx = canvas.getContext('2d');

  tempVid = document.createElement('video');
  tempVid.srcObject = new MediaStream([videoTrack]);
  tempVid.muted     = true;
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

  // Canvas video track + original audio tracks
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
    chrome.runtime.sendMessage({ event: 'recording-stopped' }).catch(() => {});
  };

  recorder.start(1000);
  videoEl.addEventListener('ended', () => stopRecording(), { once: true });

  return { success: true, mimeType, isMP4: mimeType.includes('mp4') };
}

function stopRecording() {
  if (!recorder || recorder.state === 'inactive') return { success: false, error: 'Not recording.' };
  try { recorder.stop(); return { success: true }; }
  catch (e) { return { success: false, error: e.message }; }
}

// ── Auto-record ───────────────────────────────────────────────────────────────
function enableAutoRecord(captureSubtitles) {
  // Remove any existing listener first
  disableAutoRecord();

  const video = findBestVideo();
  if (!video) return { success: false, error: 'No video found to watch.' };

  autoMode      = true;
  autoSubtitles = captureSubtitles;

  autoPlayHandler = () => {
    // Only start if not already recording
    if (!recorder || recorder.state === 'inactive') {
      beginRecording(autoSubtitles).catch(() => {});
    }
  };

  video.addEventListener('play', autoPlayHandler);

  // If video is already playing when auto-mode is enabled, start immediately
  if (!video.paused && !video.ended) {
    autoPlayHandler();
  }

  return { success: true };
}

function disableAutoRecord() {
  autoMode = false;
  if (autoPlayHandler) {
    const video = findBestVideo();
    video?.removeEventListener('play', autoPlayHandler);
    autoPlayHandler = null;
  }
  return { success: true };
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'status': {
      const video = findBestVideo();
      sendResponse({
        hasVideo:    !!video,
        isRecording: recorder?.state === 'recording',
        autoMode,
        mimeType,
        streamUrls:  capturedStreamUrls,
      });
      break;
    }
    case 'start':
      beginRecording(msg.captureSubtitles)
        .then(sendResponse)
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'stop':
      sendResponse(stopRecording());
      break;

    case 'enable-auto':
      sendResponse(enableAutoRecord(msg.captureSubtitles));
      break;

    case 'disable-auto':
      sendResponse(disableAutoRecord());
      break;
  }
  return true;
});
