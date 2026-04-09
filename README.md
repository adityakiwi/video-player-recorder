# Video Player Recorder

A Chrome extension (Manifest V3) that records any HTML5 video player — including audio and subtitles — and saves the output as MP4.

Optimized for the **Emeritus** video platform but works on any site with an HTML5 `<video>` element.

---

## Features

| Feature | Details |
|---------|---------|
| **Screen crop recording** | Captures the tab stream and crops it to the video element bounds, so player overlays and rendered subtitles are baked into the recording |
| **Player stream fallback** | Falls back to `video.captureStream()` when tab capture is unavailable; draws WebVTT cues manually |
| **Auto-stop** | Recording stops automatically when the video `ended` event fires |
| **HLS stream detection** | Intercepts `.m3u8` requests on Emeritus CDN domains and surfaces the URL in the popup for direct access |
| **MP4 output** | Uses H.264 + AAC when available; falls back to WebM |

---

## Install

### Download (easiest)

1. Go to [Releases](../../releases) and download the latest `video-player-recorder-vX.X.X.zip`
2. Unzip to any folder
3. Open Chrome → `chrome://extensions`
4. Enable **Developer mode** (top-right toggle)
5. Click **Load unpacked** → select the unzipped folder

### Build locally

```bash
git clone https://github.com/adityakiwi/video-player-recorder.git
cd video-player-recorder
bash build.sh
# Produces: ../video-player-recorder-v2.0.0.zip
```

Then follow steps 2–5 above.

---

## Usage

1. Navigate to a page with a video player
2. Click the extension icon
3. Choose mode:
   - **Screen crop** — best quality, subtitles included (requires tab capture permission prompt)
   - **Player stream** — no prompt, WebVTT subtitles only
4. Click **Start Recording**
5. Recording stops automatically when the video ends, or click **Stop & Save**
6. File downloads to your Downloads folder

---

## Architecture

```
manifest.json      — MV3, tabCapture + scripting permissions
interceptor.js     — Injected at document_start in MAIN world on Emeritus domains;
                     intercepts XHR/fetch to capture .m3u8 CDN URLs
content.js         — Tab capture stream → canvas crop to video element bounds;
                     subtitle overlay; auto-stop on video.ended
popup.html/js      — UI, mode toggle, HLS URL display
background.js      — Minimal MV3 service worker
```

### Emeritus CDN map

| Player domain | CDN |
|---------------|-----|
| `video-test.emeritus.org` | `cdn1-video-stage.emeritus.org` |
| `videocast-stage.emeritus.org` | `cdn-vc-stage.emeritus.org` |
| `videocast.emeritus.org` | `cdn.videocast.emeritus.org` |

---

## CI / CD

Every push to `main` triggers GitHub Actions which:
1. Validates `manifest.json`
2. Builds the zip
3. Publishes a GitHub Release with the zip attached

Artifacts are also available directly in the [Actions tab](../../actions) for 90 days.
