// Pure functions: value snapshot -> HTML strings. No DOM or chrome.* access, so they are unit-testable in node.
import { compactText, same, nullText } from "./model.js";

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const compact = compactText;
let jsLabels = false;
export const setRenderLang = (lang) => { jsLabels = lang === "js"; };
export { same };

// ------------------------------------------------------------------ pointer helpers
const PCLS = { l: 0, left: 0, lo: 0, low: 0, start: 0, slow: 0, begin: 0, r: 1, right: 1, hi: 1, high: 1, end: 1, fast: 1, mid: 2, m: 2, i: 3, j: 4, k: 5, idx: 3, ptr: 6 };
export function pointerClass(name) {
  if (Object.prototype.hasOwnProperty.call(PCLS, name)) return "pc" + PCLS[name];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return "pc" + (6 + (h % 3));
}
const WINDOW_PAIRS = [["lo", "hi"], ["low", "high"], ["left", "right"], ["l", "r"], ["start", "end"], ["begin", "end"]];
const GRID_PAIRS = [["r", "c"], ["row", "col"], ["i", "j"], ["x", "y"], ["y", "x"], ["a", "b"]];
const isInt = (s) => s && s.t === "prim" && typeof s.v === "number" && Number.isInteger(s.v);

/** Integer locals that look like indices. marks: {index: [names]}; off: out-of-range descriptions. Index === len is allowed ("end" slot). */
export function pointerMap(locals, len, pointerNames, selfName) {
  const marks = {}, off = [];
  for (const [name, snap] of Object.entries(locals)) {
    if (name === selfName || !isInt(snap) || !pointerNames.has(name)) continue;
    if (snap.v >= 0 && snap.v <= len) (marks[snap.v] ||= []).push(name); else off.push(`${name}=${snap.v}`);
  }
  return { marks, off };
}
function pointerWindow(locals, len, pointerNames) {
  for (const [a, b] of WINDOW_PAIRS) {
    const x = locals[a], y = locals[b];
    if (isInt(x) && isInt(y) && pointerNames.has(a) && pointerNames.has(b) && len > 0) {
      const lo = Math.max(0, x.v), hi = Math.min(len - 1, y.v);
      if (lo <= hi && x.v <= y.v + 1) return { lo, hi, names: [a, b] };
    }
  }
  return null;
}
const tags = (names) => (names || []).map((n) => `<span class="ptag ${pointerClass(n)}">${esc(n)}</span>`).join("");
const cellLabel = (x) => (x.t === "node" ? `●${esc(x.v)}` : esc(compactText(x, 3)));
const dataAttrs = (ctx, name, idx) => `data-var="${esc(name)}" data-fid="${ctx.fid ?? ""}"${idx !== undefined ? ` data-idx="${idx}"` : ""}`;

// ------------------------------------------------------------------ arrays and strings
function arrayHTML(name, s, prev, ctx, cls = "") {
  const isStr = s.t === "str";
  const asItems = (x) => (x.t === "str" ? [...x.v].map((c) => ({ t: "prim", v: c })) : x.v);
  const items = asItems(s), prevItems = prev && (prev.t === s.t) ? asItems(prev) : null;
  const { marks, off } = pointerMap(ctx.locals, items.length, ctx.pointers, name);
  const win = pointerWindow(ctx.locals, items.length, ctx.pointers);
  const col = (x, i, ghost) => {
    const changed = !ghost && prevItems && (prevItems[i] === undefined || !same(prevItems[i], x));
    const m = marks[i];
    const inWin = win && !ghost && i >= win.lo && i <= win.hi;
    return `<div class="col"><div class="marks">${tags(m)}</div>` +
      `<div class="cell ${ghost ? "ghost" : ""} ${changed ? "changed" : ""} ${m && !ghost ? "ptr" : ""} ${inWin ? "win" : ""} ${isStr ? "ch" : ""}" ${ghost ? "" : dataAttrs(ctx, name, i)} title="${esc(name)}[${i}] = ${esc(compactText(x, 4))}">${ghost ? "" : cellLabel(x)}</div>` +
      `<div class="idx">${i}</div></div>`;
  };
  const end = marks[items.length] ? col({ t: "prim", v: "" }, items.length, true) : "";
  const more = s.cut ? `<span class="muted">… ${s.n ?? ""} total</span>` : "";
  const note = [win ? `<span class="wnote">window [${win.names[0]}..${win.names[1]}]</span>` : "", off.length ? `<span class="wnote off">out of range: ${esc(off.join(", "))}</span>` : ""].join("");
  return `<div class="cells ${cls}">${items.map((x, i) => col(x, i)).join("")}${end}${more}</div>${note ? `<div class="notes">${note}</div>` : ""}`;
}

