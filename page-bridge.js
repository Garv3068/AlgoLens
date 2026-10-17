// Runs in the PAGE's JavaScript world (not the extension's isolated world) so it can reach
// LeetCode's Monaco editor. It can (1) read the editor text and (2) highlight one line using
// Monaco decorations. Decorations are visual only: they never change your code.
(() => {
  if (window.__algolensBridge) return;
  window.__algolensBridge = true;

  const STYLE_ID = "algolens-style";
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .algolens-line { background: rgba(92, 224, 140, 0.10) !important; border-top: 1px solid #4ade80; border-bottom: 1px solid #4ade80; box-sizing: border-box; }
      .algolens-line-call { background: rgba(56, 189, 248, 0.10) !important; border-top: 1px solid #38bdf8; border-bottom: 1px solid #38bdf8; box-sizing: border-box; }
      .algolens-line-return { background: rgba(192, 132, 252, 0.11) !important; border-top: 1px solid #c084fc; border-bottom: 1px solid #c084fc; box-sizing: border-box; }
      .algolens-line-error { background: rgba(255, 107, 129, 0.16) !important; border-top: 1px solid #ff6b81; border-bottom: 1px solid #ff6b81; box-sizing: border-box; }
      .algolens-gutter { border-left: 3px solid #4ade80; margin-left: 2px; }
      .algolens-gutter-call { border-left: 3px solid #38bdf8; margin-left: 2px; }
      .algolens-gutter-return { border-left: 3px solid #c084fc; margin-left: 2px; }
      .algolens-gutter-error { border-left: 3px solid #ff6b81; margin-left: 2px; }
      .algolens-after::after, .algolens-after-call::after, .algolens-after-return::after, .algolens-after-error::after { content: "\\25C0"; margin-left: 14px; font-size: 13px; }
      .algolens-after::after { color: #4ade80; } .algolens-after-call::after { color: #38bdf8; }
      .algolens-after-return::after { color: #c084fc; } .algolens-after-error::after { color: #ff6b81; }`;
    document.head.appendChild(style);
  }

  function pickEditor() {
    try {
      const monaco = window.monaco;
      if (!monaco?.editor) return null;
      const editors = monaco.editor.getEditors?.() || [];
      const withText = editors.filter((e) => e.getModel?.()?.getValue().trim());
      // Prefer the largest visible editor (LeetCode's code editor, not a small input box).
      withText.sort((a, b) => (b.getContainerDomNode?.().offsetHeight || 0) - (a.getContainerDomNode?.().offsetHeight || 0));
      return { monaco, editor: withText[0] || null, models: monaco.editor.getModels?.() || [] };
    } catch (_) { return null; }
  }

  function readEditor() {
    const found = pickEditor();
    if (!found) return null;
    let model = found.editor?.getModel?.();
    if (!model) model = found.models.sort((a, b) => b.getValue().length - a.getValue().length)[0];
    return model ? { code: model.getValue(), language: model.getLanguageId?.() || "" } : null;
  }

  let decorated = { editor: null, ids: [] };
  function clearHighlight() {
    try { if (decorated.editor) decorated.ids = decorated.editor.deltaDecorations(decorated.ids, []); } catch (_) {}
    decorated = { editor: null, ids: [] };
  }

  const KINDS = { active: "", call: "-call", return: "-return", error: "-error" };
  function highlight(line, kind, hover) {
    const found = pickEditor();
    if (!found?.editor) return false;
    const { monaco, editor } = found;
    ensureStyle();
    if (decorated.editor && decorated.editor !== editor) clearHighlight();
    const count = editor.getModel().getLineCount();
    const n = Math.max(1, Math.min(count, Number(line) || 1));
    const k = KINDS[kind] ?? "";
    const options = {
      isWholeLine: true,
      className: "algolens-line" + k,
      linesDecorationsClassName: "algolens-gutter" + k,
      afterContentClassName: "algolens-after" + k
    };
    if (hover) options.hoverMessage = { value: String(hover).slice(0, 1500) };
    decorated.ids = editor.deltaDecorations(decorated.ids, [{ range: new monaco.Range(n, 1, n, 1), options }]);
    decorated.editor = editor;
    editor.revealLineInCenterIfOutsideViewport?.(n);
    return true;
  }

  window.addEventListener("message", (event) => {
    const d = event.data;
    if (event.source !== window || d?.source !== "algolens-content") return;
    if (d.type === "READ_EDITOR") {
      window.postMessage({ source: "algolens-bridge", type: "EDITOR", requestId: d.requestId, payload: readEditor() }, "*");
    } else if (d.type === "HIGHLIGHT") {
      highlight(d.line, d.kind, d.hover);
    } else if (d.type === "CLEAR_HIGHLIGHT") {
      clearHighlight();
    }
  });
})();
