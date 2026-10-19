import { esc, compact, setRenderLang } from "./render.js";
import { buildModel, describeStep, editorLine, editorKind, hoverMarkdown, stepOver, stepOut, stepBackOver, setDisplayLang } from "./model.js";
import { renderScene, renderInspector, renderWatch } from "./scene.js";
import { renderStructures, renderCallTree } from "./structs.js";
import { parseExamples, splitInput } from "./inputs.js";

const $ = (id) => document.getElementById(id);
const MAX_STEPS = 1500, RUN_TIMEOUT_MS = 10000;

const state = { model: null, current: 0, stdout: "", examples: [], page: null, slug: null, timer: null, lastScraped: null };
const ui = { pointers: new Set(), showAll: false, expanded: new Set(), pins: new Set(), inspect: null };
const nSteps = () => (state.model ? state.model.steps.length : 0);

// ------------------------------------------------------------------ Engines (Web Workers): Python via Pyodide; Java, C++ and JavaScript via JS interpreters
class Engine {
  constructor(file) { this.file = file; this.worker = null; this.nextId = 1; this.pending = new Map(); this.readyPromise = null; }
  start() {
    this.worker = new Worker(new URL(this.file, import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      clearTimeout(p.timer);
      data.ok ? p.resolve(data.data) : p.reject(new Error(data.error));
    };
    this.worker.onerror = (e) => this.failAll(new Error(e.message || "The engine crashed."));
    this.readyPromise = this.request("init", {}, 0);
    return this.readyPromise;
  }
  failAll(err) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); } this.pending.clear(); }
  request(type, payload, timeoutMs = RUN_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = timeoutMs ? setTimeout(() => {
        // Runaway code: kill the worker (the only reliable way to stop synchronous Python) and restart it.
        this.worker.terminate();
        this.failAll(new Error(`Timed out after ${timeoutMs / 1000}s. Check for an infinite loop or use a smaller input.`));
        this.start();
      }, timeoutMs) : 0;
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, type, ...payload });
    });
  }
  async ready() { return this.readyPromise; }
}
const engines = { python: new Engine("./worker.js"), java: new Engine("./java-worker.js"), cpp: new Engine("./cpp-worker.js"), js: new Engine("./js-worker.js") };
const LANG_NAMES = { python: "Python", java: "Java", cpp: "C++", js: "JavaScript" };

