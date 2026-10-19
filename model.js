// Pure, language-neutral model built on top of the raw trace (same schema from Python, Java and C++).
// It reconstructs call frames, per-frame variable history, the recursion tree and data-structure roles.
// No DOM or chrome.* access, so it is unit-testable in node.

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Build the model. `trace` is the worker's trace result; `code` is the user's source. */
export function buildModel(trace, code, lang) {
  const steps = trace.steps || [];
  const frames = new Map();           // fid -> {fid, fn, depth, parent, callStep, retStep, ret, args, nodeId, children}
  const topSteps = new Map();         // fid -> sorted step indices where this frame was the executing one
  const stepFid = new Array(steps.length).fill(0);
  const fidStack = [];
  let nextFid = 1, maxDepth = 0;

  const makeFrame = (step, depth, i) => {
    const fid = nextFid++;
    const parent = fidStack[depth - 2] || 0;
    const args = step.stack?.[depth - 1]?.args || {};
    const f = { fid, fn: step.fn, depth, parent, callStep: i, retStep: null, ret: null, args, children: [], nodeId: null };
    for (const v of Object.values(args)) if (v && v.t === "tree" && v.v) { f.nodeId = v.v.id; break; }
    frames.set(fid, f); topSteps.set(fid, []);
    if (parent) frames.get(parent).children.push(fid);
    return f;
  };

  steps.forEach((step, i) => {
    const d = Math.max(1, step.depth || 1);
    if (step.ev === "call") { fidStack.length = Math.min(fidStack.length, d - 1); while (fidStack.length < d - 1) fidStack.push(makeFrame(step, fidStack.length + 1, i).fid); fidStack.push(makeFrame(step, d, i).fid); }
    else { fidStack.length = Math.min(fidStack.length, d); while (fidStack.length < d) fidStack.push(makeFrame(step, fidStack.length + 1, i).fid); }
    const fid = fidStack[d - 1];
    stepFid[i] = fid; topSteps.get(fid).push(i);
    maxDepth = Math.max(maxDepth, d);
    if (step.ev === "return") { const f = frames.get(fid); f.retStep = i; f.ret = step.ret; }
  });

  const roles = inferRoles(code || "", lang);
  const recursive = [...frames.values()].some((f) => f.parent && frames.get(f.parent).fn === f.fn);
  return { steps, frames, topSteps, stepFid, roles, maxDepth, calls: frames.size, recursive, input: trace.input || {}, result: trace.result,
    error: trace.error, errorLine: trace.error_line ?? null, truncated: !!trace.truncated, lang };
}

