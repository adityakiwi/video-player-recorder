const dot        = document.getElementById('dot');
const statusText = document.getElementById('statusText');
const timerEl    = document.getElementById('timer');
const listEl     = document.getElementById('videoList');
const btnMove    = document.getElementById('btnMove');
const btnStop    = document.getElementById('btnStop');
const msgEl      = document.getElementById('msg');

let tabId                   = null;
let videoFrameId            = 0;
let videoEntries            = [];
let timerInterval           = null;
let elapsed                 = 0;
let autoMoveActive          = false;
let currentRecordingFrameId = 0;

const pad = n => String(n).padStart(2, '0');
function fmtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
function startTimer() {
  elapsed = 0; timerEl.textContent = '00:00'; timerEl.style.display = 'inline';
  timerInterval = setInterval(() => { timerEl.textContent = fmtTime(++elapsed); }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval); timerInterval = null; timerEl.style.display = 'none'; elapsed = 0;
}
function setMsg(t, type = '') {
  msgEl.textContent = t; msgEl.className = 'msg' + (type ? ` ${type}` : '');
}
function sendToFrame(tid, fid, payload) {
  return new Promise(resolve => {
    chrome.tabs.sendMessage(tid, payload, { frameId: fid }, resp => {
      resolve(chrome.runtime.lastError ? null : resp);
    });
  });
}

// ── Scan all frames for videos + extract titles from main-frame headings ───────
async function scanVideos(tid) {
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: tid, allFrames: true },
      func: () => {
        function collectVids(doc) {
          const v = Array.from(doc.querySelectorAll('video'));
          for (const f of doc.querySelectorAll('iframe')) {
            try { if (f.contentDocument) v.push(...collectVids(f.contentDocument)); } catch {}
          }
          return v;
        }
        return { count: collectVids(document).length };
      },
    });
  } catch { return []; }

  // Titles: only iframes that have a preceding <h2/h3/h1> (video iframes)
  let iframeHeadings = [];
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tid, frameIds: [0] },
      func: () => {
        function headingBefore(iframe) {
          let el = iframe.parentElement;
          while (el) {
            let sib = el.previousElementSibling;
            while (sib) {
              if (/^H[1-6]$/.test(sib.tagName)) return sib.textContent.trim();
              const h = sib.querySelector('h1,h2,h3,h4');
              if (h?.textContent?.trim()) return h.textContent.trim();
              sib = sib.previousElementSibling;
            }
            el = el.parentElement;
          }
          return '';
        }
        return Array.from(document.querySelectorAll('iframe'))
          .map(headingBefore)
          .filter(Boolean);
      },
    });
    iframeHeadings = r?.result || [];
  } catch {}

  const sorted = [...results].sort((a, b) => a.frameId - b.frameId);
  const entries = [];
  let gi = 0, bestCount = 0, iframeIdx = 0;

  for (const r of sorted) {
    if (r.frameId === 0) continue;
    const count = r.result?.count || 0;
    if (count > bestCount) { bestCount = count; videoFrameId = r.frameId; }
    const title = iframeHeadings[iframeIdx++] || '';
    for (let i = 0; i < count; i++) entries.push({ frameId: r.frameId, localIndex: i, globalIndex: gi++, title });
  }
  for (const r of sorted) {
    if (r.frameId !== 0) continue;
    const count = r.result?.count || 0;
    if (count > bestCount) { bestCount = count; videoFrameId = r.frameId; }
    for (let i = 0; i < count; i++) entries.push({ frameId: r.frameId, localIndex: i, globalIndex: gi++, title: '' });
  }
  return entries;
}

// ── Per-video Record button ────────────────────────────────────────────────────
async function recordOne(gi, btn) {
  const entry = videoEntries[gi];
  if (!entry) return;
  btn.disabled = true; btn.textContent = '…';
  const result = await sendToFrame(tabId, entry.frameId, {
    action: 'record-video', localIndex: entry.localIndex, title: entry.title || '',
  });
  if (result?.success) {
    currentRecordingFrameId = entry.frameId;
    setMsg(`Downloading video ${gi + 1}…`);
    btnStop.style.display = 'block';
    dot.className = 'dot rec'; statusText.textContent = 'Recording…';
    if (!timerInterval) startTimer();
  } else {
    btn.disabled = false; btn.textContent = '⬇ Download';
    setMsg(result?.error || 'Could not start.', 'err');
  }
}

