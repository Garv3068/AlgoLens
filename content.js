// Extension-world content script: reads the problem text from the DOM and asks the page bridge for editor code.
function firstText(selectors, min = 1) {
  for (const selector of selectors) {
    const text = document.querySelector(selector)?.innerText?.trim();
    if (text && text.length >= min) return text;
  }
  return "";
}

function getProblemStatement() {
  return firstText([
    '[data-track-load="description_content"]',
    '[class*="description"] [class*="content"]',
    "div.elfjS"
  ], 30).slice(0, 12000);
}

function getDifficulty() {
  const el = document.querySelector('[class*="text-difficulty-"], [class*="difficulty"]');
  const m = (el?.innerText || "").match(/\b(Easy|Medium|Hard)\b/i);
  return m ? m[1] : "";
}

function getTitle() {
  return document.title.replace(/\s*-\s*LeetCode.*$/i, "").trim();
}

function readEditorViaBridge() {
  return new Promise((resolve) => {
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { window.removeEventListener("message", onMessage); resolve(null); }, 700);
    function onMessage(event) {
      const d = event.data;
      if (event.source !== window || d?.source !== "algolens-bridge" || d.requestId !== requestId) return;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(d.payload);
    }
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "algolens-content", type: "READ_EDITOR", requestId }, "*");
  });
}

function readEditorFromDom() {
  const lines = [...document.querySelectorAll(".monaco-editor .view-line")];
  // Monaco virtualizes lines, so this fallback may be incomplete for long files.
  return lines.length ? { code: lines.map(l => l.innerText.replace(/\u00a0/g, " ")).join("\n"), language: "", partial: true } : null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ALGOLENS_HIGHLIGHT") {
    window.postMessage({ source: "algolens-content", type: "HIGHLIGHT", line: message.line, kind: message.kind, hover: message.hover }, "*");
    sendResponse({ ok: true }); return;
  }
  if (message?.type === "ALGOLENS_CLEAR") {
    window.postMessage({ source: "algolens-content", type: "CLEAR_HIGHLIGHT" }, "*");
    sendResponse({ ok: true }); return;
  }
  if (message?.type !== "ALGOLENS_EXTRACT") return;
  (async () => {
    const editor = (await readEditorViaBridge()) || readEditorFromDom();
    sendResponse({
      ok: true,
      title: getTitle(),
      difficulty: getDifficulty(),
      url: location.href,
      problem: getProblemStatement(),
      code: editor?.code || "",
      language: editor?.language || "",
      partial: !!editor?.partial
    });
  })();
  return true; // keep the channel open for the async response
});
