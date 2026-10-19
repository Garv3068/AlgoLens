// Module Web Worker for JavaScript: pure JavaScript interpreter (acorn parser), no eval or WebAssembly needed.
import { traceJs, analyzeJs } from "./js/interp.js";

self.onmessage = ({ data }) => {
  const { id, type } = data;
  try {
    let result;
    if (type === "init") result = { ready: true };
    else if (type === "analyze") result = analyzeJs(data.code);
    else if (type === "trace") result = traceJs(data.code, data.input, data.maxSteps || 1500);
    else throw new Error(`Unknown message type: ${type}`);
    self.postMessage({ id, ok: true, data: result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
};