// ------------------------------------------------------------------ grids (2-D lists, dp tables)
export const isGrid = (s) => s.t === "list" && s.v.length > 0 && s.v.every((r) => r.t === "list" && r.v.every((x) => x.t === "prim" || (x.t === "str" && x.v.length <= 3)));
function gridHTML(name, s, prev, ctx, cls = "") {
  const rows = s.v, cols = Math.max(...rows.map((r) => r.v.length), 1);
  let pr = null, pc = null, pnames = [];
  for (const [a, b] of GRID_PAIRS) {
    const x = ctx.locals[a], y = ctx.locals[b];
    if (isInt(x) && isInt(y) && ctx.pointers.has(a) && ctx.pointers.has(b) && x.v >= 0 && x.v < rows.length && y.v >= 0 && y.v < cols) { pr = x.v; pc = y.v; pnames = [a, b]; break; }
  }
  if (pr === null) for (const n of ["r", "row", "i"]) if (isInt(ctx.locals[n]) && ctx.pointers.has(n) && ctx.locals[n].v >= 0 && ctx.locals[n].v < rows.length) { pr = ctx.locals[n].v; pnames = [n]; break; }
  const head = `<div class="gh"></div>` + Array.from({ length: cols }, (_, c) => `<div class="gh ${pc === c ? "on" : ""}">${c}</div>`).join("");
  const body = rows.map((row, r) => `<div class="gh ${pr === r ? "on" : ""}">${r}</div>` + Array.from({ length: cols }, (_, c) => {
    const x = row.v[c], prevRow = prev && prev.t === "list" ? prev.v[r] : null, pv = prevRow && prevRow.t === "list" ? prevRow.v[c] : undefined;
    const changed = prev && prev.t === "list" && x && (pv === undefined || !same(pv, x));
    const hit = pr === r && (pc === null || pc === c);
    return `<div class="cell ${changed ? "changed" : ""} ${hit && pc !== null ? "ptr" : pr === r ? "rowhl" : ""}" ${dataAttrs(ctx, name, r + "," + c)} title="${esc(name)}[${r}][${c}]">${x ? esc(compactText(x)) : ""}</div>`;
  }).join("")).join("");
  const note = pnames.length ? `<div class="notes"><span class="wnote">cursor ${pnames.map((n) => `${esc(n)}=${ctx.locals[n].v}`).join(", ")}</span></div>` : "";
  return `<div class="matrix ${cols > 12 ? "tight" : ""} ${cls}" style="grid-template-columns:auto repeat(${cols},minmax(0,1fr))">${head}${body}</div>${note}${s.cut ? `<span class="muted">… ${s.n} rows</span>` : ""}`;
}

// ------------------------------------------------------------------ stacks, queues
/** What changed between two sequences at their ends: {added:Set(indices in cur), removed:[snaps], at:'back'|'front'} */
export function diffEnds(prev, cur) {
  const none = { added: new Set(), removed: [], at: "back" };
  if (!prev || !prev.v || !cur || !cur.v) return none;
  const A = prev.v, B = cur.v, eq = (x, y) => same(x, y);
  if (B.length > A.length) {
    if (A.every((x, k) => eq(x, B[k]))) return { added: new Set(B.map((_, k) => k).slice(A.length)), removed: [], at: "back" };
    const off = B.length - A.length;
    if (A.every((x, k) => eq(x, B[k + off]))) return { added: new Set(B.map((_, k) => k).slice(0, off)), removed: [], at: "front" };
  } else if (B.length < A.length) {
    if (B.every((x, k) => eq(x, A[k]))) return { added: new Set(), removed: A.slice(B.length), at: "back" };
    const off = A.length - B.length;
    if (B.every((x, k) => eq(x, A[k + off]))) return { added: new Set(), removed: A.slice(0, off), at: "front" };
  } else if (!same(A, B) && A.length && eq(A.slice(0, -1), B.slice(0, -1))) return { added: new Set([B.length - 1]), removed: [A[A.length - 1]], at: "back" };
  return none;
}

