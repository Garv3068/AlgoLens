// Module Web Worker for C++: pure JavaScript interpreter, no WebAssembly needed.
import { traceCpp, analyzeCpp } from "./cpp/interp.js";

self.onmessage = ({ data }) => {
  const { id, type } = data;
  try {
    let result;
    if (type === "init") result = { ready: true };
    else if (type === "analyze") result = analyzeCpp(data.code);
    else if (type === "trace") result = traceCpp(data.code, data.input, data.maxSteps || 1500);
    else throw new Error(`Unknown message type: ${type}`);
    self.postMessage({ id, ok: true, data: result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error && error.message || error) });
  }
};
