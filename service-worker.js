chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

async function extract(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: "ALGOLENS_EXTRACT" });
}

async function injectScripts(tabId) {
  // Covers tabs that were already open when the extension was installed or reloaded.
  await chrome.scripting.executeScript({ target: { tabId }, files: ["page-bridge.js"], world: "MAIN" });
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "ALGOLENS_GET_PAGE_DATA") return;
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async (tabs) => {
    const tab = tabs[0];
    if (!tab?.id || !tab.url?.startsWith("https://leetcode.com/problems/")) {
      sendResponse({ ok: false, error: "Open a LeetCode problem page first." });
      return;
    }
    try {
      sendResponse(await extract(tab.id));
    } catch {
      try {
        await injectScripts(tab.id);
        sendResponse(await extract(tab.id));
      } catch {
        sendResponse({ ok: false, error: "Could not read the page. Refresh the LeetCode tab once." });
      }
    }
  });
  return true;
});

// Side panel -> active LeetCode tab: highlight a line in LeetCode's own editor.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "ALGOLENS_HIGHLIGHT" && message?.type !== "ALGOLENS_CLEAR") return;
  if (sender.tab) return; // only accept messages from extension pages
  chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(async (tabs) => {
    const tab = tabs[0];
    if (!tab?.id || !tab.url?.startsWith("https://leetcode.com/problems/")) { sendResponse({ ok: false }); return; }
    try { sendResponse(await chrome.tabs.sendMessage(tab.id, message)); }
    catch {
      try { await injectScripts(tab.id); sendResponse(await chrome.tabs.sendMessage(tab.id, message)); }
      catch { sendResponse({ ok: false }); }
    }
  });
  return true;
});