function currentLang() {
  const chosen = $("lang").value;
  if (chosen !== "auto") return chosen;
  const id = (state.page?.language || "").toLowerCase();
  if (id === "cpp" || id === "c++" || id.startsWith("cpp")) return "cpp";
  if (id === "javascript" || id === "js") return "js";
  if (id.startsWith("java") && !id.startsWith("javascript")) return "java";
  if (id.startsWith("python")) return "python";
  const code = $("code").value;
  if (/^\s*def\s+\w+|\bself\b/m.test(code)) return "python";
  if (/#include|using\s+namespace|\bvector\s*<|\bpublic\s*:|\bnullptr\b|std::/.test(code)) return "cpp";
  if ((/\b(var|let|const)\s+\w+\s*=/.test(code) || /=>|\bfunction\b/.test(code)) && !/\b(public|private|static|void)\b|\b(int|long|double|boolean|String)\s+\w+\s*[=;(]/.test(code)) return "js";
  if (/\b(public|private|class)\b/.test(code) && /;\s*$/m.test(code)) return "java";
  return "python";
}
// Engines start lazily: Pyodide is ~13 MB, so it only loads if you actually use Python.
function engineFor(lang) {
  const e = engines[lang];
  if (!e.readyPromise) {
    if (currentLang() === lang) $("engineBadge").textContent = `Loading ${LANG_NAMES[lang]}…`;
    e.start().then(
      () => { if (currentLang() === lang) $("engineBadge").textContent = `${LANG_NAMES[lang]} ready`; },
      (err) => { $("engineBadge").textContent = "Engine failed"; setStatus(`${LANG_NAMES[lang]} engine failed to load: ${err.message}`); });
  }
  return e;
}
function updateLangUi() {
  const lang = currentLang(), e = engines[lang];
  $("langNote").textContent = $("lang").value === "auto" ? `· detected ${LANG_NAMES[lang]}` : "";
  $("code").placeholder = lang === "java" ? "Your Java solution (class Solution { ... }) is read from the editor, or paste it here." : lang === "cpp" ? "Your C++ solution (class Solution { public: ... };) is read from the editor, or paste it here." : lang === "js" ? "Your JavaScript solution (var twoSum = function(nums, target) { ... }) is read from the editor, or paste it here." : "Your Python solution is read from the editor, or paste it here.";
  if (e.readyPromise) $("engineBadge").textContent = `${LANG_NAMES[lang]} ready`; else engineFor(lang);
}

function setStatus(msg) { $("status").textContent = msg; }

// ------------------------------------------------------------------ page context (automatic)
function showExamples() {
  const select = $("exampleSelect");
  select.innerHTML = state.examples.length
    ? state.examples.map((e, i) => `<option value="${i}">${esc(e.label)} — ${esc(e.input.slice(0, 40))}</option>`).join("")
    : '<option value="">No examples found — type an input below</option>';
  if (state.examples.length) $("input").value = state.examples[0].input;
}

async function readPage() {
  try { return await chrome.runtime.sendMessage({ type: "ALGOLENS_GET_PAGE_DATA" }); }
  catch { return { ok: false, error: "Could not connect to the page. Refresh LeetCode and try again." }; }
}

// Applies page data. Your code box is only overwritten if you haven't edited it by hand.
function applyPage(result, { announce }) {
  const slug = new URL(result.url).pathname.split("/")[2] || null;
  const newProblem = slug !== state.slug;
  if (newProblem) { clearHighlight(); pause(); $("traceCard").hidden = true; $("analysisCard").hidden = true; state.model = null; ui.inspect = null; ui.pins.clear(); }
  state.page = result;
  state.slug = slug;

  $("problemTitle").textContent = result.title || "LeetCode problem";
  $("difficulty").hidden = !result.difficulty; $("difficulty").textContent = result.difficulty || "";
  if (newProblem || ($("problem").value !== result.problem && result.problem)) {
    $("problem").value = result.problem || "";
    state.examples = parseExamples(result.problem);
    showExamples();
  }
  const userEdited = $("code").value !== state.lastScraped && $("code").value.trim() !== "";
  if (result.code && (newProblem || !userEdited) && result.code !== $("code").value) {
    $("code").value = result.code;
    if (nSteps()) setStatus("Your code changed in the editor. Click Visualize to re-run.");
  }
  if (result.code) state.lastScraped = result.code;
  $("codeDetails").open = !$("code").value.trim();
  $("codeSummary").textContent = $("code").value.trim() ? "Your code is read from LeetCode's editor (shown only there)" : "Editor not readable — paste your code here";

  const pageLang = (result.language || "").toLowerCase();
  updateLangUi();
  const unsupported = pageLang && $("lang").value === "auto" && !/^(python|java$|cpp|javascript)/.test(pageLang);
  if (announce) {
    if (unsupported) setStatus(`Your editor is set to ${pageLang}. Only Python 3, Java, C++ and JavaScript can be traced — switch the language in LeetCode, or pick one in the selector.`);
    else setStatus(result.code ? (result.partial ? "Code read from visible editor lines only (may be incomplete)." : `Loaded the problem and your ${LANG_NAMES[currentLang()]} code. Click Visualize.`)
      : "Problem loaded, but the editor wasn't readable yet. It will retry automatically, or paste your code.");
  }
}

async function refreshPageData() {
  setStatus("Reading the active LeetCode tab…");
  const result = await readPage();
  if (!result?.ok) { setStatus(result?.error || "Could not read LeetCode."); return; }
  applyPage(result, { announce: true });
}

// Keep in sync while the panel is open: new problem, edited code, late-loading editor.
let syncing = false;
setInterval(async () => {
  if (syncing || document.hidden || $("runBtn").disabled) return;
  syncing = true;
  try { const r = await readPage(); if (r?.ok) applyPage(r, { announce: !state.page }); } finally { syncing = false; }
}, 2000);

// ------------------------------------------------------------------ run + render
window.addEventListener("pagehide", clearHighlight);

async function run() {
  const code = $("code").value;
  const input = $("input").value.trim();
  if (!code.trim()) return setStatus("Paste or load your solution first.");
  if (!input) return setStatus("Enter a test input, e.g.  nums = [2,7,11,15], target = 9");
  pause();
  clearHighlight();
  $("runBtn").disabled = true;
  setStatus("Running your code with tracing…");
  const lang = currentLang(), engine = engineFor(lang);
  setDisplayLang(lang); setRenderLang(lang);
  try {
    await engine.ready();
    const analysis = await engine.request("analyze", { code });
    renderAnalysis(analysis);
    const trace = await engine.request("trace", { code, input, maxSteps: MAX_STEPS });
    if (!trace.ok) { $("traceCard").hidden = true; return setStatus(trace.error); }
    state.model = buildModel(trace, code, lang);
    state.current = 0; state.stdout = trace.stdout;
    Object.assign(ui, { pointers: new Set(analysis.ok ? analysis.pointers : []), showAll: false, expanded: new Set(), inspect: null });
    $("traceCard").hidden = false;
    $("scrubber").max = Math.max(0, nSteps() - 1);
    renderStep();
    setStatus(`Traced ${nSteps()} steps in ${trace.function}() (${LANG_NAMES[lang]}). Click any variable or cell to inspect its history.`);
    $("traceCard").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    setStatus(e.message);
  } finally { $("runBtn").disabled = false; }
}

function renderAnalysis(a) {
  $("analysisCard").hidden = false;
  if (!a.ok) { $("tags").innerHTML = ""; $("evidence").innerHTML = ""; $("timeComplexity").textContent = $("spaceComplexity").textContent = "—"; return; }
  $("tags").innerHTML = a.tags.length ? a.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("") : '<span class="muted">No common pattern recognised</span>';
  $("timeComplexity").textContent = a.time;
  $("spaceComplexity").textContent = a.space;
  $("evidence").innerHTML = a.tags.map((t) => `<li><b>${esc(t)}</b>: ${esc(a.evidence[t])}</li>`).join("");
}

// Highlighting happens only in LeetCode's own editor (service worker -> content script -> page bridge).
function highlightLine(line, kind, hover) { try { chrome.runtime.sendMessage({ type: "ALGOLENS_HIGHLIGHT", line, kind, hover }).catch(() => {}); } catch {} }
function clearHighlight() { try { chrome.runtime.sendMessage({ type: "ALGOLENS_CLEAR" }).catch(() => {}); } catch {} }

function renderStep() {
  const model = state.model;
  if (!model || !model.steps.length) {
    $("stepCount").textContent = "0 steps";
    $("stepTitle").textContent = "The function finished without executing any traced lines.";
    for (const id of ["stepChange", "stats", "structView", "sceneView", "inspectorView", "watchView", "treeView"]) $(id).innerHTML = "";
    return renderBanner();
  }
  const i = state.current, last = nSteps() - 1;
  $("stepCount").textContent = `Step ${i + 1} / ${nSteps()}`;
  $("scrubber").value = i;
  highlightLine(editorLine(model, i), editorKind(model, i), hoverMarkdown(model, i));
  const { title, detail } = describeStep(model, i);
  $("stepTitle").innerHTML = title;
  $("stepChange").innerHTML = detail;
  const step = model.steps[i];
  $("stats").innerHTML = `<span>depth ${step.depth}</span><span>max depth ${model.maxDepth}</span><span>${model.calls} call${model.calls === 1 ? "" : "s"}</span>`;

  $("structView").innerHTML = renderStructures(model, i);
  $("sceneView").innerHTML = renderScene(model, i, ui);
  $("inspectorView").innerHTML = renderInspector(model, i, ui.inspect, ui);
  $("watchView").innerHTML = renderWatch(model, i, ui);
  const ct = renderCallTree(model, i);
  $("treeView").innerHTML = ct; $("treeView").hidden = !ct;

  $("firstBtn").disabled = $("prevBtn").disabled = i === 0;
  $("lastBtn").disabled = $("nextBtn").disabled = $("overBtn").disabled = $("outBtn").disabled = i === last;
  if (i === last) pause();
  renderBanner();
  renderResult(i === last);
}

function renderBanner() {
  const b = $("banner"), m = state.model;
  const parts = [];
  if (m?.truncated) parts.push(`Trace stopped at ${MAX_STEPS} steps (loop too long or infinite). Try a smaller input.`);
  if (m?.error) parts.push(`Your code raised: ${esc(m.error)}`);
  b.hidden = !parts.length;
  b.className = "banner" + (m?.error ? " error" : "");
  b.innerHTML = parts.join("<br>");
}

function renderResult(isLast) {
  const r = $("resultView"), m = state.model;
  if (!isLast || !m) { r.innerHTML = ""; return; }
  let html = "";
  if (m.result && !m.error && !m.truncated) html += `<div><b>Returned:</b> <code>${esc(compact(m.result, 12))}</code></div>`;
  const ex = state.examples[$("exampleSelect").value];
  if (ex && $("input").value.trim() === ex.input.trim() && m.result && !m.error) html += `<div class="muted">Expected (from problem): <code>${esc(ex.output)}</code></div>`;
  if (state.stdout) html += `<div class="out">${esc(state.stdout)}</div>`;
  r.innerHTML = html;
}

// ------------------------------------------------------------------ interactivity (event delegation on the trace card)
function editInput(name, anchor) {
  let pairs;
  try { pairs = splitInput($("input").value); } catch { return setStatus("Fix the test input field first."); }
  const k = pairs.findIndex(([n]) => n === name);
  if (k < 0) return;
  const box = document.createElement("input");
  box.className = "inline-edit"; box.value = pairs[k][1]; box.spellcheck = false;
  anchor.replaceWith(box); box.focus(); box.select();
  const done = (commit) => {
    if (!box.isConnected) return;
    if (commit && box.value.trim() && box.value.trim() !== pairs[k][1]) { pairs[k][1] = box.value.trim(); $("input").value = pairs.map(([n, v]) => `${n} = ${v}`).join(", "); run(); }
    else renderStep();
  };
  box.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); else if (e.key === "Escape") done(false); e.stopPropagation(); });
  box.addEventListener("blur", () => done(false));
}