// ── Auto Move — popup-orchestrated across all frames ──────────────────────────
btnMove.addEventListener('click', async () => {
  if (autoMoveActive) {
    autoMoveActive = false;
    await sendToFrame(tabId, currentRecordingFrameId, { action: 'stop' });
    btnMove.classList.remove('active');
    btnMove.textContent = '⟳ Download all in sequence';
    setMsg('Stopped.');
    return;
  }
  if (!videoEntries.length) return;

  autoMoveActive = true;
  const total = videoEntries.length;
  btnMove.classList.add('active');
  btnMove.textContent = `⟳ Downloading all — ${total} video${total !== 1 ? 's' : ''}`;
  btnStop.style.display = 'block';
  dot.className = 'dot rec'; statusText.textContent = `1 of ${total}…`;
  startTimer();

  for (let i = 0; i < videoEntries.length; i++) {
    if (!autoMoveActive) break;
    const entry = videoEntries[i];
    setMsg(`Downloading ${i + 1} of ${total}…`);
    statusText.textContent = `${i + 1} of ${total}…`;
    currentRecordingFrameId = entry.frameId;

    // Scroll the correct video iframe into view
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        func: idx => {
          function hasHeading(iframe) {
            let el = iframe.parentElement;
            while (el) {
              let s = el.previousElementSibling;
              while (s) { if (/^H[1-6]$/.test(s.tagName) || s.querySelector('h1,h2,h3')) return true; s = s.previousElementSibling; }
              el = el.parentElement;
            }
            return false;
          }
          const vf = Array.from(document.querySelectorAll('iframe')).filter(hasHeading);
          if (vf[idx]) vf[idx].scrollIntoView({ behavior: 'instant', block: 'center' });
        },
        args: [i],
      });
      await new Promise(r => setTimeout(r, 800));
    } catch {}

    const ok = await new Promise(resolve => {
      const timer = setTimeout(() => done(false), 30 * 60 * 1000);
      function done(v) { clearTimeout(timer); chrome.runtime.onMessage.removeListener(onMsg); resolve(v); }
      function onMsg(msg) { if (msg.event === 'recording-stopped') done(true); }
      chrome.runtime.onMessage.addListener(onMsg);
      sendToFrame(tabId, entry.frameId, {
        action: 'record-video', localIndex: entry.localIndex, title: entry.title || '',
      }).then(resp => { if (resp && !resp.success) done(false); }).catch(() => done(false));
    });

    if (!autoMoveActive) break;
    if (!ok) setMsg(`Video ${i + 1} skipped.`, 'err');
    if (i < videoEntries.length - 1) await new Promise(r => setTimeout(r, 1500));
  }

  autoMoveActive = false;
  btnMove.classList.remove('active');
  btnMove.textContent = '⟳ Download all in sequence';
  stopTimer();
  dot.className = 'dot ok'; statusText.textContent = 'All done';
  btnStop.style.display = 'none';
  setMsg(`All ${total} videos saved.`, 'ok');
});

// ── Stop ──────────────────────────────────────────────────────────────────────
btnStop.addEventListener('click', async () => {
  autoMoveActive = false;
  await sendToFrame(tabId, currentRecordingFrameId || videoFrameId, { action: 'stop' });
  btnMove.classList.remove('active');
  btnMove.textContent = '⟳ Download all in sequence';
});

// ── recording-stopped (single video) ─────────────────────────────────────────
chrome.runtime.onMessage.addListener(msg => {
  if (msg.event === 'recording-stopped' && !autoMoveActive) {
    stopTimer();
    dot.className = 'dot ok'; statusText.textContent = 'Saved';
    btnStop.style.display = 'none';
    setMsg('Saved to Downloads.', 'ok');
  }
});

// ── Render ────────────────────────────────────────────────────────────────────
function render(entries, status) {
  videoEntries = entries;
  if (!entries.length) {
    listEl.innerHTML = '<p class="empty">No videos found on this page.</p>';
    btnMove.disabled = true;
  } else {
    btnMove.disabled = false;
    listEl.innerHTML = entries.map(e => `
      <div class="video-row" data-gi="${e.globalIndex}">
        <div class="v-dot"></div>
        <span class="v-label" title="${e.title}">${e.title ? e.title.slice(0, 38) + (e.title.length > 38 ? '…' : '') : `Video ${e.globalIndex + 1}`}</span>
        <button class="btn-auto" data-gi="${e.globalIndex}">⬇ Download</button>
      </div>`).join('');
    listEl.querySelectorAll('.btn-auto').forEach(btn =>
      btn.addEventListener('click', () => recordOne(+btn.dataset.gi, btn)));
  }
  if (autoMoveActive) return;
  if (status?.isRecording) {
    dot.className = 'dot rec'; statusText.textContent = 'Recording…';
    btnStop.style.display = 'block';
    if (!timerInterval) startTimer();
  } else {
    if (timerInterval) stopTimer();
    dot.className = entries.length ? 'dot ok' : 'dot warn';
    statusText.textContent = entries.length
      ? `${entries.length} video${entries.length !== 1 ? 's' : ''} found`
      : 'No videos found';
    btnStop.style.display = 'none';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { listEl.innerHTML = '<p class="empty">Cannot access this tab.</p>'; return; }
  tabId = tab.id;
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content.js'] }); } catch {}
  const entries = await scanVideos(tabId);
  const status  = await sendToFrame(tabId, videoFrameId, { action: 'status' });
  render(entries, status);
  setInterval(async () => {
    if (autoMoveActive) return;
    const e = await scanVideos(tabId);
    const s = await sendToFrame(tabId, videoFrameId, { action: 'status' });
    render(e, s);
  }, 2000);
}

init();
