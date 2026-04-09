// MV3 service worker — minimal, content.js handles all recording logic
chrome.runtime.onInstalled.addListener(() => {
  console.log('Video Player Recorder installed');
});