// ------------------------------------------------------------------ frames at a step
function lastTopAtOrBefore(arr, i) { // binary search: largest element <= i
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= i) { ans = arr[m]; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/** Frames live at step i, outermost first. Ancestor frames use the locals from the last moment they were executing;
 *  collections that are the same object as one in the executing frame (matching `oid`) are refreshed from it. */
export function framesAt(model, i) {
  const { steps, frames, topSteps, stepFid } = model;
  const step = steps[i];
  if (!step) return [];
  const chain = [];
  for (let fid = stepFid[i]; fid; fid = frames.get(fid).parent) chain.push(fid);
  chain.reverse();
  const topLocals = step.locals || {};
  const live = new Map();
  for (const snap of Object.values(topLocals)) if (snap && snap.oid) live.set(snap.oid, snap);
  return chain.map((fid, k) => {
    const meta = frames.get(fid), isTop = k === chain.length - 1;
    let locals, line, ev = "line";
    if (isTop) { locals = topLocals; line = step.line; ev = step.ev; }
    else {
      const j = lastTopAtOrBefore(topSteps.get(fid), i);
      const s = j >= 0 ? steps[j] : null;
      locals = s ? s.locals : meta.args; line = s ? s.line : null;
      if (live.size) { let copy = null; for (const [n, snap] of Object.entries(locals)) { const l = snap && snap.oid && live.get(snap.oid); if (l && l !== snap) { copy ||= { ...locals }; copy[n] = l; } } if (copy) locals = copy; }
    }
    return { fid, fn: meta.fn, depth: meta.depth, args: meta.args, locals, line, isTop, ev, ret: isTop && ev === "return" ? step.ret : null, callStep: meta.callStep, nodeId: meta.nodeId };
  });
}

/** Line to highlight in the editor: for a call, the call site (as in the picture); otherwise the executing line. */
export function editorLine(model, i) {
  const s = model.steps[i];
  if (!s) return null;
  if (s.ev === "call" && i > 0 && model.steps[i - 1].depth === s.depth - 1) return model.steps[i - 1].line;
  return s.line;
}

export function editorKind(model, i) {
  const s = model.steps[i];
  if (!s) return "active";
  if (i === model.steps.length - 1 && model.error && model.errorLine === s.line) return "error";
  return s.ev === "call" ? "call" : s.ev === "return" ? "return" : "active";
}

// ------------------------------------------------------------------ navigation
export function stepOver(model, i) {
  const d = model.steps[i]?.depth ?? 1;
  for (let j = i + 1; j < model.steps.length; j++) if (model.steps[j].depth <= d) return j;
  return model.steps.length - 1;
}
export function stepOut(model, i) {
  const d = model.steps[i]?.depth ?? 1;
  for (let j = i + 1; j < model.steps.length; j++) if (model.steps[j].depth < d) return j;
  return model.steps.length - 1;
}
export function stepBackOver(model, i) {
  const d = model.steps[i]?.depth ?? 1;
  let j = i - 1;
  if (j < 0) return 0;
  while (j > 0 && model.steps[j].depth > d) j--;
  return j;
}

// ------------------------------------------------------------------ variable history
/** Change points of a variable (or one cell of it) inside one frame instance: [{step, line, snap}] */
export function historyOf(model, fid, name, idx) {
  const out = []; let prevJson = null;
  for (const j of model.topSteps.get(fid) || []) {
    let snap = model.steps[j].locals[name];
    if (snap === undefined) continue;
    if (idx !== undefined && idx !== null) { snap = snap.t === "str" ? { t: "str", v: snap.v[idx] ?? "" } : (snap.v && snap.v[idx]); if (snap === undefined) continue; }
    const json = JSON.stringify(snap);
    if (json !== prevJson) { out.push({ step: j, line: model.steps[j].line, snap }); prevJson = json; }
    if (out.length >= 400) break;
  }
  return out;
}

/** Innermost live frame (at step i) that has a local called `name`. */
export function lookupVar(model, i, name) {
  const fs = framesAt(model, i);
  for (let k = fs.length - 1; k >= 0; k--) if (fs[k].locals[name] !== undefined) return { fid: fs[k].fid, snap: fs[k].locals[name], fn: fs[k].fn };
  return null;
}

export const numericOf = (snap) => (snap && snap.t === "prim" && typeof snap.v === "number" ? snap.v : snap && snap.t === "list" ? snap.n : snap && (snap.t === "dict" || snap.t === "set" || snap.t === "deque") ? snap.n : null);

// ------------------------------------------------------------------ call tree
/** Nodes for the recursion tree, only those called at or before step i. Marks repeats (same fn+args seen before). */
export function callTree(model, i) {
  const seen = new Map(), nodes = [];
  for (const f of model.frames.values()) {
    if (f.callStep > i) break; // frames are created in call order
    const key = f.fn + "(" + Object.values(f.args).map((a) => JSON.stringify(a, (k, v) => (k === "oid" || k === "id" || k === "ids" ? undefined : v))).join(",") + ")";
    const repeat = seen.has(key); seen.set(key, true);
    nodes.push({ ...f, repeat, done: f.retStep !== null && f.retStep <= i });
  }
  return nodes;
}

// ------------------------------------------------------------------ roles: how to draw a collection
/** Guess what each list/deque variable is used for, from the source. Returns {name: {role, top?}}. */
export function inferRoles(code, lang) {
  const roles = {};
  const set = (n, role, extra) => { if (!roles[n]) roles[n] = { role, ...extra }; };
  const uses = (n, re) => new RegExp(`\\b${n}\\.(?:${re})\\(`).test(code);
  if (lang === "java") {
    for (const m of code.matchAll(/\b(Stack|Deque|ArrayDeque|Queue|LinkedList|PriorityQueue)\s*<[^;=()]*>+\s+(\w+)/g)) {
      const [, type, name] = m;
      if (type === "PriorityQueue") set(name, "heap");
      else if (type === "Stack") set(name, "stack", { top: "back" });
      else if (type === "Queue") set(name, "queue");
      else if (uses(name, "push|pop") && !uses(name, "poll|offer|add|pollFirst|removeFirst|addLast")) set(name, "stack", { top: "front" });
      else set(name, "queue");
    }
  } else if (lang === "cpp") {
    for (const m of code.matchAll(/\b(stack|queue|priority_queue|deque)\s*<[^;=()]*?>+\s*&?\s*(\w+)/g)) {
      const [, type, name] = m;
      if (type === "priority_queue") set(name, "heap");
      else if (type === "stack") set(name, "stack", { top: "back" });
      else if (type === "queue") set(name, "queue");
      else if (uses(name, "push_back|pop_back|emplace_back") && !uses(name, "pop_front|push_front|emplace_front")) set(name, "stack", { top: "back" });
      else set(name, "queue");
    }
  } else {
    for (const m of code.matchAll(/\b(?:heappush|heappop|heapify|heappushpop|heapreplace)\(\s*(?:self\.)?(\w+)/g)) set(m[1], "heap");
    for (const m of code.matchAll(/\b(\w+)\s*=\s*(?:collections\.)?deque\b/g)) { if (uses(m[1], "popleft")) set(m[1], "queue"); else set(m[1], "stack", { top: "back" }); }
    for (const m of code.matchAll(/\b(\w+)\.pop\(\s*0\s*\)/g)) set(m[1], "queue");
    for (const m of code.matchAll(/\b(\w+)\.append\(/g)) if (uses(m[1], "pop") && /\b\w+\.pop\(\s*\)/.test(code) && new RegExp(`\\b${m[1]}\\.pop\\(\\s*\\)`).test(code)) set(m[1], /^(res|result|ans|answer|out|output|path|cur|current|curr|comb|combo|subset|temp|tmp|ret|paths)$/i.test(m[1]) ? "list" : "stack", { top: "back" });
  }
  for (const m of code.matchAll(/\b(dp\w*|memo\w*|cache|table|dist|prefix\w*|ways)\b/gi)) if (!roles[m[1]]) roles[m[1]] = { role: "dp" };
  for (const n of Object.keys(roles)) if (roles[n].role === "list") delete roles[n];
  return roles;
}

// ------------------------------------------------------------------ narrative
export function describeStep(model, i) {
  const { steps } = model, step = steps[i];
  const fs = framesAt(model, i), top = fs[fs.length - 1];
  const argText = (f) => Object.entries(f.args).map(([, v]) => compactText(v)).join(", ");
  let title;
  if (step.ev === "call") title = `Calling <b>${esc(step.fn)}</b>(${esc(argText(top))})`;
  else if (step.ev === "return") title = `Returning <b>${esc(compactText(step.ret))}</b> from <b>${esc(step.fn)}</b>`;
  else title = `Running line <b>${step.line}</b> in <b>${esc(step.fn)}</b>`;
  let detail = "";
  const prev = i > 0 ? steps[i - 1] : null;
  if (prev && model.stepFid[i - 1] === model.stepFid[i]) {
    const diffs = [];
    for (const [k, v] of Object.entries(step.locals)) {
      const p = prev.locals[k];
      if (!p) diffs.push(`<b>${esc(k)}</b> = ${esc(compactText(v))}`);
      else if (!same(p, v)) diffs.push(`<b>${esc(k)}</b>: ${esc(compactText(p))} → ${esc(compactText(v))}`);
    }
    detail = diffs.length ? diffs.slice(0, 4).join(" · ") + (diffs.length > 4 ? ` · +${diffs.length - 4} more` : "") : "No variable changed.";
  } else if (prev && prev.ev === "return" && prev.depth === step.depth + 1) {
    detail = `Back in <b>${esc(step.fn)}</b> with <b>${esc(compactText(prev.ret))}</b> from <b>${esc(prev.fn)}</b>.`;
  }
  return { title, detail };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Short single-line text for a snapshot (no HTML). */
export function compactText(s, limit = 6) {
  if (!s) return "";
  switch (s.t) {
    case "prim": return s.v === null ? "None" : s.v === true ? "True" : s.v === false ? "False" : String(s.v);
    case "str": return JSON.stringify(s.v) + (s.cut ? "…" : "");
    case "list": case "tuple": case "deque": case "set": {
      const [open, close] = s.t === "set" ? ["{", "}"] : s.t === "tuple" ? ["(", ")"] : ["[", "]"];
      return open + s.v.slice(0, limit).map((x) => compactText(x, 3)).join(", ") + (s.n > limit ? `, … (${s.n})` : "") + close;
    }
    case "dict": return "{" + s.v.slice(0, limit).map(([k, v]) => `${compactText(k, 3)}: ${compactText(v, 3)}`).join(", ") + (s.n > limit ? `, … (${s.n})` : "") + "}";
    case "ll": return s.v.slice(0, 8).join("→") + (s.v.length > 8 ? "→…" : "") + (s.cycle ? " ↺" : "");
    case "tree": return s.v ? `Tree(${s.v.v})` : "None";
    case "node": return `Node(${s.v})`;
    default: return String(s.v);
  }
}

/** Markdown for the Monaco hover on the highlighted line. */
export function hoverMarkdown(model, i) {
  const fs = framesAt(model, i), top = fs[fs.length - 1];
  if (!top) return "";
  const rows = Object.entries(top.locals).slice(0, 12).map(([k, v]) => `- \`${k}\` = \`${compactText(v, 6).replace(/`/g, "'")}\``);
  const stack = fs.length > 1 ? `\n\n**Call stack:** ${fs.map((f) => f.fn).join(" → ")}` : "";
  return `**AlgoLens** · step ${i + 1}/${model.steps.length} · ${top.fn}()\n\n${rows.join("\n") || "_no locals yet_"}${stack}`;
}