function stackHTML(name, s, prev, ctx, role) {
  const d = diffEnds(prev, s), topBack = role.top !== "front";
  const order = s.v.map((x, k) => ({ x, k }));
  if (topBack) order.reverse();                       // top of stack drawn first
  const shown = order.slice(0, 9), hidden = order.length - shown.length;
  const ghosts = d.removed.slice().reverse().slice(0, 3).map((x) => `<div class="si ghost" title="popped">${cellLabel(x)}<span class="gtag">popped</span></div>`).join("");
  const items = shown.map(({ x, k }, n) => `<div class="si ${n === 0 ? "top" : ""} ${d.added.has(k) ? "pushed" : ""}" ${dataAttrs(ctx, name, k)}>${cellLabel(x)}${n === 0 ? '<span class="stag">top</span>' : ""}</div>`).join("");
  if (!s.v.length) return `<div class="stk">${ghosts}<div class="stk-empty">empty stack</div><div class="stk-base"></div></div>`;
  return `<div class="stk">${ghosts}${items}${hidden > 0 ? `<div class="si more">⋮ ${hidden} more</div>` : ""}<div class="stk-base"></div></div>`;
}

function queueHTML(name, s, prev, ctx) {
  const d = diffEnds(prev, s);
  const ghosts = d.removed.slice(0, 3).map((x) => `<div class="qi ghost" title="removed">${cellLabel(x)}</div>`).join("");
  const items = s.v.map((x, k) => `<div class="qi ${d.added.has(k) ? "pushed" : ""}" ${dataAttrs(ctx, name, k)}>${cellLabel(x)}</div>`).join("");
  return `<div class="que"><span class="qend">front</span><span class="qarrow">→</span>${d.at === "front" ? ghosts : ""}${items || '<span class="muted">empty</span>'}${d.at === "back" ? ghosts : ""}<span class="qarrow">←</span><span class="qend">back</span>${s.cut ? `<span class="muted">… ${s.n} total</span>` : ""}</div>`;
}

// ------------------------------------------------------------------ heap (array drawn as a tree)
function heapHTML(name, s, prev, ctx) {
  const items = s.v.slice(0, 31);
  if (!items.length) return '<span class="prim none">empty heap</span>';
  const maxL = Math.floor(Math.log2(items.length)), W = Math.max(70, Math.min(380, (2 ** maxL) * 34)), H = (maxL + 1) * 34;
  const pos = (i) => { const L = Math.floor(Math.log2(i + 1)), k = i + 1 - 2 ** L; return { x: ((k + 0.5) / 2 ** L) * W, y: L * 34 + 14 }; };
  const edges = items.map((_, i) => (i === 0 ? "" : `<line x1="${pos((i - 1) >> 1).x}" y1="${pos((i - 1) >> 1).y}" x2="${pos(i).x}" y2="${pos(i).y}"/>`)).join("");
  const nodes = items.map((x, i) => {
    const p = pos(i), t = compactText(x, 3), w = Math.max(22, t.length * 6.4 + 10);
    const changed = prev && prev.t === s.t && (!prev.v[i] || !same(prev.v[i], x));
    return `<g class="hn ${changed ? "changed" : ""} ${i === 0 ? "root" : ""}" ${dataAttrs(ctx, name, i)}><rect x="${p.x - w / 2}" y="${p.y - 11}" width="${w}" height="22" rx="11"/><text x="${p.x}" y="${p.y}">${esc(t)}</text></g>`;
  }).join("");
  return `<svg class="heap-svg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${edges}${nodes}</svg><div class="notes"><span class="wnote">heap · root = ${esc(compactText(items[0], 3))}</span></div>`;
}