$("traceCard").addEventListener("click", (e) => {
  const t = e.target.closest("[data-pin],[data-close],[data-jump],[data-expand],[data-showall],[data-input],[data-var]");
  if (!t) return;
  if (t.dataset.pin !== undefined) { const n = t.dataset.pin; ui.pins.has(n) ? ui.pins.delete(n) : ui.pins.add(n); }
  else if (t.dataset.close !== undefined) ui.inspect = null;
  else if (t.dataset.jump !== undefined) { pause(); state.current = Number(t.dataset.jump); }
  else if (t.dataset.expand !== undefined) { const f = Number(t.dataset.expand); ui.expanded.has(f) ? ui.expanded.delete(f) : ui.expanded.add(f); }
  else if (t.dataset.showall !== undefined) ui.showAll = t.dataset.showall === "1";
  else if (t.dataset.input !== undefined) { pause(); return editInput(t.dataset.input, t); }
  else if (t.dataset.var !== undefined && t.dataset.fid) ui.inspect = { fid: t.dataset.fid, name: t.dataset.var, idx: t.dataset.idx };
  renderStep();
});

// ------------------------------------------------------------------ playback
function go(i) { state.current = Math.max(0, Math.min(nSteps() - 1, i)); renderStep(); }
function pause() { clearInterval(state.timer); state.timer = null; $("playBtn").textContent = "▶ Play"; }
function play() {
  if (!nSteps()) return;
  if (state.current >= nSteps() - 1) go(0);
  $("playBtn").textContent = "⏸ Pause";
  state.timer = setInterval(() => go(state.current + 1), Number($("speed").value));
}
function togglePlay() { state.timer ? pause() : play(); }

