/**
 * LeetRace Extension - Auto-Registration Script
 * Runs at document_start on the React website to automatically expose the extension ID to the frontend.
 */
(async () => {
  try {
    const extensionId = chrome.runtime.id;
    if (extensionId) {
      document.documentElement.setAttribute('data-leetrace-extension-id', extensionId);
      // Also cache it in localStorage as a backup
      window.localStorage.setItem('leetrace_extension_id', extensionId);
      console.log("LeetRace Extension auto-registered ID:", extensionId);
    }
  } catch (e) {
    console.error("LeetRace auto-registration failed:", e);
  }
})();
