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
// Common subtitle overlay selectors across popular HTML5 video players
const SUBTITLE_SELECTORS = [
  '.playkit-subtitles',           // Kaltura PlayKit
  '.playkit-captions',
  '[class*="playkit-subtitle"]',
  '[class*="playkit-caption"]',
  '.jw-text-track-display',       // JW Player
  '.jw-captions-text',
  '.vjs-text-track-display',      // Video.js
  '.vjs-caption-window',
  '[class*="subtitle-text"]',
  '[class*="caption-text"]',
  '[class*="text-track"]',
  '[class*="captions-overlay"]',
  '[class*="cue-block"]',
  '[class*="subtitles-container"]',
  '.shaka-text-container',        // Shaka Player
  '.bmpui-ui-subtitle-overlay',   // Bitmovin
];

function getSubtitleText(videoEl) {
  // 1. Native WebVTT text tracks
  for (const track of Array.from(videoEl.textTracks || [])) {
    if (track.mode === 'showing' && track.activeCues?.length) {
      const text = Array.from(track.activeCues)
        .map(c => (c.text || '').replace(/<[^>]+>/g, '').trim())
        .filter(Boolean).join('\n');
      if (text) return text;
    }
  }

  // 2. DOM overlay elements in the player container
  const container = findPlayerContainer(videoEl);
  for (const sel of SUBTITLE_SELECTORS) {
    try {
      const el = container.querySelector(sel);
      if (el) {
        const text = el.textContent?.trim();
        if (text) return text;
      }
    } catch { /* bad selector, skip */ }
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

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.action) {
    case 'status': {
      const video = findBestVideo();
      sendResponse({ hasVideo: !!video, isRecording: recorder?.state === 'recording', mimeType, streamUrls: capturedStreamUrls });
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
  }
  return true;
});