$("runBtn").addEventListener("click", run);
$("lang").addEventListener("change", updateLangUi);
$("code").addEventListener("input", () => { if ($("lang").value === "auto") updateLangUi(); });
$("refreshBtn").addEventListener("click", () => { state.lastScraped = null; state.slug = null; refreshPageData(); });
$("exampleSelect").addEventListener("change", (e) => { const ex = state.examples[e.target.value]; if (ex) $("input").value = ex.input; });
$("firstBtn").addEventListener("click", () => { pause(); go(0); });
$("prevBtn").addEventListener("click", () => { pause(); go(state.current - 1); });
$("nextBtn").addEventListener("click", () => { pause(); go(state.current + 1); });
$("lastBtn").addEventListener("click", () => { pause(); go(nSteps() - 1); });
$("overBtn").addEventListener("click", () => { pause(); go(stepOver(state.model, state.current)); });
$("outBtn").addEventListener("click", () => { pause(); go(stepOut(state.model, state.current)); });
$("playBtn").addEventListener("click", togglePlay);
$("scrubber").addEventListener("input", (e) => { pause(); go(Number(e.target.value)); });
$("speed").addEventListener("change", () => { if (state.timer) { pause(); play(); } });
document.addEventListener("keydown", (e) => {
  if (["TEXTAREA", "INPUT", "SELECT"].includes(e.target.tagName) && e.target.type !== "range") return;
  if (!state.model) return;
  if (e.key === "ArrowRight") { pause(); go(state.current + 1); }
  else if (e.key === "ArrowLeft") { pause(); go(state.current - 1); }
  else if (e.key === "ArrowDown" || e.key === "o") { pause(); go(stepOver(state.model, state.current)); }
  else if (e.key === "ArrowUp") { pause(); go(stepBackOver(state.model, state.current)); }
  else if (e.key === "u") { pause(); go(stepOut(state.model, state.current)); }
  else if (e.key === " ") { e.preventDefault(); togglePlay(); }
});

// ------------------------------------------------------------------ boot
updateLangUi();
refreshPageData();
