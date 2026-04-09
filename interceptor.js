/**
 * interceptor.js — runs in the page's MAIN world at document_start on Emeritus domains.
 * Intercepts XHR and fetch to capture HLS manifest (.m3u8) URLs from Emeritus CDNs,
 * then dispatches them as a CustomEvent so content.js can relay them to the popup.
 */
(function () {
  'use strict';

  // Hostname → CDN URL mapping for Emeritus video infrastructure
  const cdnUrlMap = {
    'video-test.emeritus.org':      'https://cdn1-video-stage.emeritus.org',
    'videocast-stage.emeritus.org': 'https://cdn-vc-stage.emeritus.org',
    'videocast.emeritus.org':       'https://cdn.videocast.emeritus.org',
  };

  // Set of CDN hostnames to watch for .m3u8 requests
  const CDN_HOSTS = new Set(
    Object.values(cdnUrlMap).map(u => new URL(u).hostname)
  );

  function isCDNUrl(url) {
    try { return CDN_HOSTS.has(new URL(url).hostname); }
    catch { return false; }
  }

  function maybeEmit(url) {
    if (url && typeof url === 'string' && url.includes('.m3u8') && isCDNUrl(url)) {
      window.dispatchEvent(new CustomEvent('__vr_stream__', { detail: { url } }));
    }
  }

  // ── Intercept XMLHttpRequest ─────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    maybeEmit(typeof url === 'string' ? url : String(url));
    return origOpen.call(this, method, url, ...rest);
  };

  // ── Intercept fetch ──────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string'
      ? input
      : input instanceof Request ? input.url : '';
    maybeEmit(url);
    return origFetch.call(this, input, init);
  };
})();