// ------------------------------------------------------------------ dict / set
function dictHTML(name, s, prev, ctx) {
  if (!s.v.length) return '<span class="prim none">{}</span>';
  const pv = new Map(prev && prev.t === "dict" ? prev.v.map(([k, v]) => [JSON.stringify(k), v]) : []);
  const cur = new Set(s.v.map(([k]) => JSON.stringify(k)));
  const rows = s.v.slice(0, 14).map(([k, v]) => {
    const key = JSON.stringify(k), had = pv.has(key);
    const cls = prev && prev.t === "dict" ? (!had ? "new" : !same(pv.get(key), v) ? "changed" : "") : "";
    return `<tr class="${cls}" ${dataAttrs(ctx, name, "k:" + esc(compactText(k)))}><td>${esc(compactText(k))}</td><td>${esc(compactText(v, 4))}</td></tr>`;
  }).join("");
  const gone = prev && prev.t === "dict" ? prev.v.filter(([k]) => !cur.has(JSON.stringify(k))).slice(0, 3).map(([k, v]) => `<tr class="gone"><td>${esc(compactText(k))}</td><td>${esc(compactText(v, 4))}</td></tr>`).join("") : "";
  return `<table class="kv">${rows}${gone}</table>${s.v.length > 14 || s.cut ? `<span class="muted">… ${s.n} entries</span>` : ""}`;
}
function setHTML(name, s, prev, ctx) {
  if (!s.v.length) return '<span class="prim none">set()</span>';
  const ps = new Set(prev && prev.t === "set" ? prev.v.map((x) => JSON.stringify(x)) : []), cs = new Set(s.v.map((x) => JSON.stringify(x)));
  const chips = s.v.map((x) => `<span class="chip ${prev && prev.t === "set" && !ps.has(JSON.stringify(x)) ? "new" : ""}">${esc(compactText(x, 3))}</span>`).join("");
  const gone = prev && prev.t === "set" ? prev.v.filter((x) => !cs.has(JSON.stringify(x))).slice(0, 3).map((x) => `<span class="chip gone">${esc(compactText(x, 3))}</span>`).join("") : "";
  return `<div class="chips">${chips}${gone}${s.cut ? "…" : ""}</div>`;
}

// ------------------------------------------------------------------ linked list / tree, inline (full drawings live in structs.js)
function llInline(s) {
  const nodes = s.v.map((v) => `<span class="node">${esc(v)}</span>`).join('<span class="arrow">→</span>');
  const tail = s.cycle ? `<span class="arrow">↺ back to [${s.cto}]</span>` : s.cut ? '<span class="arrow">→ …</span>' : `<span class="arrow">→ ${esc(nullText())}</span>`;
  return `<div class="ll">${nodes}${tail}</div>`;
}
export const countNodes = (n) => (n ? 1 + countNodes(n.l) + countNodes(n.r) : 0);

/** One value. ctx = {locals, pointers:Set, roles, fid, compactMode} */
export function renderValue(name, s, prev, ctx) {
  const role = ctx.roles?.[name];
  if (ctx.compactMode && !["prim", "node"].includes(s.t)) return `<span class="cval" ${dataAttrs(ctx, name)} title="${esc(compactText(s, 20))}">${esc(compactText(s, 4))}</span>`;
  switch (s.t) {
    case "prim": return `<span class="prim ${s.v === null ? "none" : ""}">${esc(compactText(s))}</span>`;
    case "node": return `<span class="nchip">●${esc(s.v)}</span>`;
    case "str": return s.v.length <= 40 ? arrayHTML(name, s, prev, ctx) : `<span class="prim">${esc(compactText(s))}</span>`;
    case "list":
      if (role?.role === "heap") return heapHTML(name, s, prev, ctx);
      if (role?.role === "stack") return stackHTML(name, s, prev, ctx, role);
      if (role?.role === "queue") return queueHTML(name, s, prev, ctx);
      if (isGrid(s)) return gridHTML(name, s, prev, ctx, role?.role === "dp" ? "dp" : "");
      return arrayHTML(name, s, prev, ctx, role?.role === "dp" ? "dp" : "");
    case "deque": return role?.role === "stack" ? stackHTML(name, s, prev, ctx, role) : queueHTML(name, s, prev, ctx);
    case "tuple": return `<span class="prim">${esc(compactText(s, 8))}</span>`;
    case "set": return setHTML(name, s, prev, ctx);
    case "dict": return dictHTML(name, s, prev, ctx);
    case "ll": return llInline(s);
    case "tree": return s.v ? `<span class="nchip tree" title="binary tree">🌳 ${countNodes(s.v)} node${countNodes(s.v) === 1 ? "" : "s"}, root ${esc(s.v.v)}</span>` : `<span class="prim none">${esc(nullText())}</span>`;
    default: return `<span class="prim">${esc(s.v)}</span>`;
  }
}

export const kindLabel = (s, role) => {
  if (!s) return "";
  if (jsLabels && s.label && !role) return s.n !== undefined ? `${s.label} · ${s.n}` : s.label;
  if (role?.role === "stack") return "stack";
  if (role?.role === "queue") return "queue";
  if (role?.role === "heap") return "heap";
  if (role?.role === "dp") return "dp table";
  return { prim: "", str: "str", list: isGrid(s) ? `grid ${s.v.length}×${Math.max(...s.v.map((r) => r.v.length))}` : `list · ${s.n}`, tuple: "tuple", deque: "deque", set: `set · ${s.n}`, dict: `dict · ${s.n}`, ll: "linked list", tree: "tree", node: "node" }[s.t] || "";
};
