// Host-side runtime for the JavaScript tracer: LeetCode helper types (ListNode, TreeNode),
// the data structures LeetCode's JS environment provides (PriorityQueue family, Queue, Deque),
// a console that captures output, and the whitelist of globals visible to user code.

export function ListNode(val, next) { this.val = val === undefined ? 0 : val; this.next = next === undefined ? null : next; }
export function TreeNode(val, left, right) { this.val = val === undefined ? 0 : val; this.left = left === undefined ? null : left; this.right = right === undefined ? null : right; }

export function buildList(values) { let head = null; for (let i = values.length - 1; i >= 0; i--) head = new ListNode(values[i], head); return head; }
export function buildTree(values) {
  if (!values.length || values[0] === null) return null;
  const root = new TreeNode(values[0]), queue = [root]; let i = 1, q = 0;
  while (q < queue.length && i < values.length) {
    const node = queue[q++];
    if (i < values.length && values[i] !== null) { node.left = new TreeNode(values[i]); queue.push(node.left); } i++;
    if (i < values.length && values[i] !== null) { node.right = new TreeNode(values[i]); queue.push(node.right); } i++;
  }
  return root;
}

const cmpDefault = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// @datastructures-js/priority-queue (v6 style: dequeue() returns the value itself)
export class PriorityQueue {
  constructor(compare, values) {
    this._a = []; this._cmp = typeof compare === "function" ? compare : cmpDefault;
    if (Array.isArray(values)) for (const v of values) this.enqueue(v);
  }
  size() { return this._a.length; }
  isEmpty() { return this._a.length === 0; }
  front() { return this._a.length ? this._a[0] : null; }
  back() { return this._a.length ? this._a.reduce((m, x) => (this._cmp(x, m) > 0 ? x : m)) : null; }
  enqueue(v) {
    const a = this._a; a.push(v); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this._cmp(a[i], a[p]) < 0) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; }
    return this;
  }
  dequeue() {
    const a = this._a; if (!a.length) return null;
    const top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && this._cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this._cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
  push(v) { return this.enqueue(v); }
  pop() { return this.dequeue(); }
  toArray() { return this._a.slice().sort(this._cmp); }
  clear() { this._a.length = 0; }
  contains(cb) { return this._a.some(cb); }
}
export class MinPriorityQueue extends PriorityQueue {
  constructor(getKey) { const k = typeof getKey === "function" ? getKey : (x) => x; super((a, b) => cmpDefault(k(a), k(b))); }
}
export class MaxPriorityQueue extends PriorityQueue {
  constructor(getKey) { const k = typeof getKey === "function" ? getKey : (x) => x; super((a, b) => cmpDefault(k(b), k(a))); }
}

export class Queue {
  constructor(values) { this._a = Array.isArray(values) ? values.slice() : []; }
  size() { return this._a.length; } isEmpty() { return this._a.length === 0; }
  front() { return this._a.length ? this._a[0] : null; } back() { return this._a.length ? this._a[this._a.length - 1] : null; }
  enqueue(v) { this._a.push(v); return this; } dequeue() { return this._a.length ? this._a.shift() : null; }
  push(v) { return this.enqueue(v); } pop() { return this.dequeue(); }
  toArray() { return this._a.slice(); } clear() { this._a.length = 0; }
}
export class Deque {
  constructor(values) { this._a = Array.isArray(values) ? values.slice() : []; }
  size() { return this._a.length; } isEmpty() { return this._a.length === 0; }
  front() { return this._a.length ? this._a[0] : null; } back() { return this._a.length ? this._a[this._a.length - 1] : null; }
  pushFront(v) { this._a.unshift(v); return this; } pushBack(v) { this._a.push(v); return this; }
  popFront() { return this._a.length ? this._a.shift() : null; } popBack() { return this._a.length ? this._a.pop() : null; }
  toArray() { return this._a.slice(); } clear() { this._a.length = 0; }
}

// ---------------------------------------------------------------- console formatting
export function inspect(v, depth = 0, top = true, seen = new Set()) {
  if (typeof v === "string") return top ? v : JSON.stringify(v);
  if (v === null || v === undefined || typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "symbol") return v.toString();
  if (typeof v === "function") return `[Function: ${v.name || "anonymous"}]`;
  if (seen.has(v)) return "[Circular]";
  if (depth > 2) return Array.isArray(v) ? "[Array]" : "[Object]";
  const s2 = new Set(seen).add(v);
  if (Array.isArray(v)) { const items = v.slice(0, 100).map((x) => inspect(x, depth + 1, false, s2)); return items.length ? `[ ${items.join(", ")}${v.length > 100 ? ", ..." : ""} ]` : "[]"; }
  if (v instanceof Map) return `Map(${v.size}) { ${[...v].map(([k, x]) => `${inspect(k, depth + 1, false, s2)} => ${inspect(x, depth + 1, false, s2)}`).join(", ")} }`;
  if (v instanceof Set) return `Set(${v.size}) { ${[...v].map((x) => inspect(x, depth + 1, false, s2)).join(", ")} }`;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  const keys = Object.keys(v), name = v.constructor && v.constructor.name && v.constructor.name !== "Object" ? `${v.constructor.name} ` : "";
  return keys.length ? `${name}{ ${keys.map((k) => `${k}: ${inspect(v[k], depth + 1, false, s2)}`).join(", ")} }` : `${name}{}`;
}

export function makeGlobals(log) {
  const write = (...args) => log(args.map((a) => inspect(a)).join(" "));
  const g = {
    Math, JSON, Number, String, Boolean, Array, Object, Map, Set, WeakMap, WeakSet, Symbol, BigInt, Date, RegExp,
    Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
    parseInt, parseFloat, isNaN, isFinite, Infinity, NaN, Reflect, structuredClone,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, ArrayBuffer,
    ListNode, TreeNode, PriorityQueue, MinPriorityQueue, MaxPriorityQueue, Queue, Deque,
    console: { log: write, info: write, warn: write, error: write, debug: write, table: write, assert() {}, time() {}, timeEnd() {}, group() {}, groupEnd() {} },
    module: { exports: {} }, exports: {}
  };
  return g;
}
