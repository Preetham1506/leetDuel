/**
 * LeetRace Chrome Extension - Background Service Worker (Manifest V3)
 * 
 * DESIGN RATIONALE:
 * 1. WebRequest Interception: Service workers cannot directly read response bodies of network
 *    requests in Manifest V3. To check if a submission succeeded, this script listens to completed
 *    calls to LeetCode's submission check endpoint. It then performs an out-of-band fetch to the
 *    same URL. Because the extension runs with host permissions for leetcode.com, this fetch
 *    automatically includes the user's cookies and retrieves the full evaluation status JSON.
 * 
 * 2. Ephemeral Service Worker: MV3 background scripts are short-lived and will shut down after
 *    inactivity (~30 seconds). Therefore, we do NOT run the WebSocket connection here. Instead,
 *    the persistent WebSocket connection is maintained inside the content script (which lives
 *    as long as the LeetCode tab is active). This background script only caches match state and
 *    forwards submission status to the active tab's content script.
 */

// 1. Listen for active match details sent externally from the React website (e.g. localhost)
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "SET_ACTIVE_MATCH") {
        console.log("Setting active match details:", message.match);
        await chrome.storage.local.set({ activeMatch: message.match });
        sendResponse({ success: true, message: "Match cached in extension storage." });
      }
    } catch (err) {
      console.error("Error saving active match context:", err);
      sendResponse({ success: false, error: err.message });
    }
  })();
  return true; // Keep message port open for async sendResponse
});

// 2. Intercept LeetCode's submission status checks
chrome.webRequest.onCompleted.addListener(
  (details) => {
    (async () => {
      // Only process requests originating from a browser tab
      if (details.tabId < 0) return;

      try {
        console.log("Submission check intercepted at URL:", details.url);
        
        // Retrieve the result by doing a parallel fetch (using active cookies)
        const response = await fetch(details.url);
        const data = await response.json();

        // LeetCode's API returns state: "SUCCESS" when the test case evaluation has finished
        if (data && data.state === "SUCCESS") {
          const isAccepted = data.status_msg === "Accepted";
          console.log(`Submission evaluated: ${data.status_msg} (Accepted: ${isAccepted})`);

          // Relay results to the content script in the corresponding tab
          await chrome.tabs.sendMessage(details.tabId, {
            type: "LEETCODE_SUBMISSION_RESULT",
            submissionId: data.submission_id,
            statusMsg: data.status_msg,
            isAccepted: isAccepted,
            language: data.lang,
            runTime: data.status_runtime,
            memory: data.status_memory
          });
        }
      } catch (error) {
        console.error("Error fetching submission evaluation details:", error);
      }
    })();
  },
  {
    urls: [
      "*://leetcode.com/submissions/detail/*/check/",
      "*://leetcode.com/submissions/detail/*/check/*",
      "*://*.leetcode.com/submissions/detail/*/check/",
      "*://*.leetcode.com/submissions/detail/*/check/*"
    ]
  }
);
