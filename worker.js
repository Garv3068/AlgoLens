// Module Web Worker: hosts Pyodide (Python in WebAssembly) and the AlgoLens tracer.
// Runs with no DOM access. The side panel terminates this worker if a run exceeds its time limit.
import { loadPyodide } from "./pyodide/pyodide.mjs";

let pyodidePromise = null;

function getPyodide() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const pyodide = await loadPyodide({ indexURL: new URL("./pyodide/", import.meta.url).href });
      const source = await (await fetch(new URL("./tracer.py", import.meta.url))).text();
      pyodide.runPython(source);
      return pyodide;
    })();
  }
  return pyodidePromise;
}

function call(pyodide, fn, ...args) {
  const f = pyodide.globals.get(fn);
  try { return JSON.parse(f(...args)); } finally { f.destroy(); }
}

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    const pyodide = await getPyodide();
    let result;
    if (type === "init") result = { ready: true };
    else if (type === "analyze") result = call(pyodide, "analyze_json", data.code);
    else if (type === "examples") result = call(pyodide, "examples_json", data.problem || "");
    else if (type === "trace") result = call(pyodide, "trace_json", data.code, data.input, data.maxSteps || 1500);
    else throw new Error(`Unknown message type: ${type}`);
    self.postMessage({ id, ok: true, data: result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
};
